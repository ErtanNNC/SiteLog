/**
 * Screen Wake Lock while recording (spec §9.3 "Screen Wake Lock while recording"), feature
 * detected: a browser without `navigator.wakeLock` (older iOS Safari) records all the same, and
 * the Recording screen says "the screen stays on" only when the lock is held.
 *
 * The lock is released by the browser whenever the page is hidden (a call, the lock screen), so
 * it is asked for again when the page becomes visible while still wanted.
 */

export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** What the lock needs of `document`: its visibility and the `visibilitychange` event. */
export interface VisibilityDoc {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface WakeLockDeps {
  /** `navigator.wakeLock`, or undefined when the browser has none. */
  api: WakeLockApi | undefined;
  /** `document`, for `visibilitychange` (undefined outside a browser). */
  doc?: VisibilityDoc;
}

export interface WakeLock {
  /** Whether the browser can hold a screen lock at all. */
  readonly supported: boolean;
  /** Whether a lock is held right now. */
  readonly held: boolean;
  /** Asks for the lock (and keeps asking after the page is hidden and shown again). */
  acquire(): Promise<boolean>;
  /** Releases it and stops re-acquiring. */
  release(): Promise<void>;
  /** Called whenever `held` changes. */
  onChange(listener: (held: boolean) => void): () => void;
}

function browserDeps(): WakeLockDeps {
  const nav = globalThis.navigator as (Navigator & { wakeLock?: WakeLockApi }) | undefined;
  return {
    api: nav?.wakeLock,
    doc: typeof document === 'undefined' ? undefined : document,
  };
}

export function createWakeLock(deps: WakeLockDeps = browserDeps()): WakeLock {
  let sentinel: WakeLockSentinelLike | null = null;
  let wanted = false;
  const listeners = new Set<(held: boolean) => void>();
  const emit = () => listeners.forEach((l) => l(sentinel !== null));

  const onVisible = () => {
    if (wanted && sentinel === null && deps.doc?.visibilityState === 'visible') void request();
  };

  async function request(): Promise<boolean> {
    if (!deps.api) return false;
    try {
      const s = await deps.api.request('screen');
      if (!wanted) {
        await s.release().catch(() => undefined);
        return false;
      }
      sentinel = s;
      s.addEventListener?.('release', () => {
        if (sentinel === s) {
          sentinel = null;
          emit();
        }
      });
      emit();
      return true;
    } catch {
      // Refused (low battery, a hidden page): the recording goes on without it.
      return false;
    }
  }

  return {
    get supported() {
      return deps.api !== undefined;
    },
    get held() {
      return sentinel !== null;
    },
    async acquire() {
      if (!deps.api) return false;
      if (!wanted) {
        wanted = true;
        deps.doc?.addEventListener('visibilitychange', onVisible);
      }
      if (sentinel) return true;
      return request();
    },
    async release() {
      wanted = false;
      deps.doc?.removeEventListener('visibilitychange', onVisible);
      const s = sentinel;
      sentinel = null;
      if (s) {
        await s.release().catch(() => undefined);
        emit();
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
