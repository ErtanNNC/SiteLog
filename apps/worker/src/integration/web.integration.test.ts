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
import { reportGuardVerdict } from '../jobs/notify';
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

/**
 * The queued jobs of a report, by type, oldest first; the §7.2 clock's delayed decide_next steps
 * (W2-07, `payload.timeout`) are left out (`timeoutJobs`).
 */
async function queued(reportId: string, type: string) {
  return database.q<{ id: number; dedupe_key: string }>(
    `select id, dedupe_key from jobs where type = $1 and status = 'queued'
       and payload ->> 'reportId' = $2 and not payload ? 'timeout' order by id`,
    [type, reportId],
  );
}

/** The §7.2 clock of a report (W2-07): its delayed decide_next steps and nudges, by key. */
async function clockJobs(reportId: string) {
  return database.q<{
    id: number;
    type: string;
    dedupe_key: string;
    status: string;
    run_after: string;
    payload: Record<string, unknown>;
  }>(
    `select id, type, dedupe_key, status::text, run_after, payload from jobs
      where (type = 'decide_next' and payload ->> 'reportId' = $1 and payload ? 'timeout')
         or (type = 'notify' and dedupe_key like 'notify:draft_nudge:' || $1 || ':%')
      order by id`,
    [reportId],
  );
}

/** The `notify` job of a Notifier key (W2-07: decide_next's texts are notify jobs). */
async function notifyJob(dedupeKey: string) {
  const rows = await database.q<JobRow & { run_after: string }>(
    `select * from jobs where type = 'notify' and dedupe_key = $1`,
    [dedupeKey],
  );
  expect(rows, `notify ${dedupeKey}`).toHaveLength(1);
  return rows[0]!;
}

async function runAgain(jobId: number) {
  await database.q(`update jobs set status = 'queued' where id = $1`, [jobId]);
  expect(await run(jobId)).toEqual({ ok: true });
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
    // Spec §19 Q61: the text waits 30 s in a notify job that sends only if the device is not seen.
    const deferred = await database.q<{ diff: { key: string; reason: string } }>(
      `select diff from audit_log where entity_id = $1 and action = 'notify.deferred'`,
      [reportId],
    );
    expect(deferred.map((a) => a.diff)).toMatchObject([
      { key: 'question_ready', reason: 'device_active' },
    ]);
    const text = await notifyJob(`notify:question_ready:${questionId}`);
    // 30 s on the database's clock (the one claim_jobs reads).
    const wait = new Date(text.run_after).getTime() - Date.now();
    expect(wait).toBeGreaterThan(DEVICE_ACTIVE_MS - 10_000);
    expect(wait).toBeLessThanOrEqual(DEVICE_ACTIVE_MS);
    expect(text.payload).toMatchObject({
      key: 'question_ready',
      reportGuard: {
        reportId,
        status: 'awaiting_answer',
        questionId,
        deviceNotSeenAfter: clock.now().toISOString(),
      },
    });
    // §7.2 / F7: the question's 60-minute clock.
    expect((await clockJobs(reportId)).map((j) => [j.dedupe_key, j.payload.timeout])).toEqual([
      [`decide:${reportId}:timeout:${questionId}`, { step: 'answer', questionId }],
    ]);
    const line = log.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'question ready' && l.report_id === reportId);
    expect(typeof line?.upload_to_decision_ms).toBe('number');
  });

  it('a retried decide_next asks nothing twice', async () => {
    const [row] = await database.q<JobRow>(
      `select * from jobs where type = 'decide_next' and payload ->> 'reportId' = $1
         and not payload ? 'timeout'`,
      [reportId],
    );
    await database.q(`update jobs set status = 'queued' where id = $1`, [row!.id]);
    expect(await run(row!.id)).toEqual({ ok: true });
    expect(
      await database.q(`select 1 from questions where report_id = $1`, [reportId]),
    ).toHaveLength(1);
  });

  it('Q61: the device not seen in those 30 s: the question is texted once, with the personal link', async () => {
    await seen(DEVICE_ACTIVE_MS);
    const [row] = await database.q<JobRow>(
      `select * from jobs where type = 'decide_next' and payload ->> 'reportId' = $1
         and not payload ? 'timeout'`,
      [reportId],
    );
    // A retried decide_next finds the text's key taken: still one job.
    await runAgain(row!.id);
    const job = await notifyJob(`notify:question_ready:${questionId}`);
    expect(await run(job.id)).toEqual({ ok: true });
    await runAgain(job.id);
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
    // Q61: the reporter is still on the recorder 10 s later: the deferred text sends nothing.
    const text = await notifyJob(`notify:draft_ready:${reportId}:${decide.id}`);
    expect(text.payload).toMatchObject({
      reportGuard: {
        status: 'awaiting_confirmation',
        deviceNotSeenAfter: clock.now().toISOString(),
      },
    });
    clock.advance(10_000);
    await seen(0);
    expect(await run(text.id)).toEqual({ ok: true });
    expect(await texts('draft_ready')).toEqual([]);
    const skipped = await database.q<{ diff: { copy_key: string; reason: string } }>(
      `select diff from audit_log where entity_id = $1 and action = 'notify.skipped'`,
      [MARCO],
    );
    expect(skipped.map((a) => a.diff)).toContainEqual(
      expect.objectContaining({ copy_key: 'draft_ready', reason: 'device_active' }),
    );
    // §7.2: the draft's confirmation clock, keyed per version and revision.
    const clockKeys = (await clockJobs(reportId)).map((j) => j.dedupe_key);
    expect(clockKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^notify:draft_nudge:${reportId}:v1:r\\d+$`)),
        expect.stringMatching(new RegExp(`^decide:${reportId}:file-timeout:v1:r\\d+$`)),
      ]),
    );
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
    // The device away: the draft is texted, once (its notify job runs at once).
    const decides = await database.q<{ id: number }>(
      `select id from jobs where type = 'decide_next' and payload ->> 'reportId' = $1
         and not payload ? 'timeout' order by id desc limit 1`,
      [reportId],
    );
    const job = await notifyJob(`notify:draft_ready:${reportId}:${decides[0]!.id}`);
    expect(job.payload).not.toHaveProperty('reportGuard.deviceNotSeenAfter');
    expect(await run(job.id)).toEqual({ ok: true });
    await runAgain(job.id);
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

describe('W2-07: the §7.2 web clock (answer timeout, nudge, timeout filing)', () => {
  let reportId = '';
  let questionId = '';
  const jobByKey = async (key: string) => {
    const [job] = await database.q<JobRow>(`select * from jobs where dedupe_key = $1`, [key]);
    expect(job, key).toBeDefined();
    return job!;
  };
  const draftRev = async () =>
    (
      await database.q<{ v: number; rev: number }>(
        `select r.current_version as v, rv.draft_rev as rev from reports r
         join report_versions rv on rv.report_id = r.id and rv.version = r.current_version
         where r.id = $1`,
        [reportId],
      )
    )[0]!;

  it('a question nobody answers for 60 min becomes a flagged draft, with no text (F7)', async () => {
    clock.set(new Date('2026-10-13T18:00:00Z')); // 13:00 in Chicago, inside the call window
    const up = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date: '2026-10-13',
    });
    reportId = up.reportId;
    expect((await photo13()).jobId).toBeNull();
    expect(await run(up.jobId!)).toEqual({ ok: true });
    await runQueued(reportId, 'extract_report');
    await seen(DEVICE_ACTIVE_MS + 1_000);
    await runQueued(reportId, 'decide_next');
    expect(await status(reportId)).toBe('awaiting_answer');
    const [q] = await database.q<{ id: string }>(`select id from questions where report_id = $1`, [
      reportId,
    ]);
    questionId = q!.id;
    const questionText = await notifyJob(`notify:question_ready:${questionId}`);

    // 59 minutes: the timeout job claimed early by a skewed clock retries, nothing changes.
    clock.advance(59 * 60_000);
    const timeout = await jobByKey(`decide:${reportId}:timeout:${questionId}`);
    expect((await run(timeout.id)).ok).toBe(false);
    expect(await status(reportId)).toBe('awaiting_answer');

    clock.advance(60_000);
    await runAgain(timeout.id);
    expect(await status(reportId)).toBe('awaiting_confirmation');
    const [question] = await database.q<{ answer: unknown; answered_at: string | null }>(
      `select answer, answered_at from questions where id = $1`,
      [questionId],
    );
    expect(question).toMatchObject({ answer: { unanswered: true, timeout: true } });
    const [report] = await database.q<{ needs_review: boolean; review_reasons: string[] }>(
      `select needs_review, review_reasons from reports where id = $1`,
      [reportId],
    );
    expect(report).toEqual({
      needs_review: true,
      review_reasons: ['unanswered:manpower.workers'],
    });
    const audits = await database.q<{ diff: { question_id: string } }>(
      `select diff from audit_log where entity_id = $1 and action = 'report.question_timeout'`,
      [reportId],
    );
    expect(audits.map((a) => a.diff.question_id)).toEqual([questionId]);
    // No draft_ready text (the reporter sees the draft next time); the stale question text is
    // dropped by its guard.
    expect(
      await database.q(`select 1 from jobs where dedupe_key like $1`, [
        `notify:draft_ready:${reportId}:%`,
      ]),
    ).toEqual([]);
    expect(await run(questionText.id)).toEqual({ ok: true });
    expect(
      await database.q(`select 1 from messages where payload ->> 'dedupe_key' = $1`, [
        `notify:question_ready:${questionId}`,
      ]),
    ).toEqual([]);
    // A retried timeout changes nothing.
    await runAgain(timeout.id);
    expect(
      await database.q(
        `select 1 from audit_log where entity_id = $1 and action = 'report.question_timeout'`,
        [reportId],
      ),
    ).toHaveLength(1);
  });

  it('the unconfirmed draft gets one nudge at +30 min (draft_ready, Q78), never in quiet hours (Q77)', async () => {
    const { v, rev } = await draftRev();
    const nudge = await jobByKey(`notify:draft_nudge:${reportId}:v${v}:r${rev}`);
    expect(nudge.payload).toMatchObject({
      key: 'draft_ready',
      reportGuard: { status: 'awaiting_confirmation', version: v, draftRev: rev, quietHours: true },
    });
    // At 21:00 in Chicago the call window is closed: the nudge would be skipped.
    const saved = clock.now();
    clock.set(new Date('2026-10-14T02:00:00Z'));
    const { reportGuard } = nudge.payload as { reportGuard: never };
    expect(await reportGuardVerdict(world.ctx, reportGuard)).toBe('quiet_hours');
    clock.set(new Date(saved.getTime() + 30 * 60_000));
    expect(await run(nudge.id)).toEqual({ ok: true });
    await runAgain(nudge.id);
    const sent = await database.q<{ body: string }>(
      `select body from messages where payload ->> 'dedupe_key' = $1`,
      [`notify:draft_nudge:${reportId}:v${v}:r${rev}`],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(
      /^Your report is ready to check: https:\/\/go\.sitelog\.test\/r\//,
    );
  });

  it('at +2 h the draft is filed `unconfirmed`; a confirm racing it files nothing twice', async () => {
    const { v, rev } = await draftRev();
    // A timeout for another revision of the draft finds it moved on.
    const staleId = await world.db.enqueueJob(
      'decide_next',
      { reportId, timeout: { step: 'file', trigger: 'timeout', version: v, draftRev: rev + 1 } },
      { dedupeKey: `decide:${reportId}:file-timeout:v${v}:r${rev + 1}` },
    );
    expect(await run(staleId)).toEqual({ ok: true });
    expect(await status(reportId)).toBe('awaiting_confirmation');

    // The reporter confirms just as the clock runs out: the timeout's job runs first.
    const [confirmed] = await database.q<{ r: { status: string; jobId: number } }>(
      `select field_confirm_report($1, $2, $3, $4) as r`,
      [reportId, MARCO, v, rev],
    );
    expect(confirmed!.r.status).toBe('queued');
    clock.advance(90 * 60_000);
    const fileTimeout = await jobByKey(`decide:${reportId}:file-timeout:v${v}:r${rev}`);
    expect(fileTimeout.payload).toEqual({
      reportId,
      timeout: { step: 'file', trigger: 'timeout', version: v, draftRev: rev },
    });
    expect(await run(fileTimeout.id)).toEqual({ ok: true });
    expect(await run(confirmed!.r.jobId)).toEqual({ ok: true });
    await runAgain(fileTimeout.id);
    const filed = await database.q<{ diff: { trigger: string; review_reasons: string[] } }>(
      `select diff from audit_log where entity_id = $1 and action = 'report.filed'`,
      [reportId],
    );
    expect(filed).toHaveLength(1);
    expect(filed[0]!.diff.trigger).toBe('timeout');
    expect(filed[0]!.diff.review_reasons).toEqual(
      expect.arrayContaining(['unanswered:manpower.workers', 'unconfirmed']),
    );
    const [report] = await database.q<{ status: string; confirmed_at: string | null }>(
      `select status::text, confirmed_at from reports where id = $1`,
      [reportId],
    );
    expect(report).toEqual({ status: 'filed', confirmed_at: null });
  });
});

/** A photo of the Oct 13 report (field_complete_upload), as `photo()` for Oct 12. */
async function photo13(): Promise<{ jobId: number | null }> {
  const [u] = await database.q<{ id: string }>(
    `insert into uploads (reporter_id, site_id, kind, storage_path, mime, recorded_at)
     values ($1, $2, 'photo', 'pending', 'image/jpeg', now()) returning id`,
    [MARCO, RIVERSIDE],
  );
  await database.q(`update uploads set storage_path = $2 where id = $1`, [
    u!.id,
    `${ORG}/${RIVERSIDE}/2026-10-13/${u!.id}.jpg`,
  ]);
  const [r] = await database.q<{ r: { jobId: number | null } }>(
    `select field_complete_upload($1, $2, 1) as r`,
    [u!.id, MARCO],
  );
  return { jobId: r!.r.jobId };
}

describe('W2-07: an answer timeout that fires while more audio is processed is armed again', () => {
  const answerTimers = (reportId: string) =>
    database.q<{ id: number; dedupe_key: string; status: string; run_after: string }>(
      `select id, dedupe_key, status::text, run_after from jobs
        where type = 'decide_next' and payload ->> 'reportId' = $1
          and payload -> 'timeout' ->> 'step' = 'answer' order by id`,
      [reportId],
    );
  const questionOf = async (reportId: string) =>
    (
      await database.q<{ id: string; answer: unknown; answered_at: string | null }>(
        `select id, answer, answered_at from questions where report_id = $1`,
        [reportId],
      )
    )[0]!;

  /** A report of `date` awaiting its one question, asked at the clock's time. */
  async function questionAsked(date: string, opts: { photo?: boolean } = {}) {
    const up = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date,
    });
    if (opts.photo) {
      const [u] = await database.q<{ id: string }>(
        `insert into uploads (reporter_id, site_id, kind, storage_path, mime, recorded_at)
         values ($1, $2, 'photo', 'pending', 'image/jpeg', now()) returning id`,
        [MARCO, RIVERSIDE],
      );
      await database.q(`update uploads set storage_path = $2 where id = $1`, [
        u!.id,
        `${ORG}/${RIVERSIDE}/${date}/${u!.id}.jpg`,
      ]);
      await database.q(`select field_complete_upload($1, $2, 1)`, [u!.id, MARCO]);
    }
    expect(await run(up.jobId!)).toEqual({ ok: true });
    await runQueued(up.reportId, 'extract_report');
    await seen(DEVICE_ACTIVE_MS + 1_000);
    await runQueued(up.reportId, 'decide_next');
    expect(await status(up.reportId)).toBe('awaiting_answer');
    return { reportId: up.reportId, questionId: (await questionOf(up.reportId)).id };
  }

  /** More audio: the clip and its transcription job (not run). */
  const moreAudio = (date: string) =>
    world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date,
    });

  it('question at t0, a clip at t0+55 untranscribed past t0+60, the gap still open → it times out', async () => {
    clock.set(new Date('2026-10-14T17:00:00Z'));
    const { reportId, questionId } = await questionAsked('2026-10-14');
    const base = `decide:${reportId}:timeout:${questionId}`;

    clock.advance(55 * 60_000);
    const second = await moreAudio('2026-10-14');
    expect(await status(reportId)).toBe('processing');

    // t0 + 60: the clip is not transcribed yet; the timer does not drop the question.
    clock.advance(5 * 60_000);
    const [timer] = await answerTimers(reportId);
    expect(timer!.dedupe_key).toBe(base);
    expect(await run(timer!.id)).toEqual({ ok: true });
    expect((await questionOf(reportId)).answered_at).toBeNull();
    let timers = await answerTimers(reportId);
    expect(timers.map((t) => [t.dedupe_key, t.status])).toEqual([
      [base, 'done'],
      [`${base}:re1`, 'queued'],
    ]);
    // A retried timer finds the re-arm live and arms nothing more.
    await runAgain(timer!.id);
    expect(await answerTimers(reportId)).toHaveLength(2);

    // The clip is transcribed and extracted; the gap is still open, so the question waits and
    // its live re-armed timer stands.
    clock.advance(60_000);
    expect(await run(second.jobId!)).toEqual({ ok: true });
    await runQueued(reportId, 'extract_report');
    await runQueued(reportId, 'decide_next');
    expect(await status(reportId)).toBe('awaiting_answer');
    timers = await answerTimers(reportId);
    expect(timers).toHaveLength(2);

    clock.advance(2 * 60_000);
    expect(await run(timers[1]!.id)).toEqual({ ok: true });
    expect(await status(reportId)).toBe('awaiting_confirmation');
    expect(await questionOf(reportId)).toMatchObject({
      id: questionId,
      answer: { unanswered: true, timeout: true },
    });
    const audits = await database.q<{ diff: { question_id: string } }>(
      `select diff from audit_log where entity_id = $1 and action = 'report.question_timeout'`,
      [reportId],
    );
    expect(audits.map((a) => a.diff.question_id)).toEqual([questionId]);
  });

  it('a timer that finished without acting (no live one left) is armed again by the next decide_next', async () => {
    clock.set(new Date('2026-10-15T17:00:00Z'));
    const { reportId, questionId } = await questionAsked('2026-10-15');
    const base = `decide:${reportId}:timeout:${questionId}`;
    clock.advance(55 * 60_000);
    const second = await moreAudio('2026-10-15');
    // As before this fix: the timer ran at t0 + 60 while the report was busy and finished done.
    clock.advance(5 * 60_000);
    await database.q(`update jobs set status = 'done', finished_at = now() where dedupe_key = $1`, [
      base,
    ]);
    clock.advance(60_000);
    expect(await run(second.jobId!)).toEqual({ ok: true });
    await runQueued(reportId, 'extract_report');
    await runQueued(reportId, 'decide_next');
    expect(await status(reportId)).toBe('awaiting_answer');
    // The wait finds no live timer: one is armed under the next key, due at once (past t0 + 60).
    const timers = await answerTimers(reportId);
    expect(timers.map((t) => [t.dedupe_key, t.status])).toEqual([
      [base, 'done'],
      [`${base}:re1`, 'queued'],
    ]);
    expect(await run(timers[1]!.id)).toEqual({ ok: true });
    expect(await status(reportId)).toBe('awaiting_confirmation');
    expect((await questionOf(reportId)).answer).toMatchObject({ unanswered: true, timeout: true });
  });

  it('a draft shown again with the same data after its clock ran out while busy gets a new clock', async () => {
    clock.set(new Date('2026-10-16T17:00:00Z'));
    const { reportId, questionId } = await questionAsked('2026-10-16', { photo: true });
    // The reporter answers (5 workers, as W1-12's answer): the draft.
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
    await runQueued(reportId, 'decide_next');
    expect(await status(reportId)).toBe('awaiting_confirmation');
    const revOf = async () =>
      (
        await database.q<{ rev: number }>(
          `select rv.draft_rev as rev from reports r join report_versions rv
             on rv.report_id = r.id and rv.version = r.current_version where r.id = $1`,
          [reportId],
        )
      )[0]!.rev;
    const rev = await revOf();
    const fileBase = `decide:${reportId}:file-timeout:v1:r${rev}`;
    const nudgeBase = `notify:draft_nudge:${reportId}:v1:r${rev}`;

    // More audio on the draft; its clock runs out while the clip waits for its transcription.
    clock.advance(10 * 60_000);
    const second = await moreAudio('2026-10-16');
    expect(await status(reportId)).toBe('processing');
    clock.advance(2 * 3600_000);
    for (const key of [nudgeBase, fileBase]) {
      const [job] = await database.q<{ id: number }>(`select id from jobs where dedupe_key = $1`, [
        key,
      ]);
      expect(await run(job!.id)).toEqual({ ok: true });
    }
    expect(await status(reportId)).toBe('processing');

    // The re-extraction writes the same draft (same revision): the draft gets a new clock.
    expect(await run(second.jobId!)).toEqual({ ok: true });
    await runQueued(reportId, 'extract_report');
    await runQueued(reportId, 'decide_next');
    expect(await status(reportId)).toBe('awaiting_confirmation');
    expect(await revOf()).toBe(rev);
    const clock2 = (await clockJobs(reportId)).filter(
      (j) => j.status === 'queued' && !j.dedupe_key.includes(':timeout:'),
    );
    expect(clock2.map((j) => j.dedupe_key).sort()).toEqual(
      [`${fileBase}:re1`, `${nudgeBase}:re1`].sort(),
    );
    const nudge = clock2.find((j) => j.type === 'notify')!;
    expect(nudge.payload).toMatchObject({ dedupeKey: `${nudgeBase}:re1` });

    const file = clock2.find((j) => j.type === 'decide_next')!;
    expect(await run(file.id)).toEqual({ ok: true });
    expect(await status(reportId)).toBe('filed');
    const filed = await database.q<{ diff: { trigger: string } }>(
      `select diff from audit_log where entity_id = $1 and action = 'report.filed'`,
      [reportId],
    );
    expect(filed.map((f) => f.diff.trigger)).toEqual(['timeout']);
  });
});
