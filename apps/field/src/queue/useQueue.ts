import { useContext, useSyncExternalStore } from 'react';
import type { QueueSnapshot, UploadQueue } from './queue';
import { QueueContext } from './context';

export function useQueue(): UploadQueue {
  const queue = useContext(QueueContext);
  if (!queue) throw new Error('useQueue needs a QueueProvider');
  return queue;
}

/** The queue's state, re-rendering on every change. */
export function useQueueSnapshot(): QueueSnapshot {
  const queue = useQueue();
  return useSyncExternalStore(
    (listener) => queue.subscribe(listener),
    () => queue.getSnapshot(),
    () => queue.getSnapshot(),
  );
}
