import { readPushData, type PushNotificationData } from '@sitelog/shared/notify/push.ts';

/**
 * The service worker's push handlers (W2-14; spec §9.3, §19 Q27), kept apart from the worker's
 * entry (`src/sw.ts`) so they run in unit tests with fakes. Typed by the few members they use, so
 * this module needs no `webworker` lib beside the app's DOM one.
 *
 * - `push`: shows the notification: the title, the §9.2 text in the reporter's language, the
 *   message's key as tag (a newer one of the same key replaces it), the app icon, and the link a
 *   tap opens in `data`.
 * - `notificationclick`: closes it and opens the link in the app: an open window of the app is
 *   navigated and focused; otherwise a new window opens. A link outside the app's origin (none
 *   today) opens in a new window as it is.
 */

export interface NotificationOptionsLike {
  body: string;
  tag: string;
  lang: string;
  icon: string;
  badge: string;
  data: { url: string | null };
}

export interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

export interface SwScope {
  location: { origin: string };
  registration: {
    showNotification(title: string, options: NotificationOptionsLike): Promise<void>;
  };
  clients: {
    matchAll(options: {
      type: 'window';
      includeUncontrolled: boolean;
    }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
}

export interface PushMessageDataLike {
  json(): unknown;
  text(): string;
}

/** The app icon of the notification (rendered by `pnpm brand`, as the manifest's). */
export const NOTIFICATION_ICON = '/brand/pwa-192.png';

/** The payload of a push event, whatever it holds (JSON from the worker, or plain text). */
export function pushEventData(data: PushMessageDataLike | null): PushNotificationData {
  if (!data) return readPushData(null);
  try {
    return readPushData(data.json());
  } catch {
    return readPushData(data.text());
  }
}

export function showPush(scope: SwScope, data: PushMessageDataLike | null): Promise<void> {
  const push = pushEventData(data);
  return scope.registration.showNotification(push.title, {
    body: push.body,
    tag: push.tag,
    lang: push.lang,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    data: { url: push.url },
  });
}

/** Where a tap goes: the message's link, or the app's start page. */
export function clickTarget(scope: SwScope, data: unknown): string {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : `${scope.location.origin}/`;
}

export async function openFromNotification(
  scope: SwScope,
  notification: { data: unknown; close(): void },
): Promise<void> {
  notification.close();
  const target = clickTarget(scope, notification.data);
  if (new URL(target).origin === scope.location.origin) {
    const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === scope.location.origin);
    if (open) {
      await open.navigate(target);
      await open.focus();
      return;
    }
  }
  await scope.clients.openWindow(target);
}
