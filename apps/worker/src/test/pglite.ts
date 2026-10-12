import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Sql } from 'postgres';
// The @sitelog/db harness (supabase/db-tests) boots PGlite with the Supabase stubs, every
// migration and the demo seed. Imported by path so the worker image does not need that package.
import { bootDatabase } from '../../../../supabase/db-tests/src/harness.ts';
import { connectSql, createDb, type Db } from '../db';

/**
 * A real Postgres for tests and the load test: PGlite (every migration + optionally the §18
 * seed) served over the wire protocol by @electric-sql/pglite-socket, so the worker talks to it
 * through the production `connectSql`/`createDb` (postgres.js) path.
 *
 * PGlite is a single Postgres session: the socket server serialises queries and keeps a
 * transaction on the connection that opened it, but it cannot keep the extended-protocol messages
 * of two connections apart. Use ONE postgres.js connection (max: 1) and share the returned `db`
 * across workers; `q()` goes straight to PGlite for setup and assertions.
 */
export interface PgliteDatabase {
  pg: PGlite;
  sql: Sql;
  db: Db;
  /** postgres:// URL of the socket server (one connection only, see above). */
  url: string;
  q<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function startPgliteDatabase(opts: { seed?: boolean } = {}): Promise<PgliteDatabase> {
  const pg = await bootDatabase({ seed: opts.seed ?? true });
  const server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 0 });
  await server.start();
  const url = `postgres://postgres:postgres@${server.getServerConn()}/postgres`;
  const sql = connectSql(url, { max: 1 });
  const db = createDb(sql);
  let closed = false;
  return {
    pg,
    sql,
    db,
    url,
    async q<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
    async close() {
      if (closed) return;
      closed = true;
      await db.close().catch(() => undefined);
      await server.stop().catch(() => undefined);
      await pg.close().catch(() => undefined);
    },
  };
}
