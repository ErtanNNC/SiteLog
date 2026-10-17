import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RecordAnswerResultSchema,
  VoiceDraftStateSchema,
  createConsoleSmsTransport,
  isCallConfirm,
  jobKeys,
  readCallPeaks,
  voiceTurnKey,
  type JobPayloads,
  type JobRow,
  type ReportExtraction,
  type VoiceTurnKind,
} from '@sitelog/shared';
import { createFixtureClaude, loadFixtureLibrary, type FakeClaude } from '../ai/fake-claude';
import { createFakeTranscriber, fakeAudio } from '../ai/fake-transcriber';
import { FIXTURES_DIR } from '../ai/eval';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { onDeadJob } from '../dead-jobs';
import { silentLogger } from '../log';
import { createFfmpegRunner, resolveFfmpegPath } from '../media/ffmpeg';
import { createWorkerNotifier } from '../messaging';
import { createMemoryStorage } from '../storage';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { decideNext } from './decide_next';
import { extractReport } from './extract_report';
import { fileReportJob } from './file_report';
import { noPhotoCheckJob } from './no_photo_check';
import { notifyJob } from './notify';
import { postCallReconcileJob } from './post_call';
import { voiceTurnJob } from './voice_turn';

/**
 * W3-11 on PGlite (spec §7.2 "Call: hang-up before confirmation", §7.3, F6 failure handling, F9,
 * §10.1 `post_call_reconcile`, §10.5 step 2, §10.9, §19 Q122, Q123, Q152, Q162, Q176): calls of
 * the recorded Riverside report (`fixtures/calls/riverside-fix-en`) through the live pipeline
 * (voice_turn_submit(), voice_file_report(), voice_call_end()) and then the worker's post-call
 * job with `EXTRACT_PROVIDER=fake` and the fake transcriber (`fixtures/voice/call-riverside-en`,
 * the reporter lane of the recording):
 *
 * - a call hung up after the read-back gets one `finish_report` text whose link opens the draft,
 *   the nudge at +30 min and the `unconfirmed` filing at +2 h from the hang-up; the 2 h filing
 *   gets the photos link (Q176) and the 23:59 photo check;
 * - a call with too little said is `abandoned`: no draft, no text, the day back to `pending`;
 * - a fallback recording becomes the report's voice note, extracted as a web note, `draft_ready`;
 * - a filed call whose recording says 5 Delta workers against a confirmed 4 is flagged
 *   `call_mismatch:manpower[2].workers:5:4` with the review notice, never a silent change; a call
 *   that agrees gets precise seconds and two-lane peaks; one with no recording is
 *   `call_unreconciled`, as is a filed call whose post-call job died;
 * - a call report without photos is flagged `no_photo` at 23:59.
 */

let pg: PgliteDatabase;
let MARCO = '';
let RIVERSIDE = '';
let ORG = '';
let fake: FakeClaude;
const storage = createMemoryStorage();
const FFMPEG = (() => {
  const bin = resolveFfmpegPath();
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return bin;
  } catch {
    return null;
  }
})();

/** The batch extraction's edit (what the recording says), per test. */
let heardEdit: ((out: ReportExtraction) => ReportExtraction) | null = null;

function ctx(): Ctx {
  const config = testConfig({
    LINK_SIGNING_SECRET: 'post-call-link-secret',
    FIELD_APP_URL: 'https://go.sitelog.test',
  });
  return {
    config,
    db: pg.db,
    storage,
    ai: { claude: fake, openai: null, transcriber: createFakeTranscriber() },
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => new Date(),
    ),
    ffmpeg: createFfmpegRunner(FFMPEG ?? 'ffmpeg'),
    log: silentLogger,
    metrics: createMetrics(),
    now: () => new Date(),
    signal: new AbortController().signal,
  } as unknown as Ctx;
}

const recorded = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'calls', 'riverside-fix-en.json'), 'utf8'),
) as { answers: string[] };

function fixtureSegments() {
  const t = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'transcripts', 'call-riverside-2026-10-09-en.json'), 'utf8'),
  ) as { segments: Array<{ start: number; end: number; text: string }> };
  return t.segments.map(({ start, end, text }) => ({ start, end, text }));
}

async function newCall(started: string): Promise<string> {
  const id = randomUUID();
  await pg.q(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language,
                        disclosure_played)
     values ($1, $2, $3, $4, 'inbound', 'web', $5, 'in_progress', $6, $6, $6, 'en-US', true)`,
    [id, ORG, MARCO, RIVERSIDE, `call-${id}`, started],
  );
  return id;
}

async function turn(callId: string, kind: VoiceTurnKind, input: unknown) {
  const key = await voiceTurnKey(kind, input);
  const [row] = await pg.q<{ r: { turnId: string; reportId: string } }>(
    `select voice_turn_submit($1, $2, $3, $4::jsonb) as r`,
    [callId, kind, key, JSON.stringify(input)],
  );
  const { turnId, reportId } = row!.r;
  await voiceTurnJob(ctx(), { turnId, reportId }, {} as JobRow);
  const [t] = await pg.q<{ status: string; result: unknown }>(
    `select status, result from voice_turns where id = $1`,
    [turnId],
  );
  return { reportId, ...t! };
}

const FOUR = 'Four, all day.';

/** The Riverside report said on the call, the Delta question answered: the read-back. */
async function readBack(callId: string, deltaAnswer = recorded.answers[0]!) {
  const draft = await turn(callId, 'update_draft', { segments: fixtureSegments() });
  const state = VoiceDraftStateSchema.parse(draft.result);
  const answer = await turn(callId, 'record_answer', {
    questionId: state.question!.id,
    utterance: deltaAnswer,
    start: 80.4,
    end: 82.1,
  });
  return { reportId: draft.reportId, ...RecordAnswerResultSchema.parse(answer.result) };
}

async function endCall(callId: string, outcome: string): Promise<number | null> {
  const [row] = await pg.q<{ r: { jobId: number | null } }>(
    `select voice_call_end($1, $2::call_outcome, '[]', '{}') as r`,
    [callId, outcome],
  );
  return row!.r.jobId;
}

async function jobRow(id: number): Promise<JobRow> {
  return (await pg.q<JobRow>(`select * from jobs where id = $1`, [id]))[0]!;
}

async function runPostCall(callId: string) {
  const [j] = await pg.q<JobRow>(`select * from jobs where dedupe_key = $1`, [
    jobKeys.postCall(callId),
  ]);
  expect(j, 'the call queued its post-call job').toBeDefined();
  await postCallReconcileJob(ctx(), { callId }, j!);
  await pg.q(`update jobs set status = 'done' where id = $1`, [j!.id]);
}

/** Runs every queued job of `type` whose payload names the report (the worker's loop, in order). */
async function runQueued<T extends 'file_report' | 'notify' | 'decide_next' | 'extract_report'>(
  type: T,
  reportId: string,
  opts: { due?: boolean } = {},
) {
  const jobs = await pg.q<JobRow & { payload: JobPayloads[T] }>(
    `select * from jobs where type = $1 and status = 'queued'
        and (payload ->> 'reportId' = $2
             or payload -> 'reportGuard' ->> 'reportId' = $2
             or payload ->> 'dedupeKey' like '%' || $2 || '%')
        ${opts.due === false ? '' : "and run_after <= now() + interval '5 seconds'"}
      order by id`,
    [type, reportId],
  );
  for (const j of jobs) {
    const c = ctx();
    if (type === 'file_report') await fileReportJob(c, j.payload as JobPayloads['file_report'], j);
    else if (type === 'notify') await notifyJob(c, j.payload as JobPayloads['notify'], j);
    else if (type === 'decide_next')
      await decideNext(c, j.payload as JobPayloads['decide_next'], j);
    else await extractReport(c, j.payload as JobPayloads['extract_report'], j);
    await pg.q(`update jobs set status = 'done' where id = $1`, [j.id]);
  }
  return jobs.length;
}

async function texts(reportOrCallKey: string) {
  return pg.q<{ copy_key: string; body: string }>(
    `select m.copy_key, m.body from messages m
      where m.reporter_id = $1 and m.direction = 'out' and m.payload ->> 'dedupe_key' like '%' || $2 || '%'
      order by m.created_at`,
    [MARCO, reportOrCallKey],
  );
}

async function report(id: string) {
  return (
    await pg.q<{
      status: string;
      review_reasons: string[];
      needs_review: boolean;
      confirmed_via: string | null;
    }>(
      `select status::text, review_reasons, needs_review, confirmed_via::text from reports where id = $1`,
      [id],
    )
  )[0]!;
}

async function uploadRecording(callId: string, body: Buffer) {
  const path = `${ORG}/${callId}.ogg`;
  await pg.q(`select voice_call_recording($1, $2)`, [callId, path]);
  await storage.upload('calls', path, body, 'audio/ogg');
}

/** A real stereo recording when ffmpeg is here (reporter left, agent right), else fake bytes. */
function stereoRecording(): Buffer {
  if (!FFMPEG) return fakeAudio('call-riverside-en', 75);
  const dir = mkdtempSync(join(tmpdir(), 'sitelog-call-'));
  try {
    const out = join(dir, 'call.ogg');
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(t,2),sin(440*2*PI*t),0)|if(gte(t,2),0.5*sin(660*2*PI*t),0)':s=16000:d=4",
      '-c:a',
      'libopus',
      out,
    ]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  fake = createFixtureClaude({
    lib: loadFixtureLibrary(),
    extractionV2: (_id, out) => (heardEdit ? heardEdit(out) : out),
    // The live answer as the call heard it: "Five, all day." (the recorded one) or "Four, all day."
    parseAnswer: (text) =>
      text === FOUR
        ? { field: 'manpower.workers', value: { workers: 4, fullDay: true }, confidence: 0.98 }
        : null,
  });
  const [marco] = await pg.q<{ id: string; site_id: string; org_id: string }>(
    `select r.id, sr.site_id, r.org_id from reporters r
       join site_reporters sr on sr.reporter_id = r.id
      where r.phone_e164 = '+15550143378' and sr.is_primary limit 1`,
  );
  MARCO = marco!.id;
  RIVERSIDE = marco!.site_id;
  ORG = marco!.org_id;
});

afterAll(async () => {
  await pg?.close();
});

describe('W3-11: a call hung up after the read-back continues on the web (§19 Q122)', () => {
  let call = '';
  let reportId = '';

  it('settles draft_saved, sends one finish_report whose link opens the draft, clocks from the hang-up', async () => {
    call = await newCall('2030-07-01T21:00:00Z');
    const back = await readBack(call);
    reportId = back.reportId;
    expect(back.draft.readBack).toMatch(/^Here's what I've got/);
    expect((await report(reportId)).status).toBe('awaiting_confirmation');
    await endCall(call, 'draft_saved');
    // The reporter hung up 20 minutes ago (the job ran late): the clocks still start then.
    await pg.q(`update calls set ended_at = now() - interval '20 minutes' where id = $1`, [call]);

    // No recording yet (the agent uploads at the end): the hang-up is settled first, then the
    // job waits for the recording (its retries).
    await expect(postCallReconcileJob(ctx(), { callId: call }, {} as JobRow)).rejects.toThrow(
      /not uploaded yet/,
    );
    const [c] = await pg.q<{ outcome: string }>(`select outcome::text from calls where id = $1`, [
      call,
    ]);
    expect(c!.outcome).toBe('draft_saved');
    expect(await runQueued('decide_next', reportId)).toBe(1);
    expect(await runQueued('notify', reportId)).toBe(1);
    const sent = await texts(call);
    expect(sent.map((t) => t.copy_key)).toEqual(['finish_report']);
    expect(sent[0]!.body).toMatch(
      /^Your call ended before filing\. Finish in one tap: https:\/\/go\.sitelog\.test\/r\//,
    );
    // The link is the reporter's personal link: the field app opens today's draft.
    const [link] = await pg.q<{ kind: string }>(
      `select kind from field_links where reporter_id = $1 and kind = 'personal'`,
      [MARCO],
    );
    expect(link!.kind).toBe('personal');

    const timers = await pg.q<{ dedupe_key: string; minutes: number }>(
      `select j.dedupe_key,
              round(extract(epoch from j.run_after - c.ended_at) / 60)::int as minutes
         from jobs j, calls c
        where c.id = $2 and j.status = 'queued'
          and (j.dedupe_key like 'decide:' || $1 || ':file-timeout:%'
               or j.dedupe_key like 'notify:draft_nudge:' || $1 || ':%')
        order by j.dedupe_key`,
      [reportId, call],
    );
    expect(timers.map((t) => [t.dedupe_key.split(':')[0], t.minutes])).toEqual([
      ['decide', 120],
      ['notify', 30],
    ]);
  });

  it('sends it once: the job again (the recording arrived) and decide_next again text nothing', async () => {
    await uploadRecording(call, fakeAudio('call-riverside-en', 75));
    await runPostCall(call);
    await decideNext(
      ctx(),
      { reportId, afterCall: { callId: call, endedAt: new Date().toISOString() } },
      { id: 999_999 } as JobRow,
    );
    expect(await runQueued('notify', reportId)).toBe(0);
    expect((await texts(call)).map((t) => t.copy_key)).toEqual(['finish_report']);
    // §19 Q162: the batch transcript replaced the live row.
    const [t] = await pg.q<{ model: string }>(`select model from transcripts where call_id = $1`, [
      call,
    ]);
    expect(t!.model).toBe('fake');
  });

  it('files at +2 h as unconfirmed, with the photos link (§19 Q176) and the 23:59 photo check', async () => {
    const [timer] = await pg.q<JobRow>(
      `select * from jobs where dedupe_key like 'decide:' || $1 || ':file-timeout:%' and status = 'queued'`,
      [reportId],
    );
    await decideNext(ctx(), timer!.payload as JobPayloads['decide_next'], timer!);
    const r = await report(reportId);
    expect(r.status).toBe('filed');
    expect(r.review_reasons).toContain('unconfirmed');
    // The photo is deferred for a call report: never `missing:photo` at filing.
    expect(r.review_reasons).not.toContain('missing:photo');
    const keys = await pg.q<{ dedupe_key: string }>(
      `select dedupe_key from jobs where dedupe_key in ($1, $2)`,
      [jobKeys.photosLink(reportId), jobKeys.noPhoto(reportId)],
    );
    expect(keys.map((k) => k.dedupe_key).sort()).toEqual(
      [jobKeys.noPhoto(reportId), jobKeys.photosLink(reportId)].sort(),
    );
  });
});

describe('W3-11: too little said is abandoned (§19 Q122)', () => {
  it('no draft and no text; the report the call made is voided and the day is pending again', async () => {
    const call = await newCall('2030-07-02T21:00:00Z');
    const t = await turn(call, 'update_draft', {
      segments: [{ start: 1, end: 3, text: 'Hello? Hello, can you hear me?' }],
    });
    expect(t.status).toBe('done');
    await endCall(call, 'draft_saved');
    await pg.q(`update calls set ended_at = now() - interval '2 hours' where id = $1`, [call]);
    await runPostCall(call);
    const [c] = await pg.q<{ outcome: string }>(`select outcome::text from calls where id = $1`, [
      call,
    ]);
    expect(c!.outcome).toBe('abandoned');
    expect((await report(t.reportId)).status).toBe('void');
    const [day] = await pg.q<{ status: string }>(
      `select d.status::text from site_days d join reports r on r.site_day_id = d.id where r.id = $1`,
      [t.reportId],
    );
    expect(day!.status).toBe('pending');
    expect(await runQueued('decide_next', t.reportId, { due: false })).toBe(0);
    expect(await texts(call)).toEqual([]);
  });
});

describe('W3-11: the fallback recording becomes the report (F6 failure handling)', () => {
  it('the reporter lane is a voice note of the report: extracted as a web note, then draft_ready', async () => {
    const call = await newCall('2030-07-03T21:00:00Z');
    await pg.q(`select voice_call_fallback($1, 'not_understood', 14.5)`, [call]);
    await endCall(call, 'fallback_recording');
    await uploadRecording(call, fakeAudio('call-riverside-en', 75));
    heardEdit = (out) => ({
      ...out,
      manpower: out.manpower.map((m) =>
        m.companyName === 'Delta Mechanical'
          ? { ...m, workers: 4, totalHours: 32, hoursBasis: 'stated' }
          : m,
      ),
    });
    try {
      await runPostCall(call);
      const [c] = await pg.q<{ report_id: string; outcome: string }>(
        `select report_id, outcome::text from calls where id = $1`,
        [call],
      );
      expect(c!.outcome).toBe('fallback_recording');
      const reportId = c!.report_id;
      expect((await report(reportId)).status).toBe('processing');
      expect(await runQueued('extract_report', reportId)).toBe(1);
      expect(await runQueued('decide_next', reportId)).toBe(1);
      expect((await report(reportId)).status).toBe('awaiting_confirmation');
      expect(await runQueued('notify', reportId)).toBe(1);
      const [sent] = await pg.q<{ copy_key: string }>(
        `select copy_key from messages where reporter_id = $1 and direction = 'out'
            and payload ->> 'dedupe_key' like 'notify:draft_ready:' || $2 || '%'`,
        [MARCO, reportId],
      );
      expect(sent!.copy_key).toBe('draft_ready');
    } finally {
      heardEdit = null;
    }
  });
});

describe('W3-11: the post-call reconcile of a filed call (§10.9, §19 Q123)', () => {
  async function fileCall(started: string, deltaAnswer?: string) {
    const call = await newCall(started);
    const back = await readBack(call, deltaAnswer);
    const [row] = await pg.q<{ r: { status: string } }>(
      `select voice_file_report($1, $2, $3, $4, $5) as r`,
      [call, back.reportId, back.draft.draftRev, 'Yes, file it.', isCallConfirm('Yes, file it.')],
    );
    expect(row!.r.status).toBe('queued');
    expect(await runQueued('file_report', back.reportId)).toBe(1);
    expect((await report(back.reportId)).confirmed_via).toBe('voice');
    await endCall(call, 'filed');
    return { call, reportId: back.reportId };
  }

  it('the recording says 5 Delta workers, the confirmed report 4: call_mismatch:manpower[2].workers:5:4', async () => {
    // The live answer as heard on the call: four.
    const { call, reportId } = await fileCall('2030-07-04T21:00:00Z', FOUR);
    await uploadRecording(call, fakeAudio('call-riverside-en', 75));
    heardEdit = (out) => ({
      ...out,
      manpower: out.manpower.map((m) =>
        m.companyName === 'Delta Mechanical'
          ? { ...m, workers: 5, totalHours: 40, hoursBasis: 'stated' }
          : m,
      ),
    });
    try {
      await runPostCall(call);
    } finally {
      heardEdit = null;
    }
    const r = await report(reportId);
    expect(r.status).toBe('filed');
    expect(r.needs_review).toBe(true);
    expect(r.review_reasons).toContain('call_mismatch:manpower[2].workers:5:4');
    // Never a silent change: the confirmed version still says 4.
    const [v] = await pg.q<{ workers: number }>(
      `select (v.data -> 'manpower' -> 2 ->> 'workers')::int as workers
         from report_versions v join reports r on r.id = v.report_id
        where r.id = $1 and v.version = r.current_version`,
      [reportId],
    );
    expect(v!.workers).toBe(4);
    const notices = await pg.q<{ kind: string; data: { params: { reasons: string[] } } }>(
      `select kind, data from notifications where target_path = '/reports/' || $1 and kind = 'needs_review'
        order by created_at`,
      [reportId],
    );
    expect(notices.at(-1)!.data.params.reasons).toEqual(['call_mismatch:manpower[2].workers:5:4']);
    const [c] = await pg.q<{ reconcile: { status: string; mismatches: string[] } }>(
      `select reconcile from calls where id = $1`,
      [call],
    );
    expect(c!.reconcile).toMatchObject({
      status: 'mismatch',
      mismatches: ['call_mismatch:manpower[2].workers:5:4'],
    });
    // The crews that agree get their precise seconds; Delta keeps its live ones.
    const precise = await pg.q<{ value_path: string }>(
      `select value_path from report_sources where report_id = $1 and value_path is not null order by value_path`,
      [reportId],
    );
    expect(precise.map((p) => p.value_path)).not.toContain('manpower[2]');
    expect(precise.map((p) => p.value_path)).toContain('manpower[0]');
    // A retry changes nothing more.
    await postCallReconcileJob(ctx(), { callId: call }, {} as JobRow);
    expect((await report(reportId)).review_reasons.filter((x) => x.startsWith('call_'))).toEqual([
      'call_mismatch:manpower[2].workers:5:4',
    ]);
  });

  it('a call that agrees: precise seconds, two-lane peaks and the batch transcript; no review', async () => {
    const { call, reportId } = await fileCall('2030-07-05T21:00:00Z');
    await uploadRecording(call, stereoRecording());
    await runPostCall(call);
    const r = await report(reportId);
    expect(r.review_reasons.filter((x) => x.startsWith('call_'))).toEqual([]);
    const precise = await pg.q<{ value_path: string; start_s: string }>(
      `select value_path, start_s from report_sources where report_id = $1 and value_path is not null order by value_path`,
      [reportId],
    );
    expect(precise.map((p) => p.value_path)).toEqual([
      'manpower[0]',
      'manpower[1]',
      'manpower[2]',
      'manpower[3]',
      'manpower[4]',
      'weather.periods[0]',
    ]);
    const [c] = await pg.q<{ reconcile: { status: string }; peaks: unknown; duration_s: number }>(
      `select reconcile, peaks, duration_s from calls where id = $1`,
      [call],
    );
    expect(c!.reconcile.status).toBe('equal');
    if (FFMPEG) {
      const lanes = readCallPeaks(c!.peaks)!;
      expect(lanes.reporter).toHaveLength(600);
      expect(lanes.agent).toHaveLength(600);
      expect(c!.duration_s).toBe(4);
    }
    const [t] = await pg.q<{ model: string; segments: Array<{ speaker: string }> }>(
      `select model, segments from transcripts where call_id = $1`,
      [call],
    );
    expect(t!.model).toBe('fake');
    expect(new Set(t!.segments.map((s) => s.speaker))).toEqual(new Set(['reporter']));
    expect(fake.phoneLeaks).toEqual([]);
  });

  it('a filed call with no recording is call_unreconciled, once', async () => {
    const { call, reportId } = await fileCall('2030-07-06T21:00:00Z');
    await pg.q(`update calls set ended_at = now() - interval '2 hours' where id = $1`, [call]);
    await runPostCall(call);
    await postCallReconcileJob(ctx(), { callId: call }, {} as JobRow);
    const r = await report(reportId);
    expect(r.review_reasons.filter((x) => x === 'call_unreconciled')).toHaveLength(1);
    expect(r.needs_review).toBe(true);
    const [c] = await pg.q<{ reconcile: { status: string; reason: string } }>(
      `select reconcile from calls where id = $1`,
      [call],
    );
    expect(c!.reconcile).toMatchObject({ status: 'unreconciled', reason: 'no_recording' });
  });

  it('a filed call whose post-call job died is call_unreconciled (§19 Q123)', async () => {
    const { call, reportId } = await fileCall('2030-07-07T21:00:00Z');
    const [j] = await pg.q<{ id: number }>(`select id from jobs where dedupe_key = $1`, [
      jobKeys.postCall(call),
    ]);
    await pg.q(`update jobs set status = 'dead', attempts = 6 where id = $1`, [j!.id]);
    await onDeadJob(ctx(), await jobRow(j!.id), new Error('Deepgram down'));
    expect((await report(reportId)).review_reasons).toContain('call_unreconciled');
    const [audit] = await pg.q<{ diff: { notified: string } }>(
      `select diff from audit_log where action = 'job.dead' and diff ->> 'job_id' = $1::text`,
      [String(j!.id)],
    );
    expect(audit!.diff.notified).toBe('call_unreconciled');
  });
});

describe('W3-11: no_photo at 23:59 for a call report (§10.5 step 2)', () => {
  it('flags a filed call report without photos, once, with the review notice', async () => {
    const call = await newCall('2030-07-08T21:00:00Z');
    const back = await readBack(call);
    await pg.q(`select voice_file_report($1, $2, $3, $4, true)`, [
      call,
      back.reportId,
      back.draft.draftRev,
      'Yes.',
    ]);
    expect(await runQueued('file_report', back.reportId)).toBe(1);
    const [check] = await pg.q<JobRow & { local: string }>(
      `select j.*, to_char(j.run_after at time zone s.timezone, 'YYYY-MM-DD HH24:MI') as local
         from jobs j join reports r on r.id = (j.payload ->> 'reportId')::uuid
         join sites s on s.id = r.site_id
        where j.dedupe_key = $1`,
      [jobKeys.noPhoto(back.reportId)],
    );
    expect(check!.local).toMatch(/ 23:59$/);
    expect((await report(back.reportId)).review_reasons).not.toContain('no_photo');
    await noPhotoCheckJob(ctx(), { reportId: back.reportId }, check!);
    await noPhotoCheckJob(ctx(), { reportId: back.reportId }, check!);
    const r = await report(back.reportId);
    expect(r.review_reasons.filter((x) => x === 'no_photo')).toHaveLength(1);
    expect(r.needs_review).toBe(true);
    const notices = await pg.q<{ data: { params: { reasons: string[] } } }>(
      `select data from notifications where target_path = '/reports/' || $1 and kind = 'needs_review'`,
      [back.reportId],
    );
    expect(notices.some((n) => n.data.params.reasons.includes('no_photo'))).toBe(true);
  });
});

describe('W3-14: a call whose reporter said no to the consent question (§19 Q120)', () => {
  it('processes nothing: no transcript, no reconcile, no hand-over; the recording is deleted', async () => {
    const call = await newCall('2030-07-09T21:00:00Z');
    await uploadRecording(call, fakeAudio('call-riverside-en', 75));
    await pg.q(`select voice_record_consent($1, 'no', 4, 'voice.consent.v1')`, [call]);
    await endCall(call, 'abandoned');
    await pg.q(`update calls set ended_at = now() - interval '2 hours' where id = $1`, [call]);
    await runPostCall(call);
    const [c] = await pg.q<{ outcome: string; reconcile: unknown; peaks: unknown }>(
      `select outcome::text, reconcile, peaks from calls where id = $1`,
      [call],
    );
    expect(c).toEqual({ outcome: 'abandoned', reconcile: null, peaks: null });
    expect(await pg.q(`select 1 from transcripts where call_id = $1`, [call])).toEqual([]);
    await expect(storage.download('calls', `${ORG}/${call}.ogg`)).rejects.toThrow();
    expect(
      await pg.q(
        `select 1 from jobs where type = 'decide_next' and payload -> 'afterCall' ->> 'callId' = $1`,
        [call],
      ),
    ).toEqual([]);
    expect(await texts(call)).toEqual([]);
  });
});
