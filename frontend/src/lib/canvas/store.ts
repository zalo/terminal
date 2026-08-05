// Tiny external store for shared canvas state. Screen frames and remote
// cursors deliberately bypass this store (they're high-frequency and go
// straight to per-key listeners in ws.ts) — this holds only the
// low-frequency shared state every canvas component may care about.

import { useSyncExternalStore } from 'react';
import type { LayoutState, Op, PresenceClient, RosterEntry, TileRect } from './types';

export interface CanvasState {
  connected: boolean;
  you: PresenceClient | null;
  sessions: RosterEntry[];
  layout: LayoutState;
  clients: PresenceClient[];
  focusedKey: string | null;   // session focused in the interactive overlay
}

type Listener = () => void;

class CanvasStore {
  private state: CanvasState = {
    connected: false,
    you: null,
    sessions: [],
    layout: { tiles: {}, previews: {}, browsers: {}, names: {} },
    clients: [],
    focusedKey: null,
  };
  private listeners = new Set<Listener>();

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getState = (): CanvasState => this.state;

  set(partial: Partial<CanvasState>) {
    this.state = { ...this.state, ...partial };
    for (const cb of this.listeners) cb();
  }

  applyOp(op: Op) {
    const layout: LayoutState = {
      tiles: { ...this.state.layout.tiles },
      previews: { ...this.state.layout.previews },
      browsers: { ...this.state.layout.browsers },
      names: this.state.layout.names,
      theme: this.state.layout.theme,
    };
    if (op.kind === 'tile') {
      const prev = layout.tiles[op.key] || { x: 60, y: 60, w: 560, h: 400, z: 1 };
      layout.tiles[op.key] = { ...prev, ...op.rect };
    } else if (op.kind === 'preview') {
      const prev = layout.previews[op.key] || { x: 60, y: 60, w: 560, h: 400, z: 1 };
      layout.previews[op.key] = { ...prev, ...op.rect };
    } else if (op.kind === 'preview:close') {
      delete layout.previews[op.key];
    } else if (op.kind === 'tiles') {
      Object.assign(layout.tiles, op.tiles || {});
      for (const [key, rect] of Object.entries(op.previews || {})) {
        if (layout.previews[key]) layout.previews[key] = { ...layout.previews[key], ...rect };
      }
      for (const [id, rect] of Object.entries(op.browsers || {})) {
        if (layout.browsers[id]) layout.browsers[id] = { ...layout.browsers[id], ...rect };
      }
    } else if (op.kind === 'theme') {
      layout.theme = { ...layout.theme, ...op.theme };
      if (op.theme.backgroundUrl === null) delete layout.theme.backgroundUrl;
    } else if (op.kind === 'browser') {
      const prev = layout.browsers[op.id] || { x: 60, y: 60, w: 720, h: 560, z: 1, url: '' };
      layout.browsers[op.id] = {
        ...prev,
        ...op.rect,
        url: op.url !== undefined ? op.url : prev.url,
        proxy: op.proxy !== undefined ? op.proxy : prev.proxy,
      };
    } else if (op.kind === 'browser:close') {
      delete layout.browsers[op.id];
    }
    this.set({ layout });
  }

  maxZ(): number {
    let z = 1;
    for (const r of Object.values(this.state.layout.tiles)) z = Math.max(z, r.z);
    for (const r of Object.values(this.state.layout.previews)) z = Math.max(z, r.z);
    for (const r of Object.values(this.state.layout.browsers)) z = Math.max(z, r.z);
    return z;
  }

  findSession(nameish: string): RosterEntry | undefined {
    const q = nameish.trim().toLowerCase();
    const { sessions, layout } = this.state;
    return (
      sessions.find((s) => s.callsign.toLowerCase() === q) ||
      sessions.find((s) => s.name.toLowerCase() === q) ||
      sessions.find((s) => layout.names[s.key]?.toLowerCase() === q) ||
      sessions.find((s) => s.name.toLowerCase().includes(q) || q.includes(s.callsign.toLowerCase()))
    );
  }
}

export const canvasStore = new CanvasStore();

export function useCanvasState(): CanvasState {
  return useSyncExternalStore(canvasStore.subscribe, canvasStore.getState);
}

export function tileRect(layout: LayoutState, key: string): TileRect | undefined {
  return layout.tiles[key];
}
