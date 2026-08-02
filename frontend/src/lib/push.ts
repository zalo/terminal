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
  const sub = await reg.pushManager.getSubscription();
  if (sub) return { status: 'subscribed', endpoint: sub.endpoint };
  return { status: 'unsubscribed' };
}

export async function subscribeUserToPush(label?: string): Promise<PushState> {
  const reg = await registerServiceWorker();
  if (!reg) return { status: 'unsupported', reason: 'Service worker registration failed' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { status: 'denied' };

  const existing = await reg.pushManager.getSubscription();
  let sub = existing;
  if (!sub) {
    const res = await fetch('/api/push/vapid-public-key');
    const { publicKey } = await res.json();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast: TS's BufferSource requires Uint8Array<ArrayBuffer> (not
      // ArrayBufferLike). Our helper already returns ArrayBuffer-backed
      // bytes, so this is a narrowing assertion.
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
    });
  }

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
