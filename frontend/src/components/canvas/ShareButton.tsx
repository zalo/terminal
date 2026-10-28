// Header button for browser/preview tiles that point at a localhost port:
// toggles a time-limited public share of that port and shows the public URL.
// Renders nothing for non-local URLs. Sharing is off by default; the server
// enforces the expiry.

import { useEffect, useRef, useState } from 'react';
import { localPortOf } from '../../lib/frameSrc';
import { createShare, fetchShares, remainingLabel, revokeShare, type ShareInfo, type ShareState } from '../../lib/share';

interface ShareButtonProps {
  url: string | undefined;
  /** Header height in px; the panel hangs just below it. */
  headerHeight: number;
}

const QUICK_MINUTES = [60, 8 * 60, 24 * 60];

function quickLabel(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

export default function ShareButton({ url, headerHeight }: ShareButtonProps) {
  const port = url ? localPortOf(url)?.port ?? null : null;
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [limits, setLimits] = useState<Pick<ShareState, 'origin' | 'defaultMinutes' | 'maxMinutes'> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    if (port === null) return;
    try {
      const s = await fetchShares();
      setLimits({ origin: s.origin, defaultMinutes: s.defaultMinutes, maxMinutes: s.maxMinutes });
      setShare(s.shares.find((x) => x.port === port) ?? null);
    } catch { /* offline or not an admin client — leave as is */ }
  };

  useEffect(() => {
    if (port === null) return;
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // Countdown repaint + local expiry while the panel is open.
  useEffect(() => {
    if (!share) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      if (share.expiresAt <= Date.now()) setShare(null);
    }, 1000);
    return () => clearInterval(id);
  }, [share]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  if (port === null) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const shareFor = (minutes?: number) => run(async () => { setShare(await createShare(port, minutes)); setOpen(true); });
  const stop = () => run(async () => { await revokeShare(port); setShare(null); setOpen(false); });
  const publicUrl = share?.url ?? (limits?.origin ? `${limits.origin}/lp/${port}/` : `/lp/${port}/`);
  const copy = async () => {
    try { await navigator.clipboard.writeText(publicUrl); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* no clipboard */ }
  };
  const stopPointer = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div className="relative" onPointerDown={stopPointer}>
      <button
        className="tile-btn"
        title={share ? `Public for ${remainingLabel(share.expiresAt)} more — click to manage` : `Share localhost:${port} publicly for ${limits?.defaultMinutes ?? 60} min`}
        style={share ? { color: 'var(--cv-accent)' } : undefined}
        disabled={busy}
        onClick={() => (share ? setOpen((o) => !o) : shareFor())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 rounded-lg p-2.5 text-[11px] flex flex-col gap-2 glass"
          style={{
            top: headerHeight - 6, width: 300, zIndex: 50, cursor: 'default',
            background: 'color-mix(in srgb, var(--cv-bg) 92%, transparent)',
            border: '1px solid var(--cv-edge)', color: 'var(--cv-ink)',
            boxShadow: '0 12px 36px rgba(4,6,20,.45)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {share ? <>Public · {remainingLabel(share.expiresAt)} left</> : 'Not shared'}
            </span>
            <span className="opacity-60 font-mono">localhost:{port}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              readOnly value={publicUrl}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 px-2 py-1 rounded-md font-mono text-[11px] outline-none"
              style={{ background: 'color-mix(in srgb, var(--cv-bg) 55%, transparent)', border: '1px solid var(--cv-edge)', color: 'var(--cv-ink)' }}
            />
            <button className="tile-btn px-2" style={{ width: 'auto' }} onClick={copy} title="Copy link">
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="opacity-60">{share ? 'renew for' : 'share for'}</span>
            {QUICK_MINUTES.filter((m) => !limits || m <= limits.maxMinutes).map((m) => (
              <button key={m} className="tile-btn px-2" style={{ width: 'auto' }} disabled={busy} onClick={() => shareFor(m)}>
                {quickLabel(m)}
              </button>
            ))}
            {share && (
              <button
                className="tile-btn px-2 ml-auto" style={{ width: 'auto', color: '#f87171' }}
                disabled={busy} onClick={stop}
              >
                stop
              </button>
            )}
          </div>
          {error && <div style={{ color: '#f87171' }}>{error}</div>}
          <div className="opacity-50 leading-snug">
            Anyone with the link can reach this port until it expires. No login is required on the share host.
          </div>
        </div>
      )}
    </div>
  );
}
