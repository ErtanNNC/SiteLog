import type { PushSubscribeRequest } from '@sitelog/shared/field-api.ts';

/**
 * Web push in the browser (W2-14; spec §9.3, §19 Q27). Push is offered only in the installed app
 * (`display-mode: standalone`, or iOS's `navigator.standalone`) with the Push API and a service
 * worker: iOS delivers push only to an installed web app (16.4+), and an optional channel is
 * clearer where it works everywhere it shows. The browser's permission is asked only when the
 * reporter turns *Notifications* on, never on load.
 */

/** What the page needs from `window` (a fake in tests). */
export interface PushEnv {
  /** Absent in some engines (jsdom): then the app is not taken as installed. */
  matchMedia?: (query: string) => { matches: boolean };
  navigator: {
    standalone?: boolean;
    serviceWorker?: { ready: Promise<{ pushManager: PushManagerLike }> };
  };
  PushManager?: unknown;
  Notification?: { permission: string; requestPermission(): Promise<string> };
}

export interface PushSubscriptionLike {
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
  /** The key it was made with (`PushSubscription.options`); absent in older engines. */
  options?: { applicationServerKey?: ArrayBuffer | null };
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array;
  }): Promise<PushSubscriptionLike>;
}

const browser = (): PushEnv => window as unknown as PushEnv;

/** The app runs installed (home-screen icon), not in a browser tab. */
export function isInstalled(env: PushEnv = browser()): boolean {
  const standalone =
    typeof env.matchMedia === 'function' && env.matchMedia('(display-mode: standalone)').matches;
  return standalone || env.navigator.standalone === true;
}

/** Push can be offered on this phone: installed, with the Push API and a service worker. */
export function pushSupported(env: PushEnv = browser()): boolean {
  return (
    isInstalled(env) &&
    env.PushManager !== undefined &&
    env.Notification !== undefined &&
    env.navigator.serviceWorker !== undefined
  );
}

/** The browser refused notifications for the app (only the phone's settings can undo it). */
export function pushBlocked(env: PushEnv = browser()): boolean {
  return env.Notification?.permission === 'denied';
}

/** A VAPID public key (base64url) as the bytes `PushManager.subscribe` takes. */
export function applicationServerKey(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export type SubscribeResult =
  { kind: 'subscribed'; subscription: PushSubscribeRequest['subscription'] } | { kind: 'blocked' };

/** Asks for permission (on the toggle), then subscribes this browser with the key. */
export async function subscribeBrowser(
  publicKey: string,
  env: PushEnv = browser(),
): Promise<SubscribeResult> {
  const permission = await env.Notification!.requestPermission();
  if (permission !== 'granted') return { kind: 'blocked' };
  const { pushManager } = await env.navigator.serviceWorker!.ready;
  const key = applicationServerKey(publicKey);
  let existing = await pushManager.getSubscription();
  // A subscription made with another VAPID key (the pair rotated, another environment) is refused
  // by the push service for TalkOlog's key (403): drop it and subscribe with the current one.
  if (existing && !sameKey(existing.options?.applicationServerKey, key)) {
    await existing.unsubscribe().catch(() => false);
    existing = null;
  }
  const sub =
    existing ?? (await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  return {
    kind: 'subscribed',
    subscription: sub.toJSON() as PushSubscribeRequest['subscription'],
  };
}

/** The subscription's key is `key` (unknown, as in older engines, counts as the same). */
function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (current === undefined || current === null) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/** Drops this browser's subscription (after field-api revoked it); a failure changes nothing. */
export async function unsubscribeBrowser(env: PushEnv = browser()): Promise<void> {
  try {
    const { pushManager } = await env.navigator.serviceWorker!.ready;
    await (await pushManager.getSubscription())?.unsubscribe();
  } catch {
    // The server side is what stops the messages; the browser's copy is only tidied up.
  }
}
