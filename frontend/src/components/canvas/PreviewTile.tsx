// A live web-preview iframe tile, linked to its session by accent color.
// While any canvas drag/pan is active, `.canvas-dragging iframe` gets
// pointer-events:none (index.css) so the iframe can't swallow the gesture.

import { useRef, useState } from 'react';
import { sessionColor } from '../../lib/canvas/colors';
import { canvasSocket } from '../../lib/canvas/ws';
import { canvasStore } from '../../lib/canvas/store';
import { isMultiTouch } from '../../lib/canvas/gesture';
import type { RosterEntry, TileRect } from '../../lib/canvas/types';
import { resolveFrameSrc } from '../../lib/frameSrc';
import { useStage } from './CanvasStage';

const HEADER_H = 34;

interface PreviewTileProps {
  session: RosterEntry;
  rect: TileRect;
  // Unselected previews sit under a transparent shield so the wheel zooms
  // the canvas; clicking selects and hands interaction to the iframe.
  selected?: boolean;
  onSelect?: (key: string) => void;
}

export default function PreviewTile({ session, rect, selected, onSelect }: PreviewTileProps) {
  const stage = useStage();
  const [drag, setDrag] = useState<TileRect | null>(null);
  const dragRef = useRef<{ mode: 'move' | 'resize'; px: number; py: number; rect: TileRect } | null>(null);
  const lastSent = useRef(0);

  const shown = drag ?? rect;
  const color = sessionColor(session.key);
  const url = session.meta?.preview_url;

  const startDrag = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isMultiTouch()) return; // two fingers down = stage pinch, never a drag
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    stage.setDragging(true);
    const z = canvasStore.maxZ() + 1;
    dragRef.current = { mode, px: e.clientX, py: e.clientY, rect: { ...shown, z } };
    canvasSocket.sendOp({ kind: 'preview', key: session.key, rect: { ...shown, z } });
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
    const s = stage.getScale();
    const dx = (e.clientX - d.px) / s;
    const dy = (e.clientY - d.py) / s;
    const next: TileRect = d.mode === 'move'
      ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
      : { ...d.rect, w: Math.max(260, d.rect.w + dx), h: Math.max(180, d.rect.h + dy) };
    setDrag(next);
    const now = performance.now();
    if (now - lastSent.current > 80) {
      lastSent.current = now;
      canvasSocket.sendOp({ kind: 'preview', key: session.key, rect: next });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    dragRef.current = null;
    stage.setDragging(false);
    if (drag) canvasSocket.sendOp({ kind: 'preview', key: session.key, rect: drag });
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
      onPointerDownCapture={() => onSelect?.(`p:${session.key}`)}
    >
      <div
        className="tile-header flex items-center gap-2 px-3 cursor-grab active:cursor-grabbing"
        style={{ height: HEADER_H }}
        onPointerDown={startDrag('move')}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" className="w-3.5 h-3.5 flex-shrink-0">
          <circle cx="12" cy="12" r="9" /><path d="M3 12h18" />
        </svg>
        <span className="font-mono text-[13px] font-semibold lowercase" style={{ color }}>
          {session.callsign}
        </span>
        <span className="text-[11px] truncate" style={{ color: 'var(--cv-ink-dim)' }}>{url}</span>
        <span className="flex-1" />
        <button
          className="tile-btn" title="Open in new tab"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => url && window.open(url, '_blank', 'noopener')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M7 17L17 7M9 7h8v8" />
          </svg>
        </button>
        <button
          className="tile-btn" title="Close preview"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => canvasSocket.sendOp({ kind: 'preview:close', key: session.key })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-b-[13px] bg-white">
        {url ? (
          <iframe
            src={resolveFrameSrc(url)}
            title={`${session.callsign} preview`}
            className="w-full h-full border-0"
            allow="fullscreen; clipboard-read; clipboard-write"
          />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-slate-500 bg-transparent">
            preview URL gone — run tm-meta preview in the session
          </div>
        )}
        {!selected && url && (
          // Shield: catches wheel (canvas zoom) and the selecting click.
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
