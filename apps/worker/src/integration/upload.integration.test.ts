import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobRow } from '@sitelog/shared';
import { createDeepgramTranscriber } from '../ai/deepgram';
import { createFakeTranscriber } from '../ai/fake-transcriber';
import { loadVoiceFixtures } from '../ai/voice-fixtures';
import { registry } from '../jobs/registry';
import { memoryLogger } from '../log';
import { runJob } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { createSim, loadFixtureLibrary, manualClock, NO_LATENCY } from './fakes';
import { createWorld, type World } from './world';

/**
 * W1-11 on a real database: the field-upload entry point (the `uploads` row and
 * `field_complete_upload()`, as field-api's `uploads/:id/complete`) → `transcribe_upload` through
 * the real runner and the production postgres.js repository, with the fixtures/voice fake (the
 * CI worker's provider) and a Deepgram transcriber on a mocked fetch. PGlite with every migration
 * and the §18 seed.
 */

let database: PgliteDatabase;
let world: World;
let log: ReturnType<typeof memoryLogger>;
const fake = createFakeTranscriber();
const FIXTURES = new Map(loadVoiceFixtures().map((f) => [f.id, f]));

let MARCO = '';
let RIVERSIDE = '';
let EMRE = '';
let KARTAL = '';
let PHONES: string[] = [];

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  log = memoryLogger('info');
  const clock = manualClock(new Date('2026-10-12T21:40:00Z'));
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim: createSim({ advance: clock, profile: NO_LATENCY }),
    lib: loadFixtureLibrary(['riverside-2026-10-09']),
    log,
    fieldTranscriber: fake,
  });
  const q = database.q.bind(database);
  MARCO = (await q<{ id: string }>(`select id from reporters where name = 'Marco Ruiz'`))[0]!.id;
  RIVERSIDE = (await q<{ id: string }>(`select id from sites where project_code = 'RL-2041'`))[0]!
    .id;
  EMRE = (await q<{ id: string }>(`select id from reporters where name = 'Emre Yıldız'`))[0]!.id;
  KARTAL = (
    await q<{ id: string }>(`select site_id as id from site_reporters where reporter_id = $1`, [
      EMRE,
    ])
  )[0]!.id;
  PHONES = (await q<{ phone_e164: string }>(`select phone_e164 from reporters`)).map(
    (r) => r.phone_e164,
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

async function job(id: number) {
  return (
    await database.q<{ status: string; dedupe_key: string; payload: Record<string, unknown> }>(
      `select status::text as status, dedupe_key, payload from jobs where id = $1`,
      [id],
    )
  )[0]!;
}

async function extractJobs(reportId: string) {
  return database.q<{ id: number; dedupe_key: string; payload: { reason?: string } }>(
    `select id, dedupe_key, payload from jobs where type = 'extract_report'
       and payload ->> 'reportId' = $1 order by id`,
    [reportId],
  );
}

describe('transcribe_upload (W1-11): a fixture upload → transcript, peaks, extract_report', () => {
  let first: Awaited<ReturnType<World['uploadVoiceNote']>>;

  it('the field-upload entry point creates the report and queues transcribe_upload', async () => {
    first = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date: '2026-10-12',
    });
    expect(first.created).toBe(true);
    expect(first.jobId).not.toBeNull();
    const j = await job(first.jobId!);
    expect(j).toMatchObject({
      status: 'queued',
      dedupe_key: `transcribe_upload:${first.uploadId}`,
      payload: { uploadId: first.uploadId },
    });
  });

  it('writes the transcript (upload_id, no message), about 600 peaks and the duration, audits, and queues extract_report', async () => {
    const res = await run(first.jobId!);
    expect(res).toEqual({ ok: true });
    const hero = FIXTURES.get('es-en-riverside-2026-10-09')!;

    const [t] = await database.q<{
      message_id: string | null;
      upload_id: string;
      language: string;
      text: string;
      segments: Array<{ start: number; end: number; text: string }>;
      model: string;
    }>(`select * from transcripts where upload_id = $1`, [first.uploadId]);
    expect(t).toMatchObject({ message_id: null, upload_id: first.uploadId, model: 'fake' });
    expect(t!.language).toBe('en+es');
    expect(t!.text).toBe(hero.text);
    expect(t!.segments).toEqual(hero.segments);

    const [u] = await database.q<{ duration_s: string; peaks: number[] }>(
      `select duration_s, peaks from uploads where id = $1`,
      [first.uploadId],
    );
    expect(Number(u!.duration_s)).toBe(hero.durationS);
    expect(u!.peaks).toHaveLength(600);
    expect(Math.max(...u!.peaks)).toBe(1);

    // §10.2 language for Marco (ES · EN) and the hints from the database: no phone number.
    const call = fake.calls.at(-1)!;
    expect(call.language).toBe('multi');
    expect(call.mime).toBe('audio/webm;codecs=opus');
    expect(call.keyterms).toContain('Riverside Lofts — Block B');
    expect(call.keyterms).toContain('Delta Mechanical');
    for (const phone of PHONES) expect(call.keyterms.join(' ')).not.toContain(phone.slice(2));

    const audit = await database.q<{
      action: string;
      actor_type: string;
      diff: Record<string, unknown>;
    }>(
      `select action, actor_type, diff from audit_log where entity = 'upload' and entity_id = $1
         and action = 'transcript.created'`,
      [first.uploadId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: 'agent',
      diff: { provider: 'fake', model: 'fake', requested_language: 'multi', seconds: 68 },
    });
    expect(JSON.stringify(audit[0]!.diff)).not.toContain('Delta');

    const extracts = await extractJobs(first.reportId);
    expect(extracts).toHaveLength(1);
    expect(extracts[0]!.dedupe_key).toBe(`extract:${first.reportId}:upload:${first.uploadId}`);
    expect(extracts[0]!.payload.reason).toBe(`upload:${first.uploadId}`);
  });

  it('logs and stores latency and audio seconds', async () => {
    const j = await job(first.jobId!);
    const metrics = j.payload.metrics as Record<string, unknown>;
    expect(metrics.audioSeconds).toBe(68);
    expect(typeof metrics.latencyMs).toBe('number');
    expect(typeof metrics.transcribeLatencyMs).toBe('number');
    expect(metrics.transcribeProvider).toBe('fake');
    const line = log.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'transcribed' && l.upload_id === first.uploadId);
    expect(line).toMatchObject({
      provider: 'fake',
      audio_seconds: 68,
      peaks: 600,
      segments: 10,
      job_type: 'transcribe_upload',
    });
    expect(typeof line!.latency_ms).toBe('number');
  });

  it('a retry is idempotent: no second transcript, no second extract_report, no provider call', async () => {
    const calls = fake.calls.length;
    await registry.transcribe_upload(world.ctx, { uploadId: first.uploadId }, {} as JobRow);
    await registry.transcribe_upload(world.ctx, { uploadId: first.uploadId }, {} as JobRow);
    expect(fake.calls.length).toBe(calls);
    const n = await database.q<{ n: number }>(
      `select count(*)::int as n from transcripts where upload_id = $1`,
      [first.uploadId],
    );
    expect(n[0]!.n).toBe(1);
    expect(await extractJobs(first.reportId)).toHaveLength(1);
    const audits = await database.q(
      `select 1 from audit_log where action = 'transcript.created' and entity_id = $1`,
      [first.uploadId],
    );
    expect(audits).toHaveLength(1);
  });

  it('two voice notes: the last one transcribed extracts once, keyed by the latest upload', async () => {
    // The draft is back to processing as field_complete_upload() leaves it for more audio.
    await database.q(`update reports set status = 'awaiting_confirmation' where id = $1`, [
      first.reportId,
    ]);
    const b = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'en-elm-2026-10-02',
      date: '2026-10-12',
    });
    const c = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date: '2026-10-12',
    });
    expect(b.reportId).toBe(first.reportId);
    expect(c.reportId).toBe(first.reportId);
    // The latest note's job happens to run first: B still waits, so no extraction yet.
    expect((await run(c.jobId!)).ok).toBe(true);
    expect(await extractJobs(first.reportId)).toHaveLength(1);
    expect((await run(b.jobId!)).ok).toBe(true);
    const extracts = await extractJobs(first.reportId);
    expect(extracts.map((e) => e.dedupe_key)).toEqual([
      `extract:${first.reportId}:upload:${first.uploadId}`,
      `extract:${first.reportId}:upload:${c.uploadId}`,
    ]);
  });

  it('a report no longer processing keeps the transcript and extracts nothing', async () => {
    const d = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'en-elm-2026-10-02',
      date: '2026-10-12',
    });
    await database.q(`update reports set status = 'void' where id = $1`, [d.reportId]);
    expect((await run(d.jobId!)).ok).toBe(true);
    expect(
      await database.q(`select 1 from transcripts where upload_id = $1`, [d.uploadId]),
    ).toHaveLength(1);
    expect(await extractJobs(d.reportId)).toHaveLength(2);
    await database.q(`update reports set status = 'processing' where id = $1`, [d.reportId]);
  });

  it('a Turkish reporter gets tr and the Turkish transcript', async () => {
    const tr = await world.uploadVoiceNote({
      reporterId: EMRE,
      siteId: KARTAL,
      fixtureId: 'tr-kartal-2026-10-09',
      date: '2026-10-12',
      mime: 'audio/mp4',
    });
    expect((await run(tr.jobId!)).ok).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ language: 'tr', mime: 'audio/mp4' });
    // The §18.2 seeds and the org's Turkish starter terms (built_in, W4-08, §19 Q238).
    expect(fake.calls.at(-1)!.keyterms).toEqual(
      expect.arrayContaining(['Usta Beton', 'döküm', 'kalıp söktük', 'metreküp', 'ramak kala']),
    );
    const [t] = await database.q<{ language: string; text: string }>(
      `select language, text from transcripts where upload_id = $1`,
      [tr.uploadId],
    );
    expect(t!.language).toBe('tr');
    expect(t!.text).toMatch(/^Kartal Konutları B Blok/);
    expect(tr.storagePath.endsWith('.m4a')).toBe(true);
  });

  it("hints with the reporter's own confirmed terms, never another reporter's (spec §19 Q143)", async () => {
    const org = (
      await database.q<{ org_id: string }>(`select org_id from reporters where id = $1`, [MARCO])
    )[0]!.org_id;
    const other = (
      await database.q<{ id: string }>(
        `select id from reporters where org_id = $1 and id <> $2 limit 1`,
        [org, MARCO],
      )
    )[0]!.id;
    await database.q(
      `insert into glossary_terms (org_id, scope_reporter_id, heard, language, kind, status, times_heard)
       values ($1, $2, 'la cimbra', 'es', 'term', 'confirmed', 5),
              ($1, $3, 'zz other reporter term', 'en', 'term', 'confirmed', 50)`,
      [org, MARCO, other],
    );
    const d = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date: '2026-10-12',
    });
    expect((await run(d.jobId!)).ok).toBe(true);
    const keyterms = fake.calls.at(-1)!.keyterms;
    expect(keyterms).toContain('la cimbra');
    expect(keyterms).not.toContain('zz other reporter term');
  });
});

describe('transcribe_upload through Deepgram (mocked HTTP) on the same database', () => {
  it('sends the stored file as recorded with the site hints and stores the mapped segments', async () => {
    const requests: Array<{ url: URL; headers: Record<string, string>; bytes: number }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: new URL(String(input)),
        headers: init?.headers as Record<string, string>,
        bytes: (init?.body as Uint8Array).byteLength,
      });
      return new Response(
        JSON.stringify({
          metadata: { duration: 33.04 },
          results: {
            channels: [
              {
                alternatives: [
                  {
                    transcript: 'Elm Street, Friday. Rain from seven to ten.',
                    words: [{ word: 'elm', start: 0.2, end: 0.4, language: 'en' }],
                  },
                ],
              },
            ],
            utterances: [
              { start: 0.2, end: 2.1, channel: 0, transcript: 'Elm Street, Friday.' },
              { start: 2.3, end: 4.0, channel: 0, transcript: 'Rain from seven to ten.' },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const deepgram = createDeepgramTranscriber({
      apiKey: 'dg-test',
      model: 'nova-3',
      fetch: fetchMock,
    });
    const ctx = { ...world.ctx, ai: { ...world.ctx.ai, transcriber: deepgram } };
    await database.q(
      `insert into glossary_terms (org_id, scope_site_id, heard, official, language, kind, status)
       select org_id, id, 'east wing', 'Level 2 east wing', 'en', 'area', 'confirmed' from sites where id = $1`,
      [RIVERSIDE],
    );
    const up = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'en-elm-2026-10-02',
      date: '2026-10-13',
    });
    const [row] = await database.q<JobRow>(
      `update jobs set status = 'running', locked_at = now(), locked_by = 'integration',
         attempts = attempts + 1 where id = $1 returning *`,
      [up.jobId],
    );
    expect(await runJob(ctx, row!, 60_000, { workerId: 'integration' })).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(r.url.searchParams.get('model')).toBe('nova-3');
    expect(r.url.searchParams.get('language')).toBe('multi');
    expect(r.url.searchParams.getAll('keyterm')).toEqual(
      expect.arrayContaining([
        'Riverside Lofts — Block B',
        'Apex Concrete',
        'east wing',
        'Level 2 east wing',
      ]),
    );
    expect(r.headers.Authorization).toBe('Token dg-test');
    expect(r.headers['Content-Type']).toBe('audio/webm');
    expect(r.bytes).toBeGreaterThan(0);
    const [t] = await database.q<{ model: string; language: string; segments: unknown }>(
      `select model, language, segments from transcripts where upload_id = $1`,
      [up.uploadId],
    );
    expect(t).toMatchObject({
      model: 'nova-3',
      language: 'en',
      segments: [
        { start: 0.2, end: 2.1, text: 'Elm Street, Friday.' },
        { start: 2.3, end: 4, text: 'Rain from seven to ten.' },
      ],
    });
    const [m] = await database.q<{ metrics: Record<string, unknown> }>(
      `select payload -> 'metrics' as metrics from jobs where id = $1`,
      [up.jobId],
    );
    // ffmpeg's duration (the fixture's 33 s) wins over the provider's 33.04 s.
    expect(m!.metrics).toMatchObject({ audioSeconds: 33, transcribeProvider: 'deepgram' });
    // The cost follows the seconds Deepgram bills.
    expect(m!.metrics.estCostUsd).toBeCloseTo((33.04 / 60) * 0.0052, 6);
  });
});
