/**
 * A small in-memory IndexedDB (fake-indexeddb is not installable offline here): databases with
 * versions and upgrades (`oldVersion`, the versionchange transaction), keyPath object stores,
 * `get`, `getAll` and `delete` with a key or a key range, `put`, transactions over several stores
 * that complete after their requests and roll back when one fails, and the two failures the queue
 * must survive: a write refused (a full disk) and a connection the browser drops (iOS after the
 * background). Enough for `openIndexedDbQueueStore`.
 */

/** `IDBKeyRange.bound` for string keys (installed as the global by `vitest.setup.ts`). */
export class FakeKeyRange {
  constructor(
    readonly lower: string,
    readonly upper: string,
  ) {}
  static bound(lower: string, upper: string) {
    return new FakeKeyRange(lower, upper);
  }
  includes(key: unknown): boolean {
    return typeof key === 'string' && key >= this.lower && key <= this.upper;
  }
}

type Row = Record<string, unknown>;
type Rows = Map<unknown, Row>;
interface StoreData {
  keyPath: string;
  rows: Rows;
}
interface DbData {
  version: number;
  stores: Map<string, StoreData>;
}

function matches(query: unknown, key: unknown): boolean {
  return query instanceof FakeKeyRange ? query.includes(key) : query === key;
}

function sortedEntries(rows: Rows): [unknown, Row][] {
  return [...rows.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
}

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  transaction: FakeTransaction | null = null;
  onsuccess: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
}

class FakeObjectStore {
  constructor(
    private readonly data: StoreData,
    private readonly tx: FakeTransaction,
  ) {}
  get(key: unknown) {
    return this.tx.request(() => {
      const row = this.data.rows.get(key);
      return row ? { ...row } : undefined;
    });
  }
  getAll(query?: unknown) {
    return this.tx.request(() =>
      sortedEntries(this.data.rows)
        .filter(([k]) => query === undefined || matches(query, k))
        .map(([, r]) => ({ ...r })),
    );
  }
  put(value: Row) {
    return this.tx.request(() => {
      const key = value[this.data.keyPath];
      this.data.rows.set(key, { ...value });
      return key;
    }, true);
  }
  delete(query: unknown) {
    return this.tx.request(() => {
      for (const key of [...this.data.rows.keys()]) {
        if (matches(query, key)) this.data.rows.delete(key);
      }
      return undefined;
    }, true);
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;
  private pending = 0;
  private finished = false;
  private readonly snapshot: Map<string, Rows> | null;

  constructor(
    private readonly conn: FakeConnection,
    private readonly names: string[],
    private readonly mode: string,
    private readonly idb: FakeIndexedDb,
  ) {
    this.snapshot =
      mode === 'readwrite'
        ? new Map(names.map((n) => [n, new Map(conn.data.stores.get(n)?.rows ?? [])]))
        : null;
    // A transaction whose caller issues no request completes on its own.
    queueMicrotask(() => queueMicrotask(() => this.maybeComplete()));
  }

  objectStore(name: string) {
    if (this.mode !== 'versionchange' && !this.names.includes(name)) {
      throw new DOMException('store not in scope', 'NotFoundError');
    }
    const store = this.conn.data.stores.get(name);
    if (!store) throw new DOMException(`no store ${name}`, 'NotFoundError');
    return new FakeObjectStore(store, this);
  }

  request<T>(op: () => T, write = false): FakeRequest<T> {
    if (this.finished) throw new DOMException('transaction finished', 'TransactionInactiveError');
    if (write && this.mode === 'readonly') {
      throw new DOMException('read-only transaction', 'ReadOnlyError');
    }
    const req = new FakeRequest<T>();
    req.transaction = this;
    this.pending++;
    let error: DOMException | null = write ? this.idb.takeWriteFailure() : null;
    let value: T | undefined;
    if (!error) {
      try {
        value = op();
      } catch (e) {
        error = e as DOMException;
      }
    }
    queueMicrotask(() => {
      if (this.finished) return;
      if (error) {
        req.error = error;
        req.onerror?.({ target: req });
        this.abort(error);
        return;
      }
      req.result = value as T;
      req.onsuccess?.({ target: req });
      this.pending--;
      queueMicrotask(() => this.maybeComplete());
    });
    return req;
  }

  private maybeComplete() {
    if (this.finished || this.pending > 0) return;
    this.finished = true;
    this.oncomplete?.();
  }

  private abort(error: DOMException) {
    if (this.finished) return;
    this.finished = true;
    for (const [name, rows] of this.snapshot ?? []) {
      const store = this.conn.data.stores.get(name);
      if (store) store.rows = new Map(rows);
    }
    this.error = error;
    this.onerror?.();
    this.onabort?.();
  }
}

class FakeConnection {
  closed = false;
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;
  constructor(
    readonly data: DbData,
    private readonly idb: FakeIndexedDb,
  ) {}
  get objectStoreNames() {
    return { contains: (name: string) => this.data.stores.has(name) };
  }
  createObjectStore(name: string, options: { keyPath: string }) {
    this.data.stores.set(name, { keyPath: options.keyPath, rows: new Map() });
  }
  transaction(names: string | string[], mode = 'readonly') {
    if (this.closed) {
      throw new DOMException('The database connection is closing.', 'InvalidStateError');
    }
    return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode, this.idb);
  }
  versionTransaction() {
    return new FakeTransaction(this, [], 'versionchange', this.idb);
  }
  close() {
    this.closed = true;
    this.idb.connections.delete(this);
  }
}

export class FakeIndexedDb {
  readonly databases = new Map<string, DbData>();
  readonly connections = new Set<FakeConnection>();
  /** When set, `open` fails with this error (a browser that refuses IndexedDB). */
  refuse: DOMException | null = null;
  /** How many times `open` ran (a reconnect opens again). */
  opens = 0;
  private writeFailures: DOMException[] = [];

  open(name: string, version = 1) {
    const req = new FakeRequest<FakeConnection>() as FakeRequest<FakeConnection> & {
      onupgradeneeded: ((ev: { oldVersion: number; newVersion: number }) => void) | null;
    };
    req.onupgradeneeded = null;
    queueMicrotask(() => {
      this.opens++;
      if (this.refuse) {
        req.error = this.refuse;
        req.onerror?.({ target: req });
        return;
      }
      let data = this.databases.get(name);
      if (!data) {
        data = { version: 0, stores: new Map() };
        this.databases.set(name, data);
      }
      const conn = new FakeConnection(data, this);
      this.connections.add(conn);
      req.result = conn;
      if (version > data.version) {
        const oldVersion = data.version;
        data.version = version;
        const tx = conn.versionTransaction();
        req.transaction = tx;
        tx.oncomplete = () => {
          req.transaction = null;
          req.onsuccess?.({ target: req });
        };
        req.onupgradeneeded?.({ oldVersion, newVersion: version });
        return;
      }
      req.onsuccess?.({ target: req });
    });
    return req;
  }

  /** The next `count` writes fail with `error` (`QuotaExceededError`: a full phone). */
  failWrites(error: DOMException, count = 1) {
    for (let i = 0; i < count; i++) this.writeFailures.push(error);
  }

  takeWriteFailure(): DOMException | null {
    return this.writeFailures.shift() ?? null;
  }

  /** The browser drops every open connection (iOS after the background): later use must reopen. */
  dropConnections({ notify = true }: { notify?: boolean } = {}) {
    for (const conn of [...this.connections]) {
      conn.closed = true;
      this.connections.delete(conn);
      if (notify) conn.onclose?.();
    }
  }

  /** A database as an older version of the app left it. */
  seed(dbName: string, version: number, stores: Record<string, Row[]>, keyPath = 'id') {
    const data: DbData = { version, stores: new Map() };
    for (const [name, rows] of Object.entries(stores)) {
      data.stores.set(name, { keyPath, rows: new Map(rows.map((r) => [r[keyPath], { ...r }])) });
    }
    this.databases.set(dbName, data);
  }

  /** The rows of a store, for assertions. */
  rows(dbName: string, store: string): Row[] {
    return [...(this.databases.get(dbName)?.stores.get(store)?.rows.values() ?? [])];
  }
}

export function fakeIndexedDb(): IDBFactory {
  return new FakeIndexedDb() as unknown as IDBFactory;
}
