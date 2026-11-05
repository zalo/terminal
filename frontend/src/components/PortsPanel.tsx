// Ports & shares on the session browser screen.
//
// One card per PROCESS (grouped by pid, else by cgroup unit), under its
// account. The card's heading is the service name; its ports are the rows
// beneath, each tagged with how reachable it is:
//   local   loopback-bound, reachable only through the private proxy
//   LAN     bound to a non-loopback address
//   ⇡ host  published by a cloudflared tunnel (any account's — "via tom"
//           marks a tunnel run by a different account than the port's)
//   public  a time-limited share grant on share.<domain>
// Pending share requests from agent accounts sit on top with approve/deny.

import { useEffect, useState } from 'react';
import { openExternal } from '../lib/openExternal';
import {
  approveRequest, createShare, denyRequest, fetchOverview, remainingLabel, revokeShare, setPortLabel, stopPort,
  type Overview, type PortRow, type ShareRequest, type TunnelInfo,
} from '../lib/share';

const CONTEXT_COLORS: Record<string, string> = {
  admin: '#a0aec0', work: '#f6ad55', john: '#4fd1c5', untrusted: '#fc8181', tom: '#b794f4',
};
const colorOf = (ctx: string | null) => (ctx && CONTEXT_COLORS[ctx]) || '#718096';
const C = { local: '#718096', lan: '#f6ad55', tunnel: '#b794f4', public: '#68d391', danger: '#fc8181', ink: '#e2e8f0' };

function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function durLabel(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface Group {
  key: string;
  account: string;          // context name or user
  context: string | null;
  title: string;
  subtitle: string | null;
  pid: number | null;
  unit: string | null;
  ports: PortRow[];
}

// Same process (pid) or same unit → one card. Ghost rows (shares/requests
// for ports nothing listens on) stand alone.
function groupPorts(ports: PortRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const p of ports) {
    const account = p.context || p.user || (p.uid >= 0 ? `uid ${p.uid}` : 'unknown');
    const key = p.pid ? `pid:${p.uid}:${p.pid}` : p.cgroup ? `cg:${p.uid}:${p.cgroup}` : `port:${p.port}`;
    let g = map.get(key);
    if (!g) {
      // A real .service unit names the service; a .scope (tmux pane, app
      // launcher) is just where the process happens to run.
      const serviceUnit = p.cgroup?.endsWith('.service') ? p.unit : null;
      const title = p.label || serviceUnit || p.command || p.process || p.unit || (p.pid ? `pid ${p.pid}` : `port ${p.port}`);
      const sub = [p.command && p.command !== title ? p.command : null, p.unit && p.unit !== title ? p.unit : null, p.pid ? `pid ${p.pid}` : null].filter(Boolean).join(' · ') || null;
      g = { key, account, context: p.context, title, subtitle: sub, pid: p.pid, unit: p.unit, ports: [] };
      map.set(key, g);
    } else if (p.label && !g.ports.some((x) => x.label)) {
      g.title = p.label;
    }
    g.ports.push(p);
  }
  return [...map.values()].map((g) => ({ ...g, ports: g.ports.sort((a, b) => a.port - b.port) }));
}

function Badge({ color, children, title, onClick, solid }: { color: string; children: React.ReactNode; title?: string; onClick?: () => void; solid?: boolean }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-1.5 py-[3px] rounded-md whitespace-nowrap leading-none"
      style={{
        backgroundColor: solid ? color : `${color}1f`, color: solid ? '#1a1a2e' : color,
        border: `1px solid ${solid ? color : `${color}55`}`, cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {children}
    </Tag>
  );
}

function IconBtn({ title, onClick, danger, disabled, children }: { title: string; onClick: () => void; danger?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title} onClick={onClick} disabled={disabled}
      className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 transition-colors disabled:opacity-40"
      style={{ color: danger ? C.danger : '#94a3b8', background: '#ffffff0a', border: '1px solid #ffffff12' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = danger ? '#fc81811f' : '#ffffff14'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#ffffff0a'; }}
    >
      {children}
    </button>
  );
}

export default function PortsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [open, setOpen] = useState<boolean>(() => { try { return localStorage.getItem('terminal.portsOpen') !== '0'; } catch { return true; } });
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [, setTick] = useState(0);

  const refresh = async () => {
    try { setData(await fetchOverview()); setError(null); } catch (e) { setError((e as Error).message); }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, open ? 5000 : 15000);
    const tick = setInterval(() => setTick((t) => t + 1), 30000);
    return () => { clearInterval(id); clearInterval(tick); };
  }, [open]);

  useEffect(() => { try { localStorage.setItem('terminal.portsOpen', open ? '1' : '0'); } catch { /* private mode */ } }, [open]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const pending = data?.requests.filter((r) => r.status === 'pending') ?? [];
  const contexts = data?.contexts ?? [];
  const ports = data?.ports ?? [];
  const isSystem = (p: PortRow) => p.context === null && p.uid >= 0 && p.uid < 1000;
  const groups = groupPorts(ports);
  const sections: Array<{ key: string; title: string; color: string; groups: Group[] }> = [];
  for (const c of contexts) {
    const gs = groups.filter((g) => g.context === c.name);
    if (gs.length) sections.push({ key: c.name, title: c.label || c.name, color: colorOf(c.name), groups: gs });
  }
  const otherAccounts = [...new Set(groups.filter((g) => g.context === null && !g.ports.some(isSystem)).map((g) => g.account))];
  for (const a of otherAccounts) sections.push({ key: `u:${a}`, title: a, color: '#718096', groups: groups.filter((g) => g.context === null && g.account === a && !g.ports.some(isSystem)) });
  const systemGroups = groups.filter((g) => g.ports.some(isSystem));
  const socketTunnels = (data?.tunnels ?? []).filter((t) => t.port === null);
  const sharedCount = data?.shares.length ?? 0;
  const privateUrl = (port: number) => `${window.location.origin}/lp/${port}/`;
  const reserved = new Set(data?.reservedPorts ?? []);

  const copy = (port: number, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(port); setTimeout(() => setCopied(null), 1200); }).catch(() => {});
  };

  const tunnelBadge = (t: TunnelInfo, p: PortRow, i: number) => {
    const foreign = (t.context ?? t.user) !== (p.context ?? p.user);
    const via = foreign ? ` via ${t.context ?? t.user ?? `uid ${t.uid}`}` : '';
    return (
      <Badge key={i} color={C.tunnel} solid={false}
        title={`${t.hostname ?? 'quick tunnel'} → ${t.target}${t.config ? `\n${t.config}` : ''}${foreign ? `\ntunnel runs as ${t.user ?? t.uid}` : ''}`}
        onClick={t.hostname ? () => openExternal(`https://${t.hostname}`) : undefined}>
        ⇡ {t.hostname ?? 'quick tunnel'}{via}
      </Badge>
    );
  };

  const requestCard = (r: ShareRequest) => (
    <div key={r.id} className="rounded-xl p-3 mb-2" style={{ background: 'linear-gradient(135deg, #2a2340, #252540)', border: `1px solid ${C.lan}66`, boxShadow: `0 0 0 3px ${C.lan}14` }}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge color={colorOf(r.account)} solid>{r.account ?? 'unknown'}</Badge>
        <span className="text-white text-sm font-medium truncate">{r.label || ports.find((p) => p.port === r.port)?.name || `port ${r.port}`}</span>
        <span className="font-mono text-slate-400 text-xs">:{r.port}</span>
        {!r.listening && <Badge color={C.danger} title="Nothing is listening on this port right now">not listening</Badge>}
      </div>
      <div className="text-xs text-slate-400 mt-1">
        wants it public for {durLabel(r.minutes)} · {ago(r.createdAt)}{r.session ? ` · from session ${r.session}` : ''}
      </div>
      <div className="flex gap-2 mt-2.5 flex-wrap">
        <button disabled={busy !== null} onClick={() => act(r.id, () => approveRequest(r.id))}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#4fd1c5] text-[#1a1a2e] hover:bg-[#38b2a8]">
          Approve {durLabel(r.minutes)}
        </button>
        {[60, 480].filter((m) => m !== r.minutes && m <= (data?.maxMinutes ?? 1440)).map((m) => (
          <button key={m} disabled={busy !== null} onClick={() => act(r.id, () => approveRequest(r.id, m))}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#2d2d4a] text-slate-200 hover:bg-[#353555]">
            {durLabel(m)}
          </button>
        ))}
        <button disabled={busy !== null} onClick={() => act(r.id, () => denyRequest(r.id))}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#2d2d4a] text-red-300 hover:bg-[#3a2d3a] ml-auto">
          Deny
        </button>
      </div>
    </div>
  );

  const portLine = (p: PortRow, g: Group) => {
    const key = `p${p.port}`;
    const shareUrl = p.share?.url || privateUrl(p.port);
    return (
      <div key={p.port} className="flex items-center gap-2 py-1.5 min-w-0">
        <button
          className="font-mono text-[13px] text-[#4fd1c5] flex-shrink-0 hover:underline w-14 text-left"
          title={`Open privately (login required): ${privateUrl(p.port)}`}
          onClick={() => openExternal(privateUrl(p.port))}
        >
          :{p.port}
        </button>
        <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1">
          {p.share ? (
            <Badge color={C.public} solid title={`Public at ${shareUrl} — click to copy`} onClick={() => copy(p.port, shareUrl)}>
              ● public · {remainingLabel(p.share.expiresAt)}{copied === p.port ? ' · copied' : ''}
            </Badge>
          ) : p.request ? (
            <Badge color={C.lan} title="A share request is pending above">share requested</Badge>
          ) : null}
          {p.tunnels.map((t, i) => tunnelBadge(t, p, i))}
          {p.uid >= 0 && (p.loopbackOnly
            ? <Badge color={C.local} title={`Bound to loopback — open through the private proxy: ${privateUrl(p.port)}`} onClick={() => openExternal(privateUrl(p.port))}>local ↗</Badge>
            : <Badge color={C.lan} title={`Bound to ${p.bind} (reachable on the LAN) — open through the private proxy: ${privateUrl(p.port)}`} onClick={() => openExternal(privateUrl(p.port))}>LAN ↗</Badge>)}
          {p.uid < 0 && <Badge color={C.danger} title="Nothing is listening on this port">not listening</Badge>}
          {g.ports.length > 1 && p.label && <span className="text-[11px] text-slate-400 truncate">{p.label}</span>}
        </div>
        {p.share ? (
          <IconBtn title="Stop sharing publicly" danger disabled={busy !== null} onClick={() => act(key, () => revokeShare(p.port))}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="9" /><path d="M5.5 5.5l13 13" /></svg>
          </IconBtn>
        ) : p.uid >= 0 && !reserved.has(p.port) ? (
          <button
            title={`Share publicly for ${data?.defaultMinutes ?? 60} min`} disabled={busy !== null}
            onClick={() => act(key, () => createShare(p.port, undefined, p.label || g.title))}
            className="h-7 px-2.5 rounded-md flex-shrink-0 text-[10.5px] font-bold tracking-wider transition-colors disabled:opacity-40"
            style={{ color: C.public, background: `${C.public}14`, border: `1px solid ${C.public}55` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = `${C.public}2e`; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = `${C.public}14`; }}
          >
            SHARE
          </button>
        ) : null}
      </div>
    );
  };

  const processCard = (g: Group, color: string) => {
    const isEditing = editing?.key === g.key;
    const stoppable = g.ports.some((p) => p.uid >= 1000 && (p.pid || p.unit)) && !g.ports.some((p) => reserved.has(p.port));
    return (
      <div key={g.key} className="rounded-xl overflow-hidden" style={{ background: '#20203a', border: '1px solid #2d2d4a' }}>
        <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-1.5" style={{ borderLeft: `3px solid ${color}` }}>
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <input
                autoFocus value={editing.value}
                onChange={(e) => setEditing({ key: g.key, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { const v = editing.value; setEditing(null); act(g.key, () => Promise.all(g.ports.map((p) => setPortLabel(p.port, v)))); }
                  if (e.key === 'Escape') setEditing(null);
                }}
                onBlur={() => setEditing(null)}
                placeholder="name this service"
                className="w-full px-2 py-0.5 rounded bg-[#1a1a2e] border border-[#4fd1c5] text-white text-sm outline-none"
              />
            ) : (
              <button
                className="text-white text-[15px] font-semibold truncate text-left w-full leading-tight"
                title={`${g.subtitle ?? ''}\nclick to rename`}
                onClick={() => setEditing({ key: g.key, value: g.ports[0]?.label || '' })}
              >
                {g.title}
              </button>
            )}
            {g.subtitle && <div className="text-[11px] text-slate-500 truncate mt-0.5">{g.subtitle}</div>}
          </div>
          {stoppable && (
            <IconBtn title={`Stop ${g.title}${g.pid ? ` (pid ${g.pid})` : ''}`} danger disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`Stop "${g.title}"${g.pid ? ` (pid ${g.pid})` : ''}?\nPorts ${g.ports.map((p) => p.port).join(', ')} will go down.`)) return;
                act(g.key, () => stopPort(g.ports[0].port));
              }}>
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            </IconBtn>
          )}
        </div>
        <div className="px-3 pb-2 divide-y divide-[#ffffff08]" style={{ borderLeft: `3px solid ${color}44` }}>
          {g.ports.map((p) => portLine(p, g))}
        </div>
      </div>
    );
  };

  const sectionHeader = (title: string, color: string, count: number, extra?: React.ReactNode) => (
    <div className="flex items-center gap-2 px-1 pt-3 pb-1.5">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="text-[11px] uppercase tracking-wider font-bold" style={{ color }}>{title}</span>
      <span className="text-[11px] text-slate-500">{count} service{count === 1 ? '' : 's'}</span>
      {extra}
    </div>
  );

  return (
    <div className="mt-5">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-1 py-1 text-left">
        <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-2">
          Ports &amp; shares
          {pending.length > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[#f6ad55] text-[#1a1a2e] normal-case tracking-normal">{pending.length} request{pending.length > 1 ? 's' : ''}</span>}
          {sharedCount > 0 && <span className="text-[10px] normal-case tracking-normal" style={{ color: C.public }}>● {sharedCount} public</span>}
        </span>
        <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {!open && pending.length > 0 && <div className="mt-1">{pending.map(requestCard)}</div>}
      {open && (
        <div className="mt-1">
          {error && <div className="text-red-400 text-xs mb-2 px-1">{error}</div>}
          {pending.map(requestCard)}
          {!data ? (
            <div className="text-slate-500 text-xs px-1 py-2">Loading…</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pb-1 text-[10px] text-slate-500">
                <span><span style={{ color: C.local }}>■</span> local = private proxy only</span>
                <span><span style={{ color: C.lan }}>■</span> LAN</span>
                <span><span style={{ color: C.tunnel }}>⇡</span> cloudflared tunnel</span>
                <span><span style={{ color: C.public }}>●</span> public share</span>
              </div>
              {sections.map((s) => (
                <div key={s.key}>
                  {sectionHeader(s.title, s.color, s.groups.length)}
                  <div className="grid gap-2 sm:grid-cols-2 items-start">
                    {s.groups.map((g) => processCard(g, s.color))}
                  </div>
                </div>
              ))}
              {systemGroups.length > 0 && (
                <div>
                  <button onClick={() => setShowSystem((v) => !v)} className="w-full text-left">
                    {sectionHeader('system', '#4a5568', systemGroups.length, <span className="text-[11px] text-slate-500 ml-auto">{showSystem ? 'hide' : 'show'}</span>)}
                  </button>
                  {showSystem && <div className="grid gap-2 sm:grid-cols-2 items-start">{systemGroups.map((g) => processCard(g, '#4a5568'))}</div>}
                </div>
              )}
              {sections.length === 0 && systemGroups.length === 0 && <div className="text-slate-500 text-xs px-1 py-3">No listening ports found.</div>}
              {socketTunnels.length > 0 && (
                <div>
                  {sectionHeader('tunnels to unix sockets', C.tunnel, socketTunnels.length)}
                  <div className="rounded-xl overflow-hidden divide-y divide-[#ffffff08]" style={{ background: '#20203a', border: '1px solid #2d2d4a' }}>
                    {socketTunnels.map((t, i) => (
                      <div key={i} className="px-3 py-2 flex items-center gap-2 text-xs min-w-0">
                        <Badge color={C.tunnel} onClick={t.hostname ? () => openExternal(`https://${t.hostname}`) : undefined}>⇡ {t.hostname ?? 'quick tunnel'}</Badge>
                        <span className="text-slate-400 truncate font-mono text-[11px]" title={t.config ?? ''}>{t.target}</span>
                        {(t.context || t.user) && <Badge color={colorOf(t.context)}>{t.context ?? t.user}</Badge>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
