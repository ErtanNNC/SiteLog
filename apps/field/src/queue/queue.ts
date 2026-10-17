import { MIN_CLIP_SECONDS } from '@sitelog/shared/field-contract.ts';
import { backoffDelay } from './backoff';
import { DraftRecorder } from './drafts';
import { browserLocks, draftLockName, lockFree, QUEUE_LOCK, type LockManagerLike } from './locks';
import { MemoryQueueStore } from './store';
import type { Persist, SendableUpload, UploadOutcome } from './uploader';
import {
  failedKind,
  storedUpload,
  type Draft,
  type NewUpload,
  type QueuedUpload,
  type QueueStore,
  type StoredUpload,
} from './types';

/**
 * The upload queue (F5 step 3; spec §9.3 "Expired / offline": the banner with the queued count):
 * items are persisted before anything is sent, sent one at a time in order, retried with backoff
 * (and at once on `online`, on the app coming back and on a tap), and resumed after a reload.
 * A refusal field-api will never change leaves the item `failed`, kept with its reason until the
 * reporter removes it; one a new pass through the link clears is sent again then (`relink`).
 *
 * One tab sends at a time (the `QUEUE_LOCK` Web Lock): each SMS tap may open another tab, and the
 * installed app can run beside the browser. Before each try the item's row is read again, so an
 * item another tab already sent (its row stays a while, `done`, without its file) or removed is
 * not sent twice. Nothing sends before `attach()`: a queue React builds and throws away (StrictMode
 * runs a state initializer twice) never sends.
 *
 * At the first `attach()` the queue picks up what a page that died left behind: photos a Recording
 * screen held, and recordings saved as they were made (drafts), which are queued as clips. Nothing
 * here touches the DOM, so it is unit-tested with a memory store and a fake uploader;
 * `QueueProvider` wires the browser.
 */

export interface QueueSnapshot {
  /** Every item of this session, oldest first (done ones included until the page reloads). */
  items: readonly QueuedUpload[];
  /** Queued or uploading: what the offline banner counts (held photos wait for their clip). */
  pending: number;
  /** The item being sent right now. */
  uploading: QueuedUpload | null;
  /** Items field-api refused, for the reporter to review (retry or remove). */
  failed: number;
  /** Items the phone's storage refused: they live in this page only until they are sent. */
  unsaved: number;
}

export interface QueueDeps {
  /** The store, once it is open (IndexedDB, else memory). */
  store: Promise<QueueStore> | QueueStore;
  /** One try: `uploadItem` with the app's routes, or a fake. `signal` aborts the try. */
  upload: (item: SendableUpload, persist: Persist, signal: AbortSignal) => Promise<UploadOutcome>;
  now?: () => number;
  random?: () => number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Web Locks; `undefined` takes the browser's, `null` runs without. */
  locks?: LockManagerLike | null;
  /** Asked once, when the first clip is queued: `navigator.storage.persist()` (best effort). */
  persistStorage?: () => void;
}

/** A try in flight longer than this is started over when the phone gets its signal back. */
export const STALL_MS = 15_000;
/** Another tab is sending: look again this much later. */
export const LOCK_RETRY_MS = 5_000;
/** A sent item's row (no file) stays this long, so another tab sees it was sent. */
export const DONE_KEEP_MS = 60 * 60_000;

type Listener = () => void;

const EMPTY: QueueSnapshot = { items: [], pending: 0, uploading: null, failed: 0, unsaved: 0 };

function baseType(mime: string | null): string {
  return (mime ?? '').split(';')[0]!.trim();
}

interface Flight {
  id: string;
  startedAt: number;
  controller: AbortController;
  /** Aborted by `kick({ now })`: tried again at once, not counted as a failure. */
  kicked: boolean;
}

export class UploadQueue {
  private readonly items = new Map<string, QueuedUpload>();
  private readonly listeners = new Set<Listener>();
  private readonly storeReady: Promise<QueueStore>;
  private store: QueueStore | null = null;
  private snapshot: QueueSnapshot = EMPTY;
  private busy = false;
  private wanted = false;
  private lockMissed = false;
  private timer: unknown = null;
  private detach: (() => void) | null = null;
  private started: Promise<void> | null = null;
  private flight: Flight | null = null;
  private askedPersistence = false;
  private readonly locks: LockManagerLike | null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.locks = deps.locks === undefined ? browserLocks() : deps.locks;
    this.storeReady = Promise.resolve(deps.store)
      .catch((err: unknown) => {
        console.warn('[field] the upload store did not open, queuing in memory', err);
        return new MemoryQueueStore() as QueueStore;
      })
      .then(async (store) => {
        let rows: StoredUpload[] = [];
        try {
          rows = await store.list();
        } catch (err) {
          // An unreadable store must not block new clips: start empty, the rows stay for later.
          console.warn('[field] could not read the queued uploads', err);
        }
        const keepFrom = this.now() - DONE_KEEP_MS;
        for (const row of rows) {
          if (row.status === 'done') {
            if ((row.doneAt ?? 0) < keepFrom) void store.delete(row.id).catch(() => undefined);
            continue;
          }
          // An item cut off mid-upload (the page died) is queued again; `process` reads the row
          // again under the lock, so one another tab is sending right now is not sent twice.
          const uploading = row.status === 'uploading';
          this.items.set(row.id, {
            ...row,
            status: uploading ? 'queued' : row.status,
            nextAt: uploading ? 0 : row.nextAt,
            blob: null,
            persisted: true,
          });
        }
        this.store = store;
        this.rebuild();
        return store;
      });
  }

  /** Resolves once the stored items are loaded. */
  ready(): Promise<void> {
    return this.storeReady.then(() => undefined);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): QueueSnapshot {
    return this.snapshot;
  }

  get(id: string): QueuedUpload | undefined {
    return this.items.get(id);
  }

  /**
   * Stores the item, then sends it when its turn comes. `hold` keeps a photo back until
   * `release(hold)` (its clip is queued); `draftId` is the recording the clip comes from, deleted
   * in the same write. A store that refuses the write (full, or a connection the browser dropped
   * twice) does not lose the item: it is sent from this page (`persisted: false`).
   */
  async enqueue(
    input: NewUpload,
    opts: { hold?: string; draftId?: string } = {},
  ): Promise<QueuedUpload> {
    const store = await this.storeReady;
    const item: QueuedUpload = {
      id: this.newId(),
      code: input.code,
      kind: input.kind,
      mime: input.mime,
      blob: input.blob,
      bytes: input.blob.size,
      siteId: input.siteId,
      date: input.date,
      recordedAt: input.recordedAt,
      ...(input.addTo ? { addTo: input.addTo } : {}),
      ...(input.answerTo ? { answerTo: input.answerTo } : {}),
      ...(input.fixTo ? { fixTo: input.fixTo } : {}),
      createdAt: this.now(),
      status: opts.hold ? 'held' : 'queued',
      attempts: 0,
      nextAt: 0,
      uploadId: null,
      signedUrl: null,
      putDone: false,
      error: null,
      result: null,
      holdId: opts.hold ?? null,
      doneAt: null,
      persisted: true,
    };
    try {
      await store.add(
        storedUpload(item),
        input.blob,
        opts.draftId ? { draftId: opts.draftId } : {},
      );
    } catch (err) {
      console.warn('[field] could not store a queued upload; sending it from this page', err);
      item.persisted = false;
      if (opts.draftId) {
        // The clip goes from memory: its draft must not come back as a second clip.
        await store.deleteDraft(opts.draftId).catch(() => undefined);
      }
    }
    this.items.set(item.id, item);
    if (input.kind === 'audio' && !this.askedPersistence) {
      this.askedPersistence = true;
      this.deps.persistStorage?.();
    }
    this.rebuild();
    if (item.status === 'queued') this.kick();
    return item;
  }

  /** A recording being made, saved chunk by chunk (`DraftRecorder`). */
  startDraft(meta: Pick<Draft, 'code' | 'siteId' | 'date'>): DraftRecorder {
    return new DraftRecorder(
      this.storeReady,
      { id: this.newId(), ...meta, mime: null, startedAt: null, createdAt: this.now() },
      this.locks,
    );
  }

  /** Sends the photos a Recording screen held (its clip is queued, or the screen went away). */
  release(holdId: string): Promise<void> {
    return this.storeReady.then(async () => {
      const held = [...this.items.values()].filter(
        (i) => i.status === 'held' && i.holdId === holdId,
      );
      for (const item of held) await this.persist({ ...item, status: 'queued', holdId: null });
      if (held.length > 0) {
        this.rebuild();
        this.kick();
      }
    });
  }

  /**
   * Tries now whatever is due, one at a time. `now` forgets the backoff (the phone got its signal
   * or the app back: F5 "retried on online / app open") and starts over a try stuck on a dead
   * connection.
   */
  kick(opts: { now?: boolean } = {}): void {
    if (opts.now) {
      for (const item of this.items.values()) {
        if (item.status === 'queued' && item.nextAt > 0) this.set({ ...item, nextAt: 0 });
      }
      const flight = this.flight;
      if (flight && this.now() - flight.startedAt > STALL_MS) {
        flight.kicked = true;
        flight.controller.abort();
      }
      this.lockMissed = false;
      this.rebuild();
    }
    if (!this.store) return;
    if (this.busy) {
      this.wanted = true;
      return;
    }
    void this.run();
  }

  /** Queues a failed item again and tries at once (a tap). */
  retry(id: string): Promise<void> {
    return this.storeReady.then(async () => {
      const item = this.items.get(id);
      if (!item || item.status !== 'failed') return;
      await this.persist({ ...item, status: 'queued', nextAt: 0, attempts: 0 });
      this.rebuild();
      this.kick();
    });
  }

  /**
   * The phone passed the link flow again (verified, consented, a newer link): the items refused
   * for the link or the phone (`RELINK_ERRORS`) go again, under `code`, when their site is one of
   * the link's. Waits for the stored items, so a cold open from the SMS retries those too.
   */
  relink(code: string, siteIds: readonly string[]): Promise<void> {
    return this.storeReady.then(async () => {
      const again = [...this.items.values()].filter(
        (i) =>
          i.status === 'failed' && failedKind(i.error) === 'relink' && siteIds.includes(i.siteId),
      );
      for (const item of again) {
        await this.persist({ ...item, code, status: 'queued', nextAt: 0, attempts: 0 });
      }
      if (again.length > 0) {
        this.rebuild();
        this.kick();
      }
    });
  }

  /** Drops an item that is not being sent (the reporter's tap: nothing else removes one). */
  async remove(id: string): Promise<void> {
    const store = await this.storeReady;
    const item = this.items.get(id);
    if (!item || item.status === 'uploading') return;
    this.items.delete(id);
    this.rebuild();
    if (!item.persisted) return;
    try {
      await store.delete(id);
    } catch (err) {
      console.warn('[field] could not delete a queued upload', err);
    }
  }

  /**
   * Resolves when the item is done or failed (rejecting nothing: read `status`); an item that is
   * not in the queue once the stored ones are loaded answers `failed` / `removed`.
   */
  async waitFor(id: string): Promise<QueuedUpload> {
    await this.storeReady;
    return new Promise((resolve) => {
      const check = () => {
        const item = this.items.get(id);
        if (!item) {
          unsubscribe();
          resolve({ ...this.failedPlaceholder(id) });
          return true;
        }
        if (item.status === 'done' || item.status === 'failed') {
          unsubscribe();
          resolve(item);
          return true;
        }
        return false;
      };
      const unsubscribe = this.subscribe(() => void check());
      check();
    });
  }

  /**
   * Listens for the moments a phone gets its signal or the app back (F5 "online / app open"), and
   * starts the queue: the first call picks up what a page that died left behind, then sends.
   */
  attach(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'> & { document?: Document },
  ) {
    this.detach?.();
    const onBack = () => this.kick({ now: true });
    const onVisible = () => {
      if (target.document?.visibilityState !== 'hidden') this.kick({ now: true });
    };
    target.addEventListener('online', onBack);
    target.addEventListener('pageshow', onBack);
    target.document?.addEventListener('visibilitychange', onVisible);
    this.detach = () => {
      target.removeEventListener('online', onBack);
      target.removeEventListener('pageshow', onBack);
      target.document?.removeEventListener('visibilitychange', onVisible);
      this.detach = null;
    };
    this.started ??= this.storeReady
      .then((store) => this.recover(store))
      .catch((err: unknown) => console.warn('[field] could not pick up earlier uploads', err));
    void this.started.then(() => this.kick());
    return this.detach;
  }

  dispose(): void {
    this.detach?.();
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────────

  /** What a page that died left: held photos (sent now) and recordings (queued as clips). */
  private async recover(store: QueueStore): Promise<void> {
    for (const item of [...this.items.values()]) {
      if (item.status === 'held') await this.persist({ ...item, status: 'queued', holdId: null });
    }
    let drafts: Draft[] = [];
    try {
      drafts = await store.listDrafts();
    } catch (err) {
      console.warn('[field] could not read the saved recordings', err);
    }
    for (const draft of drafts) {
      // Another tab still recording it holds its lock.
      if (!(await lockFree(this.locks, draftLockName(draft.id)))) continue;
      try {
        const chunks = await store.draftChunks(draft.id);
        const durationMs = chunks.at(-1)?.elapsedMs ?? 0;
        // A page that died in its first second may not have named the type yet: the chunks do.
        const mime = draft.mime ?? (chunks[0]?.blob.type || null);
        const blob = new Blob(
          chunks.map((c) => c.blob),
          { type: baseType(mime) },
        );
        if (!mime || blob.size === 0 || durationMs < MIN_CLIP_SECONDS * 1000) {
          // Nothing the Recording screen would have sent (F5 "recording < 5 s").
          await store.deleteDraft(draft.id);
          continue;
        }
        await this.enqueue(
          {
            code: draft.code,
            kind: 'audio',
            mime,
            blob,
            siteId: draft.siteId,
            date: draft.date,
            recordedAt: draft.startedAt,
          },
          { draftId: draft.id },
        );
      } catch (err) {
        console.warn('[field] could not pick up a saved recording', err);
      }
    }
    this.rebuild();
  }

  private failedPlaceholder(id: string): QueuedUpload {
    return {
      id,
      code: '',
      kind: 'audio',
      mime: '',
      blob: null,
      bytes: 0,
      siteId: '',
      date: '',
      recordedAt: null,
      createdAt: 0,
      status: 'failed',
      attempts: 0,
      nextAt: 0,
      uploadId: null,
      signedUrl: null,
      putDone: false,
      error: 'removed',
      result: null,
      holdId: null,
      doneAt: null,
      persisted: false,
    };
  }

  private set(item: QueuedUpload): void {
    this.items.set(item.id, item);
  }

  /** Keeps the item's state (never its file) in the store; a failed write leaves it in memory. */
  private async persist(item: QueuedUpload, opts: { dropFile?: boolean } = {}): Promise<void> {
    this.set(item);
    if (!item.persisted || !this.store) return;
    try {
      await this.store.put(storedUpload(item), opts);
    } catch (err) {
      console.warn('[field] could not persist a queued upload', err);
    }
  }

  private nextDue(): QueuedUpload | null {
    const now = this.now();
    let best: QueuedUpload | null = null;
    for (const item of this.items.values()) {
      if (item.status !== 'queued' || item.nextAt > now) continue;
      if (!best || item.createdAt < best.createdAt) best = item;
    }
    return best;
  }

  /** Runs `fn` while this tab holds the queue's lock; false when another tab has it. */
  private async withQueueLock(fn: () => Promise<void>): Promise<boolean> {
    if (!this.locks) {
      await fn();
      return true;
    }
    let ran = false;
    try {
      return await this.locks.request(QUEUE_LOCK, { ifAvailable: true }, async (lock) => {
        if (lock === null) return false;
        ran = true;
        await fn();
        return true;
      });
    } catch (err) {
      if (ran) throw err;
      // Web Locks refused (a sandboxed frame): send without, as a browser without them does.
      await fn();
      return true;
    }
  }

  private async run(): Promise<void> {
    this.busy = true;
    let locked = true;
    try {
      locked = await this.withQueueLock(async () => {
        for (;;) {
          this.wanted = false;
          const item = this.nextDue();
          if (!item) break;
          await this.process(item);
          if (!this.wanted && !this.nextDue()) break;
        }
      });
    } catch (err) {
      console.error('[field] the upload queue stopped', err);
    } finally {
      this.busy = false;
      this.lockMissed = !locked;
      this.schedule();
      if (this.wanted && locked) this.kick();
    }
  }

  /** The item as the store has it now: another tab may have sent, refused or removed it. */
  private async fresh(item: QueuedUpload): Promise<QueuedUpload | null> {
    if (!item.persisted) return item;
    let row: StoredUpload | undefined;
    try {
      row = await this.store!.get(item.id);
    } catch {
      return item;
    }
    if (!row) {
      this.items.delete(item.id);
      return null;
    }
    if (row.status === 'queued' || row.status === 'uploading') {
      // `uploading` under the lock is a try whose page died: this one takes it over. When to try
      // is this page's call (it may have just got its signal back).
      return {
        ...item,
        ...row,
        status: 'queued',
        nextAt: item.nextAt,
        blob: item.blob,
        persisted: true,
      };
    }
    this.set({ ...item, ...row, blob: row.status === 'done' ? null : item.blob, persisted: true });
    return null;
  }

  private async process(start: QueuedUpload): Promise<void> {
    const item = await this.fresh(start);
    if (!item) {
      this.rebuild();
      return;
    }
    let blob = item.blob;
    if (!blob) {
      try {
        blob = (await this.store!.file(item.id)) ?? null;
      } catch (err) {
        console.warn('[field] could not read a queued file', err);
        await this.persist({
          ...item,
          status: 'queued',
          attempts: item.attempts + 1,
          nextAt: this.now() + backoffDelay(item.attempts + 1, this.random),
          error: 'internal',
        });
        this.rebuild();
        return;
      }
    }
    if (!blob) {
      await this.persist({ ...item, status: 'failed', error: 'file_missing' });
      this.rebuild();
      return;
    }
    await this.persist({ ...item, status: 'uploading', error: null });
    this.rebuild();
    let current = this.items.get(item.id)!;
    const persist: Persist = async (patch) => {
      current = { ...(this.items.get(item.id) ?? current), ...patch };
      await this.persist(current);
    };
    const flight: Flight = {
      id: item.id,
      startedAt: this.now(),
      controller: new AbortController(),
      kicked: false,
    };
    this.flight = flight;
    let outcome: UploadOutcome;
    try {
      outcome = await this.deps.upload({ ...current, blob }, persist, flight.controller.signal);
    } catch (err) {
      console.error('[field] upload threw', err);
      outcome = { ok: false, permanent: false, error: 'internal' };
    } finally {
      this.flight = null;
    }
    current = this.items.get(item.id) ?? current;
    if (outcome.ok) {
      // Sent: the file goes from the phone; the row stays a while for other tabs, the result
      // for the screen.
      await this.persist(
        {
          ...current,
          status: 'done',
          result: outcome.result,
          error: null,
          blob: null,
          doneAt: this.now(),
        },
        { dropFile: true },
      );
    } else if (outcome.permanent) {
      await this.persist({ ...current, status: 'failed', error: outcome.error });
    } else if (flight.kicked) {
      await this.persist({ ...current, status: 'queued', nextAt: 0, error: outcome.error });
    } else {
      const attempts = current.attempts + 1;
      const wait = outcome.retryAfterMs ?? backoffDelay(attempts, this.random);
      await this.persist({
        ...current,
        status: 'queued',
        attempts,
        nextAt: this.now() + wait,
        error: outcome.error,
      });
    }
    this.rebuild();
  }

  /** A timer for the earliest `nextAt` still ahead (or the lock's retry), replacing any earlier one. */
  private schedule(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const now = this.now();
    let next = Infinity;
    for (const item of this.items.values()) {
      if (item.status === 'queued' && item.nextAt > now) next = Math.min(next, item.nextAt);
    }
    if (this.lockMissed && this.nextDue()) next = Math.min(next, now + LOCK_RETRY_MS);
    if (next === Infinity) return;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.kick();
      },
      Math.max(0, next - now),
    );
  }

  private rebuild(): void {
    const items = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.snapshot = {
      items,
      pending: items.filter((i) => i.status === 'queued' || i.status === 'uploading').length,
      uploading: items.find((i) => i.status === 'uploading') ?? null,
      failed: items.filter((i) => i.status === 'failed').length,
      unsaved: items.filter((i) => !i.persisted && i.status !== 'done').length,
    };
    this.listeners.forEach((l) => l());
  }
}
