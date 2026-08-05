// Canvas mode: server-side state for the alternate "bridge" homepage.
//
// Responsibilities:
//  - Persisted canvas layout (tile/preview rects, friendly callsigns) shared
//    by every client, stored at config/canvas-layout.json (same pattern as
//    push.ts).
//  - Friendly-name ("callsign") assignment per (context, session) so voice
//    commands can address sessions concisely.
//  - Live screen streaming for tiles: capture-pane polling per subscribed
//    session, fanned out to all subscribers. Tiles never attach a tmux
//    client, so they can't disturb the shared window size.
//  - /ws/canvas: one multiplexed WebSocket per client for screen frames,
//    session roster pushes, layout ops, and multiplayer presence (cursors,
//    voice activity).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  type Context,
  listSessions as ctxListSessions,
  readMeta as ctxReadMeta,
  runTmuxAsync,
} from './contexts';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAYOUT_FILE = path.join(REPO_ROOT, 'config', 'canvas-layout.json');

// --- Types -------------------------------------------------------------------

export interface TileRect { x: number; y: number; w: number; h: number; z: number }

interface CanvasTheme {
  mode?: 'night' | 'day';
  accent?: string;
  backgroundUrl?: string | null;
  // Auto-arrange: tiles pack into a minimal grid computed client-side.
  // Turned off (persisted) the moment someone drags a tile manually.
  autoArrange?: boolean;
}

export interface BrowserRect extends TileRect { url: string; proxy?: boolean }

interface CanvasLayout {
  tiles: Record<string, TileRect>;      // key = "<context>:<session>"
  previews: Record<string, TileRect>;   // open preview iframes, same key
  browsers: Record<string, BrowserRect>; // free-floating "little browser" tiles
  names: Record<string, string>;        // key -> callsign
  theme: CanvasTheme;
  nextZ: number;
}

interface RosterEntry {
  key: string;
  name: string;
  context: string;
  callsign: string;
  created: string;
  lastAccess: string;
  meta?: Record<string, unknown>;
}

interface ClientInfo {
  id: string;
  name: string;
  color: string;
  ws: WebSocket;
  subs: Set<string>;
  alive: boolean;
}

// --- Friendly callsigns --------------------------------------------------------

const CALLSIGNS = [
  'casper', 'olive', 'mabel', 'otis', 'hazel', 'felix', 'iris', 'milo',
  'ruby', 'jasper', 'wren', 'theo', 'pearl', 'hugo', 'sage', 'remy',
  'cleo', 'arlo', 'fern', 'louie', 'poppy', 'ezra', 'maeve', 'nico',
  'opal', 'silas', 'ivy', 'bruno', 'gus', 'lila', 'moss', 'nell',
  'oscar', 'piper', 'quinn', 'rosa', 'sunny', 'tilly', 'uma', 'vera',
  'wilbur', 'yara', 'ziggy', 'ada', 'basil', 'coco', 'echo', 'flora',
  'goldie', 'hank', 'inez', 'juno', 'kit', 'lars', 'mona', 'ned',
  'orla', 'pip', 'rex', 'stella', 'toby', 'ursa', 'vito', 'willa',
  'yuki', 'zora', 'amos', 'bea', 'cyrus', 'dahlia', 'faye', 'gino',
  'hattie', 'ida', 'jules', 'kai', 'lena', 'moe', 'nova', 'ollie',
];

const CLIENT_COLORS = [
  '#4fd1c5', '#f6ad55', '#b794f4', '#68d391', '#fc8181',
  '#63b3ed', '#f687b3', '#fbd38d', '#81e6d9', '#d6bcfa',
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// --- Module state --------------------------------------------------------------

let contextsList: Context[] = [];
let layout: CanvasLayout = { tiles: {}, previews: {}, browsers: {}, names: {}, theme: {}, nextZ: 1 };
const clients = new Map<WebSocket, ClientInfo>();
let lastRoster: RosterEntry[] = [];
let rosterTimer: ReturnType<typeof setInterval> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const TILE_W = 768;
const TILE_H = 554;
const GRID_GAP = 56;

// One capture stream per subscribed session key.
interface Stream {
  timer: ReturnType<typeof setInterval>;
  last: string;          // last payload signature, to skip unchanged frames
  busy: boolean;
}
const streams = new Map<string, Stream>();

// --- Layout persistence ----------------------------------------------------------

function loadLayout(): CanvasLayout {
  try {
    const parsed = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf-8'));
    return {
      tiles: parsed.tiles || {},
      previews: parsed.previews || {},
      browsers: parsed.browsers || {},
      names: parsed.names || {},
      theme: parsed.theme || {},
      nextZ: typeof parsed.nextZ === 'number' ? parsed.nextZ : 1,
    };
  } catch {
    return { tiles: {}, previews: {}, browsers: {}, names: {}, theme: {}, nextZ: 1 };
  }
}

function saveLayoutSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true });
      fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error('[canvas] failed to save layout:', (e as Error).message);
    }
  }, 500);
}

// --- Callsign + placement ---------------------------------------------------------

function ensureCallsign(key: string): string {
  const existing = layout.names[key];
  if (existing) return existing;
  const used = new Set(Object.values(layout.names));
  let idx = hashStr(key) % CALLSIGNS.length;
  for (let i = 0; i < CALLSIGNS.length; i++) {
    const candidate = CALLSIGNS[(idx + i) % CALLSIGNS.length];
    if (!used.has(candidate)) {
      layout.names[key] = candidate;
      saveLayoutSoon();
      return candidate;
    }
  }
  // Every callsign taken — suffix a number.
  const fallback = `${CALLSIGNS[idx]}-${Object.keys(layout.names).length}`;
  layout.names[key] = fallback;
  saveLayoutSoon();
  return fallback;
}

function collides(r: TileRect, others: TileRect[]): boolean {
  return others.some((o) =>
    r.x < o.x + o.w + GRID_GAP / 2 && o.x < r.x + r.w + GRID_GAP / 2 &&
    r.y < o.y + o.h + GRID_GAP / 2 && o.y < r.y + r.h + GRID_GAP / 2);
}

function ensureTile(key: string): TileRect {
  const existing = layout.tiles[key];
  if (existing) return existing;
  const others = [...Object.values(layout.tiles), ...Object.values(layout.previews)];
  for (let i = 0; i < 400; i++) {
    const rect: TileRect = {
      x: 60 + (i % 4) * (TILE_W + GRID_GAP),
      y: 60 + Math.floor(i / 4) * (TILE_H + GRID_GAP),
      w: TILE_W,
      h: TILE_H,
      z: layout.nextZ++,
    };
    if (!collides(rect, others)) {
      layout.tiles[key] = rect;
      saveLayoutSoon();
      return rect;
    }
  }
  const rect: TileRect = { x: 60, y: 60, w: TILE_W, h: TILE_H, z: layout.nextZ++ };
  layout.tiles[key] = rect;
  saveLayoutSoon();
  return rect;
}

// --- Roster (session list) ---------------------------------------------------------

function findContext(name: string): Context | undefined {
  return contextsList.find((c) => c.name === name);
}

export function keyFor(context: string, session: string): string {
  return `${context}:${session}`;
}

function collectRoster(): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const ctx of contextsList) {
    for (const row of ctxListSessions(ctx)) {
      const key = keyFor(ctx.name, row.name);
      ensureTile(key);
      out.push({
        key,
        name: row.name,
        context: ctx.name,
        callsign: ensureCallsign(key),
        created: row.created.toISOString(),
        lastAccess: row.lastAccess.toISOString(),
        meta: ctxReadMeta(ctx, row.name),
      });
    }
  }
  return out;
}

function pollRoster() {
  if (clients.size === 0) return;
  try {
    const roster = collectRoster();
    const sig = JSON.stringify(roster);
    if (sig !== JSON.stringify(lastRoster)) {
      lastRoster = roster;
      broadcast({ type: 'sessions', sessions: roster, layout: publicLayout() });
    }
  } catch (e) {
    console.error('[canvas] roster poll failed:', (e as Error).message);
  }
}

export function currentRoster(): RosterEntry[] {
  return lastRoster;
}

function publicLayout() {
  return {
    tiles: layout.tiles,
    previews: layout.previews,
    browsers: layout.browsers,
    names: layout.names,
    theme: layout.theme,
  };
}

// --- Screen capture streaming -------------------------------------------------------

const CAPTURE_INTERVAL_MS = 700;

// Canvas-standard window size: sessions with no attached clients are
// normalized to this grid so every tile renders at the same text size
// (~768px-wide tiles at a uniform font). Deliberately tall — the tile is a
// bottom-anchored viewport onto the window, so a selected tile has ~5
// screens of live content to wheel through. The moment a real client
// attaches, the window reverts to automatic sizing (resize-window -A) — the
// canvas never fights an interactive viewer.
const CANVAS_COLS = 96;
const CANVAS_ROWS = 160;
const normalizedKeys = new Set<string>();

async function captureOnce(key: string) {
  const stream = streams.get(key);
  if (!stream || stream.busy) return;
  stream.busy = true;
  try {
    const colon = key.indexOf(':');
    const ctxName = key.slice(0, colon);
    const session = key.slice(colon + 1);
    const ctx = findContext(ctxName);
    if (!ctx) return;
    // "=name:" = exact session match, active window/pane.
    const target = `=${session}:`;
    const [cap, info] = await Promise.all([
      runTmuxAsync(ctx, ['capture-pane', '-p', '-e', '-t', target]),
      runTmuxAsync(ctx, [
        'display-message', '-p', '-t', target,
        '#{window_width}|#{window_height}|#{cursor_x}|#{cursor_y}|#{alternate_on}|#{session_attached}',
      ]),
    ]);
    if (!cap.ok || !info.ok) return;
    const [w, h, cx, cy, alt, attached] = info.stdout.trim().split('|').map((v) => parseInt(v, 10));

    if (!attached) {
      // Nobody is viewing this session interactively — normalize it.
      if (w !== CANVAS_COLS || h !== CANVAS_ROWS) {
        await runTmuxAsync(ctx, ['resize-window', '-x', String(CANVAS_COLS), '-y', String(CANVAS_ROWS), '-t', target]);
        normalizedKeys.add(key);
        stream.last = '';
        return; // capture the freshly-sized window next tick
      }
      normalizedKeys.add(key);
    } else if (normalizedKeys.has(key)) {
      // A client attached to a window we manually sized — hand control back.
      // NOT resize-window -A (that just sets another manual size); unsetting
      // the window-size option restores automatic "latest client" tracking.
      normalizedKeys.delete(key);
      await runTmuxAsync(ctx, ['set-option', '-w', '-t', target, '-u', 'window-size']);
      stream.last = '';
      return;
    }
    let lines = cap.stdout.replace(/\n$/, '').split('\n');
    // Trim trailing blank lines; the client bottom-fits against `rows`.
    let end = lines.length;
    while (end > 1 && lines[end - 1].trim() === '') end--;
    lines = lines.slice(0, end);
    const sig = `${w}x${h}:${cx},${cy}:${lines.join('\n')}`;
    if (sig === stream.last) return;
    stream.last = sig;
    const msg = JSON.stringify({
      type: 'screen', key, lines, cols: w || 80, rows: h || 24,
      cx: cx || 0, cy: cy || 0, alt: alt === 1,
    });
    for (const c of clients.values()) {
      if (c.subs.has(key) && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    }
  } finally {
    if (streams.has(key)) streams.get(key)!.busy = false;
  }
}

function ensureStream(key: string) {
  if (streams.has(key)) return;
  const stream: Stream = {
    timer: setInterval(() => captureOnce(key), CAPTURE_INTERVAL_MS),
    last: '',
    busy: false,
  };
  streams.set(key, stream);
  captureOnce(key);
}

// Immediate re-capture after input injection (voice tools, canvas keyboard
// forwarding) so the keystroke echo doesn't wait out the poll interval.
// Second capture shortly after picks up the app's slower reaction.
export function pokeStream(contextName: string, session: string) {
  const key = keyFor(contextName, session);
  const nudge = () => {
    const s = streams.get(key);
    if (s) { s.last = ''; captureOnce(key); }
  };
  nudge();
  setTimeout(nudge, 160);
}

function maybeStopStream(key: string) {
  for (const c of clients.values()) if (c.subs.has(key)) return;
  const stream = streams.get(key);
  if (stream) {
    clearInterval(stream.timer);
    streams.delete(key);
  }
}

// --- Broadcast helpers -----------------------------------------------------------------

function broadcast(msg: unknown, except?: WebSocket) {
  const data = JSON.stringify(msg);
  for (const c of clients.values()) {
    if (c.ws !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

function presenceList() {
  return [...clients.values()].map((c) => ({ id: c.id, name: c.name, color: c.color }));
}

// --- Layout ops -------------------------------------------------------------------------

interface Op {
  kind: 'tile' | 'preview' | 'preview:close' | 'tiles' | 'theme' | 'browser' | 'browser:close';
  key?: string;
  rect?: Partial<TileRect>;
  tiles?: Record<string, TileRect>;
  // Bulk arrange may also reposition open previews / browser windows
  // (rects only — existing entries only, so it can't conjure windows).
  previews?: Record<string, TileRect>;
  browsers?: Record<string, TileRect>;
  theme?: CanvasTheme;
  id?: string;      // browser tile id
  url?: string;     // browser tile url ('' = blank, awaiting input)
  proxy?: boolean;  // browser tile: load through /api/proxy
  fit?: boolean;    // tiles op: receiving clients should refit their camera
}

const BROWSER_ID_RE = /^[a-z0-9-]{1,32}$/;

function validBrowserUrl(u: unknown): u is string {
  return typeof u === 'string' && (u === '' || (/^https?:\/\//.test(u) && u.length < 2000));
}

// Theme values are shared with every client and persisted — validate hard.
function sanitizeTheme(t: CanvasTheme): CanvasTheme {
  const out: CanvasTheme = {};
  if (t.mode === 'night' || t.mode === 'day') out.mode = t.mode;
  if (typeof t.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(t.accent)) out.accent = t.accent;
  if (typeof t.autoArrange === 'boolean') out.autoArrange = t.autoArrange;
  if (t.backgroundUrl === null) out.backgroundUrl = null;
  else if (
    typeof t.backgroundUrl === 'string' &&
    t.backgroundUrl.length < 2000 &&
    /^https:\/\//.test(t.backgroundUrl)
  ) out.backgroundUrl = t.backgroundUrl;
  return out;
}

function clampRect(r: Partial<TileRect>, prev?: TileRect): TileRect {
  const base = prev || { x: 60, y: 60, w: TILE_W, h: TILE_H, z: layout.nextZ };
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    x: Math.max(-100000, Math.min(100000, num(r.x, base.x))),
    y: Math.max(-100000, Math.min(100000, num(r.y, base.y))),
    w: Math.max(160, Math.min(4000, num(r.w, base.w))),
    h: Math.max(120, Math.min(4000, num(r.h, base.h))),
    z: num(r.z, base.z),
  };
}

function applyOp(op: Op): boolean {
  if (op.kind === 'tile' && op.key && op.rect) {
    layout.tiles[op.key] = clampRect(op.rect, layout.tiles[op.key]);
    if (layout.tiles[op.key].z >= layout.nextZ) layout.nextZ = layout.tiles[op.key].z + 1;
  } else if (op.kind === 'preview' && op.key && op.rect) {
    layout.previews[op.key] = clampRect(op.rect, layout.previews[op.key]);
    if (layout.previews[op.key].z >= layout.nextZ) layout.nextZ = layout.previews[op.key].z + 1;
  } else if (op.kind === 'preview:close' && op.key) {
    delete layout.previews[op.key];
  } else if (op.kind === 'tiles' && (op.tiles || op.previews || op.browsers)) {
    for (const [key, rect] of Object.entries(op.tiles || {})) {
      layout.tiles[key] = clampRect(rect, layout.tiles[key]);
    }
    for (const [key, rect] of Object.entries(op.previews || {})) {
      if (layout.previews[key]) layout.previews[key] = clampRect(rect, layout.previews[key]);
    }
    for (const [id, rect] of Object.entries(op.browsers || {})) {
      const prev = layout.browsers[id];
      if (prev) layout.browsers[id] = { ...prev, ...clampRect(rect, prev) };
    }
  } else if (op.kind === 'theme' && op.theme) {
    const clean = sanitizeTheme(op.theme);
    op.theme = clean;
    layout.theme = { ...layout.theme, ...clean };
    if (clean.backgroundUrl === null) delete layout.theme.backgroundUrl;
  } else if (op.kind === 'browser' && op.id && BROWSER_ID_RE.test(op.id)) {
    const prev = layout.browsers[op.id];
    const url = validBrowserUrl(op.url) ? op.url : prev?.url;
    if (url === undefined) return false;
    if (!prev && Object.keys(layout.browsers).length >= 40) return false;
    const rect = clampRect(op.rect || prev || {}, prev);
    if (rect.z >= layout.nextZ) layout.nextZ = rect.z + 1;
    const proxy = typeof op.proxy === 'boolean' ? op.proxy : prev?.proxy;
    layout.browsers[op.id] = { ...rect, url, ...(proxy !== undefined ? { proxy } : {}) };
  } else if (op.kind === 'browser:close' && op.id) {
    delete layout.browsers[op.id];
  } else {
    return false;
  }
  saveLayoutSoon();
  return true;
}

// Programmatic ops (used by voice REST endpoints and roster placement).
export function serverApplyOp(op: Op) {
  if (applyOp(op)) broadcast({ type: 'op', op, from: 'server' });
}

export function bringToFront(kind: 'tile' | 'preview', key: string) {
  const rec = kind === 'tile' ? layout.tiles[key] : layout.previews[key];
  if (rec) {
    rec.z = layout.nextZ++;
    saveLayoutSoon();
  }
}

// --- WebSocket server ----------------------------------------------------------------------

export const canvasWss = new WebSocketServer({ noServer: true });

canvasWss.on('connection', (ws) => {
  const id = crypto.randomBytes(6).toString('hex');
  const color = CLIENT_COLORS[clients.size % CLIENT_COLORS.length];
  const name = CALLSIGNS[hashStr(id) % CALLSIGNS.length];
  const client: ClientInfo = { id, name, color, ws, subs: new Set(), alive: true };
  clients.set(ws, client);

  // Fresh roster for the first client (poll loop may have been idle).
  if (lastRoster.length === 0) {
    try { lastRoster = collectRoster(); } catch {}
  }

  ws.send(JSON.stringify({
    type: 'init',
    you: { id, name, color },
    layout: publicLayout(),
    sessions: lastRoster,
    clients: presenceList(),
  }));
  broadcast({ type: 'presence', clients: presenceList() }, ws);

  ws.on('pong', () => { client.alive = true; });

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'hello': {
        if (typeof msg.name === 'string' && msg.name.trim()) {
          client.name = msg.name.trim().slice(0, 24);
          broadcast({ type: 'presence', clients: presenceList() });
        }
        break;
      }
      case 'sub': {
        if (typeof msg.key === 'string' && msg.key.length < 200) {
          client.subs.add(msg.key);
          ensureStream(msg.key);
          // Nudge an immediate frame for the new subscriber.
          const s = streams.get(msg.key);
          if (s) { s.last = ''; captureOnce(msg.key); }
        }
        break;
      }
      case 'unsub': {
        if (typeof msg.key === 'string') {
          client.subs.delete(msg.key);
          maybeStopStream(msg.key);
        }
        break;
      }
      case 'cursor': {
        if (typeof msg.x === 'number' && typeof msg.y === 'number') {
          broadcast({ type: 'cursor', id, x: msg.x, y: msg.y }, ws);
        }
        break;
      }
      case 'op': {
        const op = msg.op as Op;
        if (op && applyOp(op)) broadcast({ type: 'op', op, from: id }, ws);
        break;
      }
      case 'voice': {
        // Voice presence: state changes + transcript snippets, so other
        // clients can see what the operator is saying/doing.
        broadcast({ type: 'voice', id, name: client.name, color, payload: msg.payload }, ws);
        break;
      }
    }
  });

  const cleanup = () => {
    const c = clients.get(ws);
    if (!c) return;
    clients.delete(ws);
    for (const key of c.subs) maybeStopStream(key);
    broadcast({ type: 'presence', clients: presenceList() });
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Heartbeat: drop dead connections so streams stop.
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, 30000);

// --- Init ---------------------------------------------------------------------------------------

export function initCanvas(ctxs: Context[]) {
  contextsList = ctxs;
  layout = loadLayout();
  if (rosterTimer) clearInterval(rosterTimer);
  rosterTimer = setInterval(pollRoster, 2000);
  console.log(`[canvas] initialized (${ctxs.length} context(s), layout: ${Object.keys(layout.tiles).length} tiles)`);
}

export function registerCanvasRoutes(app: import('express').Express) {
  app.get('/api/canvas/layout', (_req, res) => {
    res.json(publicLayout());
  });
}
