// Multiplexed canvas WebSocket client: screen frames, roster pushes, layout
// ops, presence. Reconnects with backoff and resubscribes automatically.

import { canvasStore } from './store';
import type { Op, ScreenFrame, VoicePresence } from './types';

type ScreenListener = (frame: ScreenFrame) => void;
export type CursorEvent = { id: string; x: number; y: number };
export type VoiceEvent = { id: string; name: string; color: string; payload: VoicePresence };

class CanvasSocket {
  private ws: WebSocket | null = null;
  private wanted = false;
  private retryMs = 1000;
  private screenListeners = new Map<string, Set<ScreenListener>>();
  private cursorListeners = new Set<(e: CursorEvent) => void>();
  private voiceListeners = new Set<(e: VoiceEvent) => void>();
  private fitListeners = new Set<() => void>();
  private subCounts = new Map<string, number>();
  private lastCursorSent = 0;

  start() {
    this.wanted = true;
    this.connect();
  }

  stop() {
    this.wanted = false;
    this.ws?.close();
    this.ws = null;
    canvasStore.set({ connected: false });
  }

  private connect() {
    if (!this.wanted || this.ws) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/canvas`);
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = 1000;
      canvasStore.set({ connected: true });
      const name = localStorage.getItem('terminal:clientName');
      if (name) this.send({ type: 'hello', name });
      for (const key of this.subCounts.keys()) this.send({ type: 'sub', key });
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      switch (msg.type) {
        case 'init':
          canvasStore.set({
            you: msg.you as never,
            layout: msg.layout as never,
            sessions: msg.sessions as never,
            clients: msg.clients as never,
          });
          break;
        case 'sessions':
          canvasStore.set({ sessions: msg.sessions as never, layout: msg.layout as never });
          break;
        case 'op': {
          const op = msg.op as Op;
          canvasStore.applyOp(op);
          // Another client reset the layout — refit our camera to it too.
          if (op.kind === 'tiles' && op.fit) for (const cb of this.fitListeners) cb();
          break;
        }
        case 'presence':
          canvasStore.set({ clients: msg.clients as never });
          break;
        case 'screen': {
          const frame = msg as unknown as ScreenFrame;
          const set = this.screenListeners.get(frame.key);
          if (set) for (const cb of set) cb(frame);
          break;
        }
        case 'cursor': {
          const e = msg as unknown as CursorEvent;
          for (const cb of this.cursorListeners) cb(e);
          break;
        }
        case 'voice': {
          const e = msg as unknown as VoiceEvent;
          for (const cb of this.voiceListeners) cb(e);
          break;
        }
      }
    };

    const retry = () => {
      if (this.ws === ws) this.ws = null;
      canvasStore.set({ connected: false });
      if (this.wanted) {
        setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(10000, this.retryMs * 1.7);
      }
    };
    ws.onclose = retry;
    ws.onerror = () => ws.close();
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  subscribeScreen(key: string, cb: ScreenListener): () => void {
    let set = this.screenListeners.get(key);
    if (!set) { set = new Set(); this.screenListeners.set(key, set); }
    set.add(cb);
    const n = (this.subCounts.get(key) || 0) + 1;
    this.subCounts.set(key, n);
    if (n === 1) this.send({ type: 'sub', key });
    return () => {
      set!.delete(cb);
      const c = (this.subCounts.get(key) || 1) - 1;
      if (c <= 0) {
        this.subCounts.delete(key);
        this.screenListeners.delete(key);
        this.send({ type: 'unsub', key });
      } else {
        this.subCounts.set(key, c);
      }
    };
  }

  onCursor(cb: (e: CursorEvent) => void): () => void {
    this.cursorListeners.add(cb);
    return () => this.cursorListeners.delete(cb);
  }

  onVoice(cb: (e: VoiceEvent) => void): () => void {
    this.voiceListeners.add(cb);
    return () => this.voiceListeners.delete(cb);
  }

  onFit(cb: () => void): () => void {
    this.fitListeners.add(cb);
    return () => this.fitListeners.delete(cb);
  }

  sendOp(op: Op) {
    canvasStore.applyOp(op);
    this.send({ type: 'op', op });
  }

  sendCursor(x: number, y: number) {
    const now = performance.now();
    if (now - this.lastCursorSent < 40) return;
    this.lastCursorSent = now;
    this.send({ type: 'cursor', x: Math.round(x), y: Math.round(y) });
  }

  sendVoice(payload: VoicePresence) {
    this.send({ type: 'voice', payload });
  }
}

export const canvasSocket = new CanvasSocket();
