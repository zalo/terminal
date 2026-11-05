// Listening-port inventory: which local TCP ports are open, which account
// owns each, what service/process is behind it, and which cloudflared
// tunnels publish it. Feeds the Ports panel and the share-request flow.
//
// Sources, all read-only:
//   ss -ltnpe        every listening socket with uid + cgroup; process info
//                    only for our own uid
//   sudo -u <ctx> ss per context user, to learn pid/process for their sockets
//                    (the same passwordless sudo the contexts already rely on)
//   /proc/<pid>/cmdline  world-readable here (no hidepid) — human name
//   ps + cloudflared --config files  tunnel hostnames → local targets

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';
import type { Context } from './contexts';

const execFileP = promisify(execFile);

export interface PortInfo {
  port: number;
  bind: string;            // 127.0.0.1 / 0.0.0.0 / :: / specific address
  loopbackOnly: boolean;
  uid: number;
  user: string | null;     // account name
  context: string | null;  // context name when the uid belongs to one
  pid: number | null;
  process: string | null;  // comm, e.g. "node"
  command: string | null;  // short human form of the cmdline
  unit: string | null;     // systemd unit/scope from the cgroup, if any
  cgroup: string | null;   // raw cgroup path
}

export interface TunnelInfo {
  hostname: string | null; // null for quick tunnels (random trycloudflare name)
  target: string;          // service string from the config, or --url
  port: number | null;     // local port when the target is a local http(s) URL
  uid: number;
  user: string | null;
  context: string | null;
  tunnel: string | null;   // tunnel id or name
  config: string | null;   // config path
  quick: boolean;
}

interface AccountMap {
  byUid: Map<number, { user: string; context: string | null }>;
  byUser: Map<string, number>;
}

let accountCache: { at: number; map: AccountMap } | null = null;

function loadAccounts(contexts: Context[]): AccountMap {
  if (accountCache && Date.now() - accountCache.at < 60_000) return accountCache.map;
  const byUid = new Map<number, { user: string; context: string | null }>();
  const byUser = new Map<string, number>();
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf-8').split('\n')) {
      const [name, , uidStr] = line.split(':');
      const uid = Number(uidStr);
      if (!name || !Number.isFinite(uid)) continue;
      byUid.set(uid, { user: name, context: null });
      byUser.set(name, uid);
    }
  } catch { /* fall back to numeric uids */ }
  const self = os.userInfo();
  for (const ctx of contexts) {
    const user = ctx.user ?? self.username;
    const uid = ctx.user ? byUser.get(ctx.user) : self.uid;
    if (uid === undefined) continue;
    byUid.set(uid, { user, context: ctx.name });
  }
  const map = { byUid, byUser };
  accountCache = { at: Date.now(), map };
  return map;
}

// "node /home/x/proj/node_modules/.bin/vite --port 5173" → "vite --port 5173"
export function summarizeCommand(cmdline: string): string {
  const parts = cmdline.split('\0').filter(Boolean);
  if (!parts.length) return '';
  const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
  let args = parts.map((p) => (p.startsWith('/') || p.startsWith('./') ? base(p) : p));
  const interp = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|perl|php|java|sh|bash|zsh|npm|npx|pnpm|yarn|uv|uvx)$/;
  while (args.length > 1 && interp.test(args[0]) && !args[1].startsWith('-')) args = args.slice(1);
  if (args[0] === 'run' || args[0] === 'exec') args = args.slice(1);
  const out = args.join(' ').replace(/\s+/g, ' ').trim();
  return out.length > 72 ? out.slice(0, 69) + '…' : out;
}

function unitFromCgroup(cg: string): string | null {
  const seg = cg.split('/').filter(Boolean).pop() || '';
  if (!/\.(service|scope)$/.test(seg)) return null;
  // app-Hyprland-steam-556ed461.scope → steam ; app-foo@bar.service → foo
  const m = /^app-(?:[^-]+-)?(.+?)(?:-[0-9a-f]{6,})?\.(service|scope)$/.exec(seg);
  return m ? m[1] : seg.replace(/\.(service|scope)$/, '');
}

const SS_LINE = /^LISTEN\s+\d+\s+\d+\s+(\S+?):(\d+|\*)\s+\S+(.*)$/;

function parseSs(out: string): Array<{ bind: string; port: number; pid: number | null; process: string | null; uid: number; cgroup: string | null }> {
  const rows: Array<{ bind: string; port: number; pid: number | null; process: string | null; uid: number; cgroup: string | null }> = [];
  for (const raw of out.split('\n')) {
    const m = SS_LINE.exec(raw.trim());
    if (!m) continue;
    const port = Number(m[2]);
    if (!Number.isFinite(port)) continue;
    const rest = m[3];
    const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(rest);
    const uid = /\buid:(\d+)/.exec(rest);
    const cg = /\bcgroup:(\S+)/.exec(rest);
    rows.push({
      bind: m[1].replace(/^\[|\]$/g, ''),
      port,
      pid: proc ? Number(proc[2]) : null,
      process: proc ? proc[1] : null,
      uid: uid ? Number(uid[1]) : 0,
      cgroup: cg ? cg[1] : null,
    });
  }
  return rows;
}

async function run(cmd: string, args: string[], strict = false): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args, { encoding: 'utf-8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (strict) {
      const err = e as { stderr?: string; message: string };
      throw new StopError(500, (err.stderr || err.message || 'command failed').trim().split('\n').pop() || 'command failed');
    }
    return '';
  }
}

function readCmdline(pid: number): string | null {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8'); } catch { return null; }
}

let portCache: { at: number; value: PortInfo[] } | null = null;
let portInflight: Promise<PortInfo[]> | null = null;
const PORT_TTL = 4000;

export function scanPorts(contexts: Context[]): Promise<PortInfo[]> {
  if (portCache && Date.now() - portCache.at < PORT_TTL) return Promise.resolve(portCache.value);
  if (portInflight) return portInflight;
  portInflight = doScanPorts(contexts).then((v) => {
    portCache = { at: Date.now(), value: v };
    portInflight = null;
    return v;
  }, (e) => { portInflight = null; throw e; });
  return portInflight;
}

async function doScanPorts(contexts: Context[]): Promise<PortInfo[]> {
  const accounts = loadAccounts(contexts);
  const mine = parseSs(await run('ss', ['-ltnpeH']));
  const others = await Promise.all(
    contexts.filter((c) => c.user).map(async (c) => ({
      user: c.user as string,
      rows: parseSs(await run('sudo', ['-n', '-u', c.user as string, '--', 'ss', '-ltnpH'])),
    })),
  );
  const procByPort = new Map<string, { pid: number; process: string }>();
  for (const { user, rows } of others) {
    const uid = accounts.byUser.get(user);
    for (const r of rows) if (r.pid) procByPort.set(`${uid}:${r.port}`, { pid: r.pid, process: r.process || '' });
  }

  const byPort = new Map<number, PortInfo>();
  for (const r of mine) {
    const acct = accounts.byUid.get(r.uid);
    let pid = r.pid, process = r.process;
    if (!pid) {
      const p = procByPort.get(`${r.uid}:${r.port}`);
      if (p) { pid = p.pid; process = p.process; }
    }
    if (process === 'cloudflared') continue; // tunnel metrics/edge listeners: noise
    const cmdline = pid ? readCmdline(pid) : null;
    const info: PortInfo = {
      port: r.port,
      bind: r.bind === '*' ? '::' : r.bind,
      loopbackOnly: r.bind === '127.0.0.1' || r.bind === '::1' || r.bind.startsWith('127.'),
      uid: r.uid,
      user: acct?.user ?? null,
      context: acct?.context ?? null,
      pid,
      process,
      command: cmdline ? summarizeCommand(cmdline) : null,
      unit: r.cgroup ? unitFromCgroup(r.cgroup) : null,
      cgroup: r.cgroup,
    };
    const prev = byPort.get(r.port);
    // v4 + v6 listeners for one service: keep the richer row, widest bind.
    if (!prev || (!prev.pid && info.pid)) byPort.set(r.port, { ...info, loopbackOnly: (prev?.loopbackOnly ?? true) && info.loopbackOnly });
    else prev.loopbackOnly = prev.loopbackOnly && info.loopbackOnly;
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

// --- tunnels ------------------------------------------------------------------

let tunnelCache: { at: number; value: TunnelInfo[] } | null = null;
const TUNNEL_TTL = 10_000;

export function scanTunnels(contexts: Context[]): Promise<TunnelInfo[]> {
  if (tunnelCache && Date.now() - tunnelCache.at < TUNNEL_TTL) return Promise.resolve(tunnelCache.value);
  return doScanTunnels(contexts).then((v) => { tunnelCache = { at: Date.now(), value: v }; return v; });
}

function localPortOfTarget(target: string): number | null {
  const m = /^(https?|tcp|ws|wss):\/\/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1|\[::\])(?::(\d{1,5}))?(?:\/|$)/i.exec(target.trim());
  if (!m) return null;
  if (m[3]) return Number(m[3]);
  return /^https|^wss/i.test(m[1]) ? 443 : 80;
}

// Minimal reader for cloudflared's YAML: top-level `tunnel:` and the
// `ingress:` list items' hostname/service. Enough for every config here.
function parseIngress(yaml: string): { tunnel: string | null; rules: Array<{ hostname: string | null; service: string }> } {
  let tunnel: string | null = null;
  const rules: Array<{ hostname: string | null; service: string }> = [];
  let inIngress = false;
  let cur: { hostname: string | null; service: string | null } | null = null;
  const flush = () => { if (cur?.service) rules.push({ hostname: cur.hostname, service: cur.service }); cur = null; };
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const top = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      flush();
      inIngress = top[1] === 'ingress';
      if (top[1] === 'tunnel' && top[2]) tunnel = top[2].trim();
      continue;
    }
    if (!inIngress) continue;
    const item = /^\s*-\s*(\w+):\s*(.+)$/.exec(line);
    if (item) { flush(); cur = { hostname: null, service: null }; assign(cur, item[1], item[2]); continue; }
    const kv = /^\s+(\w+):\s*(.+)$/.exec(line);
    if (kv && cur) assign(cur, kv[1], kv[2]);
  }
  flush();
  return { tunnel, rules };
  function assign(o: { hostname: string | null; service: string | null }, k: string, v: string) {
    const val = v.trim().replace(/^["']|["']$/g, '');
    if (k === 'hostname') o.hostname = val;
    else if (k === 'service') o.service = val;
  }
}

async function readAs(path: string, user: string | null): Promise<string | null> {
  try { return fs.readFileSync(path, 'utf-8'); } catch { /* not ours */ }
  if (!user) return null;
  const out = await run('sudo', ['-n', '-u', user, '--', 'cat', path]);
  return out || null;
}

async function doScanTunnels(contexts: Context[]): Promise<TunnelInfo[]> {
  const accounts = loadAccounts(contexts);
  const ps = await run('ps', ['-eo', 'pid=,uid=,args=']);
  const out: TunnelInfo[] = [];
  const seenConfigs = new Set<string>();
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*cloudflared\b.*)$/.exec(line);
    if (!m) continue;
    const uid = Number(m[2]);
    const args = m[3];
    if (!/\btunnel\b/.test(args)) continue;
    const acct = accounts.byUid.get(uid);
    const user = acct?.user ?? null;
    const context = acct?.context ?? null;
    const quick = /--url[= ]/.exec(args);
    if (quick) {
      const target = (/--url[= ]+(\S+)/.exec(args) || [])[1] || '';
      out.push({ hostname: null, target, port: localPortOfTarget(target), uid, user, context, tunnel: null, config: null, quick: true });
      continue;
    }
    const cfg = (/--config[= ]+(\S+)/.exec(args) || [])[1] || null;
    const named = (/\brun\s+(\S+)\s*$/.exec(args) || [])[1] || null;
    if (!cfg || seenConfigs.has(`${uid}:${cfg}`)) continue;
    seenConfigs.add(`${uid}:${cfg}`);
    const yaml = await readAs(cfg, user === os.userInfo().username ? null : user);
    if (!yaml) {
      out.push({ hostname: null, target: '(config unreadable)', port: null, uid, user, context, tunnel: named, config: cfg, quick: false });
      continue;
    }
    const { tunnel, rules } = parseIngress(yaml);
    for (const r of rules) {
      if (!r.hostname) continue; // catch-all
      out.push({ hostname: r.hostname, target: r.service, port: localPortOfTarget(r.service), uid, user, context, tunnel: named || tunnel, config: cfg, quick: false });
    }
  }
  return out.sort((a, b) => (a.port ?? 1e9) - (b.port ?? 1e9) || String(a.hostname).localeCompare(String(b.hostname)));
}

export function invalidatePortCache() {
  portCache = null;
}

export class StopError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Stop whatever listens on <port>, as the account that owns it. A user
 * .service unit is stopped through its own systemd user manager (so
 * Restart= units stay down); anything else gets SIGTERM by pid. System
 * services and the terminal server itself are refused.
 */
export async function stopPort(port: number, contexts: Context[], reserved: Set<number>): Promise<{ method: string; target: string }> {
  if (reserved.has(port)) throw new StopError(403, 'that port belongs to the terminal server');
  const info = (await scanPorts(contexts)).find((p) => p.port === port);
  if (!info) throw new StopError(404, 'nothing is listening on that port');
  if (info.pid === process.pid) throw new StopError(403, 'refusing to stop the terminal server');
  if (info.uid < 1000 || (info.cgroup && info.cgroup.startsWith('/system.slice/'))) {
    throw new StopError(403, `port ${port} is a system service (${info.unit || info.process || 'unknown'}); stop it with systemctl`);
  }
  const self = os.userInfo();
  const asOwner = (cmd: string, args: string[]) =>
    info.uid === self.uid ? run(cmd, args, true) : run('sudo', ['-n', '-u', info.user || String(info.uid), '--', cmd, ...args], true);

  const unitMatch = info.cgroup && /\/user@(\d+)\.service\/.*\/([^/]+\.service)$/.exec(info.cgroup);
  if (unitMatch && Number(unitMatch[1]) === info.uid) {
    const unit = unitMatch[2];
    await asOwner('env', [`XDG_RUNTIME_DIR=/run/user/${info.uid}`, 'systemctl', '--user', 'stop', unit]);
    invalidatePortCache();
    return { method: 'systemctl --user stop', target: unit };
  }
  if (!info.pid) throw new StopError(409, `could not determine the process behind port ${port}`);
  await asOwner('kill', ['-TERM', String(info.pid)]);
  invalidatePortCache();
  return { method: 'SIGTERM', target: `${info.process || 'pid'} ${info.pid}` };
}
