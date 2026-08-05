// Session roster sidebar: needs-you first, then working, then quiet.
// Rows only regroup when a session's status band changes — within a band,
// order is stable (by creation) so nothing jumps around while you watch.

import { useState } from 'react';
import { sessionColor, STATUS_COLORS } from '../../lib/canvas/colors';
import type { RosterEntry } from '../../lib/canvas/types';

interface ContextInfo { name: string; label: string }

interface CanvasSidebarProps {
  sessions: RosterEntry[];
  contexts: ContextInfo[];
  onZoom: (key: string) => void;
  onOpen: (session: RosterEntry) => void;
  onCreate: (name: string, context?: string) => Promise<string | null>; // returns error or null
  onNewBrowser?: () => void;
  onDismiss?: () => void;  // mobile sheet close
}

function band(s: RosterEntry): 0 | 1 | 2 {
  const st = s.meta?.status;
  if (st === 'waiting') return 0;
  if (st === 'working') return 1;
  return 2;
}

const BAND_LABELS = ['needs you', 'working', 'quiet'];

export default function CanvasSidebar({
  sessions, contexts, onZoom, onOpen, onCreate, onNewBrowser, onDismiss,
}: CanvasSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [ctx, setCtx] = useState(contexts[0]?.name || '');
  const [error, setError] = useState('');
  const multiContext = contexts.length > 0;

  const groups: RosterEntry[][] = [[], [], []];
  for (const s of [...sessions].sort((a, b) => a.created.localeCompare(b.created))) {
    groups[band(s)].push(s);
  }

  const submit = async () => {
    if (!name.trim()) return;
    const err = await onCreate(name.trim(), multiContext ? (ctx || contexts[0]?.name) : undefined);
    if (err) { setError(err); return; }
    setName(''); setError(''); setCreating(false);
  };

  return (
    <div className="glass pointer-events-auto flex flex-col w-[264px] max-w-[80vw] h-auto max-h-full rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: 'var(--cv-ink-dim)' }}>
          Sessions
        </span>
        {onDismiss && (
          <button className="tile-btn" onClick={onDismiss} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        {sessions.length === 0 && (
          <div className="px-3 py-6 text-xs" style={{ color: 'var(--cv-ink-dim)' }}>
            No sessions running. Create one below, or say &ldquo;start a new session&rdquo;.
          </div>
        )}
        {groups.map((group, gi) => group.length > 0 && (
          <div key={gi} className="mb-2">
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.16em]"
              style={{ color: gi === 0 ? 'var(--cv-accent)' : 'var(--cv-ink-dim)' }}>
              {BAND_LABELS[gi]}
            </div>
            {group.map((s) => {
              const color = sessionColor(s.key);
              const st = s.meta?.status;
              return (
                <div
                  key={s.key}
                  className="sidebar-row group flex items-start gap-2.5 w-full px-3 py-2 rounded-xl cursor-pointer"
                  onClick={() => onZoom(s.key)}
                >
                  <span
                    className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${st === 'working' ? 'animate-pulse' : ''}`}
                    style={{ backgroundColor: st ? STATUS_COLORS[st] : '#565b7a' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-mono text-[13px] font-semibold lowercase" style={{ color }}>
                        {s.callsign}
                      </span>
                      <span className="text-[11px] truncate" style={{ color: 'var(--cv-ink-dim)' }}>
                        {s.name}{multiContext ? ` · ${s.context}` : ''}
                      </span>
                    </div>
                    {s.meta?.task && (
                      <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--cv-ink-dim)' }}>
                        {s.meta.task}
                      </div>
                    )}
                  </div>
                  <button
                    className="tile-btn opacity-0 group-hover:opacity-100 flex-shrink-0"
                    title="Open full view"
                    onClick={(e) => { e.stopPropagation(); onOpen(s); }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                      <path d="M7 17L17 7M9 7h8v8" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="p-3 border-t" style={{ borderColor: 'var(--cv-edge)' }}>
        {creating ? (
          <div>
            {multiContext && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {contexts.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setCtx(c.name)}
                    className="px-2 py-1 rounded-md text-[10px] uppercase tracking-wide font-semibold"
                    style={{
                      color: ctx === c.name ? 'var(--cv-bg)' : 'var(--cv-accent)',
                      background: ctx === c.name ? 'var(--cv-accent)' : 'color-mix(in srgb, var(--cv-accent) 14%, transparent)',
                    }}
                  >
                    {c.label || c.name}
                  </button>
                ))}
              </div>
            )}
            <input
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') { setCreating(false); setName(''); setError(''); }
              }}
              placeholder="session name"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: 'color-mix(in srgb, var(--cv-bg) 60%, transparent)',
                border: '1px solid var(--cv-edge)',
                color: 'var(--cv-ink)',
              }}
            />
            {error && <p className="text-red-400 text-[11px] mt-1">{error}</p>}
            <div className="flex gap-2 mt-2">
              <button
                className="flex-1 py-1.5 rounded-lg text-xs"
                style={{ color: 'var(--cv-ink-dim)', border: '1px solid var(--cv-edge)' }}
                onClick={() => { setCreating(false); setName(''); setError(''); }}
              >
                Cancel
              </button>
              <button
                className="flex-1 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: 'var(--cv-accent)', color: 'var(--cv-bg)' }}
                onClick={submit}
              >
                Create
              </button>
            </div>
          </div>
        ) : (
          <button
            className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5"
            style={{
              color: 'var(--cv-accent)',
              background: 'color-mix(in srgb, var(--cv-accent) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--cv-accent) 30%, transparent)',
            }}
            onClick={() => setCreating(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New session
          </button>
        )}
        {onNewBrowser && !creating && (
          <button
            className="w-full mt-2 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5"
            style={{ color: 'var(--cv-ink-dim)', border: '1px solid var(--cv-edge)' }}
            onClick={onNewBrowser}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.4 2.5 3.7 5.6 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.6-3.7-9s1.3-6.5 3.7-9z" />
            </svg>
            New browser window
          </button>
        )}
      </div>
    </div>
  );
}
