import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readReportData,
  type DailyReportData,
  type JobRow,
  type StoredReportData,
} from '@sitelog/shared';
import { fakeAudio, createFakeTranscriber } from '../ai/fake-transcriber';
import { runJob } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { createSim, loadFixtureLibrary, manualClock, NO_LATENCY } from './fakes';
import { createWorld, type World } from './world';

/**
 * W2-09 (F7 *Other…*, §10.7) on a real database (PGlite, every migration and the §18 seed): the
 * hero report's Delta question answered by voice. The answer clip goes in as field-api puts it
 * (`uploads.question_id`, field_complete_upload(), field_answer_question_voice()), then the real
 * parse_answer job: the fake transcriber (fixtures/voice, kind `answer`) and the fake Claude (the
 * recorded fixtures/answers output). "Five, all day." applies 5 × full day = 40 h with the answer
 * and the clip as the value's sources; an unclear answer is asked once more, then recorded
 * unanswered and flagged. The clip is never report material. Independent of the date: the report
 * days are fixed, and the worker's clock is the test's.
 */

let database: PgliteDatabase;
let world: World;
const clock = manualClock(new Date('2026-10-12T22:35:00Z'));
let MARCO = '';
let RIVERSIDE = '';
let ORG = '';

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim: createSim({ advance: clock, profile: NO_LATENCY }),
    lib: loadFixtureLibrary(['riverside-2026-10-09']),
    fieldTranscriber: createFakeTranscriber(),
    config: { CLAUDE_MODEL: 'claude-sonnet-5-5' },
  });
  const marco = (
    await database.q<{ id: string; org_id: string }>(
      `select id, org_id from reporters where name = 'Marco Ruiz'`,
    )
  )[0]!;
  MARCO = marco.id;
  ORG = marco.org_id;
  RIVERSIDE = (
    await database.q<{ id: string }>(`select id from sites where project_code = 'RL-2041'`)
  )[0]!.id;
  // Marco is on the recorder: no question_ready text in these tests.
  await database.q(
    `insert into field_devices (reporter_id, device_token_hash, verified_at, last_seen_at)
     values ($1, 'w2-09-device', now(), now() + interval '1 day')`,
    [MARCO],
  );
}, 120_000);

afterAll(async () => {
  await database?.close();
});

async function run(jobId: number) {
  const [row] = await database.q<JobRow>(
    `update jobs set status = 'running', locked_at = now(), locked_by = 'integration',
       attempts = attempts + 1 where id = $1 returning *`,
    [jobId],
  );
  return runJob(world.ctx, row!, 60_000, { workerId: 'integration' });
}

async function runQueued(type: string, reportId: string) {
  const jobs = await database.q<{ id: number; dedupe_key: string }>(
    `select id, dedupe_key from jobs where type = $1 and status = 'queued'
       and payload ->> 'reportId' = $2 and not payload ? 'timeout' order by id`,
    [type, reportId],
  );
  expect(jobs, `${type} queued`).toHaveLength(1);
  expect(await run(jobs[0]!.id)).toEqual({ ok: true });
  return jobs[0]!;
}

async function draftOf(reportId: string): Promise<DailyReportData> {
  const [v] = await database.q<{ data: StoredReportData }>(
    `select v.data from report_versions v join reports r on r.id = v.report_id
       and v.version = r.current_version where r.id = $1`,
    [reportId],
  );
  return readReportData(v!.data);
}

const reportRow = async (id: string) =>
  (
    await database.q<{ status: string; needs_review: boolean; review_reasons: string[] }>(
      `select status::text, needs_review, review_reasons from reports where id = $1`,
      [id],
    )
  )[0]!;

/** The hero voice note on `date`, transcribed and extracted, then its one question asked. */
async function heroQuestion(date: string): Promise<{ reportId: string; questionId: string }> {
  const up = await world.uploadVoiceNote({
    reporterId: MARCO,
    siteId: RIVERSIDE,
    fixtureId: 'es-en-riverside-2026-10-09',
    date,
  });
  expect(await run(up.jobId!)).toEqual({ ok: true });
  await runQueued('extract_report', up.reportId);
  await runQueued('decide_next', up.reportId);
  const [q] = await database.q<{ id: string }>(
    `select id from questions where report_id = $1 and answered_at is null`,
    [up.reportId],
  );
  expect((await reportRow(up.reportId)).status).toBe('awaiting_answer');
  return { reportId: up.reportId, questionId: q!.id };
}

/** An answer clip as field-api makes it: upload (question_id), complete, then the voice answer. */
async function speak(reportId: string, questionId: string, fixtureId: string, date: string) {
  const [u] = await database.q<{ id: string }>(
    `insert into uploads (reporter_id, site_id, kind, storage_path, mime, recorded_at, question_id)
     values ($1, $2, 'audio', 'pending', 'audio/webm', now(), $3) returning id`,
    [MARCO, RIVERSIDE, questionId],
  );
  const path = `${ORG}/${RIVERSIDE}/${date}/${u!.id}.webm`;
  await database.q(`update uploads set storage_path = $2 where id = $1`, [u!.id, path]);
  const body = fakeAudio(fixtureId, 3);
  await world.storage.upload('audio', path, body, 'audio/webm');
  const [done] = await database.q<{
    r: { reportId: string; jobId: number | null; answerClip: boolean };
  }>(`select field_complete_upload($1, $2, $3) as r`, [u!.id, MARCO, body.length]);
  expect(done!.r).toMatchObject({ reportId, jobId: null, answerClip: true });
  const [res] = await database.q<{ r: { status: string; jobId: number } }>(
    `select field_answer_question_voice($1, $2, $3, $4) as r`,
    [reportId, questionId, MARCO, u!.id],
  );
  expect(res!.r.status).toBe('listening');
  return { uploadId: u!.id, jobId: res!.r.jobId };
}

describe('W2-09: Other… answered by voice, parsed by parse_answer, applied in code', () => {
  it('"Five, all day." applies 5 × full day = 40 h, sourced to the answer and the clip', async () => {
    const date = '2026-10-12';
    const { reportId, questionId } = await heroQuestion(date);
    const before = await draftOf(reportId);
    const clip = await speak(reportId, questionId, 'answer-en-delta-five-all-day', date);

    // The clip is not report material: no report source, no transcription job, not a voice note.
    expect(
      await database.q(`select 1 from report_sources where upload_id = $1`, [clip.uploadId]),
    ).toEqual([]);
    expect(
      await database.q(
        `select 1 from jobs where type = 'transcribe_upload' and payload ->> 'uploadId' = $1`,
        [clip.uploadId],
      ),
    ).toEqual([]);
    const [job] = await database.q<{ dedupe_key: string }>(
      `select dedupe_key from jobs where id = $1`,
      [clip.jobId],
    );
    expect(job!.dedupe_key).toBe(`answer:${questionId}:${clip.uploadId}`);
    // The report keeps awaiting the answer while it is listened to.
    expect((await reportRow(reportId)).status).toBe('awaiting_answer');

    expect(await run(clip.jobId)).toEqual({ ok: true });
    const data = await draftOf(reportId);
    const delta = data.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    expect(delta).toMatchObject({ workers: 5, hoursPerWorker: 8, totalHours: 40 });
    const deltaBefore = before.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    expect(delta.source).toEqual([
      ...deltaBefore.source,
      { type: 'answer', questionId },
      { type: 'voice_note', uploadId: clip.uploadId, start: 0, end: 2.1 },
    ]);
    // Every other crew is untouched.
    expect(data.manpower.filter((m) => m !== delta)).toEqual(
      before.manpower.filter((m) => m.companyName !== 'Delta Mechanical'),
    );

    const [q] = await database.q<{
      answered_at: string | null;
      answer: Record<string, unknown>;
      answer_source: unknown;
      voice_answers: Array<Record<string, unknown>>;
    }>(`select answered_at, answer, answer_source, voice_answers from questions where id = $1`, [
      questionId,
    ]);
    expect(q!.answered_at).not.toBeNull();
    expect(q!.answer_source).toEqual({ type: 'answer', questionId });
    expect(q!.answer).toMatchObject({
      text: 'Five, all day.',
      parsed: { workers: 5, fullDay: true },
      confidence: 0.96,
      via: 'web',
      // F7's line from code's numbers, as for a tap.
      confirmation: {
        kind: 'crew',
        company: 'Delta Mechanical',
        workers: 5,
        hoursPerWorker: 8,
        totalHours: 40,
      },
    });
    expect(q!.voice_answers).toMatchObject([
      { uploadId: clip.uploadId, status: 'applied', confidence: 0.96 },
    ]);
    // The clip's transcript is kept (sources and audit), and the model saw only the answer.
    const [t] = await database.q<{ text: string }>(
      `select text from transcripts where upload_id = $1`,
      [clip.uploadId],
    );
    expect(t!.text).toBe('Five, all day.');
    expect(world.claude.phoneLeaks).toEqual([]);
    const audits = await database.q<{ action: string; diff: Record<string, unknown> }>(
      `select action, diff from audit_log where entity_id = $1 and action like 'report.%answer%' order by id`,
      [reportId],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'report.answer_spoken',
      'report.question_answered',
    ]);
    expect(audits[1]!.diff).toMatchObject({ via: 'voice', upload_id: clip.uploadId });

    // Then decide_next goes on (no photo yet: the photo question, §10.5), Delta still 40 h.
    const decide = await runQueued('decide_next', reportId);
    expect(decide.dedupe_key).toBe(`decide:${reportId}:answer:${questionId}`);
    const [next] = await database.q<{ field: string }>(
      `select field from questions where report_id = $1 and answered_at is null`,
      [reportId],
    );
    expect([(await reportRow(reportId)).status, next?.field]).toEqual(['awaiting_answer', 'photo']);
    // A retried parse changes nothing.
    await database.q(`update jobs set status = 'queued' where id = $1`, [clip.jobId]);
    expect(await run(clip.jobId)).toEqual({ ok: true });
    expect((await draftOf(reportId)).manpower).toEqual(data.manpower);
  });

  it('an unclear answer is asked once more, then recorded unanswered and flagged; the draft follows', async () => {
    const date = '2026-10-13';
    const { reportId, questionId } = await heroQuestion(date);
    const before = await draftOf(reportId);

    const first = await speak(reportId, questionId, 'answer-en-unclear', date);
    expect(await run(first.jobId)).toEqual({ ok: true });
    // Asked once more: still the open question, nothing applied, the try marked unclear.
    expect((await reportRow(reportId)).status).toBe('awaiting_answer');
    expect(await draftOf(reportId)).toEqual(before);
    const [q1] = await database.q<{ answered_at: string | null; voice_answers: unknown[] }>(
      `select answered_at, voice_answers from questions where id = $1`,
      [questionId],
    );
    expect(q1!.answered_at).toBeNull();
    expect(q1!.voice_answers).toMatchObject([
      { uploadId: first.uploadId, status: 'unclear', reason: 'low_confidence', confidence: 0.15 },
    ]);

    const second = await speak(reportId, questionId, 'answer-en-unclear', date);
    expect(await run(second.jobId)).toEqual({ ok: true });
    const r = await reportRow(reportId);
    expect(r).toMatchObject({ status: 'processing', needs_review: true });
    expect(r.review_reasons).toContain('unanswered:manpower.workers');
    const [q2] = await database.q<{ answered_at: string | null; answer: Record<string, unknown> }>(
      `select answered_at, answer from questions where id = $1`,
      [questionId],
    );
    expect(q2!.answered_at).not.toBeNull();
    expect(q2!.answer).toMatchObject({ unanswered: true, unclear: true });
    // Still never invented: Delta's headcount stays empty.
    const delta = (await draftOf(reportId)).manpower.find(
      (m) => m.companyName === 'Delta Mechanical',
    )!;
    expect(delta.workers).toBeNull();
    // F7 "then move on": decide_next goes on (the next question, or the draft).
    await runQueued('decide_next', reportId);
    expect(['awaiting_answer', 'awaiting_confirmation']).toContain(
      (await reportRow(reportId)).status,
    );
    const asked = await database.q<{ id: string }>(
      `select id from questions where report_id = $1 and answered_at is null`,
      [reportId],
    );
    expect(asked.every((x) => x.id !== questionId)).toBe(true);
  });

  it('the 60-minute timeout waits for a spoken answer still being read, which then applies', async () => {
    const date = '2026-10-14';
    const { reportId, questionId } = await heroQuestion(date);
    const clip = await speak(reportId, questionId, 'answer-en-delta-five-all-day', date);
    const timerKey = `decide:${reportId}:timeout:${questionId}`;
    const [timer] = await database.q<{ id: number }>(`select id from jobs where dedupe_key = $1`, [
      timerKey,
    ]);
    const saved = clock.now();
    clock.set(new Date(saved.getTime() + 61 * 60_000));
    try {
      // The clip is still in parse_answer (listening): the timeout records nothing and re-arms.
      expect(await run(timer!.id)).toEqual({ ok: true });
      const [open] = await database.q<{ answered_at: string | null }>(
        `select answered_at from questions where id = $1`,
        [questionId],
      );
      expect(open!.answered_at).toBeNull();
      const rearmed = await database.q<{ id: number; status: string }>(
        `select id, status::text from jobs where dedupe_key = $1`,
        [`${timerKey}:re1`],
      );
      expect(rearmed.map((j) => j.status)).toEqual(['queued']);

      // The answer is read and applied; the re-armed timer then finds the question answered.
      expect(await run(clip.jobId)).toEqual({ ok: true });
      expect(await run(rearmed[0]!.id)).toEqual({ ok: true });
      const [q] = await database.q<{
        answer: Record<string, unknown>;
        voice_answers: Array<Record<string, unknown>>;
      }>(`select answer, voice_answers from questions where id = $1`, [questionId]);
      expect(q!.voice_answers).toMatchObject([{ uploadId: clip.uploadId, status: 'applied' }]);
      expect(q!.answer).toMatchObject({ parsed: { workers: 5, fullDay: true } });
      expect(q!.answer.timeout).toBeUndefined();
      const delta = (await draftOf(reportId)).manpower.find(
        (m) => m.companyName === 'Delta Mechanical',
      )!;
      expect(delta).toMatchObject({ workers: 5, totalHours: 40 });
      expect(
        await database.q(
          `select 1 from audit_log where entity_id = $1 and action = 'report.question_timeout'`,
          [reportId],
        ),
      ).toEqual([]);
    } finally {
      clock.set(saved);
    }
  });

  it('F15 / §19 Q95: a clip spoken before recording consent is turned off goes to no provider', async () => {
    const date = '2026-10-15';
    const { reportId, questionId } = await heroQuestion(date);
    const clip = await speak(reportId, questionId, 'answer-en-delta-five-all-day', date);
    const calls = world.claude.calls.length;
    await database.q(`select field_revoke_consent($1, 'recording', null)`, [MARCO]);
    try {
      expect(await run(clip.jobId)).toEqual({ ok: true });
      expect(world.claude.calls.length).toBe(calls);
      expect(
        await database.q(`select 1 from transcripts where upload_id = $1`, [clip.uploadId]),
      ).toEqual([]);
      const [q] = await database.q<{
        answered_at: string | null;
        voice_answers: Array<Record<string, unknown>>;
      }>(`select answered_at, voice_answers from questions where id = $1`, [questionId]);
      expect(q!.answered_at).toBeNull();
      expect(q!.voice_answers).toMatchObject([
        { uploadId: clip.uploadId, status: 'unclear', reason: 'consent_revoked' },
      ]);
      const [audit] = await database.q<{ diff: Record<string, unknown> }>(
        `select diff from audit_log where entity_id = $1 and action = 'report.processing_skipped'`,
        [reportId],
      );
      expect(audit!.diff).toMatchObject({ job_type: 'parse_answer', reason: 'consent_revoked' });
    } finally {
      await database.q(
        `insert into consents (reporter_id, type, method, text_version)
         values ($1, 'recording', 'web_checkbox', 'field.consent.v1')`,
        [MARCO],
      );
    }
  });
});
