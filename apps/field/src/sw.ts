import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NAVIGATE_FALLBACK_DENYLIST } from '../config/pwa-rules.ts';
import {
  openFromNotification,
  showPush,
  type PushMessageDataLike,
  type SwScope,
} from './sw/handlers';

/**
 * The field app's service worker (W2-14; `injectManifest`, `config/pwa.ts`). The same shell-only
 * rules as the week-1 `generateSW` worker: the precached build (`self.__WB_MANIFEST`, the globs
 * of `PRECACHE_GLOBS`), outdated caches removed, the app shell for navigations except `/api`,
 * control of the first page on install, no runtime caching and no `skipWaiting`. Added: the web
 * push handlers (`src/sw/handlers.ts`).
 */

interface ServiceWorkerSelf extends SwScope {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
  addEventListener(
    type: 'push',
    listener: (event: {
      data: PushMessageDataLike | null;
      waitUntil(p: Promise<unknown>): void;
    }) => void,
  ): void;
  addEventListener(
    type: 'notificationclick',
    listener: (event: {
      notification: { data: unknown; close(): void };
      waitUntil(p: Promise<unknown>): void;
    }) => void,
  ): void;
}

declare const self: ServiceWorkerSelf;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: NAVIGATE_FALLBACK_DENYLIST,
  }),
);
clientsClaim();

self.addEventListener('push', (event) => event.waitUntil(showPush(self, event.data)));
self.addEventListener('notificationclick', (event) =>
  event.waitUntil(openFromNotification(self, event.notification)),
);
