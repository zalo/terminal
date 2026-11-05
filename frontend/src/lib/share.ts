// Client for the public share grants (/api/share): a local port can be made
// reachable on the public share hostname for a limited time. Default off.

export interface ShareInfo {
  port: number;
  label?: string;
  createdAt: number;
  expiresAt: number;
  url: string | null;
  remainingMs: number;
}

export interface ShareState {
  origin: string | null;
  defaultMinutes: number;
  maxMinutes: number;
  shares: ShareInfo[];
}

async function asJson<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error || `HTTP ${r.status}`);
  return body as T;
}

export function fetchShares(): Promise<ShareState> {
  return fetch('/api/share').then((r) => asJson<ShareState>(r));
}

export function createShare(port: number, minutes?: number, label?: string): Promise<ShareInfo> {
  return fetch('/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port, minutes, label }),
  }).then((r) => asJson<ShareInfo>(r));
}

export function revokeShare(port: number): Promise<void> {
  return fetch(`/api/share/${port}`, { method: 'DELETE' }).then((r) => asJson<unknown>(r)).then(() => undefined);
}

/** "42m", "3h 05m", "2d 1h" — how long until expiresAt. */
export function remainingLabel(expiresAt: number, now = Date.now()): string {
  const ms = Math.max(0, expiresAt - now);
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// --- ports / requests overview (admin) ----------------------------------------

export interface TunnelInfo {
  hostname: string | null;
  target: string;
  port: number | null;
  uid: number;
  user: string | null;
  context: string | null;
  tunnel: string | null;
  config: string | null;
  quick: boolean;
}

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';

export interface ShareRequest {
  id: string;
  port: number;
  minutes: number;
  label: string | null;
  session: string | null;
  account: string | null;
  uid: number | null;
  listening: boolean;
  createdAt: number;
  status: RequestStatus;
  decidedAt: number | null;
  url: string | null;
  expiresAt: number | null;
}

export interface PortRow {
  port: number;
  bind: string;
  loopbackOnly: boolean;
  uid: number;
  user: string | null;
  context: string | null;
  pid: number | null;
  process: string | null;
  command: string | null;
  unit: string | null;
  cgroup: string | null;
  label: string | null;
  name: string;
  share: (ShareInfo & { owner?: string | null }) | null;
  request: ShareRequest | null;
  tunnels: TunnelInfo[];
}

export interface Overview {
  origin: string | null;
  defaultMinutes: number;
  maxMinutes: number;
  reservedPorts?: number[];
  contexts: Array<{ name: string; label: string; user: string | null }>;
  ports: PortRow[];
  tunnels: TunnelInfo[];
  shares: ShareInfo[];
  requests: ShareRequest[];
}

export function fetchOverview(): Promise<Overview> {
  return fetch('/api/share/overview').then((r) => asJson<Overview>(r));
}

export function approveRequest(id: string, minutes?: number): Promise<{ request: ShareRequest; share: ShareInfo | null }> {
  return fetch(`/api/share/requests/${id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }),
  }).then((r) => asJson(r));
}

export function denyRequest(id: string): Promise<{ request: ShareRequest }> {
  return fetch(`/api/share/requests/${id}/deny`, { method: 'POST' }).then((r) => asJson(r));
}

export function setPortLabel(port: number, label: string): Promise<{ port: number; label: string | null }> {
  return fetch(`/api/ports/${port}/label`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }),
  }).then((r) => asJson(r));
}

export function stopPort(port: number): Promise<{ stopped: boolean; method: string; target: string }> {
  return fetch(`/api/ports/${port}/stop`, { method: 'POST' }).then((r) => asJson(r));
}
