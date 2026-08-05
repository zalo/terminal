// A free-floating "little browser window" on the canvas: editable URL bar,
// back/forward, open-in-new-tab. The URL and rect are shared (persisted +
// multiplayer); the history stack is per-client — cross-origin iframes don't
// expose their internal navigation, so back/forward tracks URL-bar entries
// and opened links (the best a parent page can do).
//
// Sites that send X-Frame-Options / CSP frame-ancestors will refuse to
// render; the ↗ button opens the URL as a real browser tab.

import { useEffect, useRef, useState } from 'react';
import { canvasSocket } from '../../lib/canvas/ws';
import { canvasStore } from '../../lib/canvas/store';
import { isMultiTouch } from '../../lib/canvas/gesture';
import type { BrowserRect, TileRect } from '../../lib/canvas/types';
import { isAppLocal, localPortOf } from '../../lib/frameSrc';
import { useStage } from './CanvasStage';

const HEADER_H = 38;

interface BrowserTileProps {
  id: string;
  rect: BrowserRect;
  selected?: boolean;
  onSelect?: (key: string) => void;
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/^https?:\/\//.test(t)) return t;
  return `https://${t}`;
}

export default function BrowserTile({ id, rect, selected, onSelect }: BrowserTileProps) {
  const stage = useStage();
  const [drag, setDrag] = useState<TileRect | null>(null);
  const dragRef = useRef<{ mode: 'move' | 'resize'; px: number; py: number; rect: TileRect; started: boolean } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastSent = useRef(0);
  const [input, setInput] = useState(rect.url);
  const [stack, setStack] = useState<string[]>(rect.url ? [rect.url] : []);
  const [idx, setIdx] = useState(rect.url ? 0 : -1);
  const [nav, setNav] = useState(0); // bumps the iframe key to force reload
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = drag ?? rect;
  const url = rect.url;
  const proxied = Boolean(rect.proxy);

  // Three loading modes:
  //  lp     — localhost target viewed remotely: path-preserving local proxy
  //           (full app fidelity: assets, XHR, websockets)
  //  proxy  — public site that refuses framing: document proxy, opaque-origin
  //           sandbox (its JS must never act as our origin)
  //  direct — plain iframe
  const lp = url && !isAppLocal() ? localPortOf(url) : null;
  const mode: 'lp' | 'proxy' | 'direct' = lp ? 'lp' : proxied && url ? 'proxy' : 'direct';
  const frameSrc =
    lp ? `/lp/${lp.port}${lp.path}` :
    mode === 'proxy' ? `/api/proxy?url=${encodeURIComponent(url)}` : url;

  // lp frames are our own origin — track in-frame navigation directly.
  const onFrameLoad = () => {
    if (mode !== 'lp') return;
    try {
      const loc = iframeRef.current?.contentWindow?.location;
      const m = loc && `${loc.pathname}${loc.search}`.match(/^\/lp\/(\d{1,5})(\/[^]*)?$/);
      if (m) {
        const actual = `http://localhost:${m[1]}${m[2] || '/'}`;
        if (actual !== rect.url) canvasSocket.sendOp({ kind: 'browser', id, url: actual });
      }
    } catch { /* frame navigated somewhere unreadable — ignore */ }
  };

  // Direct loads: ask the server whether the site allows embedding; if it
  // sends X-Frame-Options / frame-ancestors, flip to the proxy automatically
  // (a refused iframe gives the parent no reliable signal).
  useEffect(() => {
    if (mode !== 'direct' || !url) return;
    let cancelled = false;
    fetch(`/api/proxy/check?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j && j.frameable === false) {
          canvasSocket.sendOp({ kind: 'browser', id, proxy: true });
          setNav((n) => n + 1);
        }
      })
      .catch(() => { /* offline — leave direct */ });
    return () => { cancelled = true; };
  }, [url, mode, id]);

  // Document-proxied frames are sandboxed to an opaque origin; they announce
  // navigation via postMessage instead.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const nav = (e.data as { __tcNav?: unknown })?.__tcNav;
      if (typeof nav === 'string' && nav !== rect.url && /^https?:\/\//.test(nav)) {
        canvasSocket.sendOp({ kind: 'browser', id, url: nav });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [id, rect.url]);

  // Remote URL changes (another client navigated this tile) join our stack.
  useEffect(() => {
    setInput(url);
    setStack((prev) => {
      if (prev[idx] === url) return prev;
      const next = [...prev.slice(0, idx + 1), url].filter(Boolean);
      setIdx(next.length - 1);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    if (!url && selected) setTimeout(() => inputRef.current?.focus(), 60);
  }, [url, selected]);

  const navigate = (to: string) => {
    const normalized = normalizeUrl(to);
    if (!normalized) return;
    canvasSocket.sendOp({ kind: 'browser', id, url: normalized });
    setNav((n) => n + 1);
  };

  const go = (delta: number) => {
    const next = idx + delta;
    if (next < 0 || next >= stack.length) return;
    setIdx(next);
    setInput(stack[next]);
    canvasSocket.sendOp({ kind: 'browser', id, url: stack[next] });
    setNav((n) => n + 1);
  };

  const startDrag = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isMultiTouch()) return; // two fingers down = stage pinch, never a drag
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const z = canvasStore.maxZ() + 1;
    dragRef.current = { mode, px: e.clientX, py: e.clientY, rect: { ...shown, z }, started: false };
    canvasSocket.sendOp({ kind: 'browser', id, rect: { ...shown, z } });
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    if (isMultiTouch()) { // a second finger took over
      dragRef.current = null;
      setDrag(null);
      stage.setDragging(false);
      return;
    }
    // Threshold before the window actually moves: the URL bar doubles as a
    // drag handle, and a plain click on it must stay a click (focus).
    if (!d.started) {
      if (Math.hypot(e.clientX - d.px, e.clientY - d.py) < 4) return;
      d.started = true;
      stage.setDragging(true);
    }
    const s = stage.getScale();
    const dx = (e.clientX - d.px) / s;
    const dy = (e.clientY - d.py) / s;
    const next: TileRect = d.mode === 'move'
      ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
      : { ...d.rect, w: Math.max(280, d.rect.w + dx), h: Math.max(200, d.rect.h + dy) };
    setDrag(next);
    const now = performance.now();
    if (now - lastSent.current > 80) {
      lastSent.current = now;
      canvasSocket.sendOp({ kind: 'browser', id, rect: next });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    dragRef.current = null;
    stage.setDragging(false);
    if (drag) canvasSocket.sendOp({ kind: 'browser', id, rect: drag });
    setDrag(null);
  };

  const stopPointer = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      className="tile glass absolute flex flex-col"
      style={{
        left: shown.x, top: shown.y, width: shown.w, height: shown.h, zIndex: shown.z,
        borderColor: `color-mix(in srgb, var(--cv-accent) ${selected ? 60 : 26}%, transparent)`,
        boxShadow: selected ? '0 0 0 1px color-mix(in srgb, var(--cv-accent) 45%, transparent), 0 12px 44px rgba(4,6,20,.5)' : undefined,
      }}
      onPointerDownCapture={() => onSelect?.(`b:${id}`)}
    >
      <div
        className="tile-header flex items-center gap-1.5 px-2 cursor-grab active:cursor-grabbing"
        style={{ height: HEADER_H }}
        onPointerDown={startDrag('move')}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <button
          className="tile-btn" title="Back" disabled={idx <= 0}
          style={idx <= 0 ? { opacity: 0.3 } : undefined}
          onPointerDown={stopPointer}
          onClick={() => go(-1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          className="tile-btn" title="Forward" disabled={idx >= stack.length - 1}
          style={idx >= stack.length - 1 ? { opacity: 0.3 } : undefined}
          onPointerDown={stopPointer}
          onClick={() => go(1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <input
          ref={inputRef}
          value={input}
          placeholder="enter a URL…"
          // Unfocused, the URL bar is part of the drag handle (click still
          // focuses); once focused it's a normal text field.
          onPointerDown={(e) => {
            if (document.activeElement === inputRef.current) e.stopPropagation();
          }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(input);
            e.stopPropagation();
          }}
          className="flex-1 min-w-0 px-2 py-1 rounded-md font-mono text-[11px] outline-none"
          style={{
            background: 'color-mix(in srgb, var(--cv-bg) 55%, transparent)',
            border: '1px solid var(--cv-edge)',
            color: 'var(--cv-ink)',
          }}
        />
        {mode !== 'lp' && (
          <button
            className="tile-btn"
            title={proxied ? 'Proxy on — headers stripped so blocked sites render. Click to load directly.' : 'Site refuses to embed? Load through the proxy.'}
            style={proxied ? { color: 'var(--cv-accent)' } : undefined}
            onPointerDown={stopPointer}
            onClick={() => { canvasSocket.sendOp({ kind: 'browser', id, proxy: !proxied }); setNav((n) => n + 1); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6l8-3z" />
            </svg>
          </button>
        )}
        <button
          className="tile-btn" title="Open as a real browser tab"
          onPointerDown={stopPointer}
          onClick={() => url && window.open(url, '_blank', 'noopener')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M7 17L17 7M9 7h8v8" />
          </svg>
        </button>
        <button
          className="tile-btn" title="Close"
          onPointerDown={stopPointer}
          onClick={() => canvasSocket.sendOp({ kind: 'browser:close', id })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-b-[13px] bg-white">
        {url ? (
          <iframe
            ref={iframeRef}
            key={`${mode}#${url}#${nav}`}
            src={frameSrc}
            onLoad={onFrameLoad}
            title={`browser ${id}`}
            className="w-full h-full border-0"
            allow="fullscreen; clipboard-read; clipboard-write"
            sandbox={mode === 'proxy'
              ? 'allow-scripts allow-forms allow-popups'
              : 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-slate-400">
            enter a URL above
          </div>
        )}
        {!selected && url && (
          // Shield: wheel zooms the canvas until the tile is selected.
          <div className="absolute inset-0" />
        )}
      </div>

      <div
        className="tile-resize absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize"
        style={{ touchAction: 'none' }}
        onPointerDown={startDrag('resize')}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}
