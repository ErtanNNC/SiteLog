import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { FieldRoutes } from '@/api/field';
import { createAppQueue } from './appQueue';
import { QueueContext } from './context';
import type { UploadQueue } from './queue';

/**
 * One upload queue for the whole app, listening for `online`, `pageshow` and the page becoming
 * visible (F5 step 3 "retried on online / app open"). Tests hand in their own. The queue sends
 * only once attached: the copy StrictMode's second run of the initializer throws away never sends,
 * and other tabs are kept out by the queue's Web Lock.
 */
export function QueueProvider({
  queue: given,
  routes,
  children,
}: {
  queue?: UploadQueue;
  routes: FieldRoutes;
  children: ReactNode;
}) {
  const [queue] = useState(() => given ?? createAppQueue(routes));
  useEffect(() => {
    const detach = queue.attach(window);
    return () => {
      detach();
      if (!given) queue.dispose();
    };
  }, [queue, given]);
  return <QueueContext.Provider value={queue}>{children}</QueueContext.Provider>;
}
