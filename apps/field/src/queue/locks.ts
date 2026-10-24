/**
 * Web Locks (`navigator.locks`, Safari 15.4+, Chrome 69+), the part the queue uses: one tab sends
 * at a time, and a recording another tab is still making is never taken for a lost one. Where the
 * browser has none the queue runs without (a single tab, as before).
 */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T>;
}

/** The one tab that sends. */
export const QUEUE_LOCK = 'sitelog-field-upload-queue';

/** Held by the page recording a draft for as long as it records. */
export function draftLockName(draftId: string): string {
  return `sitelog-field-draft:${draftId}`;
}

export function browserLocks(): LockManagerLike | null {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/** True when nobody holds `name` (always true without Web Locks). */
export async function lockFree(locks: LockManagerLike | null, name: string): Promise<boolean> {
  if (!locks) return true;
  try {
    return await locks.request(name, { ifAvailable: true }, (lock) => lock !== null);
  } catch {
    return true;
  }
}
