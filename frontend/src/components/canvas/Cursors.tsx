// Multiplayer presence cursors, rendered inside the world transform so
// they live in canvas coordinates. High-frequency updates bypass the store.

import { useEffect, useRef, useState } from 'react';
import { canvasSocket } from '../../lib/canvas/ws';
import { useCanvasState } from '../../lib/canvas/store';

interface CursorPos { x: number; y: number; at: number }

export default function Cursors() {
  const { clients, you } = useCanvasState();
  const [cursors, setCursors] = useState<Record<string, CursorPos>>({});
  const ref = useRef(cursors);
  ref.current = cursors;

  useEffect(() => {
    const off = canvasSocket.onCursor((e) => {
      setCursors((prev) => ({ ...prev, [e.id]: { x: e.x, y: e.y, at: Date.now() } }));
    });
    const prune = setInterval(() => {
      const now = Date.now();
      const cur = ref.current;
      const stale = Object.keys(cur).filter((id) => now - cur[id].at > 8000);
      if (stale.length) {
        setCursors((prev) => {
          const next = { ...prev };
          for (const id of stale) delete next[id];
          return next;
        });
      }
    }, 2000);
    return () => { off(); clearInterval(prune); };
  }, []);

  return (
    <>
      {Object.entries(cursors).map(([id, pos]) => {
        if (id === you?.id) return null;
        const client = clients.find((c) => c.id === id);
        if (!client) return null;
        return (
          <div
            key={id}
            className="remote-cursor absolute pointer-events-none"
            style={{ left: pos.x, top: pos.y }}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" style={{ color: client.color }}>
              <path d="M5 3l14 7-6.5 1.5L9 18z" fill="currentColor" stroke="rgba(0,0,0,.4)" strokeWidth="1" />
            </svg>
            <span
              className="ml-3 px-1.5 py-0.5 rounded text-[10px] font-mono lowercase whitespace-nowrap"
              style={{ background: `color-mix(in srgb, ${client.color} 25%, #10101f)`, color: client.color }}
            >
              {client.name}
            </span>
          </div>
        );
      })}
    </>
  );
}
