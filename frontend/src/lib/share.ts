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
