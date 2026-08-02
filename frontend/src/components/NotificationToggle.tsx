import { useEffect, useState } from 'react';
import { getPushState, subscribeUserToPush, unsubscribeFromPush, type PushState } from '../lib/push';

export default function NotificationToggle() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPushState().then(setState);
  }, []);

  if (!state) return null;

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (state.status === 'subscribed') {
        const next = await unsubscribeFromPush();
        setState(next);
      } else if (state.status === 'unsubscribed' || state.status === 'denied') {
        const next = await subscribeUserToPush(navigator.userAgent.slice(0, 80));
        setState(next);
      }
    } catch (e) {
      console.error('notification toggle failed:', e);
    } finally {
      setBusy(false);
    }
  };

  // iOS-not-installed: surface instructions, no button
  if (state.status === 'not-installed-ios') {
    return (
      <div className="text-[11px] text-slate-500 text-center px-3">
        Notifications: tap <span className="text-slate-300">Share → Add to Home Screen</span> first
      </div>
    );
  }

  if (state.status === 'unsupported') {
    return null; // no UI on non-supporting browsers
  }

  const subscribed = state.status === 'subscribed';
  const denied = state.status === 'denied';

  return (
    <button
      onClick={handleClick}
      disabled={busy || denied}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        backgroundColor: subscribed ? '#4fd1c522' : '#2d2d4a',
        color: subscribed ? '#4fd1c5' : '#94a3b8',
        border: `1px solid ${subscribed ? '#4fd1c555' : '#3d3d5c'}`,
      }}
      title={denied ? 'Notifications blocked in browser settings' : subscribed ? 'Notifications on' : 'Enable notifications'}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {subscribed ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9M3 3l18 18" />
        )}
      </svg>
      {busy ? '…' : denied ? 'Blocked' : subscribed ? 'Notifications on' : 'Enable notifications'}
    </button>
  );
}
