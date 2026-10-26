import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigration, asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261015000001_worker_runtime.sql (W1-10, GAP D16, D17): `jobs.dedupe_key` fully unique with
 * `enqueue_job() … on conflict do nothing`, the §10.1 backoff with all five delays, and the clean-up
 * of a live database (staging) whose finished jobs share keys.
 */

const MIGRATION = '20261015000001_worker_runtime.sql';
const USER = '00000000-0000-4000-8000-0000000000aa';

describe('the D16 clean-up on a database from before W1-10 (staging)', () => {
  let live: PGlite;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    live = await bootDatabase({ until: MIGRATION });
    // The old partial index lets finished jobs share a key with each other and with one queued or
    // running job; running rows belong to a worker that keeps going during the migration.
    const rows: Array<[string, string, string | null, string | null]> = [
      ['k1_done_a', 'done', 'k1', null],
      ['k1_done_b', 'done', 'k1', null],
      ['k1_queued', 'queued', 'k1', null],
      ['k2_done', 'done', 'k2', null],
      ['k2_dead', 'dead', 'k2', null],
      ['k3_running', 'running', 'k3', 'worker-old'],
      ['k3_failed', 'failed', 'k3', null],
      ['k4_done', 'done', 'k4', null],
      ['no_key', 'done', null, null],
    ];
    for (const [name, status, key, lockedBy] of rows) {
      const res = await live.query<{ id: number }>(
        `insert into jobs (type, payload, status, dedupe_key, locked_by, locked_at, attempts)
         values ('render_pdf', '{}'::jsonb, $1::job_status, $2::text, $3::text,
                 case when $3::text is null then null else now() end,
                 case when $1::text = 'queued' then 0 else 1 end)
         returning id`,
        [status, key, lockedBy],
      );
      ids[name] = Number(res.rows[0]!.id);
    }
    await applyMigration(live, MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await live?.close();
  });

  it('keeps each key on its queued or running job, else on its newest finished one', async () => {
    const res = await live.query<{ id: number; status: string; dedupe_key: string | null }>(
      `select id, status::text, dedupe_key from jobs order by id`,
    );
    const key = (name: string) => res.rows.find((r) => Number(r.id) === ids[name])!.dedupe_key;
    expect({
      k1_done_a: key('k1_done_a'),
      k1_done_b: key('k1_done_b'),
      k1_queued: key('k1_queued'),
      k2_done: key('k2_done'),
      k2_dead: key('k2_dead'),
      k3_running: key('k3_running'),
      k3_failed: key('k3_failed'),
      k4_done: key('k4_done'),
      no_key: key('no_key'),
    }).toEqual({
      k1_done_a: null,
      k1_done_b: null,
      k1_queued: 'k1',
      k2_done: null,
      k2_dead: 'k2',
      k3_running: 'k3',
      k3_failed: null,
      k4_done: 'k4',
      no_key: null,
    });
    // Statuses and the running row's lock are untouched.
    const running = res.rows.find((r) => Number(r.id) === ids.k3_running)!;
    expect(running.status).toBe('running');
    const [lock] = (
      await live.query<{ locked_by: string }>(`select locked_by from jobs where id = $1`, [
        ids.k3_running,
      ])
    ).rows;
    expect(lock!.locked_by).toBe('worker-old');
  });

  it('records the released keys in one audit row', async () => {
    const res = await live.query<{ org_id: string | null; diff: Record<string, unknown> }>(
      `select org_id, diff from audit_log where action = 'jobs.dedupe_keys_released'`,
    );
    expect(res.rows).toEqual([{ org_id: null, diff: { count: 4, migration: '20261015000001' } }]);
  });

  it('replaces the partial index with the §6.3 unique constraint', async () => {
    const idx = await live.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'jobs' and indexname like 'jobs_dedupe%'`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(['jobs_dedupe_key_key']);
    const con = await live.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'jobs_dedupe_key_key'`,
    );
    expect(con.rows).toEqual([{ def: 'UNIQUE (dedupe_key)' }]);
  });

  it('answers an old key with its job: the running one, and a finished one too', async () => {
    const enqueue = async (key: string) =>
      Number(
        (
          await live.query<{ id: number }>(
            `select enqueue_job('render_pdf', '{}'::jsonb, null, $1) as id`,
            [key],
          )
        ).rows[0]!.id,
      );
    expect(await enqueue('k3')).toBe(ids.k3_running);
    expect(await enqueue('k4')).toBe(ids.k4_done);
    expect(await enqueue('k2')).toBe(ids.k2_dead);
  });
});

describe('enqueue_job, fail_job and requeue_dead_job after W1-10', () => {
  let db: PGlite;
  const svc = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await asService(db, (q) => q<T>(sql, params))).rows;
  const enqueue = async (key: string | null, runAfter: string | null = null) =>
    Number(
      (
        await svc<{ id: number }>(
          `select enqueue_job('extract_report', '{}'::jsonb, $1::timestamptz, $2) as id`,
          [runAfter, key],
        )
      )[0]!.id,
    );

  beforeAll(async () => {
    db = await bootDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('never gives a key a second job: done, dead and failed jobs keep theirs (D16)', async () => {
    const heard: string[] = [];
    const unlisten = await db.listen('jobs', (payload) => heard.push(payload));
    try {
      for (const status of ['done', 'dead', 'failed']) {
        const id = await enqueue(`d16:${status}`);
        await svc(`update jobs set status = $1::job_status, finished_at = now() where id = $2`, [
          status,
          id,
        ]);
        expect(await enqueue(`d16:${status}`)).toBe(id);
        expect(
          await svc(`select count(*)::int as n from jobs where dedupe_key = $1`, [`d16:${status}`]),
        ).toEqual([{ n: 1 }]);
      }
      await new Promise((r) => setTimeout(r, 50));
      // Only the three first enqueues were new jobs, so only they were announced.
      expect(heard).toHaveLength(3);
    } finally {
      await unlisten();
    }
  });

  it('inserts every job without a key, and a job for later without a NOTIFY', async () => {
    const a = await enqueue(null);
    const b = await enqueue(null);
    expect(b).not.toBe(a);
    const later = await enqueue('later:1', new Date(Date.now() + 3_600_000).toISOString());
    expect(await enqueue('later:1')).toBe(later);
  });

  it('refuses a second row with a used key at the table too', async () => {
    await enqueue('table:1');
    await expect(
      svc(`insert into jobs (type, payload, dedupe_key) values ('x', '{}'::jsonb, 'table:1')`),
    ).rejects.toThrow(/jobs_dedupe_key_key/);
  });

  it('waits 30 s, 2 min, 10 min, 30 min and 2 h, and the sixth failure is dead (D17)', async () => {
    const id = await enqueue('d17:1');
    const waits: Array<number | 'dead'> = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await svc(`update jobs set status = 'running', attempts = $1 where id = $2`, [attempt, id]);
      await svc(`select fail_job($1, 'boom')`, [id]);
      const [row] = await svc<{ status: string; wait: number }>(
        `select status::text, round(extract(epoch from run_after - now()))::int as wait from jobs where id = $1`,
        [id],
      );
      waits.push(row!.status === 'dead' ? 'dead' : row!.wait);
    }
    expect(waits).toEqual([30, 120, 600, 1800, 7200, 'dead']);
  });

  it('requeues only a dead job, with a fresh budget, announced; API roles cannot call it', async () => {
    const id = await enqueue('requeue:1');
    expect(await svc(`select requeue_dead_job($1) as ok`, [id])).toEqual([{ ok: false }]);
    await svc(
      `update jobs set status = 'dead', attempts = 6, finished_at = now(), last_error = 'boom' where id = $1`,
      [id],
    );
    const heard: string[] = [];
    const unlisten = await db.listen('jobs', (payload) => heard.push(payload));
    try {
      expect(await svc(`select requeue_dead_job($1) as ok`, [id])).toEqual([{ ok: true }]);
      await new Promise((r) => setTimeout(r, 50));
      expect(heard).toEqual([String(id)]);
    } finally {
      await unlisten();
    }
    expect(
      await svc(`select status::text, attempts, finished_at, last_error from jobs where id = $1`, [
        id,
      ]),
    ).toEqual([{ status: 'queued', attempts: 0, finished_at: null, last_error: 'boom' }]);
    await expect(asUser(db, USER, (q) => q(`select requeue_dead_job($1)`, [id]))).rejects.toThrow(
      /permission denied/,
    );
  });
});
