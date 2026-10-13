import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DailyReportDataV1, SiteDayWeather } from '@sitelog/shared';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import {
  createSim,
  fakeWeatherFetch,
  loadFixtureLibrary,
  manualClock,
  NO_LATENCY,
  openMeteoResponse,
  type Clock,
  type FixtureLibrary,
  type WaEvent,
} from './fakes';
import {
  buttonReplyPayload,
  readdress,
  textPayload,
  webhookFixture,
  type MetaPayload,
} from './webhook';
import { createWorld, drainQueue, type World } from './world';

/**
 * §17 Integration: webhook replay → jobs → outbound payloads, on a real database.
 *
 * PGlite with every migration + the §18 seed, the production postgres.js repository, the webhook's
 * ingest (src/integration/webhook.ts, same decisions as supabase/functions/whatsapp-webhook), and the
 * real runner + job handlers. Only the outside world is faked (src/integration/fakes.ts): Meta,
 * OpenAI (golden transcript segments), Claude (recorded tool outputs + replies.json), storage, email,
 * ffmpeg and Open-Meteo. Latency is virtual: a "12 s" transcription moves the clock 12 s.
 *
 * The scenarios share one database and run in order: A (F5→F7 happy path), B (F6 question), C
 * (duplicate delivery, bad signature, delivery status, unknown sender).
 */

const HERO = 'riverside-2026-10-09';
const MARCO = '+15550143378';
const STRANGER = '+15550199001';

let database: PgliteDatabase;
let lib: FixtureLibrary;
let world: World;
let clock: Clock;
let ORG = '';
let RIVERSIDE = '';
let RECIPIENTS: string[] = [];
/** The scenario A audio payload, kept for the duplicate-delivery check. */
let heroAudio: MetaPayload;

/** Scenario A: the hero case with the Delta headcount said out loud (no question → the draft). */
let completeHero = true;
function heroComplete(id: string, out: ReturnType<FixtureLibrary['get']>['recorded']) {
  if (id !== HERO || !completeHero) return out;
  for (const m of out.manpower) {
    if (m.workers === null) {
      m.workers = 4;
      m.totalHours = 32;
    }
  }
  return { ...out, missingRequired: [], proposedQuestions: [] };
}

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  lib = loadFixtureLibrary([HERO]);
  clock = manualClock(new Date('2026-10-13T21:40:00Z'));
  // Virtual latency (the clock moves, nobody sleeps): transcription 12 s, extraction 20 s.
  const sim = createSim({
    advance: clock,
    profile: { ...NO_LATENCY, transcribe: [12, 12], claude: [20, 20], claudeFast: [1, 1] },
  });
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim,
    lib,
    claude: { extraction: (id, out) => heroComplete(id, out) },
  });
  const [org] = await database.q<{ id: string }>(
    `select id from orgs where name = 'Kestrel Build Group'`,
  );
  ORG = org!.id;
  const [site] = await database.q<{ id: string }>(
    `select id from sites where project_code = 'RL-2041'`,
  );
  RIVERSIDE = site!.id;
  RECIPIENTS = (
    await database.q<{ email: string }>(
      `select email from site_recipients where site_id = $1 order by email`,
      [RIVERSIDE],
    )
  ).map((r) => r.email);
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await database?.close();
});

/** WhatsApp sends to `to` since the event index `mark` (kind, body, buttons, clock time). */
function sentSince(mark: number, to = MARCO): WaEvent[] {
  return world.wa.events.slice(mark).filter((e) => e.to === to);
}

async function jobsSince(id: number) {
  return database.q<{
    id: number;
    type: string;
    status: string;
    attempts: number;
    last_error: string | null;
  }>(
    `select id, type, status::text as status, attempts, last_error from jobs where id > $1 order by id`,
    [id],
  );
}

async function maxJobId(): Promise<number> {
  const [r] = await database.q<{ id: number | null }>(`select max(id)::int as id from jobs`);
  return r?.id ?? 0;
}

/** The database's wall clock (outbound messages.created_at uses it, not the virtual clock). */
async function dbMark(): Promise<Date> {
  const [r] = await database.q<{ t: Date }>(`select clock_timestamp() as t`);
  return r!.t;
}

/** payload.kind of Marco's outbound messages stored since `since`, in order. */
async function outboundKinds(since: Date): Promise<string[]> {
  const rows = await database.q<{ kind: string | null }>(
    `select m.payload->>'kind' as kind from messages m join conversations c on c.id = m.conversation_id
     where c.phone_e164 = $1 and m.direction = 'out' and m.created_at >= $2 order by m.created_at, m.id`,
    [MARCO, since],
  );
  return rows.map((r) => r.kind ?? '?');
}

/** Marco sends the hero voice note (+ a photo 5 s later) for the clock's day. */
async function sendHeroNote(tag: string) {
  world.registerVoiceNote(`media-${tag}-audio`, HERO, 168);
  world.registerPhoto(`media-${tag}-photo`);
  const audio = readdress(webhookFixture('audio-note.json'), {
    from: MARCO,
    id: `wamid.it.${tag}.audio`,
    at: clock.now(),
    mediaId: `media-${tag}-audio`,
  });
  const a = await world.deliver(audio);
  clock.advance(5_000);
  const photo = readdress(webhookFixture('image-with-caption.json'), {
    from: MARCO,
    id: `wamid.it.${tag}.photo`,
    at: clock.now(),
    mediaId: `media-${tag}-photo`,
  });
  const p = await world.deliver(photo);
  return { audio, a, p };
}

describe('integration: webhook → worker → outbound (real database, faked outside world)', () => {
  it('A · F5→F7: voice note + photo → ack → progress → draft → "OK, file it" → filed, PDF, email', async () => {
    const startedAt = await dbMark();
    const jobMark = await maxJobId();
    const waMark = world.wa.events.length;
    const claudeMark = world.claude.calls.length;
    const runner = world.runner();

    // The scheduler fetched today's weather earlier in the day (Open-Meteo faked).
    vi.stubGlobal(
      'fetch',
      fakeWeatherFetch(
        openMeteoResponse(
          '2026-10-13',
          lib.get(HERO).fixture.input.observedWeather as unknown as SiteDayWeather,
        ),
      ),
    );
    await world.db.enqueueJob(
      'fetch_weather',
      { siteId: RIVERSIDE, date: '2026-10-13' },
      { dedupeKey: `weather:${RIVERSIDE}:2026-10-13:16:55` },
    );
    await drainQueue(runner);
    vi.unstubAllGlobals();

    const { audio, a, p } = await sendHeroNote('A');
    heroAudio = audio;
    expect(a).toMatchObject({ status: 200, body: { ok: true, stored: 1, duplicates: 0 } });
    expect(p).toMatchObject({ status: 200, body: { ok: true, stored: 1 } });

    await drainQueue(runner);

    // Ack → photo merged → progress bubble (transcription took 12 s) → draft card with OK / Fix.
    const beforeOk = sentSince(waMark);
    expect(beforeOk.map((e) => e.kind)).toEqual(['text', 'text', 'text', 'buttons']);
    expect(beforeOk[0]!.body).toMatch(/^Got it, Marco — 2 min 48 s\.$/);
    expect(beforeOk[2]!.body).toMatch(/^Writing your report…/);
    const draft = beforeOk[3]!;
    expect(draft.body).toMatch(/^```\nDRAFT · TUE OCT 13\n/);
    const [report] = await database.q<{
      id: string;
      report_no: string;
      status: string;
      received_at: string;
    }>(
      `select r.id, r.report_no, r.status::text as status, r.received_at from reports r
       join site_days sd on sd.id = r.site_day_id where sd.site_id = $1 and sd.date = '2026-10-13'`,
      [RIVERSIDE],
    );
    expect(report).toBeDefined();
    expect(report!.status).toBe('awaiting_confirmation');
    expect(report!.report_no).toMatch(/^RL-2041-\d{4}$/);
    expect(draft.buttons).toEqual([
      { id: `draft:${report!.id}:ok`, title: 'OK, file it' },
      { id: `draft:${report!.id}:fix`, title: expect.any(String) },
    ]);
    // §15: draft within 90 s of the note (virtual time: 12 s transcription + 20 s extraction).
    expect(draft.at.getTime() - new Date(report!.received_at).getTime()).toBeLessThan(90_000);
    expect(await outboundKinds(startedAt)).toEqual(['ack', 'merged', 'progress', 'draft']);

    // Marco taps "OK, file it" on the draft.
    clock.advance(30_000);
    const ok = await world.deliver(
      buttonReplyPayload(
        { id: `draft:${report!.id}:ok`, title: 'OK, file it' },
        { from: MARCO, id: 'wamid.it.A.ok', at: clock.now(), contextId: draft.waMessageId },
      ),
    );
    expect(ok).toMatchObject({ status: 200, body: { stored: 1 } });
    const okAt = clock.now();
    await drainQueue(runner);

    // "Filed." → the PDF as a document → the edit hint.
    const afterOk = sentSince(waMark).slice(beforeOk.length);
    expect(afterOk.map((e) => e.kind)).toEqual(['text', 'document', 'text']);
    expect(afterOk[0]!.body).toBe(
      `Filed. Daily Report ${report!.report_no} is with the office. Thanks, Marco — that's it for today.`,
    );
    expect(afterOk[1]!.filename).toBe(`${report!.report_no}_2026-10-13_v1.pdf`);
    expect(afterOk[2]!.body).toMatch(/^Need a change later\? Reply "edit Tuesday"/);
    expect(afterOk[1]!.at.getTime() - okAt.getTime()).toBeLessThan(60_000); // F7: PDF within 60 s

    // Report filed, version 1 frozen with the PDF path, denormalised rows written.
    const [filed] = await database.q<{
      status: string;
      current_version: number;
      filed_at: string;
      confirmed_at: string | null;
      is_late: boolean;
      needs_review: boolean;
      review_reasons: string[];
    }>(
      `select status::text as status, current_version, filed_at, confirmed_at, is_late, needs_review, review_reasons
       from reports where id = $1`,
      [report!.id],
    );
    expect(filed).toMatchObject({
      status: 'filed',
      current_version: 1,
      is_late: false,
      needs_review: false,
      review_reasons: [],
    });
    expect(filed!.confirmed_at).not.toBeNull();
    const versions = await database.q<{
      version: number;
      author: string;
      pdf_path: string | null;
      data: DailyReportDataV1;
    }>(
      `select version, author::text as author, pdf_path, data from report_versions where report_id = $1`,
      [report!.id],
    );
    expect(versions).toHaveLength(1);
    const v1 = versions[0]!;
    expect(v1.author).toBe('agent');
    expect(v1.pdf_path).toBe(`${ORG}/${RIVERSIDE}/${report!.report_no}_v1.pdf`);
    expect(v1.data.reportDate).toBe('2026-10-13');
    expect(v1.data.missingRequired).toEqual([]);
    expect(v1.data.photos).toHaveLength(1);
    expect(v1.data.weather.observed).toBeTruthy(); // from the site-day weather the scheduler fetched
    expect(world.storage.files.has(`pdfs/${v1.pdf_path}`)).toBe(true);
    expect(world.storage.files.get(`pdfs/${v1.pdf_path}`)!.body.subarray(0, 5).toString()).toBe(
      '%PDF-',
    );

    const manpower = await database.q<{ company: string; workers: number; total_hours: number }>(
      `select c.name as company, me.workers, me.hours::float8 as total_hours
       from manpower_entries me left join companies c on c.id = me.company_id
       where me.report_id = $1 and me.version = 1 order by c.name`,
      [report!.id],
    );
    expect(manpower.length).toBe(v1.data.manpower.length);
    expect(manpower.find((m) => m.company === 'Delta Mechanical')).toMatchObject({
      workers: 4,
      total_hours: 32,
    });
    expect(manpower.every((m) => m.company)).toBe(true); // every crew resolved to a seed company
    // The rain delay is claim-ready: voice-note source + a photo + the observed weather (§F16).
    const weather = await database.q<{
      start_local: string;
      lost_hours: number;
      claim_ready: boolean;
    }>(
      `select start_local::text as start_local, lost_hours::float8 as lost_hours, claim_ready
       from weather_events where report_id = $1 and version = 1`,
      [report!.id],
    );
    expect(weather).toEqual([{ start_local: '07:00:00', lost_hours: 3.5, claim_ready: true }]);
    const [work] = await database.q<{ n: number }>(
      `select count(*)::int as n from work_items where report_id = $1 and version = 1`,
      [report!.id],
    );
    expect(work!.n).toBe(v1.data.workPerformed.length);

    const [day] = await database.q<{ status: string; report_id: string; has_weather: boolean }>(
      `select status::text as status, report_id, weather is not null as has_weather from site_days
       where site_id = $1 and date = '2026-10-13'`,
      [RIVERSIDE],
    );
    expect(day).toEqual({ status: 'filed', report_id: report!.id, has_weather: true });

    const [convo] = await database.q<{ state: string; context: Record<string, unknown> }>(
      `select state::text as state, context from conversations where phone_e164 = $1`,
      [MARCO],
    );
    expect(convo!.state).toBe('idle');
    expect(convo!.context.last_filed_report_id).toBe(report!.id);

    // report_filed email to the site recipients, with the PDF attached.
    const mail = world.emails.at(-1)!;
    expect(mail.to).toEqual(RECIPIENTS);
    expect(mail.subject).toContain(report!.report_no);
    expect(mail.attachments?.map((x) => x.filename)).toEqual([
      `${report!.report_no}_2026-10-13_v1.pdf`,
    ]);

    // Audit trail of the state changes.
    const audit = await database.q<{ action: string }>(
      `select action from audit_log where entity_id = $1 order by id`,
      [report!.id],
    );
    expect(audit.map((x) => x.action)).toEqual([
      'report.created',
      'report.extracted',
      'report.draft_sent',
      'report.filed',
      'report.pdf_rendered',
    ]);

    // The real runner ran every job once, in queue order, with nothing failed or dead.
    const jobs = await jobsSince(jobMark);
    expect(jobs.map((j) => j.type)).toEqual([
      'fetch_weather',
      'inbound_message',
      'inbound_message',
      'transcribe_audio',
      'extract_report',
      'decide_next',
      'inbound_message',
      'file_report',
      'render_pdf',
      'send_email',
    ]);
    expect(jobs.every((j) => j.status === 'done' && j.attempts === 1)).toBe(true);

    // Inbound rows were routed exactly once; the model was called once and never saw a phone number.
    const inbound = await database.q<{ status: string }>(
      `select status::text as status from messages where wa_message_id like 'wamid.it.A.%'`,
    );
    expect(inbound.map((m) => m.status)).toEqual(['read', 'read', 'read']);
    expect(world.claude.calls.slice(claudeMark).map((c) => c.tool)).toEqual([
      'submit_daily_report',
    ]);
    expect(world.claude.phoneLeaks).toEqual([]);
  });

  it('B · F6: a missing headcount → one question with buttons → free-text answer → draft → "ok" → filed', async () => {
    completeHero = false;
    clock.set(new Date('2026-10-14T21:40:00Z'));
    const startedAt = await dbMark();
    const waMark = world.wa.events.length;
    const claudeMark = world.claude.calls.length;
    const jobMark = await maxJobId();
    const runner = world.runner();

    await sendHeroNote('B');
    await drainQueue(runner);

    const asked = sentSince(waMark);
    expect(asked.map((e) => e.kind)).toEqual(['text', 'text', 'text', 'buttons']);
    const question = asked[3]!;
    expect(question.body).toContain("you said 'the Delta guys' were on Level 2");
    const [q] = await database.q<{
      id: string;
      field: string;
      target: { path: string };
      report_id: string;
      asked_message_id: string | null;
    }>(
      `select q.id, q.field, q.target, q.report_id, q.asked_message_id from questions q
       join reports r on r.id = q.report_id join site_days sd on sd.id = r.site_day_id
       where sd.site_id = $1 and sd.date = '2026-10-14'`,
      [RIVERSIDE],
    );
    expect(q).toMatchObject({
      field: 'manpower.workers',
      target: { path: 'manpower.workers:Delta Mechanical' },
    });
    expect(q!.asked_message_id).not.toBeNull();
    expect(question.buttons).toEqual([
      { id: `q:${q!.id}:0`, title: '4 · full day' },
      { id: `q:${q!.id}:1`, title: '5 · full day' },
      { id: `q:${q!.id}:other`, title: 'Other…' },
    ]);
    const [waiting] = await database.q<{ state: string; context: Record<string, unknown> }>(
      `select state::text as state, context from conversations where phone_e164 = $1`,
      [MARCO],
    );
    expect(waiting!.state).toBe('awaiting_answer');
    expect(waiting!.context.pending_question_id).toBe(q!.id);
    const [r1] = await database.q<{ status: string }>(
      `select status::text as status from reports where id = $1`,
      [q!.report_id],
    );
    expect(r1!.status).toBe('awaiting_answer');

    // Marco types an answer the quick parser cannot read (no number in it), so the fast model
    // classifies it (answer) and parses it: replies.json parse_answer "delta-5-full-day".
    clock.advance(45_000);
    await world.deliver(
      textPayload('Jim and his usual crew from Delta, the whole shift', {
        from: MARCO,
        id: 'wamid.it.B.answer',
        at: clock.now(),
      }),
    );
    await drainQueue(runner);
    const answered = sentSince(waMark).slice(asked.length);
    expect(answered.map((e) => e.kind)).toEqual(['text', 'buttons']);
    expect(answered[0]!.body).toBe('Thanks — Delta Mechanical: 5 workers × 8 h = 40 h.');
    expect(answered[1]!.body).toMatch(/^```\nDRAFT · WED OCT 14\n/);
    expect(answered[1]!.buttons?.[0]).toEqual({
      id: `draft:${q!.report_id}:ok`,
      title: 'OK, file it',
    });
    const [qa] = await database.q<{ answered_at: string | null; answer: Record<string, unknown> }>(
      `select answered_at, answer from questions where id = $1`,
      [q!.id],
    );
    expect(qa!.answered_at).not.toBeNull();
    expect(qa!.answer).toMatchObject({ workers: 5, fullDay: true, via: 'text' });

    // "ok" as text files it (§9.5 confirm words, no model call).
    clock.advance(20_000);
    await world.deliver(textPayload('ok', { from: MARCO, id: 'wamid.it.B.ok', at: clock.now() }));
    await drainQueue(runner);
    const filedMsgs = sentSince(waMark).slice(asked.length + answered.length);
    expect(filedMsgs.map((e) => e.kind)).toEqual(['text', 'document', 'text']);

    const [filed] = await database.q<{ status: string; review_reasons: string[] }>(
      `select status::text as status, review_reasons from reports where id = $1`,
      [q!.report_id],
    );
    expect(filed).toEqual({ status: 'filed', review_reasons: [] });
    const [delta] = await database.q<{ workers: number; total_hours: number }>(
      `select me.workers, me.hours::float8 as total_hours from manpower_entries me
       join companies c on c.id = me.company_id where me.report_id = $1 and c.name = 'Delta Mechanical'`,
      [q!.report_id],
    );
    expect(delta).toEqual({ workers: 5, total_hours: 40 });
    expect(await outboundKinds(startedAt)).toEqual([
      'ack',
      'merged',
      'progress',
      'question',
      'answer_ack',
      'draft',
      'filed',
      'pdf',
      'edit_hint',
    ]);
    expect(world.claude.calls.slice(claudeMark).map((c) => c.tool)).toEqual([
      'submit_daily_report',
      'classify_reply',
      'parse_answer',
    ]);
    const jobs = await jobsSince(jobMark);
    expect(jobs.every((j) => j.status === 'done' && j.attempts === 1)).toBe(true);
    expect(world.claude.phoneLeaks).toEqual([]);
  });

  it('C · duplicate delivery is ignored, bad signatures are refused, statuses apply, unknown senders are held', async () => {
    clock.set(new Date('2026-10-14T22:30:00Z'));
    const jobMark = await maxJobId();
    const waMark = world.wa.events.length;
    const runner = world.runner();
    const [counts] = await database.q<{ messages: number }>(
      `select count(*)::int as messages from messages`,
    );

    // Meta redelivers scenario A's voice note: same wamid → no message, no job.
    const dup = await world.deliver(heroAudio);
    expect(dup).toMatchObject({ status: 200, body: { ok: true, stored: 0, duplicates: 1 } });
    // A body signed with the wrong secret never reaches the database.
    const forged = await world.deliver(
      readdress(heroAudio, { id: 'wamid.it.C.forged', at: clock.now() }),
      { signWith: 'not-the-app-secret' },
    );
    expect(forged.status).toBe(401);
    expect(await jobsSince(jobMark)).toEqual([]);
    const [after] = await database.q<{ messages: number }>(
      `select count(*)::int as messages from messages`,
    );
    expect(after!.messages).toBe(counts!.messages);

    // A delivery status for scenario A's draft moves the outbound row forward (sent → delivered).
    const [draftRow] = await database.q<{ wa_message_id: string }>(
      `select wa_message_id from messages where payload->>'kind' = 'draft' and direction = 'out'
       order by created_at limit 1`,
    );
    const status = webhookFixture('status-update.json');
    const st = (status.entry[0]!.changes[0]!.value.statuses as Array<Record<string, unknown>>)[0]!;
    st.id = draftRow!.wa_message_id;
    const s = await world.deliver(status);
    expect(s).toMatchObject({ status: 200, body: { statuses: 1 } });
    const [delivered] = await database.q<{ status: string }>(
      `select status::text as status from messages where wa_message_id = $1`,
      [draftRow!.wa_message_id],
    );
    expect(delivered!.status).toBe('delivered');

    // An unknown number: held in unknown_senders, one reply, nothing filed.
    const hello = await world.deliver(
      textPayload('Hi, this is Dave from Ridgeway Roofing, where do I send the daily report?', {
        from: STRANGER,
        id: 'wamid.it.C.stranger.1',
        at: clock.now(),
      }),
    );
    expect(hello).toMatchObject({ status: 200, body: { stored: 1 } });
    await drainQueue(runner);
    clock.advance(60_000);
    await world.deliver(
      textPayload('Hello?', { from: STRANGER, id: 'wamid.it.C.stranger.2', at: clock.now() }),
    );
    await drainQueue(runner);

    const [convo] = await database.q<{
      id: string;
      org_id: string | null;
      reporter_id: string | null;
    }>(`select id, org_id, reporter_id from conversations where phone_e164 = $1`, [STRANGER]);
    expect(convo).toMatchObject({ org_id: null, reporter_id: null });
    const unknown = await database.q<{ status: string; snippet: string | null; first: string }>(
      `select us.status::text as status, us.snippet, m.wa_message_id as first from unknown_senders us
       join messages m on m.id = us.first_message_id where us.phone_e164 = $1`,
      [STRANGER],
    );
    expect(unknown).toEqual([
      {
        status: 'pending',
        snippet: 'Hi, this is Dave from Ridgeway Roofing, where do I send the daily report?',
        first: 'wamid.it.C.stranger.1',
      },
    ]);
    const replies = sentSince(waMark, STRANGER);
    expect(replies.map((e) => e.kind)).toEqual(['text']);
    expect(replies[0]!.body).toContain("isn't set up with SiteLog yet");
    const [reports] = await database.q<{ n: number }>(
      `select count(*)::int as n from reports r join conversations c on c.reporter_id = r.reporter_id
       where c.phone_e164 = $1`,
      [STRANGER],
    );
    expect(reports!.n).toBe(0);
    const jobs = await jobsSince(jobMark);
    expect(jobs.map((j) => `${j.type}:${j.status}`)).toEqual([
      'inbound_message:done',
      'inbound_message:done',
    ]);
  });
});
