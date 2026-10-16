import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { emptyReportData, uploadStoragePath, type DailyReportData } from '@sitelog/shared';
import { DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261016000110_filed_edits.sql (W2-11, F10 *Change something*, §7.2, §13, §19 Q81):
 * - field_request_filed_correction(): a change of a filed (or signed-off) report of a site the
 *   reporter covers (a backup too), dated within the last 14 days (site time), else
 *   `report_locked`; one at a time; apply_correction under the report's key;
 * - field_settle_correction(): a change after filing previews on the filed report;
 * - field_save_filed_correction(): version n+1 (author reporter, via web, the change note, the
 *   reporter who made it), the photos kept, re-denormalised, signed-off → filed with the signer's
 *   notice, audited, render_pdf with signerId and edit_applied; stale on a newer version;
 *   idempotent; service role only.
 */

const ID = (n: number) => `fefefefe-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = ID(1);
const SITE = ID(2);
const MARCO = ID(3);
const DANA = ID(4); // the backup on the site
const OMAR = ID(5); // on another site only
const SITE2 = ID(6);
const LENA = DEMO_USERS[0]!.id;
const TZ = 'America/Chicago';

let db: PGlite;
let seq = 100;

/** A date `days` before today in the site's time zone. */
function daysAgo(days: number): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await svc(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

async function insertUpload(date: string, opts: { fixes?: string; reporter?: string } = {}) {
  const id = ID(seq++);
  await svc(
    `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at, correction_report_id)
     values ($1, $2, $3, 'audio', $4, 'audio/webm', now(), $5)`,
    [
      id,
      opts.reporter ?? MARCO,
      SITE,
      uploadStoragePath(ORG, SITE, date, id, 'webm'),
      opts.fixes ?? null,
    ],
  );
  return id;
}

const complete = (id: string, reporter = MARCO) =>
  svc<{ r: { reportId: string } }>(`select field_complete_upload($1, $2, null) as r`, [
    id,
    reporter,
  ]).then((rows) => rows[0]!.r);

const crew = (date: string, workers = 6): DailyReportData => ({
  ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
  summary: 'Slab pour on Level 4.',
  manpower: [
    {
      companyId: null,
      companyNameHeard: 'Apex',
      companyName: 'Apex Concrete',
      workers,
      hoursPerWorker: 8,
      totalHours: workers * 8,
      hoursBasis: 'full_day_default',
      confidence: 0.95,
      source: [],
    },
  ],
});

/** A filed report of `date` (the worker's state after file_report), signed off when asked. */
async function filed(date: string, opts: { signedOff?: boolean; photos?: unknown[] } = {}) {
  const voice = await insertUpload(date);
  const { reportId } = await complete(voice);
  const base = { ...crew(date), photos: opts.photos ?? [] };
  await svc(
    `insert into report_versions (report_id, version, data, author) values ($1, 1, $2, 'agent')`,
    [reportId, JSON.stringify(base)],
  );
  await svc(
    `update reports set status = $2::report_status, filed_at = now(),
       signed_off_by = $3, signed_off_at = case when $3::uuid is null then null else now() end
     where id = $1`,
    [reportId, opts.signedOff ? 'signed_off' : 'filed', opts.signedOff ? LENA : null],
  );
  return { reportId, base };
}

const request = (report: string, opts: { upload?: string; text?: string; reporter?: string }) =>
  svc<{ r: { id: string; status: string; jobId: number | null; repeat?: boolean } }>(
    `select field_request_filed_correction($1, $2, $3, $4) as r`,
    [report, opts.reporter ?? MARCO, opts.upload ?? null, opts.text ?? null],
  ).then((rows) => rows[0]!.r);

/** The preview the worker would settle: Apex 6 → 7 (code's numbers), from version `version`. */
function preview(date: string, version = 1) {
  return {
    data: { ...crew(date, 7), photos: [] },
    changes: [
      {
        kind: 'crew',
        company: 'Apex Concrete',
        change: 'changed',
        workers: [6, 7],
        hoursPerWorker: [8, 8],
        totalHours: [48, 56],
      },
    ],
    operations: [{ op: 'replace', path: '/manpower/0/workers', value: 7 }],
    source: { type: 'reporter_edit', reporterId: MARCO, at: '2026-10-16T01:10:00Z', via: 'web' },
    changeNote: 'model note, not used',
    baseVersion: version,
    baseRev: 1,
  };
}

const settle = (id: string, outcome: string, detail: object = {}) =>
  svc<{ r: { settled: boolean; status: string } }>(
    `select field_settle_correction($1, $2, $3) as r`,
    [id, outcome, JSON.stringify(detail)],
  ).then((rows) => rows[0]!.r);

const MESSAGE = { weekday: 'Friday', change: 'Apex Concrete 6 -> 7 workers, 48 -> 56 h' };
const save = (id: string, report: string, reporter = MARCO, note = 'Apex Concrete 6 → 7 workers') =>
  svc<{ r: Record<string, unknown> }>(
    `select field_save_filed_correction($1, $2, $3, $4, $5) as r`,
    [id, report, reporter, note, JSON.stringify(MESSAGE)],
  ).then((rows) => rows[0]!.r);

const reportRow = (id: string) =>
  svc<{ status: string; current_version: number; signed_off_by: string | null }>(
    `select status::text, current_version, signed_off_by from reports where id = $1`,
    [id],
  ).then((rows) => rows[0]!);

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(`
    insert into orgs (id, name) values ('${ORG}', 'Change Build');
    insert into sites (id, org_id, name, project_code, timezone) values
      ('${SITE}', '${ORG}', 'Riverside', 'CH-1', '${TZ}'),
      ('${SITE2}', '${ORG}', 'Pier', 'CH-2', '${TZ}');
    insert into reporters (id, org_id, name, phone_e164, status) values
      ('${MARCO}', '${ORG}', 'Marco Ruiz', '+15550149301', 'active'),
      ('${DANA}', '${ORG}', 'Dana Park', '+15550149302', 'active'),
      ('${OMAR}', '${ORG}', 'Omar Diaz', '+15550149303', 'active');
    insert into site_reporters (site_id, reporter_id, is_primary) values
      ('${SITE}', '${MARCO}', true), ('${SITE}', '${DANA}', false), ('${SITE2}', '${OMAR}', true);
    insert into org_members (org_id, user_id, role) values ('${ORG}', '${LENA}', 'pm');
  `);
});

describe('field_request_filed_correction', () => {
  it('a spoken change of a filed report: the clip staged, apply_correction under the report key', async () => {
    const date = daysAgo(2);
    const { reportId } = await filed(date);
    const clip = await insertUpload(date, { fixes: reportId });
    await complete(clip);
    expect(await svc(`select 1 from report_sources where upload_id = $1`, [clip])).toEqual([]);
    const req = await request(reportId, { upload: clip });
    expect(req.status).toBe('listening');
    const [job] = await svc<{ dedupe_key: string; payload: object; lock_key: string }>(
      `select dedupe_key, payload, job_lock_key(type, payload) as lock_key from jobs where id = $1`,
      [req.jobId],
    );
    expect(job).toEqual({
      dedupe_key: `correction:${req.id}`,
      payload: { reportId, correctionId: req.id },
      lock_key: `report:${reportId}`,
    });
    const [row] = await svc<{ after_filing: boolean }>(
      `select after_filing from draft_corrections where id = $1`,
      [req.id],
    );
    expect(row!.after_filing).toBe(true);
    expect(await request(reportId, { upload: clip })).toMatchObject({ id: req.id, repeat: true });
    expect(
      await failure(`select field_request_filed_correction($1, $2, null, 'Apex had 8')`, [
        reportId,
        MARCO,
      ]),
    ).toBe('correction_pending');
    // The draft route refuses a filed report, and this one a draft.
    expect(
      await failure(`select field_request_correction($1, $2, null, 'Apex had 8')`, [
        reportId,
        MARCO,
      ]),
    ).toBe('wrong_state');
  });

  it('Q81: a reporter of the site (a backup too) within 14 days; another site, or older, no', async () => {
    const { reportId } = await filed(daysAgo(13));
    expect((await request(reportId, { text: 'Apex had 7', reporter: DANA })).status).toBe(
      'listening',
    );
    const { reportId: other } = await filed(daysAgo(12));
    expect(
      await failure(`select field_request_filed_correction($1, $2, null, 'Apex had 7')`, [
        other,
        OMAR,
      ]),
    ).toBe('report_not_found');
    const { reportId: old } = await filed(daysAgo(14));
    expect(
      await failure(`select field_request_filed_correction($1, $2, null, 'Apex had 7')`, [
        old,
        MARCO,
      ]),
    ).toBe('report_locked');
    expect(
      (
        await svc<{ a: boolean; b: boolean }>(
          `select field_report_changeable($1::date, $3) as a, field_report_changeable($2::date, $3) as b`,
          [daysAgo(13), daysAgo(14), TZ],
        )
      )[0],
    ).toEqual({ a: true, b: false });
  });
});

describe('field_save_filed_correction', () => {
  it('version n+1 from the preview, the signer told, render_pdf with the email and the text', async () => {
    const date = daysAgo(1);
    const photos = [{ uploadId: ID(9001), caption: 'Pour' }];
    const { reportId } = await filed(date, { signedOff: true, photos });
    const req = await request(reportId, { text: 'Apex had 7, not 6' });
    // Not previewed yet: nothing to save.
    expect(
      await failure(`select field_save_filed_correction($1, $2, $3, 'x')`, [
        req.id,
        reportId,
        MARCO,
      ]),
    ).toBe('correction_not_ready');
    expect(await settle(req.id, 'ready', preview(date))).toEqual({
      settled: true,
      status: 'ready',
    });

    const res = await save(req.id, reportId);
    expect(res).toMatchObject({ status: 'applied', reportStatus: 'filed', version: 2 });
    expect(await reportRow(reportId)).toEqual({
      status: 'filed',
      current_version: 2,
      signed_off_by: null,
    });
    const versions = await svc<{
      version: number;
      author: string;
      author_reporter_id: string | null;
      via: string | null;
      change_note: string | null;
      data: DailyReportData;
    }>(
      `select version, author::text, author_reporter_id, via::text, change_note, data
       from report_versions where report_id = $1 order by version`,
      [reportId],
    );
    expect(versions.map((v) => [v.version, v.author, v.author_reporter_id, v.via])).toEqual([
      [1, 'agent', null, null],
      [2, 'reporter', MARCO, 'web'],
    ]);
    expect(versions[1]!.change_note).toBe('Apex Concrete 6 → 7 workers');
    expect(versions[0]!.data.manpower[0]).toMatchObject({ workers: 6, totalHours: 48 });
    expect(versions[1]!.data.manpower[0]).toMatchObject({ workers: 7, totalHours: 56 });
    // A fix never changes photos: version 2 keeps version 1's.
    expect(versions[1]!.data.photos).toEqual(photos);
    // Re-denormalised: the crew rows follow version 2.
    const [mp] = await svc<{ workers: number; hours: number }>(
      `select workers, hours::float as hours from manpower_entries where report_id = $1 and version = 2`,
      [reportId],
    );
    expect(mp).toEqual({ workers: 7, hours: 56 });

    const [notice] = await svc<{ kind: string; user_id: string | null; data: object }>(
      `select kind, user_id, data from notifications where org_id = $1 and kind = 'report_edited'`,
      [ORG],
    );
    expect(notice).toMatchObject({ kind: 'report_edited', user_id: LENA });
    const jobs = await svc<{ type: string; dedupe_key: string; payload: Record<string, unknown> }>(
      `select type, dedupe_key, payload from jobs where type = 'render_pdf' and payload ->> 'reportId' = $1`,
      [reportId],
    );
    expect(jobs).toEqual([
      {
        type: 'render_pdf',
        dedupe_key: `render_pdf:${reportId}:2`,
        payload: {
          reportId,
          version: 2,
          emailRecipients: true,
          changeNote: 'Apex Concrete 6 → 7 workers',
          signerId: LENA,
          editApplied: { reporterId: MARCO, ...MESSAGE },
        },
      },
    ]);
    const actions = (
      await svc<{ action: string; actor_type: string; actor_id: string | null }>(
        `select action, actor_type, actor_id from audit_log where entity_id = $1 order by id`,
        [reportId],
      )
    ).filter((a) =>
      ['report.version_created', 'report.correction_saved', 'report.signoff_reverted'].includes(
        a.action,
      ),
    );
    expect(actions).toEqual([
      { action: 'report.version_created', actor_type: 'reporter', actor_id: MARCO },
      { action: 'report.correction_saved', actor_type: 'reporter', actor_id: MARCO },
      { action: 'report.signoff_reverted', actor_type: 'reporter', actor_id: MARCO },
    ]);

    // A retry (a lost answer): the same version, nothing made twice.
    expect(await save(req.id, reportId)).toMatchObject({
      status: 'applied',
      version: 2,
      repeat: true,
    });
    expect((await reportRow(reportId)).current_version).toBe(2);
    expect(
      (
        await svc(`select 1 from jobs where type = 'render_pdf' and payload ->> 'reportId' = $1`, [
          reportId,
        ])
      ).length,
    ).toBe(1);
  });

  it('a newer version first (the office, photos): the preview is stale; the draft path refuses it', async () => {
    const date = daysAgo(3);
    const { reportId } = await filed(date);
    const req = await request(reportId, { text: 'Apex had 7, not 6' });
    await settle(req.id, 'ready', preview(date));
    expect(
      await failure(`select field_apply_correction($1, $2, $3)`, [req.id, reportId, MARCO]),
    ).toBe('wrong_state');
    // The office makes version 2 meanwhile.
    await svc(
      `insert into report_versions (report_id, version, data, author, change_note)
       values ($1, 2, $2, 'office_user', 'Office fix')`,
      [reportId, JSON.stringify(crew(date, 5))],
    );
    await svc(`update reports set current_version = 2 where id = $1`, [reportId]);
    expect(await save(req.id, reportId)).toMatchObject({
      status: 'stale',
      currentVersion: 2,
    });
    expect(
      (
        await svc<{ status: string }>(`select status from draft_corrections where id = $1`, [
          req.id,
        ])
      )[0]!.status,
    ).toBe('stale');
    // Another reporter cannot save Marco's change.
    const req2 = await request(reportId, { text: 'Apex had 8' });
    await settle(req2.id, 'ready', preview(date, 2));
    expect(
      await failure(`select field_save_filed_correction($1, $2, $3, 'x')`, [
        req2.id,
        reportId,
        DANA,
      ]),
    ).toBe('correction_not_found');
  });

  it('a report that left filed meanwhile settles stale', async () => {
    const date = daysAgo(4);
    const { reportId } = await filed(date);
    const req = await request(reportId, { text: 'Apex had 7' });
    await svc(`update reports set status = 'void' where id = $1`, [reportId]);
    expect(await settle(req.id, 'ready', preview(date))).toEqual({
      settled: true,
      status: 'stale',
    });
  });
});

describe('service role only', () => {
  it('no client may call the RPCs', async () => {
    for (const sql of [
      `select field_request_filed_correction(gen_random_uuid(), gen_random_uuid(), null, 'x')`,
      `select field_save_filed_correction(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')`,
      `select field_report_changeable(current_date, 'UTC')`,
    ]) {
      for (const caller of [
        { role: 'anon' as const },
        { role: 'authenticated' as const, userId: LENA },
      ]) {
        const res = await probeAs(db, caller, sql);
        expect(res, sql).toMatchObject({ ok: false, code: '42501' });
      }
    }
  });
});

/**
 * 20261016000140_sms_keywords.sql (W2-12, F10 by SMS): sms_request_filed_correction() is the typed
 * path for an SMS EDIT, with the text's id on the correction and channel 'sms' in the audit; a
 * retry of the same text answers its correction; the 14 days, one at a time and Q99 as on the web;
 * the sms_keyword job runs under the phone's lock with the messages' priority.
 */
describe('sms_request_filed_correction (W2-12)', () => {
  const inbound = async (body: string, phone = '+15550149301') => {
    const id = ID(seq++);
    await svc(
      `insert into messages (id, org_id, reporter_id, channel, phone_e164, direction, provider,
                             provider_message_id, body, status)
       values ($1, $2, $3, 'sms', $4, 'in', 'twilio', $5, $6, 'received')`,
      [id, ORG, MARCO, phone, `SM${id.replace(/-/g, '')}`, body],
    );
    return id;
  };
  const smsRequest = (report: string, text: string, message: string, reporter = MARCO) =>
    svc<{ r: { id: string; status: string; jobId: number | null; repeat?: boolean } }>(
      `select sms_request_filed_correction($1, $2, $3, $4) as r`,
      [report, reporter, text, message],
    ).then((rows) => rows[0]!.r);

  it('a typed change from the text, apply_correction queued, audited with channel sms; a retry answers it', async () => {
    const { reportId } = await filed(daysAgo(6));
    const message = await inbound('EDIT FRI Apex was 7 not 6');
    const req = await smsRequest(reportId, 'Apex was 7 not 6', message);
    expect(req.status).toBe('listening');
    const [row] = await svc<Record<string, unknown>>(
      `select via, text, after_filing, message_id, reporter_id from draft_corrections where id = $1`,
      [req.id],
    );
    expect(row).toEqual({
      via: 'text',
      text: 'Apex was 7 not 6',
      after_filing: true,
      message_id: message,
      reporter_id: MARCO,
    });
    const [job] = await svc<{ dedupe_key: string; lock_key: string }>(
      `select dedupe_key, job_lock_key(type, payload) as lock_key from jobs where id = $1`,
      [req.jobId],
    );
    expect(job).toEqual({ dedupe_key: `correction:${req.id}`, lock_key: `report:${reportId}` });
    const [audit] = await svc<{ actor_type: string; diff: Record<string, unknown> }>(
      `select actor_type, diff from audit_log
        where entity_id = $1 and action = 'report.correction_requested' and diff->>'correction_id' = $2`,
      [reportId, req.id],
    );
    expect(audit).toMatchObject({
      actor_type: 'reporter',
      diff: { channel: 'sms', message_id: message, after_filing: true },
    });
    expect(await smsRequest(reportId, 'Apex was 7 not 6', message)).toMatchObject({
      id: req.id,
      repeat: true,
    });
    // One at a time, as on the web.
    expect(
      await failure(`select sms_request_filed_correction($1, $2, 'Apex had 8', $3)`, [
        reportId,
        MARCO,
        await inbound('EDIT FRI Apex had 8'),
      ]),
    ).toBe('correction_pending');
  });

  it('refuses a report older than 14 days, of a paused site, of another site, and an outbound message', async () => {
    const { reportId: old } = await filed(daysAgo(15));
    expect(
      await failure(`select sms_request_filed_correction($1, $2, 'Apex had 7', $3)`, [
        old,
        MARCO,
        await inbound('EDIT'),
      ]),
    ).toBe('report_locked');
    const { reportId } = await filed(daysAgo(7));
    expect(
      await failure(`select sms_request_filed_correction($1, $2, 'Apex had 7', $3)`, [
        reportId,
        OMAR,
        await inbound('EDIT'),
      ]),
    ).toBe('report_not_found');
    const out = ID(seq++);
    await svc(
      `insert into messages (id, org_id, channel, phone_e164, direction, provider, body, status)
       values ($1, $2, 'sms', '+15550149301', 'out', 'console', 'x', 'sent')`,
      [out, ORG],
    );
    expect(
      await failure(`select sms_request_filed_correction($1, $2, 'Apex had 7', $3)`, [
        reportId,
        MARCO,
        out,
      ]),
    ).toBe('message_not_found');
    await svc(`update sites set status = 'paused' where id = $1`, [SITE]);
    try {
      expect(
        await failure(`select sms_request_filed_correction($1, $2, 'Apex had 7', $3)`, [
          reportId,
          MARCO,
          await inbound('EDIT'),
        ]),
      ).toBe('site_inactive');
    } finally {
      await svc(`update sites set status = 'active' where id = $1`, [SITE]);
    }
  });

  it('sms_keyword runs under the phone lock with the messages priority', async () => {
    const message = await inbound('WEATHER', '+15550149377');
    const [k] = await svc<{ lock: string; prio: number }>(
      `select job_lock_key('sms_keyword', jsonb_build_object('messageId', $1::text)) as lock,
              job_priority('sms_keyword') as prio`,
      [message],
    );
    expect(k).toEqual({ lock: 'sms:+15550149377', prio: 0 });
  });
});
