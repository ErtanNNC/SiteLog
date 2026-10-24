import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { JobPayloadSchemas } from '@sitelog/shared';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261016000040_reminder_ladder.sql (W2-06): claim_site_day_reminder() claims one ladder stage of
 * a site-day and queues its `notify` jobs in one transaction, only while the day still waits for a
 * report: the status (re-read under the row lock), paused reminders, the site, the working day,
 * a live report, the stage already run. Closes docs/AUDIT_BACKLOG.md "Reminder-ladder claim
 * overwrites a site-day that was filed or moved to processing…", "Ladder claim and reminder send
 * are not guarded by the site-day status" (the claim half; the send half is the worker's guard)
 * and "Site-days created on non-working days…".
 */

let db: PGlite;
let siteId: string;
let reporterId: string;
let otherReporterId: string;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function day(date: string, patch: Record<string, unknown> = {}): Promise<string> {
  const [row] = await svc<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at) values ($1, $2, $3) returning id`,
    [siteId, date, `${date}T22:30:00Z`],
  );
  for (const [col, value] of Object.entries(patch)) {
    await svc(`update site_days set ${col} = $2 where id = $1`, [row!.id, value]);
  }
  return row!.id;
}

const message = (key: string, rid = reporterId) => ({
  reporterId: rid,
  key,
  vars: { site: 'Elm St.', link: 'https://go.talkolog.com/r/ABCDEFGHJKMN' },
});

async function claim(
  id: string,
  stage: string,
  messages: unknown[] = [message(stageKey(stage))],
  skipped: unknown[] = [],
  notAfter: string | null = null,
): Promise<boolean> {
  const [row] = await svc<{ ok: boolean }>(
    `select claim_site_day_reminder($1, $2, $3::jsonb, $4::jsonb, $5::timestamptz) as ok`,
    [id, stage, JSON.stringify(messages), JSON.stringify(skipped), notAfter],
  );
  return row!.ok;
}

function stageKey(stage: string): string {
  return { daily_link: 'daily_link', heads_up: 'weather_headsup' }[stage] ?? stage;
}

async function state(id: string) {
  const [sd] = await svc<{ status: string; reminder_stage: number }>(
    `select status, reminder_stage from site_days where id = $1`,
    [id],
  );
  const audits = await svc<{ action: string; diff: Record<string, unknown> }>(
    `select action, diff from audit_log where entity = 'site_day' and entity_id = $1
       and action in ('site_day.reminder', 'site_day.status_changed') order by created_at, action`,
    [id],
  );
  const jobs = await svc<{ dedupe_key: string; payload: Record<string, unknown> }>(
    `select dedupe_key, payload from jobs where type = 'notify' and dedupe_key like $1 order by id`,
    [`notify:%:${id}:%`],
  );
  return { sd, audits, jobs };
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  const rows = await svc<{ site_id: string; reporter_id: string }>(
    `select sr.site_id, sr.reporter_id from site_reporters sr
       join sites s on s.id = sr.site_id
      where s.org_id = $1 and s.status = 'active' and sr.is_primary
      order by s.name limit 2`,
    [DEMO_ORG_ID],
  );
  siteId = rows[0]!.site_id;
  reporterId = rows[0]!.reporter_id;
  otherReporterId = rows[1]!.reporter_id; // a reporter of another site
});

describe('claim_site_day_reminder', () => {
  it('R1: stage 2, reminded, its audit rows and one notify job per reporter with the guard', async () => {
    const id = await day('2030-04-01'); // a Monday
    const notAfter = '2030-04-02T01:00:00+00:00';
    expect(
      await claim(
        id,
        'reminder_1',
        [message('reminder_1')],
        [{ reporterId: 'x', reason: 'inactive' }],
        notAfter,
      ),
    ).toBe(true);
    const s = await state(id);
    expect(s.sd).toEqual({ status: 'reminded', reminder_stage: 2 });
    expect(s.audits.map((a) => a.action)).toEqual(['site_day.reminder', 'site_day.status_changed']);
    expect(s.audits[0]!.diff).toMatchObject({
      stage: 'reminder_1',
      key: 'reminder_1',
      reminder_stage: 2,
      sent: [reporterId],
      skipped: [{ reporterId: 'x', reason: 'inactive' }],
      by: 'scheduler-tick',
    });
    expect(s.audits[1]!.diff).toMatchObject({ from: 'pending', to: 'reminded' });
    expect(s.jobs).toHaveLength(1);
    const key = `notify:reminder_1:${id}:${reporterId}`;
    expect(s.jobs[0]!.dedupe_key).toBe(key);
    // The payload is what the worker's notify job parses, the Notifier key being the job's key.
    const payload = JobPayloadSchemas.notify.parse(s.jobs[0]!.payload);
    expect(payload).toMatchObject({ reporterId, key: 'reminder_1', dedupeKey: key });
    expect(payload.guard).toEqual({
      siteDayId: id,
      statuses: ['pending', 'reminded'],
      notAfter: expect.stringMatching(/^2030-04-02T01:00:00/),
    });
  });

  it('runs each stage once; a later stage after an earlier one, never the other way', async () => {
    const id = await day('2030-04-02');
    expect(await claim(id, 'heads_up')).toBe(true);
    expect(await claim(id, 'heads_up')).toBe(false);
    expect((await state(id)).sd).toEqual({ status: 'pending', reminder_stage: 1 });
    expect(await claim(id, 'reminder_2')).toBe(true);
    expect(await claim(id, 'reminder_1')).toBe(false);
    expect(await claim(id, 'reminder_2')).toBe(false);
    const s = await state(id);
    expect(s.sd).toEqual({ status: 'reminded', reminder_stage: 3 });
    expect(s.jobs.map((j) => j.dedupe_key)).toEqual([
      `notify:weather_headsup:${id}:${reporterId}`,
      `notify:reminder_2:${id}:${reporterId}`,
    ]);
  });

  it('the daily link once, by its audit row, and never after R1; it leaves the stage alone', async () => {
    const id = await day('2030-04-03');
    expect(await claim(id, 'daily_link')).toBe(true);
    expect(await claim(id, 'daily_link')).toBe(false);
    let s = await state(id);
    expect(s.sd).toEqual({ status: 'pending', reminder_stage: 0 });
    expect(s.jobs.map((j) => j.dedupe_key)).toEqual([`notify:daily_link:${id}:${reporterId}`]);
    expect(s.audits.map((a) => a.action)).toEqual(['site_day.reminder']);

    const late = await day('2030-04-04', { reminder_stage: 2, status: 'reminded' });
    expect(await claim(late, 'daily_link')).toBe(false);
    s = await state(late);
    expect(s.jobs).toHaveLength(0);
  });

  it('a stage with every reporter skipped is still claimed (once), with nothing queued', async () => {
    const id = await day('2030-04-05');
    expect(await claim(id, 'reminder_1', [], [{ reporterId, reason: 'quiet_hours' }])).toBe(true);
    const s = await state(id);
    expect(s.sd).toEqual({ status: 'reminded', reminder_stage: 2 });
    expect(s.jobs).toHaveLength(0);
    expect(s.audits[0]!.diff).toMatchObject({
      sent: [],
      skipped: [{ reporterId, reason: 'quiet_hours' }],
    });
  });

  // docs/AUDIT_BACKLOG.md "Reminder-ladder claim overwrites a site-day that was filed or moved to
  // processing after the tick read it" and "Ladder claim … not guarded by the site-day status".
  it('never claims a day that left pending/reminded after the tick read it', async () => {
    for (const status of ['processing', 'filed', 'no_work', 'weather_day', 'missing']) {
      const id = await day('2030-04-08', {});
      await svc(`update site_days set status = $2 where id = $1`, [id, status]);
      expect(await claim(id, 'reminder_1'), status).toBe(false);
      const s = await state(id);
      expect(s.sd!.status, status).toBe(status);
      expect(s.jobs, status).toHaveLength(0);
      expect(s.audits, status).toHaveLength(0);
      await svc(`delete from site_days where id = $1`, [id]);
    }
  });

  it('nothing while reminders are paused, the site is paused, or a live report exists', async () => {
    const paused = await day('2030-04-09', { reminders_paused: true });
    expect(await claim(paused, 'reminder_1')).toBe(false);

    const live = await day('2030-04-10');
    const [org] = await svc<{ org_id: string }>(`select org_id from sites where id = $1`, [siteId]);
    await svc(
      `insert into reports (org_id, site_id, site_day_id, report_no, status, channel, language)
       values ($1, $2, $3, 'TEST-LADDER-1', 'collecting', 'web', 'en')`,
      [org!.org_id, siteId, live],
    );
    expect(await claim(live, 'daily_link')).toBe(false);
    expect(await claim(live, 'reminder_1')).toBe(false);
    await svc(`update reports set status = 'void' where site_day_id = $1`, [live]);
    expect(await claim(live, 'reminder_1')).toBe(true); // a void report is not live

    const sitePaused = await day('2030-04-11');
    await svc(`update sites set status = 'paused' where id = $1`, [siteId]);
    try {
      expect(await claim(sitePaused, 'reminder_1')).toBe(false);
    } finally {
      await svc(`update sites set status = 'active' where id = $1`, [siteId]);
    }
  });

  // docs/AUDIT_BACKLOG.md "Site-days created on non-working days are left 'pending' and get the
  // reminder ladder and missing escalation".
  it('nothing on a day the org does not work', async () => {
    const saturday = await day('2030-04-13');
    for (const stage of ['daily_link', 'heads_up', 'reminder_1', 'reminder_2']) {
      expect(await claim(saturday, stage), stage).toBe(false);
    }
    expect((await state(saturday)).jobs).toHaveLength(0);
  });

  it('refuses a message for the wrong key or for a reporter who is not on the site', async () => {
    const id = await day('2030-04-15');
    await expect(claim(id, 'reminder_1', [message('daily_link')])).rejects.toThrow(
      /sends reminder_1/,
    );
    await expect(claim(id, 'reminder_1', [message('reminder_1', otherReporterId)])).rejects.toThrow(
      /not on the site/,
    );
    await expect(claim(id, 'missing')).rejects.toThrow(/unknown ladder stage/);
    // A refused call commits nothing.
    expect(await state(id)).toMatchObject({
      sd: { status: 'pending', reminder_stage: 0 },
      jobs: [],
    });
  });

  it('is not callable by office users', async () => {
    const id = await day('2030-04-16');
    await expect(
      asUser(db, DEMO_USERS[0]!.id, (q) =>
        q(`select claim_site_day_reminder($1, 'reminder_1', '[]'::jsonb)`, [id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
