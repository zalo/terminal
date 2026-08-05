// A live terminal tile on the canvas. Renders capture-pane frames as
// ANSI-colored HTML — no xterm instance, no tmux client, so dozens of tiles
// stay cheap and never disturb the real window size.
//
// Text is rendered at its final computed font size (fontSize = tileWidth /
// cols / 0.6) instead of CSS-scaling a fixed-size layer — scaled layers get
// rasterized once and look blurry when the canvas zooms in.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ansiToHtml } from '../../lib/ansi';
import { sessionColor, STATUS_COLORS } from '../../lib/canvas/colors';
import { canvasSocket } from '../../lib/canvas/ws';
import { canvasStore } from '../../lib/canvas/store';
import { isMultiTouch } from '../../lib/canvas/gesture';
import type { RosterEntry, ScreenFrame, TileRect } from '../../lib/canvas/types';
import { useStage } from './CanvasStage';

const CHAR_RATIO = 0.6;   // JetBrains Mono advance width (exactly 600/1000 em)
const LINE_RATIO = 1.25;
const HEADER_H = 34;

interface SessionTileProps {
  session: RosterEntry;
  rect: TileRect;
  multiContext: boolean;
  onFocus: (key: string) => void;
  onOpen: (session: RosterEntry) => void;
  onTogglePreview: (session: RosterEntry) => void;
  previewOpen: boolean;
  // Selection: wheel-over-tile only scrolls when the tile is selected
  // (clicked); otherwise the wheel zooms the canvas.
  selected?: boolean;
  onSelect?: (key: string) => void;
  // Clicking a URL in the tile opens an in-canvas browser window.
  onOpenLink?: (url: string, nearKey: string) => void;
}

export default function SessionTile({
  session, rect, multiContext, onFocus, onOpen, onTogglePreview, previewOpen,
  selected, onSelect, onOpenLink,
}: SessionTileProps) {
  const stage = useStage();
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [drag, setDrag] = useState<TileRect | null>(null);
  const [scrollback, setScrollback] = useState(0);   // px scrolled up from live bottom
  const dragRef = useRef<{ mode: 'move' | 'resize'; px: number; py: number; rect: TileRect } | null>(null);
  const lastSent = useRef(0);
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => canvasSocket.subscribeScreen(session.key, setFrame), [session.key]);

  const shown = drag ?? rect;
  const color = sessionColor(session.key);
  const status = session.meta?.status;
  const statusColor = status ? STATUS_COLORS[status] : '#565b7a';

  const html = useMemo(() => (frame ? ansiToHtml(frame.lines) : ''), [frame]);

  // Metrics: text fills the tile width exactly at its own font size.
  const innerW = shown.w - 2;
  const innerH = shown.h - HEADER_H - 2;
  const cols = frame?.cols || 80;
  const rows = frame?.rows || 24;
  const fontSize = innerW / (cols * CHAR_RATIO);
  const charW = fontSize * CHAR_RATIO;
  const lineH = fontSize * LINE_RATIO;
  const contentH = rows * lineH;
  const maxScrollback = Math.max(0, contentH - innerH);
  const scrollable = maxScrollback > 1 && Boolean(selected);
  const sb = Math.min(scrollback, maxScrollback);
  const offsetY = contentH > innerH ? innerH - contentH + sb : 0;

  // Wheel over the screen scrolls the captured content (native listener:
  // the stage's wheel handler also runs natively, so React's delegated
  // stopPropagation would be too late).
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!scrollable) return; // content fits — let the stage zoom
      e.preventDefault();
      e.stopPropagation();
      setScrollback((prev) => Math.max(0, Math.min(maxScrollback, prev - e.deltaY)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollable, maxScrollback]);

  const startDrag = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isMultiTouch()) return; // two fingers down = stage pinch, never a drag
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    stage.setDragging(true);
    // Raise on grab — and carry the raised z through the drag, or the
    // move/up ops would write the old z back.
    const z = canvasStore.maxZ() + 1;
    dragRef.current = { mode, px: e.clientX, py: e.clientY, rect: { ...shown, z } };
    canvasSocket.sendOp({ kind: 'tile', key: session.key, rect: { ...shown, z } });
  };

  const abortDrag = () => {
    dragRef.current = null;
    setDrag(null);
    stage.setDragging(false);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    if (isMultiTouch()) { abortDrag(); return; } // a second finger took over
    const s = stage.getScale();
    const dx = (e.clientX - d.px) / s;
    const dy = (e.clientY - d.py) / s;
    const next: TileRect = d.mode === 'move'
      ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
      : { ...d.rect, w: Math.max(220, d.rect.w + dx), h: Math.max(140, d.rect.h + dy) };
    setDrag(next);
    const now = performance.now();
    if (now - lastSent.current > 80) {
      lastSent.current = now;
      canvasSocket.sendOp({ kind: 'tile', key: session.key, rect: next });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    dragRef.current = null;
    stage.setDragging(false);
    if (drag) canvasSocket.sendOp({ kind: 'tile', key: session.key, rect: drag });
    setDrag(null);
  };

  return (
    <div
      className="tile glass absolute flex flex-col"
      style={{
        left: shown.x, top: shown.y, width: shown.w, height: shown.h, zIndex: shown.z,
        borderColor: `color-mix(in srgb, ${color} ${selected ? 75 : 34}%, transparent)`,
        boxShadow: selected ? `0 0 0 1px color-mix(in srgb, ${color} 55%, transparent), 0 12px 44px rgba(4,6,20,.5)` : undefined,
      }}
      onPointerDownCapture={() => onSelect?.(session.key)}
      onDoubleClick={() => onFocus(session.key)}
    >
      <div
        className="tile-header flex items-center gap-2 px-3 cursor-grab active:cursor-grabbing"
        style={{ height: HEADER_H }}
        onPointerDown={startDrag('move')}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${status === 'working' ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: statusColor }}
          title={status || 'no status'}
        />
        <span className="font-mono text-[13px] font-semibold lowercase" style={{ color }}>
          {session.callsign}
        </span>
        <span className="text-[11px] truncate" style={{ color: 'var(--cv-ink-dim)' }}>
          {session.name}
        </span>
        {multiContext && (
          <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded flex-shrink-0"
            style={{ color: 'var(--cv-ink-dim)', border: '1px solid var(--cv-edge)' }}>
            {session.context}
          </span>
        )}
        {selected && (
          <span
            className="flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-px rounded-full flex-shrink-0"
            style={{
              color: 'var(--cv-accent)',
              background: 'color-mix(in srgb, var(--cv-accent) 14%, transparent)',
            }}
            title="Keyboard forwarded to this terminal"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
            </svg>
            keys
          </span>
        )}
        <span className="flex-1" />
        {session.meta?.preview_url && (
          <button
            className="tile-btn"
            title={previewOpen ? 'Close preview' : 'Open preview'}
            style={previewOpen ? { color: 'var(--cv-accent)' } : undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onTogglePreview(session)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9s1.3-6.4 3.8-9z" />
            </svg>
          </button>
        )}
        <button
          className="tile-btn" title="Interact (attach)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onFocus(session.key)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
        <button
          className="tile-btn" title="Open full view"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onOpen(session)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M7 17L17 7M9 7h8v8" />
          </svg>
        </button>
      </div>

      <div
        ref={screenRef}
        className={`tile-screen relative flex-1 overflow-hidden rounded-b-[13px] ${scrollable ? 'tile-scroll-active' : ''}`}
        onClick={(e) => {
          const link = (e.target as Element).closest?.('.term-link') as HTMLElement | null;
          if (link?.dataset.url) {
            e.stopPropagation();
            onOpenLink?.(link.dataset.url, session.key);
          }
        }}
      >
        {frame ? (
          <div
            className="absolute top-0 left-0"
            style={{ transform: `translateY(${offsetY}px)`, width: innerW }}
          >
            <pre
              className="m-0 font-mono"
              style={{ fontSize, lineHeight: `${lineH}px`, whiteSpace: 'pre', color: '#d3d8ea' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {/* Live cursor block */}
            <div
              className="absolute"
              style={{
                left: frame.cx * charW,
                top: frame.cy * lineH,
                width: charW,
                height: lineH,
                background: 'color-mix(in srgb, var(--cv-accent) 65%, transparent)',
              }}
            />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--cv-ink-dim)' }}>
            connecting…
          </div>
        )}
        {sb > 1 && (
          <button
            className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono"
            style={{
              background: 'color-mix(in srgb, var(--cv-accent) 20%, #10101f)',
              color: 'var(--cv-accent)',
              border: '1px solid color-mix(in srgb, var(--cv-accent) 40%, transparent)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setScrollback(0)}
          >
            ↓ live
          </button>
        )}
        {session.meta?.task && (
          <div className="tile-task absolute bottom-0 left-0 right-0 px-3 py-1.5 text-[11px] truncate">
            {session.meta.task}
          </div>
        )}
      </div>

      <div
        className="tile-resize absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize"
        style={{ touchAction: 'none' }}
        onPointerDown={startDrag('resize')}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg viewBox="0 0 20 20" className="w-5 h-5 opacity-40" fill="none" stroke="currentColor">
          <path d="M15 9v6H9M15 4v2M4 15h2" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
