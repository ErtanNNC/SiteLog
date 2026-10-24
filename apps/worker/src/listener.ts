import postgres from 'postgres';
import type { Logger } from './log';

/**
 * LISTEN jobs (W1-10, spec §10.1): `enqueue_job()` sends `NOTIFY jobs, '<id>'` for a new job that
 * is due now (20261014000001, 20261015000001), and the runner claims at once instead of waiting
 * for its poll.
 *
 * The listener holds its own session connection, apart from the job pool: the pool runs with
 * `prepare: false` so it can sit behind a transaction pooler, and a transaction pooler does not
 * deliver notifications. `SUPABASE_DB_LISTEN_URL` names a session-mode connection when
 * SUPABASE_DB_URL is a transaction pooler (docs/RUNBOOK.md).
 *
 * postgres.js's own `sql.listen()` re-listens once when its connection drops and gives up quietly
 * if that fails (the database restarting), so the listener manages the connection itself: when it
 * closes or cannot be opened, it reconnects after a backoff (1 s doubling to 30 s), and calls
 * `onConnected` on every (re)connect, so the runner claims whatever was enqueued while nobody
 * listened. Notifications are only a wake-up: the runner's poll (POLL_INTERVAL_MS, 5 s) finds
 * every job anyway.
 */

/** One open LISTEN connection. */
export interface ListenConnection {
  close(): Promise<void>;
}

export interface ListenHandlers {
  onNotify(payload: string): void;
  /** The connection closed (the server went away, the network dropped). */
  onClose(): void;
}

/** Opens a connection and LISTENs on `channel`; rejects when it cannot. */
export type ListenConnect = (
  channel: string,
  handlers: ListenHandlers,
) => Promise<ListenConnection>;

export interface JobListenerOptions {
  connect: ListenConnect;
  channel?: string;
  onNotify: (payload: string) => void;
  /** Every (re)connect: claim what was enqueued while nobody listened. */
  onConnected?: () => void;
  log: Logger;
  /** Delay before reconnect attempt `n` (1-based). Default 1 s doubling up to 30 s. */
  backoffMs?: (attempt: number) => number;
}

export interface JobListener {
  start(): void;
  stop(): Promise<void>;
  readonly connected: boolean;
}

export function listenBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export function createJobListener(opts: JobListenerOptions): JobListener {
  const channel = opts.channel ?? 'jobs';
  const backoff = opts.backoffMs ?? listenBackoffMs;
  let running = false;
  let conn: ListenConnection | null = null;
  let failures = 0;
  let timer: NodeJS.Timeout | null = null;
  /** Bumped on every connect attempt and on stop, so a stale close or connect is ignored. */
  let generation = 0;

  function schedule(): void {
    if (!running || timer) return;
    failures++;
    const ms = backoff(failures);
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, ms);
  }

  async function connect(): Promise<void> {
    if (!running) return;
    const gen = ++generation;
    try {
      const c = await opts.connect(channel, {
        onNotify: (payload) => {
          if (gen === generation) opts.onNotify(payload);
        },
        onClose: () => {
          if (gen !== generation || !running) return;
          conn = null;
          opts.log.warn('LISTEN connection closed; reconnecting', { channel });
          generation++;
          schedule();
        },
      });
      if (gen !== generation || !running) {
        await c.close().catch(() => undefined);
        return;
      }
      conn = c;
      if (failures > 0) opts.log.info('LISTEN reconnected', { channel, attempts: failures });
      else opts.log.info('listening for new jobs', { channel });
      failures = 0;
      opts.onConnected?.();
    } catch (err) {
      if (gen !== generation || !running) return;
      opts.log.warn('LISTEN failed; polling until it reconnects', {
        channel,
        attempt: failures + 1,
        err,
      });
      schedule();
    }
  }

  return {
    get connected() {
      return conn !== null;
    },
    start() {
      if (running) return;
      running = true;
      void connect();
    },
    async stop() {
      running = false;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      const c = conn;
      conn = null;
      if (c) await c.close().catch(() => undefined);
    },
  };
}

/**
 * The real connection: one postgres.js client of one session connection that never idles out,
 * LISTENing on the channel. `onclose` fires when the server or the network drops it.
 */
export function postgresListenConnect(url: string): ListenConnect {
  return async (channel, handlers) => {
    let closed = false;
    // `onnotify` is a connection option postgres.js reads but does not type.
    const options = {
      max: 1,
      idle_timeout: null,
      max_lifetime: null,
      connect_timeout: 15,
      prepare: false,
      fetch_types: false,
      onnotice: () => {},
      // Named, so an operator (and test:stack) can find it in pg_stat_activity.
      connection: { application_name: LISTEN_APPLICATION_NAME },
      onnotify: (ch: string, payload: string) => {
        if (ch === channel) handlers.onNotify(payload);
      },
      onclose: () => {
        if (closed) return;
        closed = true;
        handlers.onClose();
        void sql.end({ timeout: 0 }).catch(() => undefined);
      },
    };
    const sql = postgres(url, options as unknown as postgres.Options<Record<string, never>>);
    try {
      await sql.unsafe(`listen "${channel.replace(/"/g, '""')}"`);
    } catch (err) {
      closed = true;
      await sql.end({ timeout: 0 }).catch(() => undefined);
      throw err;
    }
    return {
      async close() {
        closed = true;
        await sql.end({ timeout: 5 });
      },
    };
  };
}

/** `application_name` of the LISTEN session. */
export const LISTEN_APPLICATION_NAME = 'sitelog-worker-listen';

/** A transaction pooler (Supavisor's port 6543) does not deliver NOTIFY. */
export function looksLikeTransactionPooler(url: string): boolean {
  try {
    return new URL(url).port === '6543';
  } catch {
    return false;
  }
}
