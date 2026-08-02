// Web Push (RFC 8030 / VAPID) support for the terminal app.
//
// On first boot, generates a VAPID keypair and stores it at
// $REPO/config/vapid-keys.json (mode 0600). Persists browser push
// subscriptions at $REPO/config/push-subscriptions.json. Exposes helpers to
// add/remove subscriptions and to fan a payload out to every subscription
// (pruning subscriptions that the push service has marked gone).
//
// iOS Safari supports the Web Push standard for home-screen-installed PWAs
// since 16.4. See:
// https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers

import fs from 'fs';
import path from 'path';
import webpush from 'web-push';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(REPO_ROOT, 'config');
const VAPID_FILE = path.join(CONFIG_DIR, 'vapid-keys.json');
const SUBS_FILE = path.join(CONFIG_DIR, 'push-subscriptions.json');

interface VapidKeys { publicKey: string; privateKey: string; }

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  userAgent?: string;
  createdAt: number;
}

let vapid: VapidKeys | null = null;
let subscriptions: StoredSubscription[] = [];

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadOrCreateVapid(): VapidKeys {
  try {
    return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
  } catch {
    ensureDir();
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.log(`[push] generated new VAPID keys → ${VAPID_FILE}`);
    return keys;
  }
}

function loadSubs(): StoredSubscription[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSubs() {
  ensureDir();
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2), { mode: 0o600 });
}

export function initPush(): void {
  vapid = loadOrCreateVapid();
  subscriptions = loadSubs();
  const contact = process.env.VAPID_CONTACT || 'mailto:noreply@localhost';
  webpush.setVapidDetails(contact, vapid.publicKey, vapid.privateKey);
  console.log(`[push] ${subscriptions.length} subscription(s) loaded`);
}

export function getVapidPublicKey(): string {
  if (!vapid) throw new Error('push not initialized');
  return vapid.publicKey;
}

export function listSubscriptions(): StoredSubscription[] {
  return subscriptions.map((s) => ({ ...s }));
}

export function addSubscription(input: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  userAgent?: string;
}): void {
  const existing = subscriptions.findIndex((s) => s.endpoint === input.endpoint);
  const entry: StoredSubscription = {
    endpoint: input.endpoint,
    keys: input.keys,
    label: input.label,
    userAgent: input.userAgent,
    createdAt: Date.now(),
  };
  if (existing >= 0) subscriptions[existing] = entry;
  else subscriptions.push(entry);
  saveSubs();
}

export function removeSubscription(endpoint: string): boolean {
  const before = subscriptions.length;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  const removed = subscriptions.length !== before;
  if (removed) saveSubs();
  return removed;
}

export interface NotifyPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  icon?: string;
  data?: Record<string, unknown>;
}

export interface NotifyResult {
  sent: number;
  gone: number;
  errors: number;
  total: number;
}

export async function sendToAll(payload: NotifyPayload): Promise<NotifyResult> {
  if (!vapid) throw new Error('push not initialized');
  const body = JSON.stringify(payload);
  let sent = 0;
  let gone = 0;
  let errors = 0;
  const dead: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: 60 },
        );
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Push service says this subscription is gone. Prune it.
          dead.push(sub.endpoint);
          gone++;
        } else {
          errors++;
          console.error(`[push] send error (status=${status}):`, (e as Error).message);
        }
      }
    }),
  );

  if (dead.length > 0) {
    subscriptions = subscriptions.filter((s) => !dead.includes(s.endpoint));
    saveSubs();
  }

  return { sent, gone, errors, total: subscriptions.length };
}
