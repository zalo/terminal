// Pan/zoom stage for the canvas. Hand-rolled: wheel + drag on desktop,
// one-finger pan + pinch zoom on touch. The world transform is applied
// directly to the DOM (no React re-render per pointermove).

import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { TileRect } from '../../lib/canvas/types';
import { canvasSocket } from '../../lib/canvas/ws';
import { isMultiTouch, setMultiTouch } from '../../lib/canvas/gesture';

export interface StageApi {
  getScale(): number;
  getViewport(): { x: number; y: number; s: number };
  zoomToRect(rect: TileRect): void;
  fitBounds(rects: TileRect[], insets?: { left: number; top: number; right: number; bottom: number }): void;
  setDragging(on: boolean): void;
}

// Pointerdowns/wheels originating here belong to the element, not the stage.
const DRAG_ZONES = '.tile-header, .tile-resize, .tile-btn';

const StageContext = createContext<StageApi | null>(null);
export function useStage(): StageApi {
  const api = useContext(StageContext);
  if (!api) throw new Error('useStage outside CanvasStage');
  return api;
}

interface Viewport { x: number; y: number; s: number }

const VIEWPORT_KEY = 'terminal:canvasViewport';
const MIN_S = 0.06;
const MAX_S = 2.5;

function loadViewport(): Viewport {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWPORT_KEY) || '');
    if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.s === 'number') return v;
  } catch { /* fall through */ }
  // Default: clear the sidebar (desktop) and start slightly zoomed out.
  const sidebar = window.innerWidth >= 768 ? 300 : 12;
  return { x: sidebar + 20, y: 70, s: 0.5 };
}

interface CanvasStageProps {
  children: ReactNode;
  // Exposes the stage API to parents rendered outside the provider
  // (sidebar zoom-to-session, voice focus_session tool).
  onApi?: (api: StageApi) => void;
}

export default function CanvasStage({ children, onApi }: CanvasStageProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const vp = useRef<Viewport>(loadViewport());
  const apiRef = useRef<StageApi>(null as unknown as StageApi);

  if (!apiRef.current) {
    apiRef.current = {
      getScale: () => vp.current.s,
      getViewport: () => ({ ...vp.current }),
      zoomToRect: (rect: TileRect) => {
        const outer = outerRef.current;
        const world = worldRef.current;
        if (!outer || !world) return;
        const vw = outer.clientWidth;
        const vh = outer.clientHeight;
        const s = Math.min(vw / (rect.w + 120), vh / (rect.h + 200), 1.4);
        vp.current = {
          s,
          x: (vw - rect.w * s) / 2 - rect.x * s,
          y: (vh - rect.h * s) / 2 - rect.y * s,
        };
        world.style.transition = 'transform 450ms cubic-bezier(0.22, 1, 0.36, 1)';
        world.style.transform = `translate(${vp.current.x}px, ${vp.current.y}px) scale(${s})`;
        setTimeout(() => { if (world) world.style.transition = ''; }, 500);
        save();
      },
      fitBounds: (rects: TileRect[], insets = { left: 12, top: 60, right: 12, bottom: 110 }) => {
        const outer = outerRef.current;
        const world = worldRef.current;
        if (!outer || !world || rects.length === 0) return;
        const minX = Math.min(...rects.map((r) => r.x));
        const minY = Math.min(...rects.map((r) => r.y));
        const maxX = Math.max(...rects.map((r) => r.x + r.w));
        const maxY = Math.max(...rects.map((r) => r.y + r.h));
        const bw = maxX - minX;
        const bh = maxY - minY;
        const availW = Math.max(120, outer.clientWidth - insets.left - insets.right);
        const availH = Math.max(120, outer.clientHeight - insets.top - insets.bottom);
        const s = Math.min(MAX_S, Math.max(MIN_S, Math.min(availW / bw, availH / bh)));
        vp.current = {
          s,
          x: insets.left + (availW - bw * s) / 2 - minX * s,
          y: insets.top + (availH - bh * s) / 2 - minY * s,
        };
        world.style.transition = 'transform 450ms cubic-bezier(0.22, 1, 0.36, 1)';
        world.style.transform = `translate(${vp.current.x}px, ${vp.current.y}px) scale(${s})`;
        setTimeout(() => { if (world) world.style.transition = ''; }, 500);
        save();
      },
      setDragging: (on: boolean) => {
        outerRef.current?.classList.toggle('canvas-dragging', on);
      },
    };
  }

  useEffect(() => { onApi?.(apiRef.current); }, [onApi]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try { localStorage.setItem(VIEWPORT_KEY, JSON.stringify(vp.current)); } catch { /* full */ }
    }, 400);
  };

  useEffect(() => {
    const outer = outerRef.current;
    const world = worldRef.current;
    if (!outer || !world) return;

    const apply = () => {
      world.style.transform = `translate(${vp.current.x}px, ${vp.current.y}px) scale(${vp.current.s})`;
      save();
    };
    apply();

    const zoomAt = (cx: number, cy: number, factor: number) => {
      const { x, y, s } = vp.current;
      const ns = Math.min(MAX_S, Math.max(MIN_S, s * factor));
      const k = ns / s;
      vp.current = { s: ns, x: cx - (cx - x) * k, y: cy - (cy - y) * k };
      apply();
    };

    const onWheel = (e: WheelEvent) => {
      // A tile that is selected (clicked) AND hovered scrolls its own
      // content (SessionTile handles the wheel natively); everything else
      // zooms toward the cursor. Horizontal-dominant deltas still pan.
      if ((e.target as Element).closest?.('.tile-scroll-active')) return;
      e.preventDefault();
      const box = outer.getBoundingClientRect();
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        vp.current.x -= e.deltaX;
        apply();
        return;
      }
      zoomAt(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * 0.0022));
    };
    outer.addEventListener('wheel', onWheel, { passive: false });

    // --- Multi-touch takeover (window capture) ------------------------------
    // Tracks every touch pointer regardless of where it landed — a tile
    // header, an iframe shield, the background. The moment two fingers are
    // down, the gesture belongs to the stage: the shared multiTouch flag
    // flips (tiles abort/refuse drags), single-finger pan state is cleared,
    // and pinch zoom/pan runs from the fingers' true positions. Window
    // CAPTURE listeners see pointers even when a tile holds pointer capture.
    const touches = new Map<number, { x: number; y: number }>();
    let touchPinch: { dist: number; cx: number; cy: number; s: number; x: number; y: number } | null = null;
    let touchPanAnchor: { x: number; y: number } | null = null;

    const beginTouchPinch = () => {
      const [a, b] = [...touches.values()];
      const box = outer.getBoundingClientRect();
      touchPinch = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        cx: (a.x + b.x) / 2 - box.left,
        cy: (a.y + b.y) / 2 - box.top,
        s: vp.current.s,
        x: vp.current.x,
        y: vp.current.y,
      };
      touchPanAnchor = null;
    };

    const winPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        setMultiTouch(true);
        // Cancel any single-finger pan the stage had going.
        pointers.clear();
        panning = false;
        outer.classList.add('canvas-dragging');
        beginTouchPinch();
      }
    };

    const winPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!isMultiTouch()) return;
      if (touches.size >= 2 && touchPinch) {
        const [a, b] = [...touches.values()];
        const box = outer.getBoundingClientRect();
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const cx = (a.x + b.x) / 2 - box.left;
        const cy = (a.y + b.y) / 2 - box.top;
        const ns = Math.min(MAX_S, Math.max(MIN_S, touchPinch.s * (dist / touchPinch.dist)));
        const k = ns / touchPinch.s;
        vp.current = {
          s: ns,
          x: cx - (touchPinch.cx - touchPinch.x) * k,
          y: cy - (touchPinch.cy - touchPinch.y) * k,
        };
        apply();
      } else if (touches.size === 1) {
        // Trailing finger after a pinch keeps panning until fully lifted.
        const pos = [...touches.values()][0];
        if (touchPanAnchor) {
          vp.current.x += pos.x - touchPanAnchor.x;
          vp.current.y += pos.y - touchPanAnchor.y;
          apply();
        }
        touchPanAnchor = pos;
      }
    };

    const winPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      touches.delete(e.pointerId);
      if (touches.size < 2) touchPinch = null;
      if (touches.size === 1) touchPanAnchor = [...touches.values()][0];
      if (touches.size === 0) {
        touchPanAnchor = null;
        if (isMultiTouch()) {
          setMultiTouch(false);
          outer.classList.remove('canvas-dragging');
        }
      }
    };

    window.addEventListener('pointerdown', winPointerDown, { capture: true });
    window.addEventListener('pointermove', winPointerMove, { capture: true });
    window.addEventListener('pointerup', winPointerUp, { capture: true });
    window.addEventListener('pointercancel', winPointerUp, { capture: true });

    // --- Single-pointer pan (mouse, or one finger on the background) --------
    // Panning (and pointer capture) only begins after a small movement
    // threshold: capturing on pointerdown would retarget the ensuing
    // click/dblclick to the stage, so double-click-to-expand on tiles would
    // never fire.
    const PAN_THRESHOLD = 4;
    const pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
    let panning = false;

    const onPointerDown = (e: PointerEvent) => {
      // A pointerdown in a tile drag zone belongs to the tile (this native
      // listener fires before React's delegated stopPropagation can help),
      // and multi-touch gestures belong to the takeover path above.
      if (e.pointerType === 'touch' && isMultiTouch()) return;
      if ((e.target as Element).closest?.(DRAG_ZONES)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    };

    const onPointerMove = (e: PointerEvent) => {
      // Broadcast presence cursor in world coords (hover included).
      const box = outer.getBoundingClientRect();
      const wx = (e.clientX - box.left - vp.current.x) / vp.current.s;
      const wy = (e.clientY - box.top - vp.current.y) / vp.current.s;
      canvasSocket.sendCursor(wx, wy);

      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      // Self-heal: if the button is no longer held, the pointerup escaped us
      // (e.g. it landed inside an iframe after a selection re-render removed
      // the shield mid-gesture). Without this, hover moves would pan forever.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) {
          panning = false;
          outer.classList.remove('canvas-dragging');
        }
        return;
      }
      if (e.pointerType === 'touch' && isMultiTouch()) return;
      if (pointers.size === 1) {
        if (!panning) {
          if (Math.hypot(e.clientX - prev.sx, e.clientY - prev.sy) < PAN_THRESHOLD) return;
          panning = true;
          try { outer.setPointerCapture(e.pointerId); } catch { /* released pointer */ }
          outer.classList.add('canvas-dragging');
        }
        vp.current.x += e.clientX - prev.x;
        vp.current.y += e.clientY - prev.y;
        pointers.set(e.pointerId, { ...prev, x: e.clientX, y: e.clientY });
        apply();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        panning = false;
        if (!isMultiTouch()) outer.classList.remove('canvas-dragging');
      }
    };

    outer.addEventListener('pointerdown', onPointerDown);
    outer.addEventListener('pointermove', onPointerMove);
    outer.addEventListener('pointerup', onPointerUp);
    outer.addEventListener('pointercancel', onPointerUp);

    return () => {
      outer.removeEventListener('wheel', onWheel);
      outer.removeEventListener('pointerdown', onPointerDown);
      outer.removeEventListener('pointermove', onPointerMove);
      outer.removeEventListener('pointerup', onPointerUp);
      outer.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('pointerdown', winPointerDown, { capture: true });
      window.removeEventListener('pointermove', winPointerMove, { capture: true });
      window.removeEventListener('pointerup', winPointerUp, { capture: true });
      window.removeEventListener('pointercancel', winPointerUp, { capture: true });
      setMultiTouch(false);
    };
  }, []);

  return (
    <StageContext.Provider value={apiRef.current}>
      <div ref={outerRef} className="canvas-stage absolute inset-0 overflow-hidden touch-none select-none">
        {/* No will-change: a cached transform layer stays rasterized at its
            old resolution and looks blurry after zooming in. */}
        <div ref={worldRef} className="canvas-world absolute top-0 left-0 origin-top-left">
          {children}
        </div>
      </div>
    </StageContext.Provider>
  );
}
