import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261015000061_mark_site_day_missing.sql: scheduler-tick's `→ missing` step (spec §19 Q55)
 * commits the status change, its audit, the office notice and the email job together, alerts only
 * on the call that made the day missing, and commits nothing when a step fails.
 */

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

let siteId: string;

async function pendingDay(date: string): Promise<string> {
  const [row] = await svc<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at) values ($1, $2, $3) returning id`,
    [siteId, date, `${date}T23:00:00Z`],
  );
  return row!.id;
}

const mark = (id: string) =>
  svc<{ ok: boolean }>(
    `select mark_site_day_missing($1, '2030-03-01T23:30:00Z', 'Site — no report', 'Nothing came in.') as ok`,
    [id],
  ).then((r) => r[0]!.ok);

async function effects(id: string) {
  const [day] = await svc<{ status: string; reminder_stage: number }>(
    `select status, reminder_stage from site_days where id = $1`,
    [id],
  );
  const audits = await svc<{ diff: Record<string, unknown> }>(
    `select diff from audit_log where entity = 'site_day' and entity_id = $1
       and action = 'site_day.status_changed'`,
    [id],
  );
  const notices = await svc<{ title: string }>(
    `select title from notifications where kind = 'missing_report' and org_id = $1
       and title = 'Site — no report'`,
    [DEMO_ORG_ID],
  );
  const jobs = await svc<{ dedupe_key: string; payload: Record<string, unknown> }>(
    `select dedupe_key, payload from jobs where type = 'send_email' and payload->>'siteDayId' = $1`,
    [id],
  );
  return { day, audits, notices, jobs };
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  const [site] = await svc<{ id: string }>(
    `select id from sites where org_id = $1 order by id limit 1`,
    [DEMO_ORG_ID],
  );
  siteId = site!.id;
});

describe('mark_site_day_missing', () => {
  it('marks the day missing with its audit, notice and email job, once', async () => {
    await svc(`delete from notifications where title = 'Site — no report'`);
    const id = await pendingDay('2030-03-01');
    expect(await mark(id)).toBe(true);
    const e = await effects(id);
    expect(e.day).toEqual({ status: 'missing', reminder_stage: 4 });
    expect(e.audits).toHaveLength(1);
    expect(e.audits[0]!.diff).toMatchObject({
      from: 'pending',
      to: 'missing',
      by: 'scheduler-tick',
    });
    expect(e.notices).toHaveLength(1);
    expect(e.jobs).toEqual([
      {
        dedupe_key: `email:report_missing:${id}`,
        payload: { kind: 'report_missing', siteDayId: id, siteId, orgId: DEMO_ORG_ID },
      },
    ]);

    // A second tick finds the day already missing: no second alert.
    expect(await mark(id)).toBe(false);
    const again = await effects(id);
    expect(again.audits).toHaveLength(1);
    expect(again.notices).toHaveLength(1);
    expect(again.jobs).toHaveLength(1);
  });

  it('commits nothing when the alert fails, so the next tick retries', async () => {
    const id = await pendingDay('2030-03-02');
    await svc(`delete from notifications where title = 'Site — no report'`);
    await expect(
      svc(`select mark_site_day_missing($1, now(), null, null)`, [id]), // title is not null
    ).rejects.toThrow();
    let e = await effects(id);
    expect(e.day).toEqual({ status: 'pending', reminder_stage: 0 });
    expect(e.audits).toHaveLength(0);
    expect(e.jobs).toHaveLength(0);

    expect(await mark(id)).toBe(true);
    e = await effects(id);
    expect(e.day!.status).toBe('missing');
    expect(e.notices).toHaveLength(1);
    expect(e.jobs).toHaveLength(1);
  });

  it('leaves a day that is no longer pending alone', async () => {
    const id = await pendingDay('2030-03-03');
    await svc(`update site_days set status = 'filed' where id = $1`, [id]);
    expect(await mark(id)).toBe(false);
    const e = await effects(id);
    expect(e.day!.status).toBe('filed');
    expect(e.audits).toHaveLength(0);
    expect(e.jobs).toHaveLength(0);
  });

  it('is not callable by office users', async () => {
    const id = await pendingDay('2030-03-04');
    await expect(
      asUser(db, DEMO_USERS[0]!.id, (q) =>
        q(`select mark_site_day_missing($1, now(), 't', 'b')`, [id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  // 20261015000080: the notice's data for the panel, or none from the deployed caller.
  it('stores the notice data scheduler-tick passes, and none when it passes four arguments', async () => {
    const data = { key: 'missing_report', params: { site: 'Site', first: 'Priya' } };
    const withData = await pendingDay('2030-03-05');
    expect(
      (
        await svc<{ ok: boolean }>(
          `select mark_site_day_missing(p_site_day_id => $1, p_missing_at => now(),
             p_title => 'Site — data', p_body => 'b', p_data => $2::jsonb) as ok`,
          [withData, JSON.stringify(data)],
        )
      )[0]!.ok,
    ).toBe(true);
    const without = await pendingDay('2030-03-06');
    expect(
      (
        await svc<{ ok: boolean }>(
          `select mark_site_day_missing(p_site_day_id => $1, p_missing_at => now(),
             p_title => 'Site — no data', p_body => 'b') as ok`,
          [without],
        )
      )[0]!.ok,
    ).toBe(true);
    const rows = await svc<{ title: string; data: unknown }>(
      `select title, data from notifications where title in ('Site — data', 'Site — no data')
        order by title`,
    );
    expect(rows).toEqual([
      { title: 'Site — data', data },
      { title: 'Site — no data', data: null },
    ]);
  });
});
