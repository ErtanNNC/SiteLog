import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  DailyReportDataSchema,
  emptyReportData,
  emptyReportDataV1,
  uploadStoragePath,
  type DailyReportData,
} from '@sitelog/shared';
import { DEMIR_ORG_ID, DEMIR_USERS } from '@sitelog/shared/demo/demir.ts';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261015000002_extraction_v2.sql (W1-12):
 * - create_office_report() writes report data v2 (the org's language and units stamped by the
 *   server), and v1 for a panel built before W1-12 that still sends v1;
 * - field_complete_upload(): a photo on a draft awaiting confirmation reopens it (§7.2) and
 *   queues one extraction;
 * - field_answer_question(): field-api's `reports/:id/answer`, scoped, audited, idempotent.
 */

const ID = (n: number) => `abababab-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = ID(1);
const SITE = ID(2);
const MARCO = ID(3);
const DANA = ID(4); // linked to another site of the org only
const SITE2 = ID(5);
const LENA = DEMO_USERS[0]!.id;
const ELIF = DEMIR_USERS[0]!.id;

let db: PGlite;
let seq = 100;

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

async function upload(kind: 'audio' | 'photo', date: string, reporter = MARCO, site = SITE) {
  const id = ID(seq++);
  const path = uploadStoragePath(ORG, site, date, id, kind === 'audio' ? 'webm' : 'jpg');
  await svc(
    `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [id, reporter, site, kind, path, kind === 'audio' ? 'audio/webm' : 'image/jpeg'],
  );
  const [r] = await svc<{ r: { reportId: string; reportStatus: string; jobId: number | null } }>(
    `select field_complete_upload($1, $2, null) as r`,
    [id, reporter],
  );
  return { uploadId: id, ...r!.r };
}

const status = async (reportId: string) =>
  (await svc<{ s: string }>(`select status::text as s from reports where id = $1`, [reportId]))[0]!
    .s;

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(`
    insert into orgs (id, name) values ('${ORG}', 'Answer Test Build');
    insert into sites (id, org_id, name, project_code, timezone) values
      ('${SITE}', '${ORG}', 'Riverside', 'AT-1', 'America/Chicago'),
      ('${SITE2}', '${ORG}', 'Pier', 'AT-2', 'America/Chicago');
    insert into reporters (id, org_id, name, phone_e164, status) values
      ('${MARCO}', '${ORG}', 'Marco Ruiz', '+15550149001', 'active'),
      ('${DANA}', '${ORG}', 'Dana Park', '+15550149002', 'active');
    insert into site_reporters (site_id, reporter_id, is_primary) values
      ('${SITE}', '${MARCO}', true), ('${SITE2}', '${DANA}', true);
  `);
});

describe('create_office_report writes v2 (W1-12)', () => {
  const sites = async (org: string) =>
    (
      await svc<{ id: string }>(`select id from sites where org_id = $1 order by project_code`, [
        org,
      ])
    ).map((s) => s.id);

  it('stamps schemaVersion 2, the date, the org language and units, and uploadId photos', async () => {
    const [site] = await sites(DEMO_ORG_ID);
    const data = emptyReportData('2000-01-01', { reportLanguage: 'tr', units: 'metric' });
    const { schemaVersion: _v, reportDate: _d, reportLanguage: _l, units: _u, ...body } = data;
    const res = await asUser(
      db,
      LENA,
      async (q) =>
        (
          await q<{ r: { reportId: string; created: boolean } }>(
            `select create_office_report($1, '2026-09-01', $2) as r`,
            [site, JSON.stringify({ ...body, summary: 'Deck formwork.' })],
          )
        ).rows[0]!.r,
    );
    expect(res.created).toBe(true);
    const [v] = await svc<{ data: DailyReportData }>(
      `select data from report_versions where report_id = $1 and version = 1`,
      [res.reportId],
    );
    expect(v!.data).toMatchObject({
      schemaVersion: 2,
      reportDate: '2026-09-01',
      reportLanguage: 'en',
      units: 'imperial',
    });
    expect(DailyReportDataSchema.safeParse(v!.data).success).toBe(true);
  });

  it('a TR org gets tr and metric', async () => {
    const [site] = await sites(DEMIR_ORG_ID);
    const { schemaVersion: _v, ...body } = emptyReportData('2000-01-01', {
      reportLanguage: 'en',
      units: 'imperial',
    });
    const res = await asUser(
      db,
      ELIF,
      async (q) =>
        (
          await q<{ r: { reportId: string } }>(
            `select create_office_report($1, '2026-09-01', $2) as r`,
            [site, JSON.stringify({ ...body, summary: 'Kalıp işleri.' })],
          )
        ).rows[0]!.r,
      DEMIR_USERS[0]!.email,
    );
    const [v] = await svc<{ data: DailyReportData }>(
      `select data from report_versions where report_id = $1 and version = 1`,
      [res.reportId],
    );
    expect(v!.data).toMatchObject({ schemaVersion: 2, reportLanguage: 'tr', units: 'metric' });
  });

  it('a panel built before W1-12 (v1 data) still files a v1 version', async () => {
    const [, site] = await sites(DEMO_ORG_ID);
    const res = await asUser(
      db,
      LENA,
      async (q) =>
        (
          await q<{ r: { reportId: string } }>(
            `select create_office_report($1, '2026-09-02', $2) as r`,
            [site, JSON.stringify({ ...emptyReportDataV1('2000-01-01'), summary: 'Old tab.' })],
          )
        ).rows[0]!.r,
    );
    const [v] = await svc<{ data: { schemaVersion: number; reportDate: string } }>(
      `select data from report_versions where report_id = $1 and version = 1`,
      [res.reportId],
    );
    expect(v!.data).toMatchObject({ schemaVersion: 1, reportDate: '2026-09-02' });
    expect(v!.data).not.toHaveProperty('reportLanguage');
  });
});

describe('a photo on a draft awaiting confirmation (§7.2 "more photos")', () => {
  it('reopens the draft and queues one extraction; other states only attach the photo', async () => {
    const date = '2026-10-01';
    const voice = await upload('audio', date);
    expect(voice.reportStatus).toBe('processing');
    // While processing: attached, nothing queued (the running extraction picks it up).
    const p1 = await upload('photo', date);
    expect(p1.jobId).toBeNull();
    expect(await status(voice.reportId)).toBe('processing');

    await svc(`update reports set status = 'awaiting_confirmation' where id = $1`, [
      voice.reportId,
    ]);
    const p2 = await upload('photo', date);
    expect(p2.reportStatus).toBe('processing');
    const [job] = await svc<{ type: string; dedupe_key: string; payload: unknown }>(
      `select type::text, dedupe_key, payload from jobs where id = $1`,
      [p2.jobId],
    );
    expect(job).toEqual({
      type: 'extract_report',
      dedupe_key: `extract:${voice.reportId}:photo:${p2.uploadId}`,
      payload: { reportId: voice.reportId, reason: `photo:${p2.uploadId}` },
    });
    const audits = await svc<{ diff: { from: string; to: string; upload_id: string } }>(
      `select diff from audit_log where entity_id = $1 and action = 'report.status_changed'
       order by created_at desc limit 1`,
      [voice.reportId],
    );
    expect(audits[0]!.diff).toMatchObject({
      from: 'awaiting_confirmation',
      to: 'processing',
      upload_id: p2.uploadId,
    });

    // A question open: the photo is attached, the question stays.
    await svc(`update reports set status = 'awaiting_answer' where id = $1`, [voice.reportId]);
    const p3 = await upload('photo', date);
    expect(p3.jobId).toBeNull();
    expect(await status(voice.reportId)).toBe('awaiting_answer');
  });
});

describe('field_answer_question (reports/:id/answer)', () => {
  let reportId = '';
  let questionId = '';
  let base: DailyReportData;
  const date = '2026-10-05';
  const answer = { optionId: 'o2', text: '5 · full day', value: { workers: 5, fullDay: true } };

  const draft = (): DailyReportData => ({
    ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Ductwork on Level 2.',
    manpower: [
      {
        companyId: null,
        companyNameHeard: 'the Delta guys',
        companyName: 'Delta Mechanical',
        workers: null,
        hoursPerWorker: 8,
        totalHours: null,
        hoursBasis: 'full_day_default',
        confidence: 0.85,
        source: [{ type: 'voice_note', uploadId: ID(1), start: 33 }],
      },
    ],
  });

  const call = (over: Partial<Record<string, unknown>> = {}) => {
    const a = {
      report: reportId,
      question: questionId,
      reporter: MARCO,
      base,
      data: { ...base, manpower: [{ ...base.manpower[0]!, workers: 5, totalHours: 40 }] },
      answer,
      source: { type: 'answer', questionId },
      ...over,
    };
    return [
      `select field_answer_question($1, $2, $3, $4, $5, $6, $7) as r`,
      [
        a.report,
        a.question,
        a.reporter,
        JSON.stringify(a.base),
        JSON.stringify(a.data),
        JSON.stringify(a.answer),
        JSON.stringify(a.source),
      ],
    ] as const;
  };

  beforeAll(async () => {
    const voice = await upload('audio', date);
    reportId = voice.reportId;
    base = draft();
    await svc(
      `insert into report_versions (report_id, version, data, summary, author) values ($1, 1, $2, 'x', 'agent')`,
      [reportId, JSON.stringify(base)],
    );
    const [q] = await svc<{ id: string }>(
      `insert into questions (report_id, channel, field, target, prompt, options, asked_at)
       values ($1, 'web', 'manpower.workers', $2, 'How many?', $3, now()) returning id`,
      [
        reportId,
        JSON.stringify({ manpowerIndex: 0, path: 'manpower.workers:Delta Mechanical' }),
        JSON.stringify([
          { id: 'o1', label: '4 · full day' },
          { id: 'o2', label: '5 · full day' },
        ]),
      ],
    );
    questionId = q!.id;
  });

  it('refuses while the report is not awaiting an answer', async () => {
    const [sql, params] = call();
    expect(await failure(sql, [...params])).toBe('wrong_state');
  });

  it('refuses a reporter not on the site, a question of another report, a changed draft', async () => {
    await svc(`update reports set status = 'awaiting_answer' where id = $1`, [reportId]);
    const [s1, p1] = call({ reporter: DANA });
    expect(await failure(s1, [...p1])).toBe('report_not_found');
    const [s2, p2] = call({ question: ID(999) });
    expect(await failure(s2, [...p2])).toBe('question_not_found');
    const [s3, p3] = call({ base: { ...base, summary: 'stale' } });
    expect(await failure(s3, [...p3])).toBe('draft_changed');
    const [s4, p4] = call({ data: { ...base, schemaVersion: 1 } });
    expect(await failure(s4, [...p4])).toBe('invalid_answer_data');
  });

  it('stores the draft and the answer, reopens processing, audits and queues decide_next once', async () => {
    const [sql, params] = call();
    const [r] = await svc<{ r: { status: string; reportStatus: string; jobId: number } }>(sql, [
      ...params,
    ]);
    expect(r!.r).toMatchObject({ status: 'processing', reportStatus: 'processing' });
    expect(await status(reportId)).toBe('processing');
    const [v] = await svc<{ data: DailyReportData }>(
      `select data from report_versions where report_id = $1 and version = 1`,
      [reportId],
    );
    expect(v!.data.manpower[0]).toMatchObject({ workers: 5, totalHours: 40 });
    const [q] = await svc<{ answer: unknown; answer_source: unknown; answered: boolean }>(
      `select answer, answer_source, answered_at is not null as answered from questions where id = $1`,
      [questionId],
    );
    expect(q).toEqual({
      answer,
      answer_source: { type: 'answer', questionId },
      answered: true,
    });
    const [job] = await svc<{ type: string; dedupe_key: string }>(
      `select type::text, dedupe_key from jobs where id = $1`,
      [r!.r.jobId],
    );
    expect(job).toEqual({
      type: 'decide_next',
      dedupe_key: `decide:${reportId}:answer:${questionId}`,
    });
    const [audit] = await svc<{
      actor_type: string;
      actor_id: string;
      diff: Record<string, unknown>;
    }>(
      `select actor_type::text, actor_id, diff from audit_log
       where entity_id = $1 and action = 'report.question_answered'`,
      [reportId],
    );
    expect(audit).toMatchObject({
      actor_type: 'reporter',
      actor_id: MARCO,
      diff: { question_id: questionId, field: 'manpower.workers', channel: 'web', option_id: 'o2' },
    });
  });

  it('a retry of the same answer gets already_answered; another answer is refused', async () => {
    const [sql, params] = call();
    const [r] = await svc<{ r: { status: string } }>(sql, [...params]);
    expect(r!.r.status).toBe('already_answered');
    const [s2, p2] = call({ answer: { ...answer, optionId: 'o1' } });
    expect(await failure(s2, [...p2])).toBe('question_closed');
    expect(
      (
        await svc<{ n: number }>(
          `select count(*)::int as n from jobs where dedupe_key like 'decide:' || $1 || ':answer:%'`,
          [reportId],
        )
      )[0]!.n,
    ).toBe(1);
  });

  it('"Add <company>" creates the unconfirmed company, points the crew at it and flags review', async () => {
    const d = '2026-10-06';
    const voice = await upload('audio', d);
    const draftData: DailyReportData = {
      ...emptyReportData(d, { reportLanguage: 'en', units: 'imperial' }),
      manpower: [
        {
          companyId: null,
          companyNameHeard: 'the Ridgeway crew',
          companyName: 'Ridgeway',
          workers: 3,
          hoursPerWorker: 8,
          totalHours: 24,
          hoursBasis: 'full_day_default',
          confidence: 0.9,
          source: [],
        },
      ],
    };
    await svc(
      `insert into report_versions (report_id, version, data, summary, author) values ($1, 1, $2, 'x', 'agent')`,
      [voice.reportId, JSON.stringify(draftData)],
    );
    const [q] = await svc<{ id: string }>(
      `insert into questions (report_id, channel, field, target, prompt, asked_at)
       values ($1, 'web', 'company.unknown', '{"manpowerIndex":0}', 'New?', now()) returning id`,
      [voice.reportId],
    );
    await svc(`update reports set status = 'awaiting_answer' where id = $1`, [voice.reportId]);
    await svc(`select field_answer_question($1, $2, $3, $4, $4, $5, $6, $7)`, [
      voice.reportId,
      q!.id,
      MARCO,
      JSON.stringify(draftData),
      JSON.stringify({ optionId: 'o1' }),
      JSON.stringify({ type: 'answer', questionId: q!.id }),
      JSON.stringify({ name: 'Ridgeway', manpowerIndex: 0 }),
    ]);
    const [company] = await svc<{ id: string; status: string }>(
      `select id, status::text from companies where org_id = $1 and name = 'Ridgeway'`,
      [ORG],
    );
    expect(company!.status).toBe('unconfirmed');
    const [v] = await svc<{ data: DailyReportData }>(
      `select data from report_versions where report_id = $1 and version = 1`,
      [voice.reportId],
    );
    expect(v!.data.manpower[0]).toMatchObject({ companyId: company!.id, companyName: 'Ridgeway' });
    const [r] = await svc<{ needs_review: boolean; review_reasons: string[] }>(
      `select needs_review, review_reasons from reports where id = $1`,
      [voice.reportId],
    );
    expect(r).toEqual({ needs_review: true, review_reasons: ['unknown_company:Ridgeway'] });
  });

  it('is the service role’s only', async () => {
    const [row] = await svc<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select has_function_privilege('anon', f, 'execute') as anon,
              has_function_privilege('authenticated', f, 'execute') as authenticated,
              has_function_privilege('service_role', f, 'execute') as service
       from (select 'field_answer_question(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb)'::text as f) x`,
    );
    expect(row).toEqual({ anon: false, authenticated: false, service: true });
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: LENA },
      `select field_answer_question('${reportId}', '${questionId}', '${MARCO}', '{}', '{}', '{}', '{}', null)`,
    );
    expect(res).toMatchObject({ ok: false, code: '42501' });
  });
});
