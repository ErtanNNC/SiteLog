import { describe, expect, it, vi } from 'vitest';
import { createWakeLock, type WakeLockSentinelLike } from './wakeLock';

function fakeApi() {
  const sentinels: Array<WakeLockSentinelLike & { released: boolean; fire: () => void }> = [];
  const api = {
    request: vi.fn(async () => {
      let onRelease: (() => void) | null = null;
      const s = {
        released: false,
        release: vi.fn(async () => {
          s.released = true;
        }),
        addEventListener: (_t: 'release', l: () => void) => {
          onRelease = l;
        },
        fire: () => onRelease?.(),
      };
      sentinels.push(s);
      return s;
    }),
  };
  return { api, sentinels };
}

function fakeDoc(state: DocumentVisibilityState = 'visible') {
  const listeners = new Set<() => void>();
  return {
    visibilityState: state,
    addEventListener: (_t: string, l: () => void) => listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
    show() {
      this.visibilityState = 'visible';
      listeners.forEach((l) => l());
    },
    get listening() {
      return listeners.size;
    },
  };
}

describe('screen wake lock (§9.3)', () => {
  it('is unsupported without navigator.wakeLock, and records all the same', async () => {
    const lock = createWakeLock({ api: undefined, doc: fakeDoc() });
    expect(lock.supported).toBe(false);
    expect(await lock.acquire()).toBe(false);
    expect(lock.held).toBe(false);
    await lock.release();
  });

  it('acquires, reports, and releases', async () => {
    const { api, sentinels } = fakeApi();
    const doc = fakeDoc();
    const lock = createWakeLock({ api, doc });
    const seen: boolean[] = [];
    lock.onChange((h) => seen.push(h));
    expect(lock.supported).toBe(true);
    expect(await lock.acquire()).toBe(true);
    expect(lock.held).toBe(true);
    expect(await lock.acquire()).toBe(true); // idempotent: one sentinel
    expect(api.request).toHaveBeenCalledTimes(1);
    await lock.release();
    expect(lock.held).toBe(false);
    expect(sentinels[0]!.released).toBe(true);
    expect(seen).toEqual([true, false]);
    expect(doc.listening).toBe(0);
  });

  it('asks again when the page comes back while the lock is still wanted', async () => {
    const { api, sentinels } = fakeApi();
    const doc = fakeDoc();
    const lock = createWakeLock({ api, doc });
    await lock.acquire();
    // The browser drops the lock when the phone locks or a call comes in.
    sentinels[0]!.fire();
    expect(lock.held).toBe(false);
    doc.show();
    await Promise.resolve();
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(true);
    await lock.release();
    doc.show();
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it('treats a refused request as not held', async () => {
    const api = { request: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) };
    const lock = createWakeLock({ api, doc: fakeDoc() });
    expect(await lock.acquire()).toBe(false);
    expect(lock.held).toBe(false);
  });

  it('lets go of a lock granted after release() was called', async () => {
    const { api, sentinels } = fakeApi();
    const lock = createWakeLock({ api, doc: fakeDoc() });
    const pending = lock.acquire();
    await lock.release();
    expect(await pending).toBe(false);
    expect(sentinels[0]!.released).toBe(true);
    expect(lock.held).toBe(false);
  });
});
