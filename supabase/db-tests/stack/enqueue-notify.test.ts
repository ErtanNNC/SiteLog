import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectStack, STACK_DB_URL } from './db.ts';

/**
 * enqueue_job() wakes a LISTENing worker (W1-05 step 9, from W1-10;
 * 20261014000001_queue_rls_fixes.sql): a new job that is due now sends NOTIFY on channel `jobs`
 * with its id, delivered to another session when the enqueueing transaction commits. A dedupe hit,
 * a job for later and a rolled-back enqueue send nothing. W1-10's worker LISTENs on a dedicated
 * session connection; this suite does the same with a second connection.
 * Needs real Postgres: PGlite is one session.
 */

const describeStack = STACK_DB_URL ? describe : describe.skip;
/** The test's jobs: a type no worker handles, removed after each test. */
const TYPE = 'test_stack_notify';

describeStack('enqueue_job NOTIFY on real Postgres', () => {
  let sql: Sql;
  let listener: Sql;
  const heard: string[] = [];
  let unlisten: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    sql = connectStack(2);
    listener = connectStack(1);
    const sub = await listener.listen('jobs', (payload) => heard.push(payload));
    unlisten = sub.unlisten;
  });

  afterEach(async () => {
    await sql`delete from jobs where type = ${TYPE}`;
  });

  afterAll(async () => {
    await unlisten?.();
    await listener?.end({ timeout: 5 });
    await sql?.end({ timeout: 5 });
  });

  /** Waits until `ids` were heard (or the timeout passes) and returns what was heard of ours. */
  async function heardOf(ids: string[], ms = 3000): Promise<string[]> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !ids.every((id) => heard.includes(id)))
      await new Promise((r) => setTimeout(r, 20));
    return heard.filter((p) => ids.includes(p));
  }

  it('delivers the new job id to a listening session after commit', async () => {
    let id = '';
    await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select enqueue_job(${TYPE}, '{"test":"stack"}'::jsonb)::text as id`;
      id = row!.id;
      await tx`select pg_sleep(0.2)`;
      // Not before the commit.
      expect(heard).not.toContain(id);
    });
    expect(await heardOf([id])).toEqual([id]);
  });

  it('sends nothing for a dedupe hit, a job for later or a rolled-back enqueue', async () => {
    const before = heard.length;
    const key = `test:stack:notify:${Date.now()}`;
    const [first] = await sql<{ id: string }[]>`
      select enqueue_job(${TYPE}, '{}'::jsonb, null, ${key})::text as id`;
    const [again] = await sql<{ id: string }[]>`
      select enqueue_job(${TYPE}, '{}'::jsonb, null, ${key})::text as id`;
    expect(again!.id).toBe(first!.id);
    const [later] = await sql<{ id: string }[]>`
      select enqueue_job(${TYPE}, '{}'::jsonb, now() + interval '1 hour')::text as id`;
    // The rolled-back job leaves no row, so keep its id (bigserial ids are never reused).
    let rolledBack = '';
    await sql
      .begin(async (tx) => {
        const [rb] = await tx<
          { id: string }[]
        >`select enqueue_job(${TYPE}, '{}'::jsonb)::text as id`;
        rolledBack = rb!.id;
        throw new Error('roll back');
      })
      .catch(() => undefined);
    expect(rolledBack).not.toBe('');
    // A marker job sent last: once it is heard, everything before it has been delivered.
    const [marker] = await sql<{ id: string }[]>`
      select enqueue_job(${TYPE}, '{"marker":true}'::jsonb)::text as id`;
    const ours = [first!.id, later!.id, rolledBack, marker!.id];
    expect(await heardOf([first!.id, marker!.id])).toEqual([first!.id, marker!.id]);
    expect(heard).not.toContain(rolledBack);
    expect(heard).not.toContain(later!.id);
    // Of this test's jobs, only the two that were new and due were announced, each once.
    expect(heard.slice(before).filter((p) => ours.includes(p))).toEqual([first!.id, marker!.id]);
  });
});
