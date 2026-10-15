import { describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from '@/test/fakeIndexedDb';
import {
  CHUNK_STORE_NAME,
  FILE_STORE_NAME,
  MemoryQueueStore,
  openIndexedDbQueueStore,
  openQueueStore,
  QUEUE_DB_NAME,
  QUEUE_DB_VERSION,
  QUEUE_STORE_NAME,
} from './store';
import type { Draft, StoredUpload } from './types';

function item(id: string, patch: Partial<StoredUpload> = {}): StoredUpload {
  return {
    id,
    code: 'K7Q2MX',
    kind: 'audio',
    mime: 'audio/webm;codecs=opus',
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

const draft = (id: string): Draft => ({
  id,
  code: 'K7Q2MX',
  siteId: 'site-1',
  date: '2026-10-09',
  mime: 'audio/webm',
  startedAt: null,
  createdAt: 1,
});

describe('queue stores (F5 step 3)', () => {
  it('keeps rows and files apart in IndexedDB, across opens', async () => {
    const idb = new FakeIndexedDb();
    const factory = idb as unknown as IDBFactory;
    const store = await openIndexedDbQueueStore(factory);
    await store.add(item('a'), new Blob(['abc'], { type: 'audio/webm' }));
    await store.add(item('b', { createdAt: 2 }), new Blob(['de']));
    // A status change rewrites the row only.
    await store.put(item('b', { createdAt: 2, status: 'uploading' }));
    expect((await store.list()).map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(idb.rows(QUEUE_DB_NAME, QUEUE_STORE_NAME).every((r) => !('blob' in r))).toBe(true);
    expect(idb.rows(QUEUE_DB_NAME, FILE_STORE_NAME)).toHaveLength(2);

    // A "reload": the same database, opened again.
    const again = await openIndexedDbQueueStore(factory);
    expect((await again.get('b'))?.status).toBe('uploading');
    expect((await again.file('a'))?.size).toBe(3);
    // Sent: the row stays, the file goes.
    await again.put(item('a', { status: 'done', doneAt: 5 }), { dropFile: true });
    expect(await again.file('a')).toBeUndefined();
    await again.delete('b');
    expect((await again.list()).map((i) => [i.id, i.status])).toEqual([['a', 'done']]);
    expect(idb.rows(QUEUE_DB_NAME, FILE_STORE_NAME)).toHaveLength(0);
  });

  it('keeps a draft’s chunks in order and deletes them with the clip in one write', async () => {
    const idb = new FakeIndexedDb();
    const store = await openIndexedDbQueueStore(idb as unknown as IDBFactory);
    await store.putDraft(draft('d1'));
    await store.putDraft(draft('d2'));
    for (const seq of [2, 0, 1]) {
      await store.addChunk({ draftId: 'd1', seq, blob: new Blob([`c${seq}`]), elapsedMs: seq });
    }
    await store.addChunk({ draftId: 'd2', seq: 0, blob: new Blob(['x']), elapsedMs: 0 });
    expect((await store.draftChunks('d1')).map((c) => c.seq)).toEqual([0, 1, 2]);
    expect((await store.listDrafts()).map((d) => d.id).sort()).toEqual(['d1', 'd2']);
    await store.add(item('clip'), new Blob(['c0c1c2']), { draftId: 'd1' });
    expect((await store.listDrafts()).map((d) => d.id)).toEqual(['d2']);
    expect(idb.rows(QUEUE_DB_NAME, CHUNK_STORE_NAME)).toHaveLength(1);
    await store.deleteDraft('d2');
    expect(idb.rows(QUEUE_DB_NAME, CHUNK_STORE_NAME)).toHaveLength(0);
  });

  it('moves version 1 rows’ files apart when it upgrades the database', async () => {
    const idb = new FakeIndexedDb();
    idb.seed(QUEUE_DB_NAME, 1, {
      [QUEUE_STORE_NAME]: [{ ...item('old'), blob: new Blob(['abc']) } as never],
    });
    const store = await openIndexedDbQueueStore(idb as unknown as IDBFactory);
    expect(idb.databases.get(QUEUE_DB_NAME)?.version).toBe(QUEUE_DB_VERSION);
    const [row] = await store.list();
    expect(row).toMatchObject({ id: 'old', holdId: null, doneAt: null });
    expect(row).not.toHaveProperty('blob');
    expect((await store.file('old'))?.size).toBe(3);
  });

  it('rolls a refused write back whole, and opens a dropped connection again', async () => {
    const idb = new FakeIndexedDb();
    const store = await openIndexedDbQueueStore(idb as unknown as IDBFactory);
    // A write of `add` is refused (a full phone): neither the row nor the file stays.
    idb.failWrites(new DOMException('full', 'QuotaExceededError'));
    await expect(store.add(item('a'), new Blob(['abc']))).rejects.toThrow('full');
    expect(await store.list()).toEqual([]);
    // iOS dropped the connection while the app was in the background: the next use reopens.
    const opens = idb.opens;
    idb.dropConnections({ notify: false });
    await store.add(item('b'), new Blob(['abc']));
    expect(idb.opens).toBe(opens + 1);
    expect((await store.list()).map((i) => i.id)).toEqual(['b']);
  });

  it('rejects without IndexedDB, and openQueueStore then falls back to memory', async () => {
    await expect(openIndexedDbQueueStore(undefined)).rejects.toThrow('IndexedDB is not available');
    const refusing = new FakeIndexedDb();
    refusing.refuse = new DOMException('blocked', 'SecurityError');
    await expect(openIndexedDbQueueStore(refusing as unknown as IDBFactory)).rejects.toThrow(
      'blocked',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('indexedDB', undefined);
    const store = await openQueueStore();
    expect(store).toBeInstanceOf(MemoryQueueStore);
    expect(warn).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it('memory store copies rows in and out, and keeps files apart', async () => {
    const store = new MemoryQueueStore();
    const a = item('a');
    await store.add(a, new Blob(['abc']));
    a.status = 'done';
    expect((await store.list())[0]?.status).toBe('queued');
    expect((await store.file('a'))?.size).toBe(3);
    await store.delete('a');
    expect(await store.list()).toEqual([]);
    expect(store.files.size).toBe(0);
  });
});
