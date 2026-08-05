// The voice bar — the canvas's signature element. A frosted capsule at the
// bottom of the screen holding the mic orb and the conversation: your words
// appear in italic serif (spoken language gets a different material than
// machine text), the agent's replies beneath, tool actions as mono chips.
// Saying "go to sleep" ends the session; the orb wakes it again.

import { useEffect, useRef, useState } from 'react';
import type { VoiceStatus } from '../../lib/voice/voiceAgent';
import { canvasSocket } from '../../lib/canvas/ws';
import type { VoiceEvent } from '../../lib/canvas/ws';

interface VoiceBarProps {
  status: VoiceStatus;
  userText: string;
  assistantText: string;
  action: string;
  onWake: () => void;
  onSleep: () => void;
}

const STATUS_LABEL: Record<VoiceStatus, string> = {
  off: 'Tap to speak',
  connecting: 'Connecting…',
  idle: 'Listening for you',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  nokey: 'Add GROK_API_KEY to .env to enable voice',
  error: 'Voice hit an error — tap to retry',
};

export default function VoiceBar({
  status, userText, assistantText, action, onWake, onSleep,
}: VoiceBarProps) {
  const active = status !== 'off' && status !== 'nokey' && status !== 'error';
  const [remote, setRemote] = useState<VoiceEvent | null>(null);
  const remoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show what other clients are saying to their voice agents.
  useEffect(() => {
    const off = canvasSocket.onVoice((e) => {
      setRemote(e);
      if (remoteTimer.current) clearTimeout(remoteTimer.current);
      remoteTimer.current = setTimeout(() => setRemote(null), 6000);
    });
    return () => { off(); if (remoteTimer.current) clearTimeout(remoteTimer.current); };
  }, []);

  const showConversation = active && (userText || assistantText || action);

  return (
    <div className="voice-bar pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center px-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      {remote && (
        <div className="pointer-events-auto glass mb-2 px-3 py-1.5 rounded-full text-[11px] max-w-[80vw] truncate">
          <span className="font-mono lowercase" style={{ color: remote.color }}>{remote.name}</span>
          <span style={{ color: 'var(--cv-ink-dim)' }}>
            {' '}{remote.payload.action ? `· ${remote.payload.action}` : remote.payload.transcript ? `“${remote.payload.transcript}”` : `is ${remote.payload.state}`}
          </span>
        </div>
      )}

      <div className={`pointer-events-auto glass rounded-3xl w-full max-w-xl transition-all ${showConversation ? 'px-4 pt-3 pb-2.5' : 'px-2.5 py-2'}`}>
        {showConversation && (
          <div className="mb-2 max-h-28 overflow-hidden flex flex-col justify-end">
            {userText && (
              <p className="voice-spoken m-0 text-[15px] leading-snug" style={{ color: 'var(--cv-ink)' }}>
                “{userText}”
              </p>
            )}
            {action && (
              <p className="m-0 mt-1 font-mono text-[11px]" style={{ color: 'var(--cv-accent)' }}>
                ▸ {action}
              </p>
            )}
            {assistantText && (
              <p className="voice-spoken m-0 mt-1 text-[13px] leading-snug" style={{ color: 'var(--cv-ink-dim)' }}>
                {assistantText}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            className={`voice-orb voice-orb-${status} flex-shrink-0`}
            onClick={active ? onSleep : onWake}
            title={active ? 'Put voice to sleep' : 'Wake voice'}
            aria-label={active ? 'Put voice to sleep' : 'Wake voice'}
          >
            {active ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            )}
          </button>
          <span className="text-xs flex-1 truncate" style={{ color: 'var(--cv-ink-dim)' }}>
            {STATUS_LABEL[status]}
          </span>
          {active && (
            <button
              className="text-[11px] px-2.5 py-1 rounded-full flex-shrink-0"
              style={{ color: 'var(--cv-ink-dim)', border: '1px solid var(--cv-edge)' }}
              onClick={onSleep}
            >
              go to sleep
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
