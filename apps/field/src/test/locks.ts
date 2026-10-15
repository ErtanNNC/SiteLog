import type { LockManagerLike } from '@/queue/locks';

/** An in-memory LockManager shared by the queues of one test (two "tabs"). */
export class MemoryLocks implements LockManagerLike {
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();

  async request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve) => {
        const list = this.waiting.get(name) ?? [];
        list.push(resolve);
        this.waiting.set(name, list);
      });
    }
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
      this.waiting.get(name)?.shift()?.();
    }
  }

  isHeld(name: string): boolean {
    return this.held.has(name);
  }
}
