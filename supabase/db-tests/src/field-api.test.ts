import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { UPLOAD_MAX_BYTES, uploadStoragePath } from '@sitelog/shared';
import { asService, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261014000006_field_api.sql: the service-only RPCs behind field-api (W1-07).
 *
 * - field_complete_upload(): uploads/:id/complete numbers and inserts the site-day's report in one
 *   transaction, attaches the upload and enqueues transcribe_upload; scoped to the reporter's
 *   own uploads on their own sites.
 * - field_set_day_status(): the F12 buttons (pending or reminded → no_work or weather_day).
 * - field_rate_limit(): the rolling windows of rate_limits (spec §6.5, D26).
 * - field_confirm_report(): reports/:id/confirm enqueues file_report for the confirmed version
 *   under the site-day lock; field_complete_upload() then refuses audio and photos until filed.
 * - The audio and photos buckets' type and size limits.
 *
 * PGlite is one session, so "concurrent" completes run one after the other here; the real race
 * (two transactions at once) is supabase/db-tests/stack/field-api.test.ts.
 */

const ID = (n: number) => `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = ID(1);
const SITE = ID(2);
const SITE2 = ID(3);
const MARCO = ID(4);
const DANA = ID(5); // linked to SITE only
const OUTSIDER = ID(6); // a reporter of another org
const ORG_TR = ID(7);
const SITE_TR = ID(8);
const EMRE = ID(9);
const OTHER_ORG = ID(10);
const OTHER_SITE = ID(11);

let db: PGlite;
let uploadSeq = 100;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

/** An uploads row as field-api's `uploads` route writes it (path from uploadStoragePath()). */
async function upload(input: {
  reporter: string;
  site: string;
  org: string;
  date: string;
  kind?: 'audio' | 'photo';
}): Promise<string> {
  const id = ID(uploadSeq++);
  const kind = input.kind ?? 'audio';
  const path = uploadStoragePath(
    input.org,
    input.site,
    input.date,
    id,
    kind === 'audio' ? 'webm' : 'jpg',
  );
  await svc(
    `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at)
     values ($1, $2, $3, $4, $5, $6, '2026-10-09T22:30:00Z')`,
    [id, input.reporter, input.site, kind, path, kind === 'audio' ? 'audio/webm' : 'image/jpeg'],
  );
  return id;
}

interface Completed {
  reportId: string;
  reportNo: string;
  reportStatus: string;
  created: boolean;
  alreadyComplete: boolean;
  jobId: number | null;
}

async function complete(uploadId: string, reporter: string, bytes: number | null = null) {
  const rows = await svc<{ r: Completed }>(`select field_complete_upload($1, $2, $3) as r`, [
    uploadId,
    reporter,
    bytes,
  ]);
  return rows[0]!.r;
}

/** The message of the exception a call raises (the code field-api maps), or null. */
async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await svc(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const siteDay = async (site: string, date: string) =>
  (
    await svc<{ id: string; status: string; report_id: string | null }>(
      `select id, status, report_id from site_days where site_id = $1 and date = $2`,
      [site, date],
    )
  )[0];

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(`
    insert into orgs (id, name) values ('${ORG}', 'Field Test Build'), ('${OTHER_ORG}', 'Other Co');
    insert into orgs (id, name, country, locale, units, currency, timezone)
      values ('${ORG_TR}', 'Saha Test', 'TR', 'tr-TR', 'metric', 'TRY', 'Europe/Istanbul');
    insert into sites (id, org_id, name, project_code, timezone, deadline) values
      ('${SITE}', '${ORG}', 'Riverside', 'FT-1', 'America/Chicago', '17:30'),
      ('${SITE2}', '${ORG}', 'Pier 9', 'FT-2', 'America/Chicago', null),
      ('${OTHER_SITE}', '${OTHER_ORG}', 'Elsewhere', 'OT-1', 'America/Chicago', null),
      ('${SITE_TR}', '${ORG_TR}', 'Ataşehir', 'TR-1', 'Europe/Istanbul', '18:00');
    insert into reporters (id, org_id, name, phone_e164, status) values
      ('${MARCO}', '${ORG}', 'Marco Ruiz', '+15550143378', 'active'),
      ('${DANA}', '${ORG}', 'Dana Park', '+15550143379', 'active'),
      ('${OUTSIDER}', '${OTHER_ORG}', 'Out Sider', '+15550143380', 'active'),
      ('${EMRE}', '${ORG_TR}', 'Emre Yıldız', '+905321234567', 'active');
    insert into site_reporters (site_id, reporter_id, is_primary) values
      ('${SITE}', '${MARCO}', true), ('${SITE2}', '${MARCO}', true), ('${SITE}', '${DANA}', false),
      ('${OTHER_SITE}', '${OUTSIDER}', true), ('${SITE_TR}', '${EMRE}', true);
  `);
});

describe('field_complete_upload (uploads/:id/complete)', () => {
  it('creates the site-day and the numbered report on the first voice note, and enqueues transcribe_upload', async () => {
    const up = await upload({ reporter: MARCO, site: SITE, org: ORG, date: '2026-10-09' });
    const res = await complete(up, MARCO, 2_400_000);
    expect(res).toMatchObject({
      reportNo: 'FT-1-0001',
      reportStatus: 'processing',
      created: true,
      alreadyComplete: false,
    });
    expect(res.jobId).toEqual(expect.any(Number));

    const [report] = await svc(
      `select r.status, r.channel, r.language, r.kind, r.reporter_id, r.received_at is not null as received,
              sd.date::text as date, sd.status as day_status, sd.deadline_at
       from reports r join site_days sd on sd.id = r.site_day_id where r.id = $1`,
      [res.reportId],
    );
    expect(report).toMatchObject({
      status: 'processing',
      channel: 'web',
      language: 'en',
      kind: 'daily',
      reporter_id: MARCO,
      received: true,
      date: '2026-10-09',
      day_status: 'processing',
    });
    // The site's deadline (17:30 Chicago, CDT) as create_office_report() computes it.
    expect(new Date(report!.deadline_at as string).toISOString()).toBe('2026-10-09T22:30:00.000Z');

    const [u] = await svc(`select report_id, bytes, received_at from uploads where id = $1`, [up]);
    expect(u).toMatchObject({ report_id: res.reportId, bytes: 2_400_000 });
    expect(
      await svc(
        `select kind, upload_id, taken_at is not null as taken from report_sources where report_id = $1`,
        [res.reportId],
      ),
    ).toEqual([{ kind: 'voice_note', upload_id: up, taken: true }]);

    const jobs = await svc(
      `select id, type, payload, dedupe_key, status from jobs where type = 'transcribe_upload' and payload->>'uploadId' = $1`,
      [up],
    );
    expect(jobs).toEqual([
      {
        id: res.jobId,
        type: 'transcribe_upload',
        payload: { uploadId: up },
        dedupe_key: `transcribe_upload:${up}`,
        status: 'queued',
      },
    ]);

    const audit = await svc<{ action: string; actor_type: string; actor_id: string }>(
      `select action, actor_type, actor_id from audit_log
       where org_id = $1 and action in ('report.created', 'upload.completed', 'site_day.status_changed')
       order by id`,
      [ORG],
    );
    expect(audit).toEqual([
      { action: 'report.created', actor_type: 'reporter', actor_id: MARCO },
      { action: 'site_day.status_changed', actor_type: 'reporter', actor_id: MARCO },
      { action: 'upload.completed', actor_type: 'reporter', actor_id: MARCO },
    ]);
  });

  it('is idempotent: completing the same upload again returns the first result, with no new job', async () => {
    const up = await upload({ reporter: MARCO, site: SITE2, org: ORG, date: '2026-10-09' });
    const first = await complete(up, MARCO);
    const again = await complete(up, MARCO);
    expect(again).toMatchObject({
      reportId: first.reportId,
      reportNo: first.reportNo,
      created: false,
      alreadyComplete: true,
      jobId: null,
    });
    const [{ n }] = (await svc<{ n: number }>(
      `select count(*)::int as n from jobs where payload->>'uploadId' = $1`,
      [up],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('puts every upload of a site-day on one report: one number, one job per voice note', async () => {
    const day = '2026-10-12';
    const [{ seq: before }] = (await svc<{ seq: number }>(
      `select report_seq as seq from sites where id = $1`,
      [SITE],
    )) as [{ seq: number }];
    const a = await upload({ reporter: MARCO, site: SITE, org: ORG, date: day });
    const b = await upload({ reporter: DANA, site: SITE, org: ORG, date: day });
    const c = await upload({ reporter: MARCO, site: SITE, org: ORG, date: day, kind: 'photo' });
    // Started together (PGlite runs them one after the other; the stack test races them).
    const [ra, rb, rc] = await Promise.all([
      complete(a, MARCO),
      complete(b, DANA),
      complete(c, MARCO),
    ]);
    expect(new Set([ra.reportId, rb.reportId, rc.reportId]).size).toBe(1);
    expect([ra, rb, rc].filter((r) => r.created)).toHaveLength(1);
    const [{ seq: after }] = (await svc<{ seq: number }>(
      `select report_seq as seq from sites where id = $1`,
      [SITE],
    )) as [{ seq: number }];
    expect(after).toBe(before + 1);
    expect(rc.jobId).toBeNull(); // a photo is not transcribed
    expect(
      await svc(`select kind from report_sources where report_id = $1 order by kind`, [
        ra.reportId,
      ]),
    ).toEqual([{ kind: 'photo' }, { kind: 'voice_note' }, { kind: 'voice_note' }]);
    expect(
      (
        await svc(
          `select count(*)::int as n from reports where site_day_id = (select id from site_days where site_id = $1 and date = $2)`,
          [SITE, day],
        )
      )[0],
    ).toEqual({ n: 1 });
  });

  it('numbers the reports of different site-days uniquely and in order', async () => {
    const numbers: string[] = [];
    for (const day of ['2026-10-13', '2026-10-14', '2026-10-15']) {
      const up = await upload({ reporter: MARCO, site: SITE2, org: ORG, date: day });
      numbers.push((await complete(up, MARCO)).reportNo);
    }
    expect(numbers).toEqual(['FT-2-0002', 'FT-2-0003', 'FT-2-0004']);
  });

  it('starts a photo-only report as collecting (no job, the day stays pending); a voice note then moves it to processing', async () => {
    const day = '2026-10-16';
    const photo = await upload({ reporter: MARCO, site: SITE, org: ORG, date: day, kind: 'photo' });
    const first = await complete(photo, MARCO);
    expect(first).toMatchObject({ reportStatus: 'collecting', created: true, jobId: null });
    expect((await siteDay(SITE, day))!.status).toBe('pending');

    const voice = await upload({ reporter: MARCO, site: SITE, org: ORG, date: day });
    const second = await complete(voice, MARCO);
    expect(second).toMatchObject({
      reportId: first.reportId,
      reportStatus: 'processing',
      created: false,
    });
    expect(second.jobId).toEqual(expect.any(Number));
    expect((await siteDay(SITE, day))!.status).toBe('processing');
    expect(
      await svc(
        `select diff from audit_log where action = 'report.status_changed' and entity_id = $1`,
        [first.reportId],
      ),
    ).toEqual([{ diff: { from: 'collecting', to: 'processing', upload_id: voice } }]);
  });

  it('puts a draft back to processing when more audio arrives (§7.2)', async () => {
    const day = '2026-10-19';
    const first = await complete(
      await upload({ reporter: MARCO, site: SITE, org: ORG, date: day }),
      MARCO,
    );
    await svc(`update reports set status = 'awaiting_confirmation' where id = $1`, [
      first.reportId,
    ]);
    const more = await complete(
      await upload({ reporter: MARCO, site: SITE, org: ORG, date: day }),
      MARCO,
    );
    expect(more).toMatchObject({ reportId: first.reportId, reportStatus: 'processing' });
  });

  it('writes the org report language: tr for a tr-TR org', async () => {
    const up = await upload({ reporter: EMRE, site: SITE_TR, org: ORG_TR, date: '2026-10-09' });
    const res = await complete(up, EMRE);
    expect(res.reportNo).toBe('TR-1-0001');
    const [r] = await svc(`select language, channel from reports where id = $1`, [res.reportId]);
    expect(r).toEqual({ language: 'tr', channel: 'web' });
  });

  it('refuses another reporter, an unlinked site and a path outside the site', async () => {
    const mine = await upload({ reporter: MARCO, site: SITE2, org: ORG, date: '2026-10-20' });
    // Dana is in the same org but did not upload it, and is not linked to Pier 9.
    expect(await failure(`select field_complete_upload($1, $2)`, [mine, DANA])).toBe(
      'upload_not_found',
    );
    expect(await failure(`select field_complete_upload($1, $2)`, [mine, OUTSIDER])).toBe(
      'upload_not_found',
    );
    expect(await failure(`select field_complete_upload($1, $2)`, [ID(999), MARCO])).toBe(
      'upload_not_found',
    );

    // An upload row on a site the reporter is no longer linked to.
    const unlinked = await upload({ reporter: DANA, site: SITE2, org: ORG, date: '2026-10-20' });
    expect(await failure(`select field_complete_upload($1, $2)`, [unlinked, DANA])).toBe(
      'upload_not_found',
    );

    // A path that names another org's folder.
    const id = ID(uploadSeq++);
    await svc(
      `insert into uploads (id, reporter_id, site_id, kind, storage_path) values ($1, $2, $3, 'audio', $4)`,
      [id, MARCO, SITE, uploadStoragePath(OTHER_ORG, SITE, '2026-10-20', id, 'webm')],
    );
    expect(await failure(`select field_complete_upload($1, $2)`, [id, MARCO])).toBe(
      'upload_path_mismatch',
    );
    // Nothing was created for any of them.
    expect(await siteDay(SITE2, '2026-10-20')).toBeUndefined();
  });

  it('refuses a filed day (report_filed) and a closed one (day_closed)', async () => {
    const filed = await complete(
      await upload({ reporter: MARCO, site: SITE, org: ORG, date: '2026-10-21' }),
      MARCO,
    );
    await svc(`update reports set status = 'filed', filed_at = now() where id = $1`, [
      filed.reportId,
    ]);
    const late = await upload({ reporter: MARCO, site: SITE, org: ORG, date: '2026-10-21' });
    expect(await failure(`select field_complete_upload($1, $2)`, [late, MARCO])).toBe(
      'report_filed',
    );
    expect((await svc(`select report_id from uploads where id = $1`, [late]))[0]).toEqual({
      report_id: null,
    });

    await svc(
      `insert into site_days (site_id, date, status, deadline_at) values ($1, '2026-10-22', 'no_work', now())`,
      [SITE],
    );
    const closed = await upload({ reporter: MARCO, site: SITE, org: ORG, date: '2026-10-22' });
    expect(await failure(`select field_complete_upload($1, $2)`, [closed, MARCO])).toBe(
      'day_closed',
    );
  });

  it('refuses audio and photos while the report is being filed (report_filing), not after', async () => {
    const day = '2026-10-26';
    const first = await complete(
      await upload({ reporter: MARCO, site: SITE, org: ORG, date: day }),
      MARCO,
    );
    await svc(`update reports set status = 'awaiting_confirmation' where id = $1`, [
      first.reportId,
    ]);
    await svc(`select field_confirm_report($1, $2, 1)`, [first.reportId, MARCO]);
    const voice = await upload({ reporter: DANA, site: SITE, org: ORG, date: day });
    const photo = await upload({ reporter: MARCO, site: SITE, org: ORG, date: day, kind: 'photo' });
    expect(await failure(`select field_complete_upload($1, $2)`, [voice, DANA])).toBe(
      'report_filing',
    );
    expect(await failure(`select field_complete_upload($1, $2)`, [photo, MARCO])).toBe(
      'report_filing',
    );
    const [r] = await svc(`select status from reports where id = $1`, [first.reportId]);
    expect(r).toEqual({ status: 'awaiting_confirmation' });
    expect(
      await svc(`select count(*)::int as n from uploads where report_id = $1`, [first.reportId]),
    ).toEqual([{ n: 1 }]);
    // The job ran and found nothing to file (a stale confirm): the draft takes audio again.
    await svc(`update jobs set status = 'done' where dedupe_key = $1`, [
      `file:${first.reportId}:v1`,
    ]);
    expect(await complete(voice, DANA)).toMatchObject({
      reportId: first.reportId,
      reportStatus: 'processing',
    });
  });

  it('counts a filing job queued before W1-10 (key file:<report>) as being filed', async () => {
    const day = '2026-10-27';
    const first = await complete(
      await upload({ reporter: MARCO, site: SITE, org: ORG, date: day }),
      MARCO,
    );
    await svc(
      `select enqueue_job('file_report', jsonb_build_object('reportId', $1::text, 'trigger', 'timeout'), null, $2)`,
      [first.reportId, `file:${first.reportId}`],
    );
    const voice = await upload({ reporter: MARCO, site: SITE, org: ORG, date: day });
    expect(await failure(`select field_complete_upload($1, $2)`, [voice, MARCO])).toBe(
      'report_filing',
    );
    await svc(`delete from jobs where dedupe_key = $1`, [`file:${first.reportId}`]);
  });

  it('moves a missing day to processing on a late voice note', async () => {
    await svc(
      `insert into site_days (site_id, date, status, deadline_at) values ($1, '2026-10-23', 'missing', now() - interval '3 hours')`,
      [SITE],
    );
    await complete(
      await upload({ reporter: MARCO, site: SITE, org: ORG, date: '2026-10-23' }),
      MARCO,
    );
    expect((await siteDay(SITE, '2026-10-23'))!.status).toBe('processing');
  });
});

describe('field_set_day_status (day-status, F12 buttons)', () => {
  const call = (reporter: string, site: string, date: string, status: string, details = {}) =>
    svc<{ r: { siteDayId: string; status: string; changed: boolean } }>(
      `select field_set_day_status($1, $2, $3, $4, $5) as r`,
      [reporter, site, date, status, JSON.stringify(details)],
    ).then((rows) => rows[0]!.r);

  it('creates the site-day when missing and sets no_work, audited with the details', async () => {
    const res = await call(MARCO, SITE2, '2026-11-02', 'no_work', { note: 'holiday' });
    expect(res).toMatchObject({ status: 'no_work', changed: true });
    expect((await siteDay(SITE2, '2026-11-02'))!.status).toBe('no_work');
    const [a] = await svc(
      `select actor_type, actor_id, diff from audit_log where action = 'site_day.no_work' and entity_id = $1`,
      [res.siteDayId],
    );
    expect(a).toEqual({
      actor_type: 'reporter',
      actor_id: MARCO,
      diff: {
        from: 'pending',
        to: 'no_work',
        date: '2026-11-02',
        channel: 'web',
        details: { note: 'holiday' },
      },
    });
    // Again: no change, no second audit row.
    expect(await call(MARCO, SITE2, '2026-11-02', 'no_work')).toMatchObject({ changed: false });
    expect(
      (
        await svc(
          `select count(*)::int as n from audit_log where action = 'site_day.no_work' and entity_id = $1`,
          [res.siteDayId],
        )
      )[0],
    ).toEqual({ n: 1 });
  });

  it('sets a reminded day to weather_day', async () => {
    await svc(
      `insert into site_days (site_id, date, status, deadline_at, reminder_stage) values ($1, '2026-11-03', 'reminded', now(), 2)`,
      [SITE2],
    );
    expect(await call(MARCO, SITE2, '2026-11-03', 'weather_day')).toMatchObject({
      status: 'weather_day',
      changed: true,
    });
  });

  it('refuses a day with a live report, a filed day, other states, other statuses and other sites', async () => {
    const live = await complete(
      await upload({ reporter: MARCO, site: SITE2, org: ORG, date: '2026-11-04' }),
      MARCO,
    );
    const fail = (reporter: string, site: string, date: string, status: string) =>
      failure(`select field_set_day_status($1, $2, $3, $4)`, [reporter, site, date, status]);
    expect(await fail(MARCO, SITE2, '2026-11-04', 'no_work')).toBe('report_in_progress');
    await svc(`update reports set status = 'filed' where id = $1`, [live.reportId]);
    expect(await fail(MARCO, SITE2, '2026-11-04', 'weather_day')).toBe('report_filed');
    await svc(
      `insert into site_days (site_id, date, status, deadline_at) values ($1, '2026-11-05', 'missing', now())`,
      [SITE2],
    );
    expect(await fail(MARCO, SITE2, '2026-11-05', 'no_work')).toBe('wrong_state');
    expect(await fail(MARCO, SITE2, '2026-11-06', 'filed')).toBe('invalid_status');
    expect(await fail(DANA, SITE2, '2026-11-06', 'no_work')).toBe('site_not_found');
    expect(await fail(OUTSIDER, SITE, '2026-11-06', 'no_work')).toBe('site_not_found');
    expect(await siteDay(SITE2, '2026-11-06')).toBeUndefined();
  });
});

describe('field_confirm_report (reports/:id/confirm, F8)', () => {
  type Confirmed = { status: 'queued' | 'filed'; jobId: number | null; version: number };
  const confirm = (report: string, reporter: string, version: number | null) =>
    svc<{ r: Confirmed }>(`select field_confirm_report($1, $2, $3) as r`, [
      report,
      reporter,
      version,
    ]).then((rows) => rows[0]!.r);
  const draft = async (date: string, site = SITE2) => {
    const res = await complete(await upload({ reporter: MARCO, site, org: ORG, date }), MARCO);
    await svc(`update reports set status = 'awaiting_confirmation' where id = $1`, [res.reportId]);
    return res.reportId;
  };

  it('enqueues file_report for the confirmed version, audited as the reporter; a second tap reuses it', async () => {
    const report = await draft('2026-11-09');
    const first = await confirm(report, MARCO, 1);
    expect(first).toMatchObject({ status: 'queued', version: 1 });
    const jobs = await svc(
      `select id, payload, dedupe_key, status from jobs where type = 'file_report' and payload->>'reportId' = $1`,
      [report],
    );
    expect(jobs).toEqual([
      {
        id: first.jobId,
        payload: { reportId: report, trigger: 'confirm', version: 1 },
        dedupe_key: `file:${report}:v1`,
        status: 'queued',
      },
    ]);
    expect(await confirm(report, MARCO, 1)).toEqual(first);
    expect(
      await svc(
        `select actor_type, actor_id, diff from audit_log where action = 'report.confirm_requested' and entity_id = $1`,
        [report],
      ),
    ).toEqual([
      {
        actor_type: 'reporter',
        actor_id: MARCO,
        diff: { job_id: first.jobId, version: 1, channel: 'web' },
      },
    ]);
  });

  it('reuses a filing job the WhatsApp confirm or a timeout already queued', async () => {
    const report = await draft('2026-11-10');
    const [{ id }] = (await svc<{ id: number }>(
      `select enqueue_job('file_report', jsonb_build_object('reportId', $1::text, 'trigger', 'timeout'), null, $2) as id`,
      [report, `file:${report}:v1`],
    )) as [{ id: number }];
    expect(await confirm(report, MARCO, 1)).toEqual({ status: 'queued', jobId: id, version: 1 });
    // One queued before W1-10 under the old key counts too.
    await svc(`delete from jobs where id = $1`, [id]);
    const [{ id: old }] = (await svc<{ id: number }>(
      `select enqueue_job('file_report', jsonb_build_object('reportId', $1::text, 'trigger', 'timeout'), null, $2) as id`,
      [report, `file:${report}`],
    )) as [{ id: number }];
    expect(await confirm(report, MARCO, 1)).toEqual({ status: 'queued', jobId: old, version: 1 });
  });

  it('files each draft version once (D16): a later draft gets its own job, a dead one runs again', async () => {
    const report = await draft('2026-11-12');
    const v1 = await confirm(report, MARCO, 1);
    // The job ran but filed nothing (the draft moved on meanwhile), and version 2 is confirmed.
    await svc(`update jobs set status = 'done' where id = $1`, [v1.jobId]);
    await svc(`update reports set current_version = 2 where id = $1`, [report]);
    const v2 = await confirm(report, MARCO, 2);
    expect(v2.jobId).not.toBe(v1.jobId);
    expect(
      await svc(`select dedupe_key, status::text from jobs where id = $1`, [v2.jobId]),
    ).toEqual([{ dedupe_key: `file:${report}:v2`, status: 'queued' }]);
    // Version 2's job dies after six attempts; the reporter taps Confirm again: the same job runs.
    await svc(`update jobs set status = 'dead', attempts = 6, finished_at = now() where id = $1`, [
      v2.jobId,
    ]);
    expect(await confirm(report, MARCO, 2)).toEqual({
      status: 'queued',
      jobId: v2.jobId,
      version: 2,
    });
    expect(
      await svc(`select status::text, attempts, finished_at from jobs where id = $1`, [v2.jobId]),
    ).toEqual([{ status: 'queued', attempts: 0, finished_at: null }]);
    const audits = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'report.confirm_requested' and entity_id = $1 order by created_at, id`,
      [report],
    );
    expect(audits.map((a) => a.diff.requeued ?? false)).toEqual([false, false, true]);
  });

  it('files a later confirm of the same version after a filing that finished without filing (D16 occurrence key)', async () => {
    const report = await draft('2026-11-13');
    const first = await confirm(report, MARCO, 1);
    // The filing completed stale (`report.confirm_stale`: a WhatsApp voice note moved the report
    // to processing meanwhile); the new draft overwrote v1 in place, so it is v1 again.
    await svc(`update jobs set status = 'done', finished_at = now() where id = $1`, [first.jobId]);
    const second = await confirm(report, MARCO, 1);
    expect(second).toMatchObject({ status: 'queued', version: 1 });
    expect(second.jobId).not.toBe(first.jobId);
    // ops discards that one (`failed`): the next confirm is another occurrence again.
    await svc(`update jobs set status = 'failed', finished_at = now() where id = $1`, [
      second.jobId,
    ]);
    const third = await confirm(report, MARCO, 1);
    expect([third.jobId === first.jobId, third.jobId === second.jobId]).toEqual([false, false]);
    expect(
      await svc(
        `select dedupe_key, status::text, payload from jobs
         where type = 'file_report' and payload->>'reportId' = $1 order by id`,
        [report],
      ),
    ).toEqual([
      {
        dedupe_key: `file:${report}:v1`,
        status: 'done',
        payload: { reportId: report, trigger: 'confirm', version: 1 },
      },
      {
        dedupe_key: `file:${report}:v1:c2`,
        status: 'failed',
        payload: { reportId: report, trigger: 'confirm', version: 1 },
      },
      {
        dedupe_key: `file:${report}:v1:c3`,
        status: 'queued',
        payload: { reportId: report, trigger: 'confirm', version: 1 },
      },
    ]);
    // A third tap while it is queued reuses it.
    expect(await confirm(report, MARCO, 1)).toEqual(third);
    // A taken occurrence key (a WhatsApp or timeout job, or an audit row purged) moves on.
    await svc(`update jobs set status = 'done', finished_at = now() where id = $1`, [third.jobId]);
    await svc(
      `select enqueue_job('file_report', jsonb_build_object('reportId', $1::text), null, $2)`,
      [report, `file:${report}:v1:c4`],
    );
    await svc(`update jobs set status = 'done' where dedupe_key = $1`, [`file:${report}:v1:c4`]);
    const fourth = await confirm(report, MARCO, 1);
    expect(
      await svc(`select dedupe_key, status::text from jobs where id = $1`, [fourth.jobId]),
    ).toEqual([{ dedupe_key: `file:${report}:v1:c5`, status: 'queued' }]);
  });

  it('refuses another state, a newer draft, another reporter and a void report; answers filed once filed', async () => {
    const report = await draft('2026-11-11');
    const fail = (reporter: string, version: number | null, id = report) =>
      failure(`select field_confirm_report($1, $2, $3)`, [id, reporter, version]);
    expect(await fail(MARCO, 2)).toBe('draft_changed');
    expect(await fail(MARCO, null)).toBe('draft_changed');
    expect(await fail(DANA, 1)).toBe('report_not_found'); // not linked to Pier 9
    expect(await fail(OUTSIDER, 1)).toBe('report_not_found');
    expect(await fail(MARCO, 1, ID(998))).toBe('report_not_found');
    await svc(`update reports set status = 'processing' where id = $1`, [report]);
    expect(await fail(MARCO, 1)).toBe('wrong_state');
    expect(
      await svc(
        `select count(*)::int as n from jobs where type = 'file_report' and payload->>'reportId' = $1`,
        [report],
      ),
    ).toEqual([{ n: 0 }]);
    await svc(`update reports set status = 'filed', filed_at = now() where id = $1`, [report]);
    expect(await confirm(report, MARCO, 1)).toEqual({ status: 'filed', jobId: null, version: 1 });
    await svc(`update reports set status = 'void' where id = $1`, [report]);
    expect(await fail(MARCO, 1)).toBe('report_not_found');
  });
});

describe('field_rate_limit (rate_limits, spec §6.5, D26)', () => {
  const hit = (key: string, limit: number, seconds: number) =>
    svc<{ r: { allowed: boolean; count: number; resetAt: string } }>(
      `select field_rate_limit($1, $2, $3) as r`,
      [key, limit, seconds],
    ).then((rows) => rows[0]!.r);

  it('allows `limit` hits in the window and refuses the next ones until it ends', async () => {
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await hit('code:+15550143378', 5, 3600));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const [{ start }] = (await svc<{ start: string }>(
      `select window_start as start from rate_limits where key = 'code:+15550143378'`,
    )) as [{ start: string }];
    expect(new Date(results[6]!.resetAt).getTime() - new Date(start).getTime()).toBe(3_600_000);
  });

  it('keeps keys apart', async () => {
    expect(await hit('dev:a', 1, 60)).toMatchObject({ allowed: true, count: 1 });
    expect(await hit('dev:b', 1, 60)).toMatchObject({ allowed: true, count: 1 });
    expect(await hit('dev:a', 1, 60)).toMatchObject({ allowed: false, count: 2 });
  });

  it('opens a new window once the old one has ended, and drops the ended one', async () => {
    await svc(
      `insert into rate_limits (key, window_start, count) values ('code_send:+15550143379', now() - interval '61 minutes', 9)`,
    );
    expect(await hit('code_send:+15550143379', 5, 3600)).toMatchObject({ allowed: true, count: 1 });
    expect(await svc(`select count from rate_limits where key = 'code_send:+15550143379'`)).toEqual(
      [{ count: 1 }],
    );
  });

  it('refuses a bad limit', async () => {
    expect(await failure(`select field_rate_limit('x', 0, 60)`)).toBe('invalid rate limit');
  });
});

describe('the field-api functions are the service role’s only', () => {
  const FUNCTIONS = [
    'field_lock_site_day(uuid,date)',
    'field_reporter_on_site(uuid,uuid)',
    'field_complete_upload(uuid,uuid,integer)',
    'field_set_day_status(uuid,uuid,date,text,jsonb)',
    'field_rate_limit(text,integer,integer)',
    'field_confirm_report(uuid,uuid,integer)',
  ];

  it('grants execute to service_role and to no API role', async () => {
    const rows = await svc<{ fn: string; anon: boolean; authenticated: boolean; service: boolean }>(
      `select f as fn, has_function_privilege('anon', f, 'execute') as anon,
              has_function_privilege('authenticated', f, 'execute') as authenticated,
              has_function_privilege('service_role', f, 'execute') as service
       from unnest($1::text[]) f order by 1`,
      [FUNCTIONS],
    );
    expect(rows).toHaveLength(FUNCTIONS.length);
    expect(rows.filter((r) => r.anon || r.authenticated || !r.service)).toEqual([]);
  });

  it('refuses an office user who calls one', async () => {
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: ID(500) },
      `select field_set_day_status('${MARCO}', '${SITE}', '2026-12-01', 'no_work')`,
    );
    expect(res).toMatchObject({ ok: false, code: '42501' });
  });
});

describe('upload bucket limits (storage)', () => {
  it('takes audio/* only in audio, 50 MB a file in audio and photos; photos keeps any type until step 22', async () => {
    const st = await bootDatabase({ storage: true });
    const rows = (
      await st.query<{ id: string; allowed_mime_types: string[] | null; file_size_limit: number }>(
        `select id, allowed_mime_types, file_size_limit::int from storage.buckets
         where id in ('audio', 'photos', 'pdfs') order by id`,
      )
    ).rows;
    expect(rows).toEqual([
      { id: 'audio', allowed_mime_types: ['audio/*'], file_size_limit: UPLOAD_MAX_BYTES },
      { id: 'pdfs', allowed_mime_types: null, file_size_limit: null },
      { id: 'photos', allowed_mime_types: null, file_size_limit: UPLOAD_MAX_BYTES },
    ]);
    await st.close();
  });
});
