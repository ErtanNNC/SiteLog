import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAnswer,
  optionAnswer,
  readReportData,
  type DailyReportData,
  type JobRow,
  type QuestionOption,
  type StoredReportData,
} from '@sitelog/shared';
import { createFakeTranscriber } from '../ai/fake-transcriber';
import { memoryLogger } from '../log';
import { DEVICE_ACTIVE_MS } from '../pipeline/web';
import { runJob } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { createSim, loadFixtureLibrary, manualClock, NO_LATENCY } from './fakes';
import { createWorld, type World } from './world';

/**
 * W1-12 on a real database (PGlite, every migration and the §18 seed): the web recorder's report
 * through the real runner and the production repository. The ES + EN hero voice note
 * (fixtures/voice/es-en-riverside-2026-10-09) → the fake transcriber → extraction v2 on the
 * recorded tool output → a v2 draft and exactly one question, the Delta headcount (D27), on the
 * web channel, with no text while the reporter's device was seen in the last 30 s (D25); then the
 * answer (field_answer_question(), as field-api's `reports/:id/answer` calls it) → the draft;
 * then a photo on the draft (§7.2) → a new extraction → the draft again. W1-15: Confirm & send
 * (field_confirm_report(), as field-api's `reports/:id/confirm` calls it) → file_report → one PDF,
 * one `filed` text and one email, even when every job is retried or the filing failed after
 * `status = filed`.
 */

let database: PgliteDatabase;
let world: World;
let log: ReturnType<typeof memoryLogger>;
const clock = manualClock(new Date('2026-10-12T22:35:00Z'));

let MARCO = '';
let RIVERSIDE = '';
let ORG = '';

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  log = memoryLogger('info');
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim: createSim({ advance: clock, profile: NO_LATENCY }),
    lib: loadFixtureLibrary(['riverside-2026-10-09']),
    log,
    fieldTranscriber: createFakeTranscriber(),
    config: {
      CLAUDE_MODEL: 'claude-sonnet-5-5',
      LINK_SIGNING_SECRET: 'integration-link-secret',
      FIELD_APP_URL: 'https://go.sitelog.test',
    },
  });
  const q = database.q.bind(database);
  const marco = (
    await q<{ id: string; org_id: string }>(
      `select id, org_id from reporters where name = 'Marco Ruiz'`,
    )
  )[0]!;
  MARCO = marco.id;
  ORG = marco.org_id;
  RIVERSIDE = (await q<{ id: string }>(`select id from sites where project_code = 'RL-2041'`))[0]!
    .id;
  // A verified device of Marco's (the recorder he reports from).
  await q(
    `insert into field_devices (reporter_id, device_token_hash, verified_at, last_seen_at)
     values ($1, 'w1-12-device', now(), $2)`,
    [MARCO, clock.now().toISOString()],
  );
}, 120_000);

afterAll(async () => {
  await database?.close();
});

/** Claims one job by id (as claim_jobs does) and runs it through the real runner. */
async function run(jobId: number) {
  const [row] = await database.q<JobRow>(
    `update jobs set status = 'running', locked_at = now(), locked_by = 'integration',
       attempts = attempts + 1 where id = $1 returning *`,
    [jobId],
  );
  return runJob(world.ctx, row!, 60_000, { workerId: 'integration' });
}

/** The queued jobs of a report, by type, oldest first. */
async function queued(reportId: string, type: string) {
  return database.q<{ id: number; dedupe_key: string }>(
    `select id, dedupe_key from jobs where type = $1 and status = 'queued'
       and payload ->> 'reportId' = $2 order by id`,
    [type, reportId],
  );
}

async function runQueued(reportId: string, type: string) {
  const jobs = await queued(reportId, type);
  expect(jobs, `${type} queued`).toHaveLength(1);
  expect(await run(jobs[0]!.id)).toEqual({ ok: true });
  return jobs[0]!;
}

async function draftOf(reportId: string): Promise<{ data: DailyReportData; raw: unknown }> {
  const [v] = await database.q<{ data: StoredReportData }>(
    `select v.data from report_versions v join reports r on r.id = v.report_id
       and v.version = r.current_version where r.id = $1`,
    [reportId],
  );
  return { data: readReportData(v!.data), raw: v!.data };
}

const status = async (reportId: string) =>
  (
    await database.q<{ s: string }>(`select status::text as s from reports where id = $1`, [
      reportId,
    ])
  )[0]!.s;

const texts = async (key: string) =>
  database.q<{ body: string; channel: string }>(
    `select body, channel::text from messages where reporter_id = $1 and copy_key = $2`,
    [MARCO, key],
  );

/** A photo of the report as field-api completes it (the `photos` bucket path, field_complete_upload). */
async function photo(): Promise<{ uploadId: string; jobId: number | null; status: string }> {
  const [u] = await database.q<{ id: string }>(
    `insert into uploads (reporter_id, site_id, kind, storage_path, mime, recorded_at)
     values ($1, $2, 'photo', 'pending', 'image/jpeg', now()) returning id`,
    [MARCO, RIVERSIDE],
  );
  const path = `${ORG}/${RIVERSIDE}/2026-10-12/${u!.id}.jpg`;
  await database.q(`update uploads set storage_path = $2 where id = $1`, [u!.id, path]);
  const [r] = await database.q<{ r: { jobId: number | null; reportStatus: string } }>(
    `select field_complete_upload($1, $2, 1) as r`,
    [u!.id, MARCO],
  );
  return { uploadId: u!.id, jobId: r!.r.jobId, status: r!.r.reportStatus };
}

const seen = (msAgo: number) =>
  database.q(`update field_devices set last_seen_at = $2 where reporter_id = $1`, [
    MARCO,
    new Date(clock.now().getTime() - msAgo).toISOString(),
  ]);

describe('W1-12: ES + EN voice note → extraction v2 → one question → answer → draft', () => {
  let reportId = '';
  let questionId = '';

  it('the hero note yields a v2 draft and exactly one question, the Delta headcount', async () => {
    const up = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date: '2026-10-12',
    });
    reportId = up.reportId;
    // "Sending two photos": they reach the report while it is processing (attached, no job).
    expect((await photo()).jobId).toBeNull();
    expect((await photo()).jobId).toBeNull();
    expect(await run(up.jobId!)).toEqual({ ok: true }); // transcribe_upload
    await runQueued(reportId, 'extract_report');
    const { data } = await draftOf(reportId);
    expect(data).toMatchObject({
      schemaVersion: 2,
      reportLanguage: 'en',
      units: 'imperial',
      reportDate: '2026-10-12',
    });
    expect(data.languageDetected.sort()).toEqual(['en', 'es']);
    const delta = data.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    // Never invented: the headcount nobody said stays null.
    expect(delta).toMatchObject({ workers: null, totalHours: null, hoursPerWorker: 8 });
    expect(delta.source).toEqual([
      { type: 'voice_note', uploadId: up.uploadId, start: 33, end: 40.5 },
    ]);
    // The totals code computed: Apex 6 × 8.
    expect(data.manpower[0]).toMatchObject({ workers: 6, hoursPerWorker: 8, totalHours: 48 });

    // The device was seen just now: the reporter is on the recorder, so no text (D25).
    await seen(5_000);
    const decide = await runQueued(reportId, 'decide_next');
    expect(decide.dedupe_key).toMatch(new RegExp(`^decide:${reportId}:extract-job:\\d+$`));
    const questions = await database.q<{
      id: string;
      channel: string;
      field: string;
      target: { path: string };
      options: QuestionOption[];
      answered_at: string | null;
    }>(`select * from questions where report_id = $1`, [reportId]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      channel: 'web',
      field: 'manpower.workers',
      target: { path: 'manpower.workers:Delta Mechanical' },
      options: [
        { id: 'o1', label: '4 · full day' },
        { id: 'o2', label: '5 · full day' },
      ],
      answered_at: null,
    });
    questionId = questions[0]!.id;
    expect(await status(reportId)).toBe('awaiting_answer');
    expect(await texts('question_ready')).toEqual([]);
    const skipped = await database.q<{ diff: { key: string; reason: string } }>(
      `select diff from audit_log where entity_id = $1 and action = 'notify.skipped'`,
      [reportId],
    );
    expect(skipped.map((a) => a.diff)).toMatchObject([
      { key: 'question_ready', reason: 'device_active' },
    ]);
    const line = log.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'question ready' && l.report_id === reportId);
    expect(typeof line?.upload_to_decision_ms).toBe('number');
  });

  it('a retried decide_next asks nothing twice', async () => {
    const [row] = await database.q<JobRow>(
      `select * from jobs where type = 'decide_next' and payload ->> 'reportId' = $1`,
      [reportId],
    );
    await database.q(`update jobs set status = 'queued' where id = $1`, [row!.id]);
    expect(await run(row!.id)).toEqual({ ok: true });
    expect(
      await database.q(`select 1 from questions where report_id = $1`, [reportId]),
    ).toHaveLength(1);
  });

  it('the device away for 30 s: the question is texted once, with the personal link', async () => {
    await seen(DEVICE_ACTIVE_MS);
    const [row] = await database.q<JobRow>(
      `select * from jobs where type = 'decide_next' and payload ->> 'reportId' = $1`,
      [reportId],
    );
    await database.q(`update jobs set status = 'queued' where id = $1`, [row!.id]);
    expect(await run(row!.id)).toEqual({ ok: true });
    await database.q(`update jobs set status = 'queued' where id = $1`, [row!.id]);
    expect(await run(row!.id)).toEqual({ ok: true });
    const sent = await texts('question_ready');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms' });
    expect(sent[0]!.body).toMatch(
      /^One quick question about today's report: https:\/\/go\.sitelog\.test\/r\//,
    );
  });

  it('the answer (field_answer_question) → decide_next → the draft, 5 × 8 h = 40 h', async () => {
    const { raw, data } = await draftOf(reportId);
    const [q] = await database.q<{
      field: 'manpower.workers';
      target: object;
      options: QuestionOption[];
    }>(`select field, target, options from questions where id = $1`, [questionId]);
    const option = q!.options.find((o) => o.id === 'o2')!;
    const value = optionAnswer(q!.field, option)!;
    const applied = applyAnswer(data, { field: q!.field, target: q!.target }, value, {
      defaultShiftHours: 8,
      source: { type: 'answer', questionId },
    });
    await database.q(`select field_answer_question($1, $2, $3, $4, $5, $6, $7, null)`, [
      reportId,
      questionId,
      MARCO,
      JSON.stringify(raw),
      JSON.stringify(applied.data),
      JSON.stringify({ optionId: 'o2', text: option.label, parsed: value, via: 'web' }),
      JSON.stringify({ type: 'answer', questionId }),
    ]);
    expect(await status(reportId)).toBe('processing');
    await seen(1_000);
    const decide = await runQueued(reportId, 'decide_next');
    expect(decide.dedupe_key).toBe(`decide:${reportId}:answer:${questionId}`);
    expect(await status(reportId)).toBe('awaiting_confirmation');
    const after = await draftOf(reportId);
    const delta = after.data.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    expect(delta).toMatchObject({ workers: 5, hoursPerWorker: 8, totalHours: 40 });
    expect(delta.source.at(-1)).toEqual({ type: 'answer', questionId });
    // Still one question in all: the draft has the hero's two photos, so nothing else is asked.
    expect(
      await database.q(`select 1 from questions where report_id = $1`, [reportId]),
    ).toHaveLength(1);
    expect(after.data.photos).toHaveLength(2);
    expect(await texts('draft_ready')).toEqual([]);
  });

  it('a photo on the draft reopens it, extracts again and shows the draft again (§7.2)', async () => {
    const p = await photo();
    expect(p.status).toBe('processing');
    const extract = await runQueued(reportId, 'extract_report');
    expect(extract.dedupe_key).toBe(`extract:${reportId}:photo:${p.uploadId}`);
    // The recorded output stands in for the model and has the Delta headcount unknown again: the
    // reporter's answer is applied again by code, so nothing is asked twice and nothing is lost.
    await seen(DEVICE_ACTIVE_MS + 1_000);
    await runQueued(reportId, 'decide_next');
    expect(await status(reportId)).toBe('awaiting_confirmation');
    const { data } = await draftOf(reportId);
    expect(data.photos).toHaveLength(3);
    expect(data.manpower.find((m) => m.companyName === 'Delta Mechanical')).toMatchObject({
      workers: 5,
      totalHours: 40,
    });
    expect(
      await database.q(`select 1 from questions where report_id = $1`, [reportId]),
    ).toHaveLength(1);
    // The device away: the draft is texted, once.
    const sent = await texts('draft_ready');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(
      /^Your report is ready to check: https:\/\/go\.sitelog\.test\/r\//,
    );
  });
  it('W1-15: Confirm & send files it (via web): one PDF, one `filed` text, one email, retries included', async () => {
    const jobsOf = (type: string) =>
      database.q<JobRow>(
        `select * from jobs where type = $1 and payload ->> 'reportId' = $2 order by id`,
        [type, reportId],
      );
    const rerun = async (job: JobRow) => {
      await database.q(`update jobs set status = 'queued' where id = $1`, [job.id]);
      expect(await run(job.id)).toEqual({ ok: true });
    };
    const [{ v, rev }] = (await database.q<{ v: number; rev: number }>(
      `select r.current_version as v, rv.draft_rev as rev from reports r
       join report_versions rv on rv.report_id = r.id and rv.version = r.current_version
       where r.id = $1`,
      [reportId],
    )) as [{ v: number; rev: number }];
    const [confirmed] = await database.q<{ r: { status: string; jobId: number } }>(
      `select field_confirm_report($1, $2, $3, $4) as r`,
      [reportId, MARCO, v, rev],
    );
    expect(confirmed!.r.status).toBe('queued');
    const [fileJob] = await jobsOf('file_report');
    expect(fileJob!.payload).toEqual({
      reportId,
      trigger: 'confirm',
      version: v,
      draftRev: rev,
      via: 'web',
    });
    expect(await run(fileJob!.id)).toEqual({ ok: true });

    const [report] = await database.q<{
      status: string;
      confirmed_via: string | null;
      confirmed_at: string | null;
      filed_at: string | null;
    }>(
      `select status::text, confirmed_via::text, confirmed_at, filed_at from reports where id = $1`,
      [reportId],
    );
    expect(report).toMatchObject({ status: 'filed', confirmed_via: 'web' });
    expect(report!.confirmed_at).not.toBeNull();
    const [day] = await database.q<{ status: string }>(
      `select d.status::text from site_days d join reports r on r.site_day_id = d.id where r.id = $1`,
      [reportId],
    );
    expect(day!.status).toBe('filed');

    // The filing failed after `status = filed`, before its post-filing jobs were enqueued: its
    // retry finds the report filed and enqueues them (the keys were free).
    await database.q(
      `delete from jobs where type in ('render_pdf', 'notify') and payload ->> 'reportId' = $1`,
      [reportId],
    );
    await database.q(`delete from jobs where type = 'notify' and dedupe_key = $1`, [
      `notify:filed:${reportId}`,
    ]);
    await rerun(fileJob!);
    // Retried again: every key is taken, nothing new.
    await rerun(fileJob!);
    const renders = await jobsOf('render_pdf');
    expect(renders.map((j) => j.dedupe_key)).toEqual([`render_pdf:${reportId}:${v}`]);
    const notices = await database.q<JobRow>(`select * from jobs where dedupe_key = $1`, [
      `notify:filed:${reportId}`,
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'notify', status: 'queued' });

    // render_pdf, twice: one file, one email job.
    expect(await run(renders[0]!.id)).toEqual({ ok: true });
    await rerun(renders[0]!);
    const [version] = await database.q<{ pdf_path: string | null }>(
      `select pdf_path from report_versions where report_id = $1 and version = $2`,
      [reportId, v],
    );
    expect(version!.pdf_path).toMatch(
      new RegExp(`^${ORG}/${RIVERSIDE}/RL-2041-\\d{4}_v${v}\\.pdf$`),
    );
    expect(world.storage.files.has(`pdfs/${version!.pdf_path}`)).toBe(true);

    // notify(filed), twice: one text, with the Filed-screen link (F8).
    expect(await run(notices[0]!.id)).toEqual({ ok: true });
    await rerun(notices[0]!);
    // (The §18.1 seed has Marco's earlier `filed` texts: this report's is the one with its key.)
    const filed = await database.q<{ body: string; channel: string }>(
      `select body, channel::text from messages where reporter_id = $1 and copy_key = 'filed'
         and payload ->> 'dedupe_key' = $2`,
      [MARCO, `notify:filed:${reportId}`],
    );
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ channel: 'sms' });
    expect(filed[0]!.body).toMatch(
      new RegExp(
        `^Filed: Daily Report RL-2041-\\d{4}\\. PDF: https://go\\.sitelog\\.test/r/[A-Z2-9]{12}/report/${reportId}$`,
      ),
    );

    // send_email, twice: one email (the job's key is the provider's idempotency key).
    const emails = await jobsOf('send_email');
    expect(emails.map((j) => j.dedupe_key)).toEqual([`email:report_filed:${reportId}:${v}`]);
    const before = world.emails.length;
    expect(await run(emails[0]!.id)).toEqual({ ok: true });
    await rerun(emails[0]!);
    const sent = world.emails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(
      /^Daily report · Riverside Lofts · Mon Oct 12 · RL-2041-\d{4}$/,
    );
    expect(sent[0]!.idempotencyKey).toBe(`email:report_filed:${reportId}:${v}`);
    expect(sent[0]!.attachments?.map((a) => a.filename)).toEqual([
      expect.stringMatching(new RegExp(`^RL-2041-\\d{4}_2026-10-12_v${v}\\.pdf$`)),
    ]);
    expect(sent[0]!.text).not.toMatch(/WhatsApp/);

    // The console provider (no RESEND_API_KEY) files one Demo phone row per key.
    const row = {
      org_id: ORG,
      kind: 'report_filed',
      recipients: ['pm@kestrel.example'],
      subject: sent[0]!.subject,
      body_text: sent[0]!.text,
      attachments: [],
      dedupe_key: `email:report_filed:${reportId}:${v}`,
    };
    const first = await world.db.insertConsoleEmail(row);
    expect(await world.db.insertConsoleEmail(row)).toBe(first);
    const [n] = await database.q<{ n: number }>(
      `select count(*)::int as n from console_emails where dedupe_key = $1`,
      [row.dedupe_key],
    );
    expect(n!.n).toBe(1);
  }, 60_000);
});
