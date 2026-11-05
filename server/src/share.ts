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
// Non-admin accounts (agent users) cannot grant; they file a share REQUEST
// over the loopback notify listener. Requests are inert until the owner
// approves them in the UI. The requesting account is derived from who owns
// the listening socket, not from anything the caller claims.
//
// The share listener mounts nothing but the gated proxy — no API, no static
// app, no websocket endpoints of our own — so a public visitor can reach
// exactly the shared upstreams and nothing else on this machine.

import express, { type Express } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Duplex } from 'stream';
import { localProxyMiddleware, handleLocalWsUpgrade } from './proxy';
import { scanPorts, scanTunnels, stopPort, type PortInfo, type TunnelInfo } from './ports';
import { sendToAll } from './push';
import type { Context } from './contexts';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_FILE = process.env.SHARE_STATE_FILE || path.join(REPO_ROOT, 'config', 'share-state.json');
const LEGACY_FILE = path.join(REPO_ROOT, 'config', 'shares.json');
const DEFAULT_MINUTES = Math.max(1, Number(process.env.SHARE_DEFAULT_MINUTES) || 60);
const MAX_MINUTES = Math.max(DEFAULT_MINUTES, Number(process.env.SHARE_MAX_MINUTES) || 24 * 60);
const SWEEP_MS = 15_000;
const REQUEST_TTL_MS = 24 * 3600_000;   // pending requests expire after a day
const MAX_PENDING = 25;
const KEEP_DECIDED = 30;

export interface ShareGrant {
  port: number;
  label?: string;
  owner?: string | null;   // account (context name or user) the port belonged to
  requestId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ShareView extends ShareGrant {
  url: string | null;
  remainingMs: number;
}

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';

export interface ShareRequest {
  id: string;
  port: number;
  minutes: number;
  label: string | null;
  session: string | null;
  account: string | null;  // derived from the socket owner at request time
  uid: number | null;
  listening: boolean;
  createdAt: number;
  status: RequestStatus;
  decidedAt: number | null;
  url: string | null;      // set on approval
  expiresAt: number | null;
}

interface State {
  grants: ShareGrant[];
  requests: ShareRequest[];
  labels: Record<string, string>;
}

const grants = new Map<number, ShareGrant>();
const requests = new Map<string, ShareRequest>();
const labels = new Map<number, string>();
const liveSockets = new Map<number, Set<Duplex>>();
let reservedPorts = new Set<number>();
let publicOrigin = '';
let contextList: Context[] = [];

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const state: State = {
      grants: [...grants.values()],
      requests: [...requests.values()],
      labels: Object.fromEntries([...labels.entries()].map(([p, l]) => [String(p), l])),
    };
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.warn('[share] could not persist state:', (e as Error).message);
  }
}

function loadGrants(raw: unknown, now: number) {
  if (!Array.isArray(raw)) return;
  for (const g of raw) {
    if (typeof g?.port !== 'number' || typeof g?.expiresAt !== 'number' || g.expiresAt <= now) continue;
    grants.set(g.port, {
      port: g.port,
      label: typeof g.label === 'string' ? g.label : undefined,
      owner: typeof g.owner === 'string' ? g.owner : null,
      requestId: typeof g.requestId === 'string' ? g.requestId : undefined,
      createdAt: typeof g.createdAt === 'number' ? g.createdAt : now,
      expiresAt: g.expiresAt,
    });
  }
}

function load() {
  const now = Date.now();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<State>;
      loadGrants(st.grants, now);
      for (const r of Array.isArray(st.requests) ? st.requests : []) {
        if (typeof r?.id === 'string' && typeof r?.port === 'number') requests.set(r.id, r as ShareRequest);
      }
      for (const [p, l] of Object.entries(st.labels || {})) if (typeof l === 'string') labels.set(Number(p), l);
    } else if (fs.existsSync(LEGACY_FILE)) {
      loadGrants(JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf-8')), now);
      persist();
      fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`);
    }
    if (grants.size) console.log(`[share] restored ${grants.size} active grant(s): ${[...grants.keys()].join(', ')}`);
  } catch (e) {
    console.warn('[share] could not read state:', (e as Error).message);
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
  for (const r of requests.values()) {
    if (r.status === 'pending' && now - r.createdAt > REQUEST_TTL_MS) {
      r.status = 'expired'; r.decidedAt = now; changed = true;
    }
  }
  // Keep the decided history short.
  const decided = [...requests.values()].filter((r) => r.status !== 'pending').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  for (const r of decided.slice(KEEP_DECIDED)) { requests.delete(r.id); changed = true; }
  if (changed) persist();
}

export function initShare(opts: { reservedPorts?: number[]; publicOrigin?: string; contexts?: Context[] }) {
  reservedPorts = new Set((opts.reservedPorts || []).filter((p) => Number.isFinite(p)));
  publicOrigin = (opts.publicOrigin || '').replace(/\/+$/, '');
  contextList = opts.contexts || [];
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

function parsePort(raw: unknown): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ShareError(400, 'port must be 1-65535');
  return port;
}

function parseMinutes(raw: unknown): number {
  const minutes = raw === undefined || raw === null || raw === '' ? DEFAULT_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 1) throw new ShareError(400, 'minutes must be at least 1');
  if (minutes > MAX_MINUTES) throw new ShareError(400, `minutes may not exceed ${MAX_MINUTES}`);
  return minutes;
}

function parseLabel(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim().slice(0, 80) || undefined : undefined;
}

/** Create or renew a grant: the port is public for `minutes` from now. */
export function createShare(portRaw: unknown, minutesRaw?: unknown, labelRaw?: unknown, owner?: string | null, requestId?: string): ShareView {
  const port = parsePort(portRaw);
  if (reservedPorts.has(port)) throw new ShareError(403, `port ${port} belongs to the terminal server and cannot be shared`);
  const minutes = parseMinutes(minutesRaw);
  const label = parseLabel(labelRaw);

  const now = Date.now();
  const prev = grants.get(port);
  const grant: ShareGrant = {
    port,
    label: label ?? prev?.label ?? labels.get(port),
    owner: owner ?? prev?.owner ?? null,
    requestId: requestId ?? prev?.requestId,
    createdAt: prev && prev.expiresAt > now ? prev.createdAt : now,
    expiresAt: now + Math.round(minutes * 60_000),
  };
  grants.set(port, grant);
  persist();
  console.log(`[share] port ${port} public for ${minutes} min (until ${new Date(grant.expiresAt).toISOString()})${owner ? ` for ${owner}` : ''}`);
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
  return { origin: publicOrigin || null, defaultMinutes: DEFAULT_MINUTES, maxMinutes: MAX_MINUTES, reservedPorts: [...reservedPorts] };
}

// --- requests ----------------------------------------------------------------

async function ownerOfPort(port: number): Promise<{ account: string | null; uid: number | null; listening: boolean }> {
  try {
    const p = (await scanPorts(contextList)).find((x) => x.port === port);
    if (!p) return { account: null, uid: null, listening: false };
    return { account: p.context ?? p.user ?? String(p.uid), uid: p.uid, listening: true };
  } catch {
    return { account: null, uid: null, listening: false };
  }
}

export function pendingRequests(): ShareRequest[] {
  return [...requests.values()].filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
}

export function listRequests(): ShareRequest[] {
  const pending = pendingRequests();
  const decided = [...requests.values()].filter((r) => r.status !== 'pending').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 10);
  return [...pending, ...decided];
}

export function getRequest(id: string): ShareRequest | undefined {
  return requests.get(id);
}

/** File (or refresh) a pending request for a port. Returns {request, created}. */
export async function requestShare(body: { port?: unknown; minutes?: unknown; label?: unknown; session?: unknown }): Promise<{ request: ShareRequest; created: boolean }> {
  const port = parsePort(body.port);
  if (reservedPorts.has(port)) throw new ShareError(403, `port ${port} belongs to the terminal server and cannot be shared`);
  const minutesGiven = body.minutes !== undefined && body.minutes !== null && body.minutes !== '';
  const minutes = parseMinutes(body.minutes);
  const label = parseLabel(body.label) ?? null;
  const session = typeof body.session === 'string' ? body.session.trim().slice(0, 80) || null : null;

  const existing = pendingRequests().find((r) => r.port === port);
  const owner = await ownerOfPort(port);
  if (existing) {
    if (minutesGiven) existing.minutes = minutes;
    if (label) existing.label = label;
    if (session) existing.session = session;
    existing.account = owner.account; existing.uid = owner.uid; existing.listening = owner.listening;
    persist();
    return { request: existing, created: false };
  }
  if (pendingRequests().length >= MAX_PENDING) throw new ShareError(429, 'too many pending share requests');

  const request: ShareRequest = {
    id: crypto.randomBytes(9).toString('base64url'),
    port, minutes, label, session,
    account: owner.account, uid: owner.uid, listening: owner.listening,
    createdAt: Date.now(),
    status: 'pending', decidedAt: null, url: null, expiresAt: null,
  };
  requests.set(request.id, request);
  if (label) labels.set(port, label);
  persist();
  console.log(`[share] request ${request.id}: ${request.account ?? 'unknown account'} asks to share port ${port} for ${minutes} min${label ? ` (${label})` : ''}`);
  sendToAll({
    title: 'Share request',
    body: `${request.account ?? 'Someone'} wants to share port ${port}${label ? ` (${label})` : ''} for ${minutes} min`,
    tag: `share-request-${port}`,
    url: '/',
  }).catch(() => { /* push not configured */ });
  return { request, created: true };
}

export function decideRequest(id: string, decision: 'approve' | 'deny', minutesRaw?: unknown): { request: ShareRequest; share: ShareView | null } {
  const r = requests.get(id);
  if (!r) throw new ShareError(404, 'no such request');
  if (r.status !== 'pending') throw new ShareError(409, `request already ${r.status}`);
  r.decidedAt = Date.now();
  if (decision === 'deny') {
    r.status = 'denied';
    persist();
    console.log(`[share] request ${id} denied`);
    return { request: r, share: null };
  }
  const share = createShare(r.port, minutesRaw ?? r.minutes, r.label ?? undefined, r.account, r.id);
  r.status = 'approved'; r.url = share.url; r.expiresAt = share.expiresAt;
  persist();
  console.log(`[share] request ${id} approved`);
  return { request: r, share };
}

export function cancelRequest(id: string): ShareRequest {
  const r = requests.get(id);
  if (!r) throw new ShareError(404, 'no such request');
  if (r.status === 'pending') { r.status = 'cancelled'; r.decidedAt = Date.now(); persist(); }
  return r;
}

export function setPortLabel(portRaw: unknown, labelRaw: unknown): { port: number; label: string | null } {
  const port = parsePort(portRaw);
  const label = parseLabel(labelRaw) ?? null;
  if (label) labels.set(port, label); else labels.delete(port);
  const g = grants.get(port);
  if (g) g.label = label ?? undefined;
  persist();
  return { port, label };
}

// --- overview ----------------------------------------------------------------

export interface PortRow extends PortInfo {
  label: string | null;
  name: string;
  share: ShareView | null;
  request: ShareRequest | null;
  tunnels: TunnelInfo[];
}

export async function overview() {
  const [ports, tunnels] = await Promise.all([scanPorts(contextList), scanTunnels(contextList)]);
  const shares = listShares();
  const pending = pendingRequests();
  const rows: PortRow[] = ports.map((p) => {
    const label = labels.get(p.port) ?? null;
    const share = shares.find((s) => s.port === p.port) ?? null;
    const request = pending.find((r) => r.port === p.port) ?? null;
    const name = label || share?.label || request?.label || p.command || p.unit || p.process || `port ${p.port}`;
    return { ...p, label, name, share, request, tunnels: tunnels.filter((t) => t.port === p.port) };
  });
  // Shares/requests for ports nothing listens on right now still deserve a row.
  for (const s of shares) if (!rows.some((r) => r.port === s.port)) rows.push(ghostRow(s.port, s.label ?? labels.get(s.port) ?? null, s, null, s.owner ?? null, tunnels));
  for (const q of pending) if (!rows.some((r) => r.port === q.port)) rows.push(ghostRow(q.port, q.label ?? labels.get(q.port) ?? null, null, q, q.account, tunnels));
  rows.sort((a, b) => a.port - b.port);
  return {
    ...shareLimits(),
    contexts: contextList.map((c) => ({ name: c.name, label: c.label, user: c.user })),
    ports: rows,
    tunnels,
    shares,
    requests: listRequests(),
  };
}

function ghostRow(port: number, label: string | null, share: ShareView | null, request: ShareRequest | null, account: string | null, tunnels: TunnelInfo[]): PortRow {
  const ctx = contextList.find((c) => c.name === account);
  return {
    port, bind: '', loopbackOnly: true, uid: -1,
    user: ctx ? (ctx.user ?? null) : account, context: ctx ? ctx.name : null,
    pid: null, process: null, command: null, unit: null, cgroup: null,
    label, name: label || share?.label || request?.label || `port ${port} (not listening)`,
    share, request, tunnels: tunnels.filter((t) => t.port === port),
  };
}

// --- routes -------------------------------------------------------------------

function fail(res: express.Response, e: unknown) {
  const err = e as ShareError;
  res.status(err.status || 500).json({ error: err.message || 'error' });
}

// Management API — mounted on the MAIN (owner-only / Access-protected) app.
export function registerShareRoutes(app: Express) {
  app.get('/api/share', (_req, res) => {
    res.json({ ...shareLimits(), shares: listShares() });
  });

  app.get('/api/share/overview', async (_req, res) => {
    try { res.json(await overview()); } catch (e) { fail(res, e); }
  });

  app.post('/api/share', (req, res) => {
    try {
      res.status(201).json(createShare(req.body?.port, req.body?.minutes, req.body?.label, req.body?.owner ?? null));
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/share/:port', (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port)) return res.status(400).json({ error: 'bad port' });
    res.json({ revoked: revokeShare(port) });
  });

  app.get('/api/share/requests', (_req, res) => res.json({ requests: listRequests() }));

  app.post('/api/share/requests/:id/approve', (req, res) => {
    try { res.json(decideRequest(req.params.id, 'approve', req.body?.minutes)); } catch (e) { fail(res, e); }
  });

  app.post('/api/share/requests/:id/deny', (req, res) => {
    try { res.json(decideRequest(req.params.id, 'deny')); } catch (e) { fail(res, e); }
  });

  app.put('/api/ports/:port/label', (req, res) => {
    try { res.json(setPortLabel(req.params.port, req.body?.label)); } catch (e) { fail(res, e); }
  });

  // Stop the process behind a port, as its owning account. Also drops any
  // share grant on it so the public URL does not dangle.
  app.post('/api/ports/:port/stop', async (req, res) => {
    try {
      const port = parsePort(req.params.port);
      const result = await stopPort(port, contextList, reservedPorts);
      revokeShare(port);
      console.log(`[ports] stopped port ${port} via ${result.method} (${result.target})`);
      res.json({ stopped: true, ...result });
    } catch (e) { fail(res, e); }
  });
}

// Request API — mounted on the LOOPBACK notify listener (any local user).
// Nothing here grants access; it files requests and reads their status.
export function registerShareRequestRoutes(app: Express) {
  app.post('/api/share/requests', async (req, res) => {
    try {
      const { request, created } = await requestShare(req.body || {});
      res.status(created ? 201 : 200).json(request);
    } catch (e) { fail(res, e); }
  });

  app.get('/api/share/requests', (req, res) => {
    const port = Number(req.query.port);
    if (!Number.isInteger(port)) return res.status(400).json({ error: 'port required' });
    const r = pendingRequests().find((x) => x.port === port) || [...requests.values()].filter((x) => x.port === port).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!r) return res.status(404).json({ error: 'no request for that port' });
    res.json(r);
  });

  app.get('/api/share/requests/:id', (req, res) => {
    const r = getRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'no such request' });
    res.json(r);
  });

  app.delete('/api/share/requests/:id', (req, res) => {
    try { res.json(cancelRequest(req.params.id)); } catch (e) { fail(res, e); }
  });

  app.get('/api/share/list', (_req, res) => {
    res.json({ shares: listShares().map((s) => ({ port: s.port, url: s.url, label: s.label ?? null, owner: s.owner ?? null, expiresAt: s.expiresAt })) });
  });

  app.post('/api/ports/label', (req, res) => {
    try { res.json(setPortLabel(req.body?.port, req.body?.label)); } catch (e) { fail(res, e); }
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
