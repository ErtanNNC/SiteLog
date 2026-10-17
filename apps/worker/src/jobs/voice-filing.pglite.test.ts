import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApplyCorrectionResultSchema,
  RecordAnswerResultSchema,
  VoiceDraftStateSchema,
  computeTotals,
  createConsoleSmsTransport,
  isCallConfirm,
  jobKeys,
  readReportData,
  voiceTurnKey,
  type DailyReportData,
  type JobPayloads,
  type JobRow,
  type StoredReportData,
  type VoiceTurnKind,
} from '@sitelog/shared';
import { createFixtureClaude, loadFixtureLibrary, type FakeClaude } from '../ai/fake-claude';
import { FIXTURES_DIR } from '../ai/eval';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { fileReportJob } from './file_report';
import { notifyJob } from './notify';
import { voiceTurnJob } from './voice_turn';

/**
 * W3-10 on PGlite (spec F6 steps 5–7, F8 call, F9 step 1, §7.2 "yes (call)", §9.4 rule 5, §13,
 * §19 Q118, Q119, Q151): the recorded call `fixtures/calls/riverside-fix-en` through the live
 * pipeline (field-api's half: voice_turn_submit() and voice_file_report(); the worker's: the
 * `voice_turn`, `file_report` and `notify` jobs) with `EXTRACT_PROVIDER=fake`:
 *
 * - the read-back (code's), then "No, Apex had seven, not six." changes the draft at once to
 *   7 × 8 = 56 h citing the call second, and the change alone is read back;
 * - "Yes, file it." (code's confirm grammar, never a model) files the revision read back, once,
 *   with `confirmed_via voice`, under a retried file_report and a repeated filing job;
 * - the Demo phone (the console driver of a demo org) shows `filed` and `photos_link` once each,
 *   the photos link a `kind 'photos'` link until 23:59 the day after;
 * - "sounds good I guess" files nothing.
 */

let pg: PgliteDatabase;
let MARCO = '';
let RIVERSIDE = '';
let ORG = '';
let fake: FakeClaude;

function ctx(): Ctx {
  const config = testConfig({
    LINK_SIGNING_SECRET: 'voice-filing-link-secret',
    FIELD_APP_URL: 'https://go.sitelog.test',
  });
  return {
    config,
    db: pg.db,
    ai: { claude: fake, openai: null, transcriber: null },
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => new Date(),
    ),
    log: silentLogger,
    metrics: createMetrics(),
    now: () => new Date(),
  } as unknown as Ctx;
}

const recorded = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'calls', 'riverside-fix-en.json'), 'utf8'),
) as {
  routes: Record<string, unknown[]>;
  reporterTurns: string[];
  answers: string[];
  corrections: string[];
  filing: Array<{ utterance: string; draftRev: number; answer: string }>;
};

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'reportId' && k !== 'draftRev' && k !== 'id')
      .map(([k, v]) => [k, withoutIds(v)]),
  );
}

function fixtureSegments(id: string) {
  const t = JSON.parse(readFileSync(join(FIXTURES_DIR, 'transcripts', `${id}.json`), 'utf8')) as {
    segments: Array<{ start: number; end: number; text: string }>;
  };
  return t.segments.map(({ start, end, text }) => ({ start, end, text }));
}

async function newCall(started: string): Promise<string> {
  const id = randomUUID();
  await pg.q(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language)
     values ($1, $2, $3, $4, 'inbound', 'web', $5, 'in_progress', $6, $6, $6, 'en-US')`,
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
  const [t] = await pg.q<{ status: string; result: unknown; error: string | null }>(
    `select status, result, error from voice_turns where id = $1`,
    [turnId],
  );
  return { reportId, ...t! };
}

/** field-api's file_report: code's grammar on the words, then voice_file_report(). */
async function fileOnCall(callId: string, reportId: string, draftRev: number, words: string) {
  const [row] = await pg.q<{ r: { status: string; jobId?: number } }>(
    `select voice_file_report($1, $2, $3, $4, $5) as r`,
    [callId, reportId, draftRev, words, isCallConfirm(words)],
  );
  return row!.r;
}

async function draftOf(reportId: string): Promise<{ data: DailyReportData; rev: number }> {
  const [v] = await pg.q<{ data: StoredReportData; draft_rev: number }>(
    `select v.data, v.draft_rev from report_versions v join reports r on r.id = v.report_id
      where r.id = $1 and v.version = r.current_version`,
    [reportId],
  );
  return { data: readReportData(v!.data), rev: v!.draft_rev };
}

/** Runs every queued job of `type` once (the worker's loop, in order). */
async function runQueued<T extends 'file_report' | 'notify'>(type: T, reportId: string) {
  const jobs = await pg.q<{ id: number; payload: JobPayloads[T] }>(
    `select id, payload from jobs where type = $1 and status = 'queued'
        and (payload ->> 'reportId' = $2 or payload ->> 'dedupeKey' like '%' || $2 || '%')
      order by id`,
    [type, reportId],
  );
  for (const j of jobs) {
    if (type === 'file_report')
      await fileReportJob(ctx(), j.payload as JobPayloads['file_report'], {} as JobRow);
    else await notifyJob(ctx(), j.payload as JobPayloads['notify'], {} as JobRow);
    await pg.q(`update jobs set status = 'done' where id = $1`, [j.id]);
  }
  return jobs.length;
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  fake = createFixtureClaude({ lib: loadFixtureLibrary() });
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

describe('W3-10: a correction and the spoken yes on a call (riverside-fix-en)', () => {
  let call = '';
  let reportId = '';

  it('reads back, then "No, Apex had seven, not six." changes the draft to 7 × 8 = 56 h citing the call second', async () => {
    call = await newCall('2030-06-17T22:30:00Z');
    const draft = await turn(call, 'update_draft', {
      segments: fixtureSegments('call-riverside-2026-10-09-en'),
    });
    reportId = draft.reportId;
    const state = VoiceDraftStateSchema.parse(draft.result);
    expect(withoutIds(state)).toEqual(withoutIds(recorded.routes.update_draft![0]));
    const answer = await turn(call, 'record_answer', {
      questionId: state.question!.id,
      utterance: recorded.answers[0],
      start: 80.4,
      end: 82.1,
    });
    const answered = RecordAnswerResultSchema.parse(answer.result);
    expect(answered.draft.readBack).toMatch(/^Here's what I've got: 23 on site/);

    const fix = await turn(call, 'apply_correction', {
      utterance: recorded.corrections[0],
      start: 101.5,
      end: 104,
    });
    expect(fix.status).toBe('done');
    const result = ApplyCorrectionResultSchema.parse(fix.result);
    expect(withoutIds(result)).toEqual(withoutIds(recorded.routes.apply_correction![0]));
    expect(result.readBack).toBe(
      'Apex Concrete: 7 workers, 8 hours each — 56 hours. Shall I file it?',
    );
    const { data, rev } = await draftOf(reportId);
    expect(result.draft!.draftRev).toBe(rev);
    expect(rev).toBeGreaterThan(answered.draft.draftRev);
    const apex = data.manpower.find((m) => m.companyName === 'Apex Concrete')!;
    expect([apex.workers, apex.hoursPerWorker, apex.totalHours]).toEqual([7, 8, 56]);
    expect(apex.source).toContainEqual({ type: 'call', callId: call, start: 101.5, end: 104 });
    expect(computeTotals(data).totals).toMatchObject({ crewOnSite: 24, totalHours: 192 });
    // Recorded as applied, so a later re-extraction keeps it (§19 Q96); audited as the reporter.
    const [fixRow] = await pg.q<{ via: string; status: string; text: string }>(
      `select via, status, text from draft_corrections where report_id = $1`,
      [reportId],
    );
    expect(fixRow).toEqual({ via: 'voice', status: 'applied', text: recorded.corrections[0] });
    const [audit] = await pg.q<{ actor_type: string; diff: { call_id: string } }>(
      `select actor_type, diff from audit_log where action = 'report.draft_corrected' and entity_id = $1`,
      [reportId],
    );
    expect(audit).toMatchObject({ actor_type: 'reporter', diff: { call_id: call } });
    expect(await reportStatus(reportId)).toBe('awaiting_confirmation');
    expect(fake.phoneLeaks).toEqual([]);
  });

  it('"sounds good I guess" files nothing', async () => {
    const { rev } = await draftOf(reportId);
    expect(await fileOnCall(call, reportId, rev, 'sounds good I guess')).toMatchObject({
      status: 'not_confirmed',
    });
    expect(await runQueued('file_report', reportId)).toBe(0);
    expect(await reportStatus(reportId)).toBe('awaiting_confirmation');
  });

  it('"Yes, file it." files the revision read back once, via voice; a retry and a second run file nothing more', async () => {
    const { rev } = await draftOf(reportId);
    const step = recorded.filing[0]!;
    const first = await fileOnCall(call, reportId, rev, step.utterance);
    expect(first.status).toBe('queued');
    // The agent's retry before the worker ran: the same filing job.
    expect(await fileOnCall(call, reportId, rev, step.utterance)).toMatchObject({
      status: 'queued',
      jobId: first.jobId,
    });
    expect(await runQueued('file_report', reportId)).toBe(1);
    expect(await fileOnCall(call, reportId, rev, step.utterance)).toMatchObject({
      status: step.answer,
    });
    const [r] = await pg.q<{ status: string; confirmed_via: string; confirmed_at: string | null }>(
      `select status::text, confirmed_via::text, confirmed_at from reports where id = $1`,
      [reportId],
    );
    expect(r).toMatchObject({ status: 'filed', confirmed_via: 'voice' });
    expect(r!.confirmed_at).not.toBeNull();
    // A repeated filing job (a queue retry) finds it filed: nothing new is queued.
    const [payload] = await pg.q<{ payload: JobPayloads['file_report'] }>(
      `select payload from jobs where type = 'file_report' and payload ->> 'reportId' = $1`,
      [reportId],
    );
    await fileReportJob(ctx(), payload!.payload, {} as JobRow);
    const notify = await pg.q<{ dedupe_key: string }>(
      `select dedupe_key from jobs where type = 'notify' and dedupe_key like '%' || $1 || '%' order by id`,
      [reportId],
    );
    expect(notify.map((n) => n.dedupe_key)).toEqual([
      jobKeys.filed(reportId),
      jobKeys.photosLink(reportId),
    ]);
  });

  it('the Demo phone shows filed and photos_link once each; the photos link lasts until 23:59 the day after', async () => {
    expect(await runQueued('notify', reportId)).toBe(2);
    const texts = await pg.q<{ copy_key: string; body: string }>(
      `select copy_key, body from messages where reporter_id = $1 and direction = 'out'
          and copy_key in ('filed', 'photos_link') and created_at > now() - interval '1 hour'
        order by created_at`,
      [MARCO],
    );
    expect(texts.map((t) => t.copy_key)).toEqual(['filed', 'photos_link']);
    expect(texts[1]!.body).toMatch(
      /^Add photos to today's report: https:\/\/go\.sitelog\.test\/r\//,
    );
    const links = await pg.q<{ report_date: string; expires_at: string }>(
      `select report_date::text, expires_at from field_links
        where reporter_id = $1 and kind = 'photos' and site_id = $2`,
      [MARCO, RIVERSIDE],
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.report_date).toBe('2030-06-17');
    expect(new Date(links[0]!.expires_at).toISOString()).toBe('2030-06-19T04:59:00.000Z');
  });
});

async function reportStatus(id: string): Promise<string> {
  return (
    await pg.q<{ status: string }>(`select status::text from reports where id = $1`, [id])
  )[0]!.status;
}
