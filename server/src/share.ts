// Public share mode for the local reverse proxy.
//
// Normally /lp/<port>/ is reachable only through the Access-protected main
// app. A share grant makes one local port reachable through a second,
// separately-trusted listener (the "share" socket) that cloudflared exposes
// on a public hostname with no Access policy in front of it. Grants are:
//
//   - off by default: a port with no grant answers 404 on the share host
//   - time-limited: every grant carries an absolute expiry; expired grants
//     are swept and any live websocket through them is cut
//   - admin-only to create: the management API lives on the main app, which
//     only the owner's socket (and Access-authenticated clients) can reach
//
// The share listener mounts nothing but the gated proxy — no API, no static
// app, no websocket endpoints of our own — so a public visitor can reach
// exactly the shared upstreams and nothing else on this machine.

import express, { type Express } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import type { Duplex } from 'stream';
import { localProxyMiddleware, handleLocalWsUpgrade } from './proxy';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHARES_FILE = process.env.SHARES_FILE || path.join(REPO_ROOT, 'config', 'shares.json');
const DEFAULT_MINUTES = Math.max(1, Number(process.env.SHARE_DEFAULT_MINUTES) || 60);
const MAX_MINUTES = Math.max(DEFAULT_MINUTES, Number(process.env.SHARE_MAX_MINUTES) || 24 * 60);
const SWEEP_MS = 15_000;

export interface ShareGrant {
  port: number;
  label?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ShareView extends ShareGrant {
  url: string | null;
  remainingMs: number;
}

const grants = new Map<number, ShareGrant>();
const liveSockets = new Map<number, Set<Duplex>>();
let reservedPorts = new Set<number>();
let publicOrigin = '';

function persist() {
  try {
    fs.mkdirSync(path.dirname(SHARES_FILE), { recursive: true });
    const tmp = `${SHARES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...grants.values()], null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, SHARES_FILE);
  } catch (e) {
    console.warn('[share] could not persist grants:', (e as Error).message);
  }
}

function load() {
  try {
    if (!fs.existsSync(SHARES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf-8'));
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const g of raw) {
      if (typeof g?.port !== 'number' || typeof g?.expiresAt !== 'number') continue;
      if (g.expiresAt <= now) continue;
      grants.set(g.port, {
        port: g.port,
        label: typeof g.label === 'string' ? g.label : undefined,
        createdAt: typeof g.createdAt === 'number' ? g.createdAt : now,
        expiresAt: g.expiresAt,
      });
    }
    if (grants.size) console.log(`[share] restored ${grants.size} active grant(s): ${[...grants.keys()].join(', ')}`);
  } catch (e) {
    console.warn('[share] could not read grants:', (e as Error).message);
  }
}

function cutSockets(port: number) {
  const set = liveSockets.get(port);
  if (!set) return;
  for (const s of set) { try { s.destroy(); } catch { /* already gone */ } }
  liveSockets.delete(port);
}

function sweep() {
  const now = Date.now();
  let changed = false;
  for (const [port, g] of grants) {
    if (g.expiresAt <= now) {
      grants.delete(port);
      cutSockets(port);
      changed = true;
      console.log(`[share] port ${port} expired`);
    }
  }
  if (changed) persist();
}

export function initShare(opts: { reservedPorts?: number[]; publicOrigin?: string }) {
  reservedPorts = new Set((opts.reservedPorts || []).filter((p) => Number.isFinite(p)));
  publicOrigin = (opts.publicOrigin || '').replace(/\/+$/, '');
  if (!publicOrigin) {
    console.warn('[share] TERMINAL_SHARE_ORIGIN not set; share URLs will be shown as paths only');
  }
  load();
  setInterval(sweep, SWEEP_MS).unref();
}

export function isShared(port: number): boolean {
  const g = grants.get(port);
  return !!g && g.expiresAt > Date.now();
}

export function shareUrl(port: number): string | null {
  return publicOrigin ? `${publicOrigin}/lp/${port}/` : null;
}

function view(g: ShareGrant): ShareView {
  return { ...g, url: shareUrl(g.port), remainingMs: Math.max(0, g.expiresAt - Date.now()) };
}

export function listShares(): ShareView[] {
  const now = Date.now();
  return [...grants.values()].filter((g) => g.expiresAt > now).sort((a, b) => a.port - b.port).map(view);
}

export class ShareError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Create or renew a grant: the port is public for `minutes` from now. */
export function createShare(portRaw: unknown, minutesRaw?: unknown, labelRaw?: unknown): ShareView {
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ShareError(400, 'port must be 1-65535');
  if (reservedPorts.has(port)) throw new ShareError(403, `port ${port} belongs to the terminal server and cannot be shared`);
  const minutes = minutesRaw === undefined || minutesRaw === null || minutesRaw === '' ? DEFAULT_MINUTES : Number(minutesRaw);
  if (!Number.isFinite(minutes) || minutes < 1) throw new ShareError(400, 'minutes must be at least 1');
  if (minutes > MAX_MINUTES) throw new ShareError(400, `minutes may not exceed ${MAX_MINUTES}`);
  const label = typeof labelRaw === 'string' ? labelRaw.trim().slice(0, 80) || undefined : undefined;

  const now = Date.now();
  const prev = grants.get(port);
  const grant: ShareGrant = {
    port,
    label: label ?? prev?.label,
    createdAt: prev && prev.expiresAt > now ? prev.createdAt : now,
    expiresAt: now + Math.round(minutes * 60_000),
  };
  grants.set(port, grant);
  persist();
  console.log(`[share] port ${port} public for ${minutes} min (until ${new Date(grant.expiresAt).toISOString()})`);
  return view(grant);
}

export function revokeShare(portRaw: unknown): boolean {
  const port = Number(portRaw);
  const had = grants.delete(port);
  cutSockets(port);
  if (had) {
    persist();
    console.log(`[share] port ${port} revoked`);
  }
  return had;
}

export function shareLimits() {
  return { origin: publicOrigin || null, defaultMinutes: DEFAULT_MINUTES, maxMinutes: MAX_MINUTES };
}

// Management API — mounted on the MAIN (owner-only / Access-protected) app.
export function registerShareRoutes(app: Express) {
  app.get('/api/share', (_req, res) => {
    res.json({ ...shareLimits(), shares: listShares() });
  });

  app.post('/api/share', (req, res) => {
    try {
      res.status(201).json(createShare(req.body?.port, req.body?.minutes, req.body?.label));
    } catch (e) {
      const err = e as ShareError;
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete('/api/share/:port', (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port)) return res.status(400).json({ error: 'bad port' });
    res.json({ revoked: revokeShare(port) });
  });
}

// The public-facing server: gated proxy only.
export function createShareServer(): http.Server {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.use(localProxyMiddleware({ allowPort: isShared }));
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Nothing is shared at this address.\n');
  });

  const server = http.createServer(app);
  server.on('upgrade', (request, socket, head) => {
    const handled = handleLocalWsUpgrade(request, socket, head, {
      allowPort: isShared,
      onAccept: (port) => {
        let set = liveSockets.get(port);
        if (!set) liveSockets.set(port, (set = new Set()));
        set.add(socket);
        socket.on('close', () => set!.delete(socket));
      },
    });
    if (!handled) socket.destroy();
  });
  return server;
}
