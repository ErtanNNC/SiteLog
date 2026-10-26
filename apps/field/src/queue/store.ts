import type { Draft, DraftChunk, QueueStore, StoredUpload } from './types';

/**
 * The queue's stores: IndexedDB on the phone (database `sitelog-field`), and memory for tests and
 * for a browser that refuses IndexedDB (some private modes), where a clip then survives only as
 * long as the page.
 *
 * IndexedDB keeps four object stores: `uploads`, each item's row (its state, written on every
 * change); `files`, each item's file, written once when it is queued and deleted once it is sent,
 * so a status change never copies a clip again; `drafts` and `chunks`, the recording being made,
 * chunk by chunk, until its clip is queued (in the same write that deletes the draft).
 */

export const QUEUE_DB_NAME = 'sitelog-field';
/** 1: each row held its file (the first W1-09 cut); 2: files, drafts and chunks apart. */
export const QUEUE_DB_VERSION = 2;
export const QUEUE_STORE_NAME = 'uploads';
export const FILE_STORE_NAME = 'files';
export const DRAFT_STORE_NAME = 'drafts';
export const CHUNK_STORE_NAME = 'chunks';

/** A chunk's key: its draft, then its number, so one key range holds a draft's chunks in order. */
export function chunkKey(draftId: string, seq: number): string {
  return `${draftId}:${String(seq).padStart(8, '0')}`;
}

function chunkRange(draftId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${draftId}:`, `${draftId}:~`);
}

function byChunk(a: DraftChunk, b: DraftChunk): number {
  return a.seq - b.seq;
}

export class MemoryQueueStore implements QueueStore {
  readonly items = new Map<string, StoredUpload>();
  readonly files = new Map<string, Blob>();
  readonly drafts = new Map<string, Draft>();
  readonly chunks = new Map<string, DraftChunk>();

  list(): Promise<StoredUpload[]> {
    return Promise.resolve([...this.items.values()].map((i) => ({ ...i })));
  }

  get(id: string): Promise<StoredUpload | undefined> {
    const row = this.items.get(id);
    return Promise.resolve(row ? { ...row } : undefined);
  }

  add(item: StoredUpload, blob: Blob, opts: { draftId?: string } = {}): Promise<void> {
    this.items.set(item.id, { ...item });
    this.files.set(item.id, blob);
    if (opts.draftId) this.dropDraft(opts.draftId);
    return Promise.resolve();
  }

  put(item: StoredUpload, opts: { dropFile?: boolean } = {}): Promise<void> {
    this.items.set(item.id, { ...item });
    if (opts.dropFile) this.files.delete(item.id);
    return Promise.resolve();
  }

  file(id: string): Promise<Blob | undefined> {
    return Promise.resolve(this.files.get(id));
  }

  delete(id: string): Promise<void> {
    this.items.delete(id);
    this.files.delete(id);
    return Promise.resolve();
  }

  putDraft(draft: Draft): Promise<void> {
    this.drafts.set(draft.id, { ...draft });
    return Promise.resolve();
  }

  addChunk(chunk: DraftChunk): Promise<void> {
    this.chunks.set(chunkKey(chunk.draftId, chunk.seq), { ...chunk });
    return Promise.resolve();
  }

  listDrafts(): Promise<Draft[]> {
    return Promise.resolve([...this.drafts.values()].map((d) => ({ ...d })));
  }

  draftChunks(draftId: string): Promise<DraftChunk[]> {
    return Promise.resolve(
      [...this.chunks.values()].filter((c) => c.draftId === draftId).sort(byChunk),
    );
  }

  deleteDraft(draftId: string): Promise<void> {
    this.dropDraft(draftId);
    return Promise.resolve();
  }

  private dropDraft(draftId: string) {
    this.drafts.delete(draftId);
    for (const [key, chunk] of this.chunks) if (chunk.draftId === draftId) this.chunks.delete(key);
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * The browser dropped the connection: iOS WebKit's "Connection to Indexed Database server lost"
 * after the app sat in the background, or a connection closed under us (`InvalidStateError`).
 */
function lostConnection(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === 'InvalidStateError' || e?.name === 'UnknownError') return true;
  return /connection.*(lost|clos)/i.test(e?.message ?? '');
}

function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number) {
  const has = (name: string) => db.objectStoreNames.contains(name);
  for (const name of [QUEUE_STORE_NAME, FILE_STORE_NAME, DRAFT_STORE_NAME, CHUNK_STORE_NAME]) {
    if (!has(name)) db.createObjectStore(name, { keyPath: 'id' });
  }
  if (oldVersion >= 1 && oldVersion < 2) {
    // Version 1 kept each file in its row: move it to `files`, once.
    const rows = tx.objectStore(QUEUE_STORE_NAME);
    const files = tx.objectStore(FILE_STORE_NAME);
    const all = rows.getAll();
    all.onsuccess = () => {
      for (const row of all.result as (Partial<StoredUpload> & { id: string; blob?: Blob })[]) {
        const { blob, ...rest } = row;
        if (blob) files.put({ id: row.id, blob });
        rows.put({ ...rest, holdId: rest.holdId ?? null, doneAt: rest.doneAt ?? null });
      }
    };
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const open = factory.open(QUEUE_DB_NAME, QUEUE_DB_VERSION);
  open.onupgradeneeded = (event) => upgrade(open.result, open.transaction!, event.oldVersion);
  return request(open);
}

/** Opens (or creates, or upgrades) the queue database. Rejects where IndexedDB is missing or refused. */
export async function openIndexedDbQueueStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<QueueStore> {
  if (!factory) throw new Error('IndexedDB is not available');
  let db: IDBDatabase | null = null;
  const connect = async (): Promise<IDBDatabase> => {
    if (db) return db;
    const opened = await openDatabase(factory);
    // A connection the browser closes, or one a newer version of the app needs closed, is opened
    // again on the next use.
    opened.onclose = () => {
      if (db === opened) db = null;
    };
    opened.onversionchange = () => {
      opened.close();
      if (db === opened) db = null;
    };
    db = opened;
    return opened;
  };
  await connect();

  /** One transaction; a dropped connection is opened again once and the transaction run again. */
  async function run<T>(
    names: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const conn = await connect();
      try {
        const tx = conn.transaction(names, mode);
        const finished = done(tx);
        finished.catch(() => undefined);
        let result: Promise<T>;
        try {
          result = Promise.resolve(body(tx));
        } catch (err) {
          result = Promise.reject(err);
        }
        result.catch(() => undefined);
        await finished;
        return await result;
      } catch (err) {
        if (attempt > 0 || !lostConnection(err)) throw err;
        try {
          conn.close();
        } catch {
          // Already closed.
        }
        if (db === conn) db = null;
      }
    }
  }

  return {
    list: () =>
      run([QUEUE_STORE_NAME], 'readonly', (tx) =>
        request(tx.objectStore(QUEUE_STORE_NAME).getAll() as IDBRequest<StoredUpload[]>),
      ),
    get: (id) =>
      run([QUEUE_STORE_NAME], 'readonly', (tx) =>
        request(tx.objectStore(QUEUE_STORE_NAME).get(id) as IDBRequest<StoredUpload | undefined>),
      ),
    add: (item, blob, opts = {}) =>
      run(
        opts.draftId
          ? [QUEUE_STORE_NAME, FILE_STORE_NAME, DRAFT_STORE_NAME, CHUNK_STORE_NAME]
          : [QUEUE_STORE_NAME, FILE_STORE_NAME],
        'readwrite',
        (tx) => {
          tx.objectStore(QUEUE_STORE_NAME).put(item);
          tx.objectStore(FILE_STORE_NAME).put({ id: item.id, blob });
          if (opts.draftId) {
            tx.objectStore(DRAFT_STORE_NAME).delete(opts.draftId);
            tx.objectStore(CHUNK_STORE_NAME).delete(chunkRange(opts.draftId));
          }
        },
      ),
    put: (item, opts = {}) =>
      run(
        opts.dropFile ? [QUEUE_STORE_NAME, FILE_STORE_NAME] : [QUEUE_STORE_NAME],
        'readwrite',
        (tx) => {
          tx.objectStore(QUEUE_STORE_NAME).put(item);
          if (opts.dropFile) tx.objectStore(FILE_STORE_NAME).delete(item.id);
        },
      ),
    file: async (id) => {
      const row = await run([FILE_STORE_NAME], 'readonly', (tx) =>
        request(tx.objectStore(FILE_STORE_NAME).get(id) as IDBRequest<{ blob: Blob } | undefined>),
      );
      return row?.blob;
    },
    delete: (id) =>
      run([QUEUE_STORE_NAME, FILE_STORE_NAME], 'readwrite', (tx) => {
        tx.objectStore(QUEUE_STORE_NAME).delete(id);
        tx.objectStore(FILE_STORE_NAME).delete(id);
      }),
    putDraft: (draft) =>
      run([DRAFT_STORE_NAME], 'readwrite', (tx) => {
        tx.objectStore(DRAFT_STORE_NAME).put(draft);
      }),
    addChunk: (chunk) =>
      run([CHUNK_STORE_NAME], 'readwrite', (tx) => {
        tx.objectStore(CHUNK_STORE_NAME).put({ id: chunkKey(chunk.draftId, chunk.seq), ...chunk });
      }),
    listDrafts: () =>
      run([DRAFT_STORE_NAME], 'readonly', (tx) =>
        request(tx.objectStore(DRAFT_STORE_NAME).getAll() as IDBRequest<Draft[]>),
      ),
    draftChunks: async (draftId) => {
      const rows = await run([CHUNK_STORE_NAME], 'readonly', (tx) =>
        request(
          tx.objectStore(CHUNK_STORE_NAME).getAll(chunkRange(draftId)) as IDBRequest<
            (DraftChunk & { id: string })[]
          >,
        ),
      );
      return rows.map(({ id: _id, ...chunk }) => chunk).sort(byChunk);
    },
    deleteDraft: (draftId) =>
      run([DRAFT_STORE_NAME, CHUNK_STORE_NAME], 'readwrite', (tx) => {
        tx.objectStore(DRAFT_STORE_NAME).delete(draftId);
        tx.objectStore(CHUNK_STORE_NAME).delete(chunkRange(draftId));
      }),
  };
}

/** IndexedDB when the browser gives it, else memory (and a console note, so a tester knows). */
export async function openQueueStore(): Promise<QueueStore> {
  try {
    return await openIndexedDbQueueStore();
  } catch (err) {
    console.warn('[field] IndexedDB unavailable, uploads are queued in memory only', err);
    return new MemoryQueueStore();
  }
}
