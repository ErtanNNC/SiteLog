import { describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from '@/test/fakeIndexedDb';
import { MemoryLocks } from '@/test/locks';
import { draftLockName } from './locks';
import { DONE_KEEP_MS, STALL_MS, UploadQueue, type QueueDeps } from './queue';
import { MemoryQueueStore, openIndexedDbQueueStore } from './store';
import type { NewUpload, QueuedUpload, StoredUpload } from './types';
import type { UploadOutcome } from './uploader';

const result = {
  reportId: 'r1',
  reportNo: 'RL-2041-0188',
  reportStatus: 'processing' as const,
  created: true,
  alreadyComplete: false,
};

function input(patch: Partial<NewUpload> = {}): NewUpload {
  return {
    code: 'K7Q2MX',
    kind: 'audio',
    mime: 'audio/webm',
    blob: new Blob(['abc'], { type: 'audio/webm' }),
    siteId: 'site-1',
    date: '2026-10-09',
    recordedAt: null,
    ...patch,
  };
}

function row(id: string, patch: Partial<StoredUpload> = {}): StoredUpload {
  return {
    id,
    code: 'K7Q2MX',
    kind: 'audio',
    mime: 'audio/webm',
    bytes: 3,
    siteId: 'site-1',
    date: '2026-10-09',
    recordedAt: null,
    createdAt: 1,
    status: 'queued',
    attempts: 0,
    nextAt: 0,
    uploadId: null,
    signedUrl: null,
    putDone: false,
    error: null,
    result: null,
    holdId: null,
    doneAt: null,
    ...patch,
  };
}

/** A window the queue can listen to. */
function fakeWindow() {
  return new EventTarget() as unknown as Window;
}

/** A queue on a memory store with a scripted uploader and a manual clock. */
function harness(
  outcomes: UploadOutcome[] = [],
  {
    store = new MemoryQueueStore(),
    locks = null,
    attach = true,
    clock = { now: 1_000 },
    prefix = 'q',
  }: {
    store?: MemoryQueueStore;
    locks?: MemoryLocks | null;
    attach?: boolean;
    clock?: { now: number };
    prefix?: string;
  } = {},
) {
  const timers: { fn: () => void; at: number }[] = [];
  const calls: QueuedUpload[] = [];
  const signals: AbortSignal[] = [];
  let n = 0;
  const upload = vi.fn(async (item: QueuedUpload, _persist: unknown, signal: AbortSignal) => {
    calls.push(item);
    signals.push(signal);
    return outcomes.shift() ?? ({ ok: true, result } as UploadOutcome);
  });
  const deps: QueueDeps = {
    store,
    upload,
    now: () => clock.now,
    random: () => 0.5,
    newId: () => `${prefix}${++n}`,
    locks,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock.now + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const queue = new UploadQueue(deps);
  const win = fakeWindow();
  if (attach) queue.attach(win);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Moves the clock and fires the timers that came due. */
  const advance = async (ms: number) => {
    clock.now += ms;
    const due = timers.filter((t) => t.at <= clock.now);
    for (const t of due) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    await flush();
  };
  return { queue, store, upload, calls, signals, timers, flush, advance, clock, win };
}

describe('UploadQueue (F5 step 3, §9.3 offline)', () => {
  it('persists before sending, sends in order, and keeps only a file-less row once done', async () => {
    const h = harness();
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    // In the store, file apart from the row, before (and while) it is sent.
    expect(h.store.files.get(a.id)?.size).toBe(3);
    expect(h.store.items.get(a.id)).not.toHaveProperty('blob');
    const done = await h.queue.waitFor(a.id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual(result);
    expect(done.blob).toBeNull();
    // The file is gone; the row stays a while (for other tabs) with the result.
    expect(h.store.files.has(a.id)).toBe(false);
    expect(h.store.items.get(a.id)).toMatchObject({ status: 'done', doneAt: 1_000 });
    expect(h.queue.getSnapshot()).toMatchObject({ pending: 0, failed: 0, uploading: null });
    expect(h.queue.getSnapshot().items.map((i) => i.id)).toEqual([a.id]);
  });

  it('writes the file once: status changes rewrite the row only', async () => {
    const store = new MemoryQueueStore();
    const add = vi.spyOn(store, 'add');
    const put = vi.spyOn(store, 'put');
    const h = harness([{ ok: false, permanent: false, error: 'network' }], { store });
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    await h.flush();
    await h.advance(2_000);
    await h.queue.waitFor(a.id);
    expect(add).toHaveBeenCalledOnce();
    for (const [stored] of put.mock.calls) expect(stored).not.toHaveProperty('blob');
    expect(put.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('retries with backoff and jitter after a failure, at once on online', async () => {
    const h = harness([
      { ok: false, permanent: false, error: 'network' },
      { ok: false, permanent: false, error: 'network' },
    ]);
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    await h.flush();
    expect(h.calls).toHaveLength(1);
    const after1 = h.queue.get(a.id)!;
    expect(after1).toMatchObject({ status: 'queued', attempts: 1, error: 'network' });
    // 2 s base, jitter 0.5 → 2 000 ms.
    expect(after1.nextAt - h.clock.now).toBe(2_000);
    expect(h.queue.getSnapshot().pending).toBe(1);
    await h.advance(1_000);
    expect(h.calls).toHaveLength(1);
    await h.advance(1_000);
    expect(h.calls).toHaveLength(2);
    expect(h.queue.get(a.id)!.nextAt - h.clock.now).toBe(4_000);
    // The phone gets its signal back: no waiting for the timer.
    h.win.dispatchEvent(new Event('online'));
    await h.flush();
    expect(h.calls).toHaveLength(3);
    expect((await h.queue.waitFor(a.id)).status).toBe('done');
  });

  it('honours a rate limit wait instead of the backoff', async () => {
    const h = harness([
      { ok: false, permanent: false, error: 'rate_limited', retryAfterMs: 30_000 },
    ]);
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    await h.flush();
    expect(h.queue.get(a.id)!.nextAt - h.clock.now).toBe(30_000);
  });

  it('starts over at once a try stuck on a dead connection when the signal comes back', async () => {
    const h = harness();
    let calls = 0;
    h.upload.mockImplementation(
      (_item: QueuedUpload, _persist: unknown, signal: AbortSignal) =>
        new Promise<UploadOutcome>((resolve) => {
          if (++calls > 1) return resolve({ ok: true, result });
          signal.addEventListener('abort', () =>
            resolve({ ok: false, permanent: false, error: 'timeout' }),
          );
        }),
    );
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    await h.flush();
    // A fresh try is left alone…
    h.win.dispatchEvent(new Event('online'));
    await h.flush();
    expect(calls).toBe(1);
    // …one stuck longer than STALL_MS is aborted and tried again at once, not counted.
    h.clock.now += STALL_MS + 1;
    h.win.dispatchEvent(new Event('online'));
    const done = await h.queue.waitFor(a.id);
    expect(done).toMatchObject({ status: 'done', attempts: 0 });
    expect(calls).toBe(2);
  });

  it('keeps a permanent refusal as failed until the reporter retries or removes it', async () => {
    const h = harness([{ ok: false, permanent: true, error: 'site_inactive' }]);
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    const failed = await h.queue.waitFor(a.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'site_inactive' });
    expect(h.store.items.get(a.id)?.status).toBe('failed');
    expect(h.queue.getSnapshot()).toMatchObject({ pending: 0, failed: 1 });
    expect(h.timers).toHaveLength(0);
    await h.queue.retry(a.id);
    expect((await h.queue.waitFor(a.id)).status).toBe('done');
    // Removing a failed one takes its row and file.
    const h2 = harness([{ ok: false, permanent: true, error: 'day_closed' }]);
    await h2.queue.ready();
    const b = await h2.queue.enqueue(input());
    await h2.queue.waitFor(b.id);
    await h2.queue.remove(b.id);
    expect(h2.queue.get(b.id)).toBeUndefined();
    expect(h2.store.items.size).toBe(0);
    expect(h2.store.files.size).toBe(0);
  });

  it('resumes what a closed page left behind once attached, re-queuing an item cut off mid-upload', async () => {
    const store = new MemoryQueueStore();
    await store.add(row('a', { status: 'uploading', uploadId: 'u1' }), new Blob(['abc']));
    await store.add(row('old', { status: 'done', doneAt: 1 }), new Blob());
    // Not attached (React threw this queue away): nothing is sent.
    const ghost = harness([], { store, attach: false, clock: { now: DONE_KEEP_MS + 10 } });
    await ghost.queue.ready();
    await ghost.flush();
    expect(ghost.calls).toEqual([]);

    const second = harness([], { store, clock: { now: DONE_KEEP_MS + 10 } });
    await second.queue.ready();
    await second.flush();
    expect(second.calls.map((c) => c.id)).toEqual(['a']);
    // The file is read from the store for the try.
    expect(second.calls[0]!.blob?.size).toBe(3);
    expect(second.calls[0]!.uploadId).toBe('u1');
    expect((await second.queue.waitFor('a')).status).toBe('done');
    // A sent row older than DONE_KEEP_MS is pruned.
    expect(store.items.has('old')).toBe(false);
  });

  it('sends one at a time, oldest first, and counts what is pending', async () => {
    let release: (() => void) | null = null;
    const h = harness();
    h.upload.mockImplementation(
      (item: QueuedUpload) =>
        new Promise<UploadOutcome>((resolve) => {
          h.calls.push(item);
          release = () => resolve({ ok: true, result });
        }),
    );
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    const b = await h.queue.enqueue(input({ kind: 'photo', mime: 'image/jpeg' }));
    await h.flush();
    expect(h.calls.map((c) => c.id)).toEqual([a.id]);
    expect(h.queue.getSnapshot()).toMatchObject({ pending: 2, uploading: { id: a.id } });
    release!();
    await h.flush();
    expect(h.calls.map((c) => c.id)).toEqual([a.id, b.id]);
    release!();
    await h.flush();
    expect(h.queue.getSnapshot().pending).toBe(0);
  });

  it('treats an uploader that throws as a retry, never losing the clip', async () => {
    const h = harness();
    h.upload.mockRejectedValueOnce(new Error('boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    await h.flush();
    expect(h.queue.get(a.id)).toMatchObject({ status: 'queued', attempts: 1, error: 'internal' });
    expect(h.store.files.get(a.id)?.size).toBe(3);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('sends again under the new link the items a new pass through the link clears', async () => {
    const h = harness([
      { ok: false, permanent: true, error: 'link_expired' },
      { ok: false, permanent: true, error: 'report_filed' },
      { ok: false, permanent: true, error: 'device_unverified' },
    ]);
    await h.queue.ready();
    const a = await h.queue.enqueue(input({ code: 'OLD123' }));
    await h.queue.waitFor(a.id);
    const b = await h.queue.enqueue(input({ kind: 'photo', mime: 'image/jpeg' }));
    await h.queue.waitFor(b.id);
    const c = await h.queue.enqueue(input({ siteId: 'site-elsewhere' }));
    await h.queue.waitFor(c.id);
    expect(h.queue.getSnapshot()).toMatchObject({ pending: 0, failed: 3 });
    // The reporter opens the link again: only the link's refusals on the link's sites go.
    await h.queue.relink('K7Q2MX', ['site-1']);
    const sent = await h.queue.waitFor(a.id);
    expect(sent.status).toBe('done');
    expect(h.calls.at(-1)).toMatchObject({ id: a.id, code: 'K7Q2MX' });
    expect(h.queue.get(b.id)?.status).toBe('failed');
    expect(h.queue.get(c.id)?.status).toBe('failed');
  });

  it('relinks the stored items too when called before they are loaded (a cold open from the SMS)', async () => {
    const store = new MemoryQueueStore();
    await store.add(row('a', { status: 'failed', error: 'device_unverified' }), new Blob(['abc']));
    let open: (s: MemoryQueueStore) => void = () => undefined;
    const h = harness([], {
      store: new Promise<MemoryQueueStore>((resolve) => (open = resolve)) as never,
    });
    const relinked = h.queue.relink('K7Q2MX', ['site-1']);
    open(store);
    await relinked;
    expect((await h.queue.waitFor('a')).status).toBe('done');
  });

  it('lets one tab send: two queues on one store send each item once', async () => {
    const store = new MemoryQueueStore();
    await store.add(row('a'), new Blob(['abc']));
    await store.add(row('b', { createdAt: 2, kind: 'photo', mime: 'image/jpeg' }), new Blob(['d']));
    const locks = new MemoryLocks();
    const clock = { now: 1_000 };
    const tab1 = harness([], { store, locks, clock, attach: false, prefix: 'x' });
    const tab2 = harness([], { store, locks, clock, attach: false, prefix: 'y' });
    await Promise.all([tab1.queue.ready(), tab2.queue.ready()]);
    tab1.queue.attach(tab1.win);
    tab2.queue.attach(tab2.win);
    await tab1.flush();
    await tab1.advance(5_000);
    await tab2.advance(5_000);
    await tab1.advance(5_000);
    const sent = [...tab1.calls, ...tab2.calls].map((c) => c.id).sort();
    expect(sent).toEqual(['a', 'b']);
    // The tab that did not send learns from the rows that both went.
    await tab2.advance(5_000);
    await tab1.advance(5_000);
    expect(store.items.get('a')?.status).toBe('done');
    expect(store.items.get('b')?.status).toBe('done');
    for (const tab of [tab1, tab2]) {
      expect(tab.queue.get('a')?.status).toBe('done');
      expect(tab.queue.get('b')?.status).toBe('done');
    }
  });

  it('sends an item the phone could not store, from this page, and says so', async () => {
    const store = new MemoryQueueStore();
    vi.spyOn(store, 'add').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    const h = harness([], { store });
    h.upload.mockImplementationOnce(
      () =>
        new Promise<UploadOutcome>((resolve) => (release = () => resolve({ ok: true, result }))),
    );
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    expect(a.persisted).toBe(false);
    await h.flush();
    expect(h.queue.getSnapshot()).toMatchObject({ unsaved: 1, pending: 1 });
    release();
    expect((await h.queue.waitFor(a.id)).status).toBe('done');
    expect(h.upload.mock.calls[0]![0].blob?.size).toBe(3);
    expect(h.queue.getSnapshot().unsaved).toBe(0);
    warn.mockRestore();
  });

  it('starts empty when the stored items cannot be read, and still takes new ones', async () => {
    const store = new MemoryQueueStore();
    vi.spyOn(store, 'list').mockRejectedValue(new DOMException('lost', 'UnknownError'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness([], { store });
    await h.queue.ready();
    const a = await h.queue.enqueue(input());
    expect((await h.queue.waitFor(a.id)).status).toBe('done');
    warn.mockRestore();
  });

  it('holds photos taken during a recording until their clip goes, or the next start', async () => {
    const h = harness();
    await h.queue.ready();
    const p = await h.queue.enqueue(input({ kind: 'photo', mime: 'image/jpeg' }), { hold: 'rec1' });
    await h.flush();
    expect(h.calls).toEqual([]);
    expect(h.queue.getSnapshot()).toMatchObject({ pending: 0 });
    expect(h.store.items.get(p.id)?.status).toBe('held');
    await h.queue.release('rec1');
    expect((await h.queue.waitFor(p.id)).status).toBe('done');

    // A page that died while holding one: the next start sends it.
    const store = new MemoryQueueStore();
    await store.add(
      row('held', { status: 'held', holdId: 'gone', kind: 'photo' }),
      new Blob(['x']),
    );
    const next = harness([], { store });
    expect((await next.queue.waitFor('held')).status).toBe('done');
  });

  it('saves a recording as it is made and sends it after the page died (F5 nothing lost)', async () => {
    const store = new MemoryQueueStore();
    const locks = new MemoryLocks();
    const first = harness([], { store, locks });
    await first.queue.ready();
    const draft = first.queue.startDraft({ code: 'K7Q2MX', siteId: 'site-1', date: '2026-10-09' });
    draft.describe({ mime: 'audio/webm;codecs=opus', startedAt: '2026-10-09T21:00:00.000Z' });
    draft.append(new Blob(['aa']), 1_000);
    draft.append(new Blob(['bb']), 6_000);
    await draft.seal();
    expect(store.drafts.get(draft.id)).toMatchObject({ mime: 'audio/webm;codecs=opus' });
    expect([...store.chunks.values()].map((c) => c.seq)).toEqual([0, 1]);
    // While this page still records, another tab never takes the draft for a lost one.
    expect(locks.isHeld(draftLockName(draft.id))).toBe(true);
    const otherTab = harness([], { store, locks, prefix: 'o' });
    await otherTab.flush();
    expect(otherTab.calls).toEqual([]);
    expect(store.drafts.has(draft.id)).toBe(true);

    // The page dies (its lock goes with it); the next start queues what was said.
    await draft.close({ discard: false });
    const next = harness([], { store, locks, prefix: 'n' });
    await next.flush();
    await next.flush();
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]).toMatchObject({
      kind: 'audio',
      mime: 'audio/webm;codecs=opus',
      siteId: 'site-1',
      date: '2026-10-09',
      recordedAt: '2026-10-09T21:00:00.000Z',
      bytes: 4,
    });
    expect(store.drafts.size).toBe(0);
    expect(store.chunks.size).toBe(0);
  });

  it('recovers a recording from IndexedDB after the browser killed the page mid-clip', async () => {
    const idb = new FakeIndexedDb();
    const factory = idb as unknown as IDBFactory;
    const page1 = new UploadQueue({
      store: openIndexedDbQueueStore(factory),
      upload: vi.fn(),
      locks: null,
    });
    await page1.ready();
    const draft = page1.startDraft({ code: 'K7Q2MX', siteId: 'site-1', date: '2026-10-09' });
    draft.describe({ mime: 'audio/webm;codecs=opus', startedAt: '2026-10-09T21:00:00.000Z' });
    for (let i = 0; i < 8; i++) draft.append(new Blob([`c${i}`]), i * 1_000);
    await draft.seal();
    // The page is killed here: no Stop, no clip. The phone opens SiteLog again.
    const sent: QueuedUpload[] = [];
    const page2 = new UploadQueue({
      store: openIndexedDbQueueStore(factory),
      upload: async (item) => {
        sent.push(item);
        return { ok: true, result };
      },
      locks: null,
    });
    page2.attach(fakeWindow());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ kind: 'audio', mime: 'audio/webm;codecs=opus', bytes: 16 });
    expect(await sent[0]!.blob!.text()).toBe('c0c1c2c3c4c5c6c7');
    await vi.waitFor(() => expect(idb.rows('sitelog-field', 'drafts')).toEqual([]));
    expect(idb.rows('sitelog-field', 'chunks')).toEqual([]);
  });

  it('drops a saved recording shorter than 5 s, and deletes a draft with its clip in one write', async () => {
    const store = new MemoryQueueStore();
    await store.putDraft({
      id: 'd1',
      code: 'K7Q2MX',
      siteId: 'site-1',
      date: '2026-10-09',
      mime: 'audio/webm',
      startedAt: null,
      createdAt: 1,
    });
    await store.addChunk({ draftId: 'd1', seq: 0, blob: new Blob(['aa']), elapsedMs: 3_000 });
    const h = harness([], { store });
    await h.flush();
    expect(h.calls).toEqual([]);
    expect(store.drafts.size).toBe(0);

    const draft = h.queue.startDraft({ code: 'K7Q2MX', siteId: 'site-1', date: '2026-10-09' });
    draft.append(new Blob(['aa']), 6_000);
    await draft.seal();
    await h.queue.enqueue(input(), { draftId: draft.id });
    expect(store.drafts.size).toBe(0);
    expect(store.chunks.size).toBe(0);
  });
});
