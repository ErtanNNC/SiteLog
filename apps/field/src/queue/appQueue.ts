import type { FieldRoutes } from '@/api/field';
import { UploadQueue } from './queue';
import { openQueueStore } from './store';
import { uploadItem } from './uploader';

/**
 * The app's queue: IndexedDB (else memory), field-api through the given routes, Web Locks, and
 * persistent storage asked for once a clip is queued (so the browser does not evict the queue).
 */
export function createAppQueue(routes: FieldRoutes): UploadQueue {
  return new UploadQueue({
    store: openQueueStore(),
    upload: (item, persist, signal) => uploadItem(item, { routes }, persist, signal),
    persistStorage: () => {
      const storage = (globalThis.navigator as Navigator | undefined)?.storage;
      if (typeof storage?.persist === 'function') void storage.persist().catch(() => undefined);
    },
  });
}
