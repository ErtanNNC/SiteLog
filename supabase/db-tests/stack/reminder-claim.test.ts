import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectStack, STACK_DB_URL } from './db.ts';

/**
 * claim_site_day_reminder() racing a filing on real Postgres (W2-06; docs/AUDIT_BACKLOG.md
 * "Reminder-ladder claim overwrites a site-day that was filed or moved to processing after the
 * tick read it", "Ladder claim and reminder send are not guarded by the site-day status"). The
 * claim locks the site-day row and checks the status in the same statement, so whichever commits
 * first wins: a filing first leaves the claim nothing to do (false, no job, the day stays filed);
 * a claim first queues its job and the filing then files the day over `reminded` (the worker's
 * guard then sends nothing, `ladder.pglite.test.ts`). Needs real Postgres: PGlite is one session.
 */

const describeStack = STACK_DB_URL ? describe : describe.skip;

describeStack('claim_site_day_reminder racing a filing', () => {
  let sql: Sql;
  let orgId: string | undefined;
  let siteId: string;
  let reporterId: string;
  const days: string[] = [];

  beforeAll(async () => {
    sql = connectStack(4);
    const [org] = await sql<{ id: string }[]>`
      insert into orgs (name, country) values (${`test:stack ladder ${Date.now()}`}, 'US') returning id`;
    orgId = org!.id;
    await sql`update org_settings set working_days = '{1,2,3,4,5}' where org_id = ${orgId}`;
    const [site] = await sql<{ id: string }[]>`
      insert into sites (org_id, name, project_code, timezone)
      values (${orgId}, 'Ladder', 'LAD-1', 'America/Chicago') returning id`;
    siteId = site!.id;
    const [r] = await sql<{ id: string }[]>`
      insert into reporters (org_id, name, phone_e164, status, locale, languages, contact_pref, activated_at)
      values (${orgId}, 'Priya Ladder', ${`+1555${Date.now() % 10_000_000}`.padEnd(12, '7')}, 'active',
              'en-US', '{en}', 'link', now()) returning id`;
    reporterId = r!.id;
    await sql`insert into site_reporters (site_id, reporter_id, is_primary) values (${siteId}, ${reporterId}, true)`;
    // Two Mondays.
    for (const date of ['2030-06-03', '2030-06-10']) {
      const [d] = await sql<{ id: string }[]>`
        insert into site_days (site_id, date, deadline_at)
        values (${siteId}, ${date}, ${`${date}T22:30:00Z`}) returning id`;
      days.push(d!.id);
    }
  });

  afterAll(async () => {
    if (orgId) {
      for (const id of days)
        await sql`delete from jobs where dedupe_key like ${`notify:%:${id}:%`}`;
      await sql`delete from audit_log where org_id = ${orgId}`;
      await sql`delete from orgs where id = ${orgId}`;
    }
    await sql?.end({ timeout: 5 });
  });

  const messages = () =>
    JSON.stringify([
      {
        reporterId,
        key: 'reminder_1',
        vars: { site: 'Ladder', link: 'https://go.sitelog.app/r/ABCDEFGHJKMN' },
      },
    ]);

  async function race(day: string, filingFirst: boolean) {
    let release!: () => void;
    const firstHasLock = new Promise<void>((resolve) => (release = resolve));
    const filing = async () => {
      if (!filingFirst) await firstHasLock;
      return sql.begin(async (tx) => {
        await tx`update site_days set status = 'filed' where id = ${day}`;
        if (filingFirst) {
          release();
          await tx`select pg_sleep(0.3)`;
        }
        return 'filed';
      });
    };
    const claim = async () => {
      if (filingFirst) await firstHasLock;
      return sql.begin(async (tx) => {
        const [row] = await tx<{ ok: boolean }[]>`
          select claim_site_day_reminder(${day}, 'reminder_1', ${messages()}::jsonb, '[]'::jsonb) as ok`;
        if (!filingFirst) {
          release();
          await tx`select pg_sleep(0.3)`;
        }
        return row!.ok;
      });
    };
    const [filed, claimed] = await Promise.all([filing(), claim()]);
    const [sd] = await sql<{ status: string; reminder_stage: number }[]>`
      select status, reminder_stage from site_days where id = ${day}`;
    const jobs =
      await sql`select id from jobs where dedupe_key = ${`notify:reminder_1:${day}:${reporterId}`}`;
    return { filed, claimed, sd: sd!, jobs: jobs.length };
  }

  it('a filing that commits first wins: the claim does nothing', async () => {
    const r = await race(days[0]!, true);
    expect(r.claimed).toBe(false);
    expect(r.sd).toEqual({ status: 'filed', reminder_stage: 0 });
    expect(r.jobs).toBe(0);
  });

  it('a claim that commits first queues once; the filing then files the day', async () => {
    const r = await race(days[1]!, false);
    expect(r.claimed).toBe(true);
    expect(r.sd).toEqual({ status: 'filed', reminder_stage: 2 });
    expect(r.jobs).toBe(1);
  });
});
