import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RecordAnswerResultSchema,
  VoiceDraftStateSchema,
  computeTotals,
  readReportData,
  voiceTurnKey,
  type DailyReportData,
  type JobRow,
  type StoredReportData,
  type VoiceTurnKind,
} from '@sitelog/shared';
import { createFixtureClaude, loadFixtureLibrary, type FakeClaude } from '../ai/fake-claude';
import { FIXTURES_DIR } from '../ai/eval';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { voiceTurnJob } from './voice_turn';

/**
 * W3-09 on PGlite (spec §4.3 B step 3, §10.4 live mode, §10.5 on a call, F7 on a call, §19 Q117,
 * Q118): a call's live turns as field-api submits them (voice_turn_submit()) and the worker's
 * `voice_turn` job runs them, on the recorded call fixtures (fixtures/transcripts/call-*.json,
 * `EXTRACT_PROVIDER=fake`):
 * - Northgate's call (the ticket's Done when): 14 workers from 2 companies, 100.0 h, totals in
 *   code, every value citing the call second; nothing to ask on a call, so code's read-back;
 * - the Delta gap: F7's spoken question with two choices; "Five, all day." applies 5 × 8 = 40 h,
 *   citing the answer and the call second, with F7's spoken confirmation from code's numbers;
 * - Spanish, unclear twice: asked once more, then left for the office (`unanswered:<field>`) and
 *   the draft moves on;
 * - a second call the same day merges into the report; no phone number reaches the model.
 */

let pg: PgliteDatabase;
let KEVIN = '';
let NORTHGATE = '';
let MARCO = '';
let RIVERSIDE = '';
let ORG = '';
let fake: FakeClaude;
/** The user messages the fake model was sent (the extraction's and parse_answer's). */
const sent: string[] = [];

function ctx(): Ctx {
  return {
    config: testConfig(),
    db: pg.db,
    ai: { claude: fake, openai: null, transcriber: null },
    log: silentLogger,
    metrics: createMetrics(),
    now: () => new Date(),
  } as unknown as Ctx;
}

function fixtureSegments(id: string): Array<{ start: number; end: number; text: string }> {
  const t = JSON.parse(readFileSync(join(FIXTURES_DIR, 'transcripts', `${id}.json`), 'utf8')) as {
    segments: Array<{ start: number; end: number; text: string }>;
  };
  return t.segments.map(({ start, end, text }) => ({ start, end, text }));
}

/** A recorded call (fixtures/calls/<id>.json): field-api's answers per route, in order. */
function recordedCall(id: string): { routes: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'calls', `${id}.json`), 'utf8')) as {
    routes: Record<string, unknown[]>;
  };
}

/** A draft state or an answer without its ids and revision: what a recorded call must match. */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'reportId' && k !== 'draftRev' && k !== 'id')
      .map(([k, v]) => [k, withoutIds(v)]),
  );
}

async function newCall(
  reporter: string,
  site: string,
  started: string,
  language = 'en-US',
): Promise<string> {
  const id = randomUUID();
  await pg.q(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language)
     values ($1, $2, $3, $4, 'inbound', 'web', $5, 'in_progress', $6, $6, $6, $7)`,
    [id, ORG, reporter, site, `call-${id}`, started, language],
  );
  return id;
}

/** field-api's half: voice_turn_submit(); then the worker's half: the job it queued. */
async function turn(callId: string, kind: VoiceTurnKind, input: unknown) {
  const key = await voiceTurnKey(kind, input);
  const [row] = await pg.q<{ r: { turnId: string; reportId: string; repeat: boolean } }>(
    `select voice_turn_submit($1, $2, $3, $4::jsonb) as r`,
    [callId, kind, key, JSON.stringify(input)],
  );
  const { turnId, reportId } = row!.r;
  await voiceTurnJob(ctx(), { turnId, reportId }, {} as JobRow);
  const [t] = await pg.q<{ status: string; result: unknown; error: string | null }>(
    `select status, result, error from voice_turns where id = $1`,
    [turnId],
  );
  return { turnId, reportId, ...t! };
}

async function draftOf(reportId: string): Promise<DailyReportData> {
  const [v] = await pg.q<{ data: StoredReportData }>(
    `select v.data from report_versions v join reports r on r.id = v.report_id
      where r.id = $1 and v.version = r.current_version`,
    [reportId],
  );
  return readReportData(v!.data);
}

const reportStatus = async (id: string) =>
  (await pg.q<{ status: string }>(`select status::text from reports where id = $1`, [id]))[0]!
    .status;

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const lib = loadFixtureLibrary();
  const inner = createFixtureClaude({ lib });
  fake = {
    ...inner,
    messages: {
      async create(params) {
        const first = params.messages[0];
        if (first && typeof first.content === 'string') sent.push(first.content);
        return inner.messages.create(params);
      },
    },
  };
  const who = async (phone: string) =>
    (
      await pg.q<{ id: string; site_id: string; org_id: string }>(
        `select r.id, sr.site_id, r.org_id from reporters r
           join site_reporters sr on sr.reporter_id = r.id
          where r.phone_e164 = $1 and sr.is_primary limit 1`,
        [phone],
      )
    )[0]!;
  const kevin = await who('+15550142087');
  const marco = await who('+15550143378');
  KEVIN = kevin.id;
  NORTHGATE = kevin.site_id;
  MARCO = marco.id;
  RIVERSIDE = marco.site_id;
  ORG = kevin.org_id;
});

afterAll(async () => {
  await pg?.close();
});

describe('W3-09: update_draft on a call (live mode)', () => {
  let call = '';
  let reportId = '';

  it("Northgate's call: 14 workers from 2 companies, 100.0 h, every value citing the call second, then code's read-back", async () => {
    call = await newCall(KEVIN, NORTHGATE, '2030-06-07T22:10:00Z');
    const segments = fixtureSegments('call-northgate-2026-10-09-en');
    // The reporter says a phone number: it never reaches the model (§10.12).
    segments.push({ start: 46.5, end: 50, text: 'If the office needs me, 555 014 2087.' });
    const r = await turn(call, 'update_draft', { segments });
    expect(r.status).toBe('done');
    reportId = r.reportId;
    const state = VoiceDraftStateSchema.parse(r.result);
    expect(state.question).toBeNull();
    expect(state.missing).toEqual([]);
    expect(state.readBack).toBe(
      "Here's what I've got: 14 on site from 2 companies, 100 hours. Shall I file it?",
    );
    expect(state.reportId).toBe(reportId);
    // The recorded call the agent's tests replay answers what the pipeline answers.
    expect(withoutIds(state)).toEqual(
      withoutIds(recordedCall('northgate-call-en').routes.update_draft![0]),
    );

    const data = await draftOf(reportId);
    const { totals } = computeTotals(data);
    expect(totals).toMatchObject({ crewOnSite: 14, companies: 2, totalHours: 100 });
    expect(data.manpower.map((m) => [m.workers, m.hoursPerWorker, m.totalHours])).toEqual([
      [3, 8, 24],
      [8, 8, 64],
      [3, 4, 12],
    ]);
    // Every crew, work line and the safety statement cites this call, at a second of its lane.
    const starts = new Set(segments.map((s) => s.start));
    for (const item of [...data.manpower, ...data.workPerformed, data.safety]) {
      expect(item.source.length).toBeGreaterThan(0);
      for (const s of item.source) {
        expect(s).toMatchObject({ type: 'call', callId: call });
        expect(starts.has((s as { start: number }).start)).toBe(true);
      }
    }
    expect(await reportStatus(reportId)).toBe('awaiting_confirmation');
    const [report] = await pg.q<{ channel: string; site_status: string }>(
      `select r.channel::text, sd.status::text as site_status
         from reports r join site_days sd on sd.id = r.site_day_id where r.id = $1`,
      [reportId],
    );
    expect(report).toEqual({ channel: 'voice', site_status: 'processing' });
    // Live mode: CHANNEL call, the call's lane by its id, no number.
    const extraction = sent.find((m) => m.includes(`PHONE CALL callId=${call}`))!;
    expect(extraction).toMatch(/^CHANNEL: call$/m);
    expect(extraction).not.toContain('555 014 2087');
    expect(fake.phoneLeaks).toEqual([]);
    // No text to the reporter during the call, no web clock.
    expect(
      await pg.q(
        `select type from jobs where (payload ->> 'reportId' = $1 or payload -> 'reportGuard' ->> 'reportId' = $1)
           and type in ('notify', 'decide_next')`,
        [reportId],
      ),
    ).toEqual([]);
    const audits = await pg.q<{ action: string; diff: Record<string, unknown> }>(
      `select action, diff from audit_log where entity = 'report' and entity_id = $1 order by id`,
      [reportId],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'report.created',
      'report.extracted',
      'report.status_changed',
    ]);
    expect(audits[1]!.diff).toMatchObject({ mode: 'live', call_id: call });
  });

  it('the same words again are the same turn: the answer is kept, nothing runs twice', async () => {
    const segments = fixtureSegments('call-northgate-2026-10-09-en');
    segments.push({ start: 46.5, end: 50, text: 'If the office needs me, 555 014 2087.' });
    const input = { segments };
    const key = await voiceTurnKey('update_draft', input);
    const before = sent.length;
    const [row] = await pg.q<{ r: { repeat: boolean; status: string; result: unknown } }>(
      `select voice_turn_submit($1, 'update_draft', $2, $3::jsonb) as r`,
      [call, key, JSON.stringify(input)],
    );
    expect(row!.r).toMatchObject({ repeat: true, status: 'done' });
    expect(VoiceDraftStateSchema.parse(row!.r.result).readBack).toMatch(/^Here's what I've got/);
    expect(sent.length).toBe(before);
  });

  it('a turn the worker cannot run settles failed at once (no queue retry); the next request runs it again', async () => {
    const other = await newCall(KEVIN, NORTHGATE, '2030-06-14T22:10:00Z');
    const input = { segments: fixtureSegments('call-northgate-2026-10-09-en') };
    const key = await voiceTurnKey('update_draft', input);
    const submit = async () =>
      (
        await pg.q<{ r: { turnId: string; reportId: string; status: string } }>(
          `select voice_turn_submit($1, 'update_draft', $2, $3::jsonb) as r`,
          [other, key, JSON.stringify(input)],
        )
      )[0]!.r;
    const first = await submit();
    // No model client (as without ANTHROPIC_API_KEY): the job finishes, the turn is failed.
    const keyless = {
      ...ctx(),
      ai: { claude: null, openai: null, transcriber: null },
    } as unknown as Ctx;
    await voiceTurnJob(keyless, { turnId: first.turnId, reportId: first.reportId }, {} as JobRow);
    const [failed] = await pg.q<{ status: string; error: string }>(
      `select status, error from voice_turns where id = $1`,
      [first.turnId],
    );
    expect(failed).toEqual({ status: 'failed', error: 'turn_failed' });
    const again = await submit();
    expect(again).toMatchObject({ turnId: first.turnId, status: 'pending' });
    await voiceTurnJob(ctx(), { turnId: first.turnId, reportId: first.reportId }, {} as JobRow);
    const [done] = await pg.q<{ status: string; attempts: number }>(
      `select status, attempts from voice_turns where id = $1`,
      [first.turnId],
    );
    expect(done).toEqual({ status: 'done', attempts: 2 });
  });

  it('a second call the same day merges into the report (§7.2: re-extracted with every source)', async () => {
    const second = await newCall(KEVIN, NORTHGATE, '2030-06-07T22:40:00Z');
    const r = await turn(second, 'update_draft', {
      segments: [{ start: 6, end: 9, text: 'Northgate again, I forgot nothing, just checking.' }],
    });
    expect(r.reportId).toBe(reportId);
    const last = sent.at(-1)!;
    expect(last).toContain(`PHONE CALL callId=${call}`);
    expect(last).toContain(`PHONE CALL callId=${second}`);
  });
});

describe('W3-09: spoken questions and record_answer (F7 on a call)', () => {
  it('the Delta gap: "four or five people, and the full day?" with two choices; "Five, all day." applies 5 × 8 = 40 h', async () => {
    const call = await newCall(MARCO, RIVERSIDE, '2030-06-10T22:30:00Z');
    const draft = await turn(call, 'update_draft', {
      segments: fixtureSegments('call-riverside-2026-10-09-en'),
    });
    const state = VoiceDraftStateSchema.parse(draft.result);
    expect(state.question).toMatchObject({
      text: 'Quick one — the Delta guys on Level 2: was that four or five people, and the full day?',
      choices: ['4, full day', '5, full day'],
    });
    expect(state.missing).toEqual([
      'manpower.workers:Delta Mechanical',
      'manpower.hours:Delta Mechanical',
    ]);
    expect(state.readBack).toBeNull();
    const recorded = recordedCall('riverside-delta-en').routes;
    expect(withoutIds(state)).toEqual(withoutIds(recorded.update_draft![1]));
    expect(await reportStatus(draft.reportId)).toBe('awaiting_answer');
    const [q] = await pg.q<{ channel: string; call_id: string }>(
      `select channel::text, call_id from questions where id = $1`,
      [state.question!.id],
    );
    expect(q).toEqual({ channel: 'voice', call_id: call });

    const answer = await turn(call, 'record_answer', {
      questionId: state.question!.id,
      utterance: 'Five, all day.',
      start: 80.4,
      end: 82.1,
    });
    const result = RecordAnswerResultSchema.parse(answer.result);
    expect(result.status).toBe('applied');
    expect(result.confirmation).toBe('Delta Mechanical: 5 workers, 8 hours each — 40 hours.');
    expect(result.draft.question).toBeNull();
    expect(result.draft.readBack).toBe(
      "Here's what I've got: 23 on site from 5 companies, 184 hours. Weather stopped work for 3.5 hours. Shall I file it?",
    );
    expect(withoutIds(result)).toEqual(withoutIds(recorded.record_answer![0]));
    const data = await draftOf(draft.reportId);
    const delta = data.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    expect([delta.workers, delta.hoursPerWorker, delta.totalHours]).toEqual([5, 8, 40]);
    expect(delta.source).toEqual(
      expect.arrayContaining([
        { type: 'answer', questionId: state.question!.id },
        { type: 'call', callId: call, start: 80.4, end: 82.1 },
      ]),
    );
    expect(await reportStatus(draft.reportId)).toBe('awaiting_confirmation');
    const [qa] = await pg.q<{ answered_at: string | null; answer: { via: string } }>(
      `select answered_at, answer from questions where id = $1`,
      [state.question!.id],
    );
    expect(qa!.answered_at).not.toBeNull();
    expect(qa!.answer.via).toBe('call');
  });

  it('Spanish, unclear twice: asked once more, then left for the office and the draft moves on', async () => {
    const call = await newCall(MARCO, RIVERSIDE, '2030-06-11T22:30:00Z', 'es-US');
    const draft = await turn(call, 'update_draft', {
      segments: fixtureSegments('call-riverside-2026-10-09-es'),
    });
    const state = VoiceDraftStateSchema.parse(draft.result);
    expect(state.question).toMatchObject({
      text: 'Una pregunta — los de Delta en el nivel 2: ¿eran cuatro o cinco, y todo el día?',
      choices: ['4, todo el día', '5, todo el día'],
    });
    const qid = state.question!.id;
    const recorded = recordedCall('riverside-delta-es').routes;
    expect(withoutIds(state)).toEqual(withoutIds(recorded.update_draft![0]));

    const first = await turn(call, 'record_answer', {
      questionId: qid,
      utterance: 'No sé, la verdad.',
      start: 80,
    });
    const once = RecordAnswerResultSchema.parse(first.result);
    expect(once).toMatchObject({
      status: 'not_understood',
      confirmation: 'Perdón, no le entendí.',
    });
    expect(once.draft.question?.id).toBe(qid);
    expect(withoutIds(once)).toEqual(withoutIds(recorded.record_answer![0]));
    expect(await reportStatus(draft.reportId)).toBe('awaiting_answer');

    const second = await turn(call, 'record_answer', {
      questionId: qid,
      utterance: 'Mmm, no me acuerdo.',
      start: 86,
    });
    const twice = RecordAnswerResultSchema.parse(second.result);
    expect(twice.status).toBe('skipped');
    expect(withoutIds(twice)).toEqual(withoutIds(recorded.record_answer![1]));
    expect(twice.confirmation).toBe(
      'No logré entenderlo, así que lo dejo para que la oficina lo revise.',
    );
    expect(twice.draft.question).toBeNull();
    // The headcount stays unknown: no crew total is spoken, only the weather and the question
    // (US Spanish writes 3.5).
    expect(twice.draft.readBack).toBe('El clima detuvo el trabajo 3.5 horas. ¿Lo registro?');
    expect(twice.draft.missing).toEqual([
      'manpower.workers:Delta Mechanical',
      'manpower.hours:Delta Mechanical',
    ]);
    const [r] = await pg.q<{ status: string; needs_review: boolean; review_reasons: string[] }>(
      `select status::text, needs_review, review_reasons from reports where id = $1`,
      [draft.reportId],
    );
    expect(r).toMatchObject({ status: 'awaiting_confirmation', needs_review: true });
    expect(r!.review_reasons).toContain('unanswered:manpower.workers');
    const data = await draftOf(draft.reportId);
    expect(data.manpower.find((m) => m.companyName === 'Delta Mechanical')!.workers).toBeNull();
  });

  it('a question not open on this call is refused before the worker runs', async () => {
    const call = await newCall(MARCO, RIVERSIDE, '2030-06-12T22:30:00Z');
    await turn(call, 'update_draft', { segments: fixtureSegments('call-riverside-2026-10-09-en') });
    const err = await pg
      .q(`select voice_turn_submit($1, 'record_answer', $2, $3::jsonb)`, [
        call,
        'e'.repeat(64),
        JSON.stringify({ questionId: randomUUID(), utterance: 'Five.', start: 1 }),
      ])
      .catch((e: Error) => e.message);
    expect(err).toMatch(/question_closed/);
  });
});
