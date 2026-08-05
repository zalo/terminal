// The canvas homepage ("the bridge"): every live session on one pannable,
// zoomable surface — server-persisted layout, multiplayer cursors, preview
// iframes, and a voice operator that can read and drive any session.

import { useCallback, useEffect, useRef, useState } from 'react';
import CanvasStage, { type StageApi } from './CanvasStage';
import SessionTile from './SessionTile';
import PreviewTile from './PreviewTile';
import BrowserTile from './BrowserTile';
import Cursors from './Cursors';
import CanvasSidebar from './CanvasSidebar';
import VoiceBar from './VoiceBar';
import HomeTabs from '../HomeTabs';
import Terminal from '../Terminal';
import ControlBar from '../ControlBar';
import { canvasSocket } from '../../lib/canvas/ws';
import { canvasStore, useCanvasState } from '../../lib/canvas/store';
import { VoiceAgent, type VoiceStatus } from '../../lib/voice/voiceAgent';
import { sessionColor, STATUS_COLORS } from '../../lib/canvas/colors';
import { readClipboardText } from '../../lib/clipboard';
import type { RosterEntry, TileRect } from '../../lib/canvas/types';

interface ContextInfo { name: string; label: string; user: string | null }

interface CanvasViewProps {
  onSelectSession: (name: string, context?: string) => void;
  onSwitchView: (view: 'list' | 'canvas') => void;
}

interface TerminalRef {
  sendInput: (data: string) => void;
  paste: (text: string) => void;
  focus: () => void;
  copySelection: () => Promise<void>;
  hasSelection: () => boolean;
  enterSelectMode: () => void;
  scrollUp: () => void;
  scrollDown: () => void;
}

// Standard tile: 768px content width. The server normalizes unattached
// windows to 96x32 cells, so text renders at a uniform 768/96/0.6 ≈ 13.3px.
const TILE_W = 768;
const TILE_H = 554;
const GRID_GAP = 56;

function apiContext(context: string): string | undefined {
  return context === 'default' ? undefined : context;
}

// Reset layout: pick the grid closest to the viewport's shape, but punish
// empty cells hard — zero-waste grids (2x2 or 4x1 for four tiles) win unless
// their shape is wildly wrong for the screen. Sent as one shared `tiles`
// op, so every client sees the same layout.
function gridRects(n: number, viewportAspect: number, forceCols?: number): TileRect[] {
  if (n === 0) return [];
  let cols = 1;
  if (forceCols) {
    cols = Math.max(1, Math.min(n, forceCols));
  } else {
    let bestScore = Infinity;
    for (let c = 1; c <= n; c++) {
      const rows = Math.ceil(n / c);
      const gridAspect = (c * (TILE_W + GRID_GAP)) / (rows * (TILE_H + GRID_GAP));
      const waste = c * rows - n;
      const score = Math.abs(Math.log(gridAspect / viewportAspect)) + waste * 0.5;
      if (score < bestScore) { bestScore = score; cols = c; }
    }
  }
  return Array.from({ length: n }, (_, i) => ({
    x: 60 + (i % cols) * (TILE_W + GRID_GAP),
    y: 60 + Math.floor(i / cols) * (TILE_H + GRID_GAP),
    w: TILE_W,
    h: TILE_H,
    z: i + 1,
  }));
}

function fitInsets() {
  const desktop = window.innerWidth >= 768;
  return { left: desktop ? 316 : 12, top: 64, right: 16, bottom: 120 };
}

export default function CanvasView({ onSelectSession, onSwitchView }: CanvasViewProps) {
  const state = useCanvasState();
  const [contexts, setContexts] = useState<ContextInfo[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Selected tile (clicked): wheel over it scrolls / interacts instead of
  // zooming the canvas, and keystrokes forward to that terminal. Cleared by
  // clicking anything that isn't a tile.
  const [selectedTile, setSelectedTile] = useState<string | null>(null);
  const selectedRef = useRef(selectedTile);
  selectedRef.current = selectedTile;
  const stageApi = useRef<StageApi | null>(null);

  // Camera: fit everything once when the shared layout first arrives, and
  // again whenever another client hits "reset layout" (fit-hinted op).
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current || state.sessions.length === 0) return;
    didFit.current = true;
    const rects = state.sessions
      .map((s) => state.layout.tiles[s.key])
      .filter(Boolean) as TileRect[];
    const t = setTimeout(() => stageApi.current?.fitBounds(rects, fitInsets()), 100);
    return () => clearTimeout(t);
  }, [state.sessions, state.layout.tiles]);

  useEffect(() => canvasSocket.onFit(() => {
    const { sessions, layout } = canvasStore.getState();
    const rects = sessions.map((s) => layout.tiles[s.key]).filter(Boolean) as TileRect[];
    stageApi.current?.fitBounds(rects, fitInsets());
  }), []);

  // Voice UI state
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('off');
  const [userText, setUserText] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [voiceAction, setVoiceAction] = useState('');
  const userFinal = useRef(false);
  const agentRef = useRef<VoiceAgent | null>(null);

  // Focus overlay (interactive terminal)
  const focused = state.focusedKey
    ? state.sessions.find((s) => s.key === state.focusedKey) || null
    : null;
  const [termRef, setTermRef] = useState<TerminalRef | null>(null);
  const [inputVisible, setInputVisible] = useState(false);
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    canvasSocket.start();
    fetch('/api/contexts')
      .then((r) => r.json())
      .then((d) => setContexts(d?.contexts || []))
      .catch(() => setContexts([]));
    return () => {
      canvasSocket.stop();
      agentRef.current?.stop();
    };
  }, []);

  // Keep the voice agent's context fresh: sessions AND open windows.
  useEffect(() => {
    agentRef.current?.refreshContext();
  }, [state.sessions, state.layout.browsers, state.layout.previews]);

  // --- Keyboard forwarding to the selected tile -------------------------------
  // Keystrokes queue briefly so fast typing coalesces into few requests,
  // preserving order between literal text and special keys.
  const keyQueue = useRef<Array<{ t?: string; k?: string }>>([]);
  const keyFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const SPECIAL: Record<string, string> = {
      Enter: 'Enter', Backspace: 'BSpace', Tab: 'Tab', Escape: 'Escape',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'DC',
    };

    const flush = async () => {
      keyFlushTimer.current = null;
      const queue = keyQueue.current;
      keyQueue.current = [];
      const key = selectedRef.current;
      const session = key ? canvasStore.getState().sessions.find((s) => s.key === key) : null;
      if (!session || queue.length === 0) return;
      // Split into ordered segments of literal text vs special keys.
      const segments: Array<{ text?: string; keys?: string[] }> = [];
      for (const item of queue) {
        const last = segments[segments.length - 1];
        if (item.t !== undefined) {
          if (last?.text !== undefined) last.text += item.t;
          else segments.push({ text: item.t });
        } else if (item.k) {
          if (last?.keys) last.keys.push(item.k);
          else segments.push({ keys: [item.k] });
        }
      }
      for (const seg of segments) {
        try {
          await fetch(`/api/sessions/${encodeURIComponent(session.name)}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: apiContext(session.context), ...seg }),
          });
        } catch { /* connection hiccup — drop the segment */ }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const key = selectedRef.current;
      if (!key || key.startsWith('p:') || key.startsWith('b:')) return;
      if (canvasStore.getState().focusedKey) return;      // overlay owns the keyboard
      if (e.metaKey) return;                              // leave Cmd shortcuts alone
      const target = e.target as HTMLElement;
      if (target.closest?.('input, textarea, [contenteditable="true"]')) return;

      let item: { t?: string; k?: string } | null = null;
      if (e.ctrlKey && /^[a-zA-Z]$/.test(e.key)) item = { k: `C-${e.key.toLowerCase()}` };
      else if (e.altKey && /^[a-zA-Z]$/.test(e.key)) item = { k: `M-${e.key.toLowerCase()}` };
      else if (SPECIAL[e.key] && !e.ctrlKey && !e.altKey) item = { k: SPECIAL[e.key] };
      else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) item = { t: e.key };
      if (!item) return;

      e.preventDefault();
      keyQueue.current.push(item);
      if (!keyFlushTimer.current) keyFlushTimer.current = setTimeout(flush, 50);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (keyFlushTimer.current) clearTimeout(keyFlushTimer.current);
    };
  }, []);

  const zoomTo = useCallback((key: string) => {
    const rect = canvasStore.getState().layout.tiles[key];
    if (rect) stageApi.current?.zoomToRect(rect);
    setSidebarOpen(false);
  }, []);

  const openSession = useCallback((s: RosterEntry) => {
    onSelectSession(s.name, apiContext(s.context));
  }, [onSelectSession]);

  const createSession = useCallback(async (name: string, context?: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...(context ? { context } : {}) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        return j.error || 'Failed to create session';
      }
      return null;
    } catch {
      return 'Failed to create session';
    }
  }, []);

  const togglePreview = useCallback((s: RosterEntry) => {
    const { layout } = canvasStore.getState();
    if (layout.previews[s.key]) {
      canvasSocket.sendOp({ kind: 'preview:close', key: s.key });
    } else {
      const t = layout.tiles[s.key] || { x: 60, y: 60, w: TILE_W, h: TILE_H, z: 1 };
      canvasSocket.sendOp({
        kind: 'preview',
        key: s.key,
        rect: { x: t.x + t.w + GRID_GAP, y: t.y, w: 640, h: 480, z: canvasStore.maxZ() + 1 },
      });
    }
  }, []);

  // Open a "little browser" tile: next to a source tile (clicked link) or
  // centered in the current view (new-window button).
  const openBrowser = useCallback((url = '', nearKey?: string) => {
    const id = `b${Math.random().toString(36).slice(2, 10)}`;
    let x: number;
    let y: number;
    const near = nearKey ? canvasStore.getState().layout.tiles[nearKey] : undefined;
    if (near) {
      x = near.x + near.w + GRID_GAP;
      y = near.y;
    } else {
      const vp = stageApi.current?.getViewport() || { x: 0, y: 0, s: 0.5 };
      x = (window.innerWidth / 2 - vp.x) / vp.s - 360;
      y = (window.innerHeight / 2 - vp.y) / vp.s - 280;
    }
    canvasSocket.sendOp({
      kind: 'browser', id, url,
      rect: { x, y, w: 720, h: 560, z: canvasStore.maxZ() + 1 },
    });
    setSelectedTile(`b:${id}`);
  }, []);

  // "Reset layout": THIS client computes the grid from its own viewport and
  // shares it; other clients apply the same rects and refit their cameras.
  // The grid flows over EVERY window — each session tile, then its open
  // preview right beside it (dev/preview pairs stay together), then browser
  // windows. Voice can force a shape ("make it 2x2") via columns/rows.
  const arrangeGrid = useCallback((columns?: number, rows?: number) => {
    const { sessions, layout } = canvasStore.getState();
    const sorted = [...sessions].sort((a, b) => a.created.localeCompare(b.created));
    const slots: Array<{ bucket: 'tiles' | 'previews' | 'browsers'; key: string }> = [];
    for (const s of sorted) {
      slots.push({ bucket: 'tiles', key: s.key });
      if (layout.previews[s.key]) slots.push({ bucket: 'previews', key: s.key });
    }
    for (const id of Object.keys(layout.browsers)) slots.push({ bucket: 'browsers', key: id });
    if (slots.length === 0) return;

    const insets = fitInsets();
    const aspect = Math.max(
      0.3,
      (window.innerWidth - insets.left - insets.right) / Math.max(200, window.innerHeight - insets.top - insets.bottom),
    );
    let forceCols: number | undefined;
    if (columns && columns >= 1) forceCols = Math.min(slots.length, Math.round(columns));
    else if (rows && rows >= 1) forceCols = Math.ceil(slots.length / Math.min(slots.length, Math.round(rows)));

    const rects = gridRects(slots.length, aspect, forceCols);
    const op = {
      kind: 'tiles' as const,
      tiles: {} as Record<string, TileRect>,
      previews: {} as Record<string, TileRect>,
      browsers: {} as Record<string, TileRect>,
      fit: true,
    };
    slots.forEach((slot, i) => { op[slot.bucket][slot.key] = rects[i]; });
    canvasSocket.sendOp(op);
    stageApi.current?.fitBounds(rects, insets);
  }, []);

  // Resolve "casper", "casper's preview", a window id, or a URL fragment to
  // a positionable canvas item.
  const findItem = useCallback((qRaw: string): { bucket: 'tile' | 'preview' | 'browser'; key: string; rect: TileRect; label: string } | null => {
    const q = qRaw.toLowerCase().trim();
    const { layout } = canvasStore.getState();
    const wantsPreview = /\bpreview\b/.test(q);
    const stripped = q.replace(/\bpreview(\s+of)?\b/g, '').replace(/['’]s\b/g, '').trim();
    const sess = canvasStore.findSession(stripped || q);
    if (sess && wantsPreview && layout.previews[sess.key]) {
      return { bucket: 'preview', key: sess.key, rect: layout.previews[sess.key], label: `${sess.callsign}'s preview` };
    }
    if (sess && !wantsPreview && layout.tiles[sess.key]) {
      return { bucket: 'tile', key: sess.key, rect: layout.tiles[sess.key], label: sess.callsign };
    }
    const b = Object.entries(layout.browsers).find(([wid, br]) =>
      wid.toLowerCase() === q || (br.url && br.url.toLowerCase().includes(q)));
    if (b) return { bucket: 'browser', key: b[0], rect: b[1], label: b[1].url || b[0] };
    return null;
  }, []);

  // --- Voice host --------------------------------------------------------------

  const getAgent = useCallback((): VoiceAgent => {
    if (agentRef.current) return agentRef.current;

    const resolve = (nameish: unknown): RosterEntry => {
      const s = canvasStore.findSession(String(nameish ?? ''));
      if (!s) throw new Error(`No session matches "${nameish}". Call list_sessions to see what's running.`);
      return s;
    };

    const rosterSummary = () =>
      canvasStore.getState().sessions.map((s) => ({
        callsign: s.callsign,
        tmux_name: s.name,
        context: s.context,
        status: s.meta?.status || 'unknown',
        task: s.meta?.task || null,
        preview_url: s.meta?.preview_url || null,
      }));

    const agent = new VoiceAgent({
      buildInstructions: () => {
        const { sessions, clients } = canvasStore.getState();
        const roster = sessions.map((s) =>
          `- ${s.callsign} — tmux "${s.name}"${s.context !== 'default' ? ` (context: ${s.context})` : ''}: ` +
          `${s.meta?.status || 'no status'}${s.meta?.task ? ` — ${s.meta.task}` : ''}` +
          `${s.meta?.preview_url ? ` · has web preview${canvasStore.getState().layout.previews[s.key] ? ' (open on canvas)' : ''}` : ''}`).join('\n');
        const { layout } = canvasStore.getState();
        const windows = Object.entries(layout.browsers)
          .map(([wid, b]) => `- window "${wid}": ${b.url || '(blank)'}`).join('\n');
        return [
          'You are the voice operator of a live canvas of terminal sessions (tmux), most running AI coding agents.',
          'You can read any session, type into any session, create/kill sessions, move the camera, arrange tiles, open web previews, and restyle the canvas (night/day mode, accent color, background image).',
          'Sessions are addressed by short friendly callsigns. Users may also use the tmux name; both work.',
          '',
          'Style: you are spoken aloud — answer in one or two short conversational sentences. Summarize terminal output, never read it verbatim unless asked.',
          'Rules:',
          '- Before answering ANY question about what a session is doing or what happened in it, call read_session first.',
          '- To run a command, use type_text on the right session. For Ctrl-C or menu navigation use press_keys.',
          '- You inject PARAPHRASES of what the user says. Before typing: if it is ambiguous which session is meant, what exact wording/command is wanted, or the session\'s current state could change the meaning (an open menu, a waiting prompt, a half-typed command) — call read_session and ask the user one brief clarifying question first. Only type once you are confident. Never guess at destructive or irreversible wording.',
          '- kill_session and destructive commands (rm -rf, git push --force, DROP TABLE): state what you are about to do and get verbal confirmation first.',
          '- For a new background image: web_search for a direct https image URL (jpg/png/webp), then set_background.',
          '- arrange_grid arranges terminals, previews, AND browser windows together (a session\'s preview lands beside it). move_next_to pairs any two items explicitly.',
          '- When the user says goodbye, "go to sleep", or similar — call go_to_sleep.',
          '',
          `Current sessions:\n${roster || '(none running)'}`,
          windows ? `\nOpen browser windows (close_window / navigate_window by id or URL):\n${windows}` : '',
          clients.length > 1 ? `\nOther people on the canvas: ${clients.map((c) => c.name).join(', ')}.` : '',
        ].join('\n');
      },

      keyterms: () => {
        const { sessions } = canvasStore.getState();
        return [...new Set([...sessions.map((s) => s.callsign), ...sessions.map((s) => s.name), 'tmux'])];
      },

      execute: async (name, args) => {
        switch (name) {
          case 'list_sessions':
            return { sessions: rosterSummary() };
          case 'read_session': {
            const s = resolve(args.session);
            const lines = Math.min(2000, Math.max(0, Number(args.lines) || 0));
            const qs = new URLSearchParams();
            if (apiContext(s.context)) qs.set('context', s.context);
            if (lines) qs.set('lines', String(lines));
            const res = await fetch(`/api/sessions/${encodeURIComponent(s.name)}/screen?${qs}`);
            if (!res.ok) throw new Error('failed to read session');
            const j = await res.json();
            return { callsign: s.callsign, screen: j.text };
          }
          case 'type_text': {
            const s = resolve(args.session);
            const res = await fetch(`/api/sessions/${encodeURIComponent(s.name)}/keys`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                context: apiContext(s.context),
                text: String(args.text ?? ''),
                enter: args.press_enter !== false,
              }),
            });
            if (!res.ok) throw new Error('failed to type into session');
            return { ok: true, callsign: s.callsign };
          }
          case 'press_keys': {
            const s = resolve(args.session);
            const res = await fetch(`/api/sessions/${encodeURIComponent(s.name)}/keys`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ context: apiContext(s.context), keys: args.keys }),
            });
            if (!res.ok) throw new Error('failed to send keys');
            return { ok: true };
          }
          case 'create_session': {
            const newName = String(args.name || `session-${Math.random().toString(36).slice(2, 6)}`)
              .replace(/[^a-zA-Z0-9-_]/g, '-');
            const err = await createSession(newName, typeof args.context === 'string' ? args.context : undefined);
            if (err) throw new Error(err);
            // Wait for the roster to pick it up so we can report the callsign.
            for (let i = 0; i < 8; i++) {
              await new Promise((r) => setTimeout(r, 500));
              const found = canvasStore.getState().sessions.find((s) => s.name === newName);
              if (found) { zoomTo(found.key); return { created: newName, callsign: found.callsign }; }
            }
            return { created: newName };
          }
          case 'kill_session': {
            if (args.confirmed !== true) {
              return { error: 'Not confirmed. Ask the user to verbally confirm, then call again with confirmed=true.' };
            }
            const s = resolve(args.session);
            const qs = apiContext(s.context) ? `?context=${encodeURIComponent(s.context)}` : '';
            const res = await fetch(`/api/sessions/${encodeURIComponent(s.name)}${qs}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('failed to kill session');
            return { killed: s.callsign };
          }
          case 'focus_session': {
            const s = resolve(args.session);
            zoomTo(s.key);
            return { focused: s.callsign };
          }
          case 'arrange_grid': {
            const cols = typeof args.columns === 'number' ? args.columns : undefined;
            const rws = typeof args.rows === 'number' ? args.rows : undefined;
            arrangeGrid(cols, rws);
            const n = canvasStore.getState().sessions.length;
            const c = cols || (rws ? Math.ceil(n / rws) : undefined);
            return { ok: true, arranged: c ? `${c} column(s) x ${Math.ceil(n / c)} row(s)` : 'auto grid', tiles: n };
          }
          case 'list_windows': {
            const { layout, sessions } = canvasStore.getState();
            return {
              browser_windows: Object.entries(layout.browsers).map(([wid, b]) => ({ id: wid, url: b.url })),
              preview_windows: sessions.filter((s) => layout.previews[s.key])
                .map((s) => ({ callsign: s.callsign, url: s.meta?.preview_url })),
            };
          }
          case 'close_window': {
            const q = String(args.window || '').toLowerCase().trim();
            const { layout, sessions } = canvasStore.getState();
            const browserHit = Object.entries(layout.browsers).find(([wid, b]) =>
              wid.toLowerCase() === q || (b.url && b.url.toLowerCase().includes(q)));
            if (browserHit) {
              canvasSocket.sendOp({ kind: 'browser:close', id: browserHit[0] });
              return { closed: browserHit[1].url || browserHit[0] };
            }
            const previewHit = sessions.find((s) => layout.previews[s.key] &&
              (s.callsign.toLowerCase() === q || s.name.toLowerCase() === q ||
               (s.meta?.preview_url || '').toLowerCase().includes(q)));
            if (previewHit) {
              canvasSocket.sendOp({ kind: 'preview:close', key: previewHit.key });
              return { closed: `preview of ${previewHit.callsign}` };
            }
            return { error: `No open window matches "${args.window}". Call list_windows to see them.` };
          }
          case 'navigate_window': {
            const q = String(args.window || '').toLowerCase().trim();
            const url = String(args.url || '');
            if (!/^https?:\/\//.test(url)) return { error: 'Need a full http(s) URL.' };
            const { layout } = canvasStore.getState();
            const hit = Object.entries(layout.browsers).find(([wid, b]) =>
              wid.toLowerCase() === q || (b.url && b.url.toLowerCase().includes(q)));
            if (!hit) return { error: `No browser window matches "${args.window}". Call list_windows.` };
            canvasSocket.sendOp({ kind: 'browser', id: hit[0], url });
            return { ok: true, window: hit[0], now: url };
          }
          case 'move_next_to': {
            const item = findItem(String(args.item || ''));
            if (!item) return { error: `Can't find "${args.item}" on the canvas. Call list_sessions or list_windows.` };
            const target = findItem(String(args.target || ''));
            if (!target) return { error: `Can't find "${args.target}" on the canvas.` };
            if (item.bucket === target.bucket && item.key === target.key) {
              return { error: 'Item and target are the same thing.' };
            }
            const rect: TileRect = {
              x: target.rect.x + target.rect.w + GRID_GAP,
              y: target.rect.y,
              w: item.rect.w,
              h: item.rect.h,
              z: canvasStore.maxZ() + 1,
            };
            if (item.bucket === 'tile') canvasSocket.sendOp({ kind: 'tile', key: item.key, rect });
            else if (item.bucket === 'preview') canvasSocket.sendOp({ kind: 'preview', key: item.key, rect });
            else canvasSocket.sendOp({ kind: 'browser', id: item.key, rect });
            // Frame the new pair.
            stageApi.current?.fitBounds([target.rect, rect], fitInsets());
            return { ok: true, moved: item.label, beside: target.label };
          }
          case 'open_preview': {
            const s = resolve(args.session);
            if (!s.meta?.preview_url) {
              return { error: `${s.callsign} has no preview URL. A dev server must register one with tm-meta preview.` };
            }
            if (!canvasStore.getState().layout.previews[s.key]) togglePreview(s);
            return { opened: s.meta.preview_url };
          }
          case 'close_preview': {
            const s = resolve(args.session);
            canvasSocket.sendOp({ kind: 'preview:close', key: s.key });
            return { ok: true };
          }
          case 'set_theme': {
            const theme: Record<string, unknown> = {};
            if (args.mode === 'night' || args.mode === 'day') theme.mode = args.mode;
            if (typeof args.accent === 'string') theme.accent = args.accent;
            canvasSocket.sendOp({ kind: 'theme', theme });
            return { ok: true, theme };
          }
          case 'set_background': {
            if (args.clear === true) {
              canvasSocket.sendOp({ kind: 'theme', theme: { backgroundUrl: null } });
              return { cleared: true };
            }
            const url = String(args.url || '');
            if (!/^https:\/\//.test(url)) return { error: 'Need a direct https image URL. Use web_search to find one.' };
            canvasSocket.sendOp({ kind: 'theme', theme: { backgroundUrl: url } });
            return { ok: true };
          }
          case 'open_url': {
            const url = String(args.url || '');
            if (!/^https?:\/\//.test(url)) return { error: 'Need a full http(s) URL.' };
            openBrowser(url);
            return { opened: url };
          }
          case 'go_to_sleep':
            return { ok: true };
          default:
            return { error: `unknown tool ${name}` };
        }
      },

      onStatus: (s) => {
        setVoiceStatus(s);
        canvasSocket.sendVoice({ state: s });
        if (s === 'off') { setUserText(''); setAssistantText(''); setVoiceAction(''); }
      },
      onTranscript: (role, text, final) => {
        if (role === 'user') {
          if (userFinal.current && !final) { setAssistantText(''); setVoiceAction(''); }
          userFinal.current = final;
          setUserText(text);
          if (final && text) canvasSocket.sendVoice({ state: 'speaking', transcript: text.slice(0, 120) });
        } else {
          setAssistantText(text);
        }
      },
      onAction: (desc) => {
        setVoiceAction(desc);
        canvasSocket.sendVoice({ state: 'acting', action: desc });
      },
    });
    agentRef.current = agent;
    return agent;
  }, [createSession, zoomTo, arrangeGrid, togglePreview, openBrowser]);

  // --- Focus overlay handlers -------------------------------------------------------

  const closeFocus = useCallback(() => {
    canvasStore.set({ focusedKey: null });
    setTermRef(null);
    setInputVisible(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canvasStore.getState().focusedKey) closeFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeFocus]);

  const handlePaste = async () => {
    if (!termRef) return;
    const text = await readClipboardText();
    if (text) { termRef.paste(text); termRef.focus(); }
    else { setInputVisible(true); setTimeout(() => textareaRef.current?.focus(), 50); }
  };

  // --- Render -------------------------------------------------------------------------

  const theme = state.layout.theme || {};
  const isDay = theme.mode === 'day';
  const multiContext = contexts.length > 0;
  const focusedStatus = focused?.meta?.status;

  return (
    <div
      className={`canvas-root h-dvh relative overflow-hidden ${isDay ? 'canvas-day' : ''}`}
      style={theme.accent ? ({ '--cv-accent': theme.accent } as React.CSSProperties) : undefined}
      onPointerDownCapture={(e) => {
        if (!(e.target as Element).closest?.('.tile')) setSelectedTile(null);
      }}
    >
      {/* Background: optional image under a tinted veil, plus the dot grid */}
      {theme.backgroundUrl && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${JSON.stringify(theme.backgroundUrl)})` }}
        />
      )}
      <div className={`absolute inset-0 canvas-veil ${theme.backgroundUrl ? 'canvas-veil-img' : ''}`} />
      <div className="absolute inset-0 canvas-dots" />

      <CanvasStage onApi={(api) => { stageApi.current = api; }}>
        {state.sessions.map((s) => {
          const rect = state.layout.tiles[s.key];
          if (!rect) return null;
          return (
            <SessionTile
              key={s.key}
              session={s}
              rect={rect}
              multiContext={multiContext}
              onFocus={(key) => canvasStore.set({ focusedKey: key })}
              onOpen={openSession}
              onTogglePreview={togglePreview}
              previewOpen={Boolean(state.layout.previews[s.key])}
              selected={selectedTile === s.key}
              onSelect={setSelectedTile}
              onOpenLink={openBrowser}
            />
          );
        })}
        {state.sessions.map((s) => {
          const rect = state.layout.previews[s.key];
          if (!rect || !s.meta?.preview_url) return null;
          return (
            <PreviewTile
              key={`p:${s.key}`}
              session={s}
              rect={rect}
              selected={selectedTile === `p:${s.key}`}
              onSelect={setSelectedTile}
            />
          );
        })}
        {Object.entries(state.layout.browsers).map(([id, r]) => (
          <BrowserTile
            key={id}
            id={id}
            rect={r}
            selected={selectedTile === `b:${id}`}
            onSelect={setSelectedTile}
          />
        ))}
        <Cursors />
      </CanvasStage>

      {/* Top bar */}
      <div className="absolute top-0 inset-x-0 z-40 flex items-center gap-2 px-3 pt-[max(10px,env(safe-area-inset-top))] pointer-events-none">
        <div className="pointer-events-auto">
          <HomeTabs current="canvas" onSwitch={onSwitchView} glass />
        </div>
        <span className="flex-1" />
        <button
          className="pointer-events-auto glass w-10 h-10 rounded-full flex items-center justify-center"
          style={{ color: 'var(--cv-accent)' }}
          title={isDay ? 'Switch to dark mode (for everyone)' : 'Switch to light mode (for everyone)'}
          aria-label={isDay ? 'Switch to dark mode' : 'Switch to light mode'}
          onClick={() => canvasSocket.sendOp({ kind: 'theme', theme: { mode: isDay ? 'night' : 'day' } })}
        >
          {isDay ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          )}
        </button>
        <div className="pointer-events-auto glass rounded-full flex items-center gap-2 px-3 py-1.5">
          <span
            className={`status-dot ${state.connected ? 'status-connected' : 'status-connecting'}`}
            style={{ width: 8, height: 8 }}
            title={state.connected ? 'canvas connected' : 'reconnecting'}
          />
          {state.clients.map((c) => (
            <span
              key={c.id}
              title={c.id === state.you?.id ? `${c.name} (you)` : c.name}
              className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-mono lowercase"
              style={{
                background: `color-mix(in srgb, ${c.color} 25%, transparent)`,
                color: c.color,
                border: `1px solid ${c.color}`,
              }}
            >
              {c.name.slice(0, 2)}
            </span>
          ))}
          <button
            className="tile-btn" title="New browser window" onClick={() => openBrowser()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <circle cx="11" cy="11" r="8" /><path d="M3 11h16M11 3c2.2 2.4 3.4 5.2 3.4 8s-1.2 5.6-3.4 8c-2.2-2.4-3.4-5.2-3.4-8s1.2-5.6 3.4-8z" />
              <path d="M19 16v6M16 19h6" strokeWidth="2.4" />
            </svg>
          </button>
          <button
            className="tile-btn" title="Reset layout (auto-arrange & fit)" onClick={() => arrangeGrid()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button className="tile-btn md:hidden" title="Sessions" onClick={() => setSidebarOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
          </button>
        </div>
      </div>

      {/* Sidebar: fixed on desktop, sheet on mobile */}
      {/* pointer-events-none: the wrapper spans to the voice bar even when
          the sidebar is short — it must not block canvas drags beneath it */}
      <div className="absolute left-3 top-16 bottom-24 z-30 hidden md:block pointer-events-none">
        <CanvasSidebar
          sessions={state.sessions}
          contexts={contexts}
          onZoom={zoomTo}
          onOpen={openSession}
          onCreate={createSession}
          onNewBrowser={() => openBrowser()}
        />
      </div>
      {sidebarOpen && (
        <div className="absolute inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <div className="absolute left-2 top-2 bottom-2">
            <CanvasSidebar
              sessions={state.sessions}
              contexts={contexts}
              onZoom={zoomTo}
              onOpen={openSession}
              onCreate={createSession}
              onNewBrowser={() => { openBrowser(); setSidebarOpen(false); }}
              onDismiss={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      <VoiceBar
        status={voiceStatus}
        userText={userText}
        assistantText={assistantText}
        action={voiceAction}
        onWake={() => { void getAgent().start(); }}
        onSleep={() => agentRef.current?.stop()}
      />

      {/* Focus overlay: the real interactive terminal, attached */}
      {focused && (
        <div
          className="absolute inset-0 z-[60] flex items-center justify-center p-0 sm:p-6 bg-black/55 backdrop-blur-[6px]"
          onClick={(e) => { if (e.target === e.currentTarget) closeFocus(); }}
        >
          <div className="glass w-full h-full sm:max-w-5xl flex flex-col sm:rounded-2xl rounded-none overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0 border-b" style={{ borderColor: 'var(--cv-edge)' }}>
              <span
                className={`w-2 h-2 rounded-full ${focusedStatus === 'working' ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: focusedStatus ? STATUS_COLORS[focusedStatus] : '#565b7a' }}
              />
              <span className="font-mono text-sm font-semibold lowercase" style={{ color: sessionColor(focused.key) }}>
                {focused.callsign}
              </span>
              <span className="text-xs truncate" style={{ color: 'var(--cv-ink-dim)' }}>{focused.name}</span>
              <span className="flex-1" />
              <button className="tile-btn" title="Open full view" onClick={() => openSession(focused)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M7 17L17 7M9 7h8v8" />
                </svg>
              </button>
              <button className="tile-btn" title="Close (Esc)" onClick={closeFocus}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <ControlBar
              onKey={(k) => { termRef?.sendInput(k); termRef?.focus(); }}
              onCopy={async () => {
                if (!termRef) return;
                if (termRef.hasSelection()) await termRef.copySelection();
                else termRef.enterSelectMode();
              }}
              onPaste={handlePaste}
              onToggleInput={() => {
                setInputVisible((p) => {
                  if (!p) setTimeout(() => textareaRef.current?.focus(), 50);
                  return !p;
                });
              }}
              inputVisible={inputVisible}
            />
            {inputVisible && (
              <div className="flex items-stretch gap-2 px-2 py-2 flex-shrink-0 border-b" style={{ borderColor: 'var(--cv-edge)' }}>
                <textarea
                  ref={textareaRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (termRef && inputText) { termRef.sendInput(inputText); setInputText(''); termRef.focus(); }
                    }
                  }}
                  placeholder="Type or dictate text..."
                  rows={2}
                  className="flex-1 rounded-lg px-3 py-2 text-sm resize-none outline-none"
                  style={{ background: 'color-mix(in srgb, var(--cv-bg) 65%, transparent)', border: '1px solid var(--cv-edge)', color: 'var(--cv-ink)' }}
                />
                <button
                  onClick={() => { if (termRef && inputText) { termRef.sendInput(inputText); setInputText(''); termRef.focus(); } }}
                  disabled={!inputText}
                  className="px-4 rounded-lg font-medium text-sm disabled:opacity-40"
                  style={{ background: 'var(--cv-accent)', color: 'var(--cv-bg)' }}
                >
                  Send
                </button>
              </div>
            )}
            <div className="flex-1 min-h-0">
              <Terminal
                sessionName={focused.name}
                context={apiContext(focused.context)}
                onReady={setTermRef}
                onConnectionChange={() => {}}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
