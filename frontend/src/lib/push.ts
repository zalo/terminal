// Browser-side push subscription helpers.
//
// iOS requires the PWA to be installed to the Home Screen before
// Notification.requestPermission resolves to 'granted'. In normal Safari it
// will reject.

export type PushState =
  | { status: 'unsupported'; reason: string }
  | { status: 'not-installed-ios'; reason: string }
  | { status: 'denied' }
  | { status: 'unsubscribed' }
  | { status: 'subscribed'; endpoint: string };

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mq = window.matchMedia?.('(display-mode: standalone)');
  if (mq?.matches) return true;
  // iOS legacy property
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.error('SW registration failed:', e);
    return null;
  }
}

export async function getPushState(): Promise<PushState> {
  if (typeof window === 'undefined') return { status: 'unsupported', reason: 'no window' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    if (isIos() && !isStandalone()) {
      return { status: 'not-installed-ios', reason: 'Install to Home Screen first (Share → Add to Home Screen)' };
    }
    return { status: 'unsupported', reason: 'Push not available in this browser' };
  }
  if (isIos() && !isStandalone()) {
    return { status: 'not-installed-ios', reason: 'Install to Home Screen first (Share → Add to Home Screen)' };
  }
  if (Notification.permission === 'denied') return { status: 'denied' };
  const reg = await registerServiceWorker();
  if (!reg) return { status: 'unsupported', reason: 'Service worker registration failed' };
  return reconcileSubscription(reg);
}

// Make the browser's subscription and the server's record agree.
//
// The server regenerates its VAPID keys on a fresh install (this happened on
// the Ubuntu -> Omarchy move) and its subscription store is on disk, not in the
// browser. The PWA's old subscription survives both, so the bell showed "on"
// while the server had zero devices and every tm-notify went nowhere. Here:
//   - a subscription bound to a different server key is dropped and recreated
//   - any live subscription is (re)registered with the server, idempotently
//   - if permission is already granted, a missing subscription is recreated
//     without needing another tap
async function reconcileSubscription(reg: ServiceWorkerRegistration): Promise<PushState> {
  let serverKey: string | null = null;
  try {
    const res = await fetch('/api/push/vapid-public-key');
    serverKey = (await res.json()).publicKey ?? null;
  } catch {
    // offline / server down: fall back to reporting local state only
  }

  let sub = await reg.pushManager.getSubscription();
  if (sub && serverKey && !keyMatches(sub, serverKey)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    sub = null;
  }
  if (!sub && serverKey && Notification.permission === 'granted') {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(serverKey) as unknown as BufferSource,
      });
    } catch (e) {
      console.error('push resubscribe failed:', e);
    }
  }
  if (!sub) return { status: 'unsubscribed' };
  if (serverKey) await registerWithServer(sub, navigator.userAgent.slice(0, 80));
  return { status: 'subscribed', endpoint: sub.endpoint };
}

function keyMatches(sub: PushSubscription, serverKey: string): boolean {
  const local = sub.options?.applicationServerKey;
  if (!local) return true; // can't tell; assume fine
  return arrayBufferToBase64(local as ArrayBuffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    === serverKey.replace(/=+$/, '');
}

async function registerWithServer(sub: PushSubscription, label?: string): Promise<void> {
  const subJson = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: {
        p256dh: subJson.keys?.p256dh ?? arrayBufferToBase64(sub.getKey('p256dh')),
        auth: subJson.keys?.auth ?? arrayBufferToBase64(sub.getKey('auth')),
      },
      label,
    }),
  });
}

export async function subscribeUserToPush(label?: string): Promise<PushState> {
  const reg = await registerServiceWorker();
  if (!reg) return { status: 'unsupported', reason: 'Service worker registration failed' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { status: 'denied' };

  const res = await fetch('/api/push/vapid-public-key');
  const { publicKey } = await res.json();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !keyMatches(sub, publicKey)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast: TS's BufferSource requires Uint8Array<ArrayBuffer> (not
      // ArrayBufferLike). Our helper already returns ArrayBuffer-backed
      // bytes, so this is a narrowing assertion.
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
    });
  }

  await registerWithServer(sub, label);
  return { status: 'subscribed', endpoint: sub.endpoint };
}

export async function unsubscribeFromPush(): Promise<PushState> {
  if (!('serviceWorker' in navigator)) return { status: 'unsupported', reason: 'no SW' };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { status: 'unsubscribed' };
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { status: 'unsubscribed' };
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  return { status: 'unsubscribed' };
}
