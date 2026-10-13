import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectStack, STACK_DB_URL } from './db.ts';

/**
 * next_report_no() under concurrency (W1-05; GAP W1-05 "Gap-free numbering"): it locks the
 * site's row while it bumps sites.report_seq, so transactions that number a report and insert it
 * in one transaction get unique numbers with no gaps, also when some of them roll back.
 * Needs real Postgres: PGlite is a single session and cannot run two transactions at once.
 */

const N = 16;
// Without SUPABASE_DB_URL the suite skips (vitest.stack.config.ts prints why).
const describeStack = STACK_DB_URL ? describe : describe.skip;

describeStack('next_report_no on real Postgres', () => {
  let sql: Sql;
  let orgId: string | undefined;
  let siteId: string;
  const days: string[] = [];

  beforeAll(async () => {
    sql = connectStack(N + 2);
    const [org] = await sql<{ id: string }[]>`
      insert into orgs (name) values (${`test:stack numbering ${Date.now()}`}) returning id`;
    orgId = org!.id;
    const [site] = await sql<{ id: string }[]>`
      insert into sites (org_id, name, project_code, timezone)
      values (${orgId}, 'Numbering', 'STK-1', 'America/Chicago') returning id`;
    siteId = site!.id;
    // One site-day per report: at most one live report per site-day.
    const rows = await sql<{ id: string }[]>`
      insert into site_days (site_id, date, deadline_at)
      select ${siteId}, d::date, d + interval '22 hours 30 minutes'
      from generate_series(date '2026-01-01', date '2026-01-01' + ${2 * N - 1}::int, interval '1 day') d
      returning id`;
    days.push(...rows.map((r) => r.id));
  });

  afterAll(async () => {
    if (orgId) await sql`delete from orgs where id = ${orgId}`;
    await sql?.end({ timeout: 5 });
  });

  /**
   * Opens `count` transactions at once (each holds its own connection), waits until all of them
   * have started, then has each take a number and insert its report. `rollback(i)` makes
   * transaction i fail after its insert. Returns the numbers of the committed transactions.
   */
  async function numberInParallel(
    count: number,
    firstDay: number,
    rollback: (i: number) => boolean,
  ): Promise<string[]> {
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => (release = resolve));
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_, i) =>
        sql.begin(async (tx) => {
          await tx`select 1`;
          if (++started === count) release();
          await allStarted;
          const [{ n }] = (await tx`select next_report_no(${siteId}) as n`) as unknown as [
            { n: string },
          ];
          await tx`
            insert into reports (org_id, site_id, site_day_id, report_no, status)
            values (${orgId!}, ${siteId}, ${days[firstDay + i]!}, ${n}, 'filed')`;
          await tx`select pg_sleep(0.01)`;
          if (rollback(i)) throw new Error(`rollback ${n}`);
          return n;
        }),
      ),
    );
    for (const [i, r] of results.entries())
      if (r.status === 'rejected' && !rollback(i)) throw r.reason;
    return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  }

  const numbers = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `STK-1-${String(from + i).padStart(4, '0')}`);

  it(`gives ${N} parallel transactions unique numbers with no gaps`, async () => {
    const got = await numberInParallel(N, 0, () => false);
    expect([...got].sort()).toEqual(numbers(1, N));
    const [site] = await sql<
      { report_seq: number }[]
    >`select report_seq from sites where id = ${siteId}`;
    expect(site!.report_seq).toBe(N);
  });

  it('hands the numbers of rolled-back transactions to the next ones, so filed numbers stay gap-free', async () => {
    const got = await numberInParallel(N, N, (i) => i % 3 === 1);
    const committed = N - Array.from({ length: N }, (_, i) => i).filter((i) => i % 3 === 1).length;
    expect([...got].sort()).toEqual(numbers(N + 1, N + committed));
    const stored = await sql<{ report_no: string }[]>`
      select report_no from reports where site_id = ${siteId} order by report_no`;
    expect(stored.map((r) => r.report_no)).toEqual(numbers(1, N + committed));
    const [site] = await sql<
      { report_seq: number }[]
    >`select report_seq from sites where id = ${siteId}`;
    expect(site!.report_seq).toBe(N + committed);
  });
});
