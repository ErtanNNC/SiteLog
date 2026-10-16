import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { emptyReportData, uploadStoragePath, type DailyReportData } from '@sitelog/shared';
import { DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261016000060_voice_answers.sql (W2-09, F7 *Other…*, §10.7):
 * - uploads.question_id: an answer clip completes onto its question's report as no report material
 *   (no source, no status change, no job; the report's voice notes leave it out);
 * - field_answer_question_voice(): the `listening` try and parse_answer (`answer:<q>:<upload>`),
 *   idempotent per clip, `answer_pending` for a second clip, scoped and audited;
 * - field_settle_voice_answer(): applied (draft, answer, decide_next), unclear once (asked again),
 *   unclear twice (recorded unanswered, flagged), stale and settled-before tries changing nothing,
 *   a changed draft refused; service role only;
 * - job_lock_key(): parse_answer under the report's key.
 */

const ID = (n: number) => `cdcdcdcd-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = ID(1);
const SITE = ID(2);
const MARCO = ID(3);
const DANA = ID(4); // on another site of the org only
const SITE2 = ID(5);
const LENA = DEMO_USERS[0]!.id;

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

async function insertUpload(date: string, opts: { question?: string; reporter?: string } = {}) {
  const id = ID(seq++);
  const path = uploadStoragePath(ORG, SITE, date, id, 'webm');
  await svc(
    `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at, question_id)
     values ($1, $2, $3, 'audio', $4, 'audio/webm', now(), $5)`,
    [id, opts.reporter ?? MARCO, SITE, path, opts.question ?? null],
  );
  return id;
}

const complete = (id: string, reporter = MARCO) =>
  svc<{ r: Record<string, unknown> }>(`select field_complete_upload($1, $2, null) as r`, [
    id,
    reporter,
  ]).then((rows) => rows[0]!.r);

const draft = (date: string): DailyReportData => ({
  ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
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
      source: [],
    },
  ],
});

/** A report awaiting the answer to one web question (the worker's state after decide_next). */
async function awaiting(date: string) {
  const voice = await insertUpload(date);
  const { reportId } = (await complete(voice)) as { reportId: string };
  const base = draft(date);
  await svc(
    `insert into report_versions (report_id, version, data, author) values ($1, 1, $2, 'agent')`,
    [reportId, JSON.stringify(base)],
  );
  await svc(`update reports set status = 'awaiting_answer' where id = $1`, [reportId]);
  const [q] = await svc<{ id: string }>(
    `insert into questions (report_id, channel, field, target, prompt, asked_at)
     values ($1, 'web', 'manpower.workers', '{"manpowerIndex": 0}', 'How many?', now()) returning id`,
    [reportId],
  );
  return { reportId, questionId: q!.id, base, voice };
}

const speak = (report: string, question: string, upload: string, reporter = MARCO) =>
  svc<{ r: { status: string; jobId: number | null; repeat?: boolean } }>(
    `select field_answer_question_voice($1, $2, $3, $4) as r`,
    [report, question, reporter, upload],
  ).then((rows) => rows[0]!.r);

const settle = (
  question: string,
  upload: string,
  outcome: string,
  detail: object = {},
  extra: { base?: object; data?: object; answer?: object } = {},
) =>
  svc<{ r: Record<string, unknown> }>(
    `select field_settle_voice_answer($1, $2, $3, $4, $5, $6, $7) as r`,
    [
      question,
      upload,
      outcome,
      JSON.stringify(detail),
      extra.base ? JSON.stringify(extra.base) : null,
      extra.data ? JSON.stringify(extra.data) : null,
      extra.answer ? JSON.stringify(extra.answer) : null,
    ],
  ).then((rows) => rows[0]!.r);

const report = (id: string) =>
  svc<{ status: string; needs_review: boolean; review_reasons: string[] }>(
    `select status::text, needs_review, review_reasons from reports where id = $1`,
    [id],
  ).then((rows) => rows[0]!);

const question = (id: string) =>
  svc<{
    answered_at: string | null;
    answer: Record<string, unknown> | null;
    voice_answers: Array<Record<string, unknown>>;
  }>(`select answered_at, answer, voice_answers from questions where id = $1`, [id]).then(
    (rows) => rows[0]!,
  );

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(`
    insert into orgs (id, name) values ('${ORG}', 'Voice Answer Build');
    insert into sites (id, org_id, name, project_code, timezone) values
      ('${SITE}', '${ORG}', 'Riverside', 'VA-1', 'America/Chicago'),
      ('${SITE2}', '${ORG}', 'Pier', 'VA-2', 'America/Chicago');
    insert into reporters (id, org_id, name, phone_e164, status) values
      ('${MARCO}', '${ORG}', 'Marco Ruiz', '+15550149101', 'active'),
      ('${DANA}', '${ORG}', 'Dana Park', '+15550149102', 'active');
    insert into site_reporters (site_id, reporter_id, is_primary) values
      ('${SITE}', '${MARCO}', true), ('${SITE2}', '${DANA}', true);
  `);
});

describe('answer clips (uploads.question_id)', () => {
  it('complete onto the question’s report as no report material', async () => {
    const { reportId, questionId } = await awaiting('2026-10-05');
    const jobs = (await svc(`select id from jobs`)).length;
    const clip = await insertUpload('2026-10-05', { question: questionId });
    expect(await complete(clip)).toMatchObject({
      reportId,
      reportStatus: 'awaiting_answer',
      jobId: null,
      created: false,
      answerClip: true,
    });
    expect(await svc(`select 1 from report_sources where upload_id = $1`, [clip])).toEqual([]);
    expect((await svc(`select id from jobs`)).length).toBe(jobs);
    expect((await report(reportId)).status).toBe('awaiting_answer');
    // A retry answers alreadyComplete, still an answer clip.
    expect(await complete(clip)).toMatchObject({ alreadyComplete: true, answerClip: true });
    // A clip filed under another day than its question's report is refused.
    const wrongDay = await insertUpload('2026-10-06', { question: questionId });
    expect(await failure(`select field_complete_upload($1, $2, null)`, [wrongDay, MARCO])).toBe(
      'upload_path_mismatch',
    );
  });

  it('only an audio upload outside a batch names a question', async () => {
    const { questionId } = await awaiting('2026-10-07');
    expect(
      await failure(
        `insert into uploads (reporter_id, site_id, kind, storage_path, question_id)
         values ($1, $2, 'photo', 'x', $3)`,
        [MARCO, SITE, questionId],
      ),
    ).toMatch(/uploads_answer_clip_check/);
  });
});

describe('field_answer_question_voice and field_settle_voice_answer', () => {
  it('listening → applied: the draft, the answer, decide_next under the tap’s key, audited', async () => {
    const { reportId, questionId, base } = await awaiting('2026-10-12');
    const clip = await insertUpload('2026-10-12', { question: questionId });
    // Not completed yet: not this report's clip.
    expect(
      await failure(`select field_answer_question_voice($1, $2, $3, $4)`, [
        reportId,
        questionId,
        MARCO,
        clip,
      ]),
    ).toBe('upload_not_found');
    await complete(clip);
    const res = await speak(reportId, questionId, clip);
    expect(res.status).toBe('listening');
    const [job] = await svc<{
      type: string;
      dedupe_key: string;
      payload: object;
      lock_key: string | null;
    }>(
      `select type, dedupe_key, payload, job_lock_key(type, payload) as lock_key from jobs where id = $1`,
      [res.jobId],
    );
    expect(job).toEqual({
      type: 'parse_answer',
      dedupe_key: `answer:${questionId}:${clip}`,
      payload: { reportId, questionId, uploadId: clip },
      lock_key: `report:${reportId}`,
    });
    expect((await report(reportId)).status).toBe('awaiting_answer');
    // The same clip again: the first call's answer, no second job.
    expect(await speak(reportId, questionId, clip)).toMatchObject({
      status: 'listening',
      repeat: true,
    });
    expect(
      (
        await svc(
          `select 1 from jobs where type = 'parse_answer' and payload ->> 'questionId' = $1`,
          [questionId],
        )
      ).length,
    ).toBe(1);
    // Another clip while this one is listened to.
    const other = await insertUpload('2026-10-12', { question: questionId });
    await complete(other);
    expect(
      await failure(`select field_answer_question_voice($1, $2, $3, $4)`, [
        reportId,
        questionId,
        MARCO,
        other,
      ]),
    ).toBe('answer_pending');
    // Another reporter not on the site.
    expect(
      await failure(`select field_answer_question_voice($1, $2, $3, $4)`, [
        reportId,
        questionId,
        DANA,
        clip,
      ]),
    ).toBe('report_not_found');

    // A changed draft is refused; the job retries on the new one.
    const data = { ...base, manpower: [{ ...base.manpower[0]!, workers: 5, totalHours: 40 }] };
    const answer = {
      text: 'Five, all day.',
      parsed: { workers: 5, fullDay: true },
      voice: { type: 'voice_note', uploadId: clip, start: 0, end: 2 },
    };
    expect(
      await failure(`select field_settle_voice_answer($1, $2, 'applied', '{}', $3, $4, $5)`, [
        questionId,
        clip,
        JSON.stringify({ ...base, summary: 'other' }),
        JSON.stringify(data),
        JSON.stringify(answer),
      ]),
    ).toBe('draft_changed');
    expect(
      await settle(questionId, clip, 'applied', { confidence: 0.96 }, { base, data, answer }),
    ).toMatchObject({
      settled: true,
      status: 'applied',
    });
    const [v] = await svc<{ data: DailyReportData }>(
      `select data from report_versions where report_id = $1 and version = 1`,
      [reportId],
    );
    expect(v!.data.manpower[0]).toMatchObject({ workers: 5, totalHours: 40 });
    const q = await question(questionId);
    expect(q.answered_at).not.toBeNull();
    expect(q.answer).toEqual(answer);
    expect(q.voice_answers).toMatchObject([
      { uploadId: clip, status: 'applied', confidence: 0.96 },
    ]);
    expect((await report(reportId)).status).toBe('processing');
    expect(
      await svc(
        `select dedupe_key from jobs where type = 'decide_next' and payload ->> 'reportId' = $1`,
        [reportId],
      ),
    ).toEqual([{ dedupe_key: `decide:${reportId}:answer:${questionId}` }]);
    const audits = await svc<{ action: string; actor_type: string }>(
      `select action, actor_type::text from audit_log where entity_id = $1 and action like 'report.%' order by id`,
      [reportId],
    );
    expect(audits.filter((a) => /answer/.test(a.action))).toEqual([
      { action: 'report.answer_spoken', actor_type: 'reporter' },
      { action: 'report.question_answered', actor_type: 'agent' },
    ]);
    // Settled before (a retried job): nothing changes.
    expect(await settle(questionId, clip, 'unclear')).toEqual({
      settled: false,
      status: 'applied',
    });
    // The answered question takes no more clips.
    expect(
      await failure(`select field_answer_question_voice($1, $2, $3, $4)`, [
        reportId,
        questionId,
        MARCO,
        other,
      ]),
    ).toBe('question_closed');
  });

  it('unclear once: asked again; unclear twice: recorded unanswered, flagged, decide_next', async () => {
    const { reportId, questionId } = await awaiting('2026-10-13');
    const first = await insertUpload('2026-10-13', { question: questionId });
    await complete(first);
    await speak(reportId, questionId, first);
    expect(
      await settle(questionId, first, 'unclear', { reason: 'low_confidence', confidence: 0.15 }),
    ).toMatchObject({
      settled: true,
      status: 'unclear',
      retry: true,
    });
    expect((await question(questionId)).answered_at).toBeNull();
    expect((await report(reportId)).status).toBe('awaiting_answer');

    const second = await insertUpload('2026-10-13', { question: questionId });
    await complete(second);
    await speak(reportId, questionId, second);
    expect(await settle(questionId, second, 'unclear', { reason: 'silent' })).toMatchObject({
      settled: true,
      status: 'unclear',
      retry: false,
    });
    const q = await question(questionId);
    expect(q.answer).toEqual({
      unanswered: true,
      unclear: true,
      via: 'web',
      uploadIds: [first, second],
    });
    expect(await report(reportId)).toEqual({
      status: 'processing',
      needs_review: true,
      review_reasons: ['unanswered:manpower.workers'],
    });
    expect(
      await svc(`select 1 from jobs where type = 'decide_next' and dedupe_key = $1`, [
        `decide:${reportId}:answer:${questionId}`,
      ]),
    ).toHaveLength(1);
  });

  it('a try the question no longer needs (a tap, the timeout) is stale', async () => {
    const { reportId, questionId } = await awaiting('2026-10-14');
    const clip = await insertUpload('2026-10-14', { question: questionId });
    await complete(clip);
    await speak(reportId, questionId, clip);
    await svc(
      `update questions set answered_at = now(), answer = '{"unanswered": true, "timeout": true}' where id = $1`,
      [questionId],
    );
    expect(await settle(questionId, clip, 'unclear')).toEqual({ settled: false, status: 'stale' });
    expect((await question(questionId)).answer).toEqual({ unanswered: true, timeout: true });
  });

  it('both are the service role’s only', async () => {
    for (const f of [
      'field_answer_question_voice(uuid,uuid,uuid,uuid)',
      'field_settle_voice_answer(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
    ]) {
      const [row] = await svc<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [f],
      );
      expect(row, f).toEqual({ anon: false, authenticated: false, service: true });
    }
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: LENA },
      `select field_settle_voice_answer('${ID(999)}', '${ID(998)}', 'unclear')`,
    );
    expect(res).toMatchObject({ ok: false, code: '42501' });
  });
});
