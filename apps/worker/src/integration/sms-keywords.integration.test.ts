import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  emptyReportData,
  jobKeys,
  readReportData,
  resolveDayReference,
  type DailyReportData,
  type JobRow,
  type StoredReportData,
} from '@sitelog/shared';
import { runJob } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { createSim, loadFixtureLibrary, manualClock, NO_LATENCY } from './fakes';
import { createWorld, type World } from './world';

/**
 * W2-12 (§9.5 report keywords, F10 and F12 by SMS) on a real database (PGlite, every migration and
 * the §18 seed): texts from Marco's phone on the Kestrel demo org (a two-way US pack), as the Demo
 * phone stores them (`messages`, provider console, the pack in the payload), answered by the real
 * `sms_keyword` job. WEATHER after R1 answers with the day sheet's link and leaves the day as it
 * is; OK with the open draft's link and nothing confirmed (§19 Q82); "EDIT FRI Apex was 7 not 6"
 * (classify_utterance from fixtures/utterances, apply_correction from the recorded output) answers
 * with the change and a confirm link, and Save change on the recorder makes version 2 (W2-11). An
 * EDIT with no day, a consent turned off, a phone that opted out and a one-way pack: no change.
 */

const TZ = 'America/Chicago';
let database: PgliteDatabase;
let world: World;
let MARCO = '';
let RIVERSIDE = '';
let ORG = '';
let PHONE = '';

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  // The database's clock is the wall clock: the worker's too, so "today" is one day.
  const clock = manualClock(new Date());
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim: createSim({ advance: clock, profile: NO_LATENCY }),
    lib: loadFixtureLibrary(['riverside-2026-10-09']),
    config: { CLAUDE_MODEL: 'claude-test' },
  });
  const [marco] = await database.q<{ id: string; org_id: string; phone_e164: string }>(
    `select id, org_id, phone_e164 from reporters where name = 'Marco Ruiz'`,
  );
  MARCO = marco!.id;
  ORG = marco!.org_id;
  PHONE = marco!.phone_e164;
  RIVERSIDE = (
    await database.q<{ id: string }>(`select id from sites where project_code = 'RL-2041'`)
  )[0]!.id;
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

async function byKey(key: string) {
  const [job] = await database.q<{ id: number }>(`select id from jobs where dedupe_key = $1`, [
    key,
  ]);
  expect(job, key).toBeDefined();
  return job!.id;
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

/** A text from Marco's phone as the Demo phone stores it; its sms_keyword job is run. */
async function text(body: string, opts: { pack?: string; run?: boolean } = {}) {
  const id = randomUUID();
  await database.q(
    `insert into messages (id, org_id, reporter_id, channel, phone_e164, direction, provider,
                           provider_message_id, body, status, payload)
     values ($1, $2, $3, 'sms', $4, 'in', 'console', $5, $6, 'received', $7)`,
    [
      id,
      ORG,
      MARCO,
      PHONE,
      `console:${id}`,
      body,
      JSON.stringify({ to: 'console', keyword: null, pack: opts.pack ?? 'US', opt_out_type: null }),
    ],
  );
  const jobId = await world.ctx.db.enqueueJob(
    'sms_keyword',
    { messageId: id },
    { dedupeKey: jobKeys.smsKeyword(id) },
  );
  if (opts.run !== false) expect(await run(jobId)).toEqual({ ok: true });
  return id;
}

/** The replies sent to Marco's phone after `since` (the Demo phone's thread). */
async function replies(since: string) {
  return database.q<{ copy_key: string; body: string }>(
    `select copy_key, body from messages where phone_e164 = $1 and direction = 'out'
       and created_at > $2 order by created_at, id`,
    [PHONE, since],
  );
}

const stamp = async () =>
  (await database.q<{ t: string }>(`select clock_timestamp()::text as t`))[0]!.t;

async function answered(messageId: string) {
  return database.q<{ diff: Record<string, unknown> }>(
    `select diff from audit_log where action = 'sms.keyword_answered' and entity_id = $1`,
    [messageId],
  );
}

/** Today at Riverside, as the ladder leaves it after R1 (no report yet). */
async function remindedToday() {
  await database.q(`delete from site_days where site_id = $1 and date = $2`, [RIVERSIDE, today()]);
  const [day] = await database.q<{ id: string }>(
    `insert into site_days (site_id, date, status, deadline_at, reminder_stage)
     values ($1, $2, 'reminded', ($2::date + time '17:30') at time zone '${TZ}', 1) returning id`,
    [RIVERSIDE, today()],
  );
  return day!.id;
}

const crew = (date: string, workers: number): DailyReportData => ({
  ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
  summary: 'Slab pour on Level 4.',
  manpower: [
    {
      companyId: null,
      companyNameHeard: 'Apex',
      companyName: 'Apex Concrete',
      workers,
      hoursPerWorker: 8,
      totalHours: workers * 8,
      hoursBasis: 'full_day_default',
      confidence: 0.95,
      source: [],
    },
  ],
});

/** A filed web report of `date` at Riverside by Marco (version 1: Apex 6 × 8 h). */
async function filedReport(date: string) {
  await database.q(`delete from site_days where site_id = $1 and date = $2`, [RIVERSIDE, date]);
  const [day] = await database.q<{ id: string }>(
    `insert into site_days (site_id, date, status, deadline_at)
     values ($1, $2, 'filed', ($2::date + time '17:30') at time zone '${TZ}') returning id`,
    [RIVERSIDE, date],
  );
  const [report] = await database.q<{ id: string }>(
    `insert into reports (org_id, site_id, site_day_id, report_no, status, kind, current_version,
                          reporter_id, received_at, filed_at, confirmed_at, confirmed_via, channel, language)
     values ($1, $2, $3, next_report_no($2), 'filed', 'daily', 1, $4, now(), now(), now(), 'web', 'web', 'en')
     returning id`,
    [ORG, RIVERSIDE, day!.id, MARCO],
  );
  await database.q(
    `insert into report_versions (report_id, version, data, summary, author) values ($1, 1, $2, $3, 'agent')`,
    [report!.id, JSON.stringify({ ...crew(date, 6), photos: [] }), 'Slab pour on Level 4.'],
  );
  await database.q(`select denormalize_report_version($1, 1)`, [report!.id]);
  await database.q(`update site_days set report_id = $1 where id = $2`, [report!.id, day!.id]);
  return report!.id;
}

describe('SMS report keywords (W2-12) on the Demo phone of a two-way demo org', () => {
  it('WEATHER after R1 answers with the day sheet link; the day stays as it was', async () => {
    const dayId = await remindedToday();
    const since = await stamp();
    const id = await text('WEATHER');
    const sent = await replies(since);
    const riverside = sent.find((m) => m.body.includes('Riverside'));
    expect(riverside?.copy_key).toBe('day_off_link');
    expect(riverside!.body).toMatch(
      /^Add the details for Riverside[^:]* today: https:\/\/go\.sitelog\.test\/r\/[A-Z2-9]+$/,
    );
    // The day sheet's link is today's daily link of the site, made once.
    const links = await database.q<{ n: number }>(
      `select count(*)::int as n from field_links where reporter_id = $1 and kind = 'daily'
         and site_id = $2 and report_date = $3`,
      [MARCO, RIVERSIDE, today()],
    );
    expect(links[0]!.n).toBe(1);
    expect(
      (
        await database.q<{ status: string }>(`select status from site_days where id = $1`, [dayId])
      )[0]!.status,
    ).toBe('reminded');
    const [audit] = await answered(id);
    expect(audit!.diff).toMatchObject({ keyword: 'weather', outcome: 'day_off_link' });
    expect(audit!.diff.site_ids).toContain(RIVERSIDE);

    // NO WORK again: the same link (ensureDailyLink), no second row.
    const again = await stamp();
    await text('no work');
    const second = (await replies(again)).find((m) => m.body.includes('Riverside'))!;
    expect(second.body).toBe(riverside!.body);
    expect(
      (
        await database.q<{ n: number }>(
          `select count(*)::int as n from field_links where reporter_id = $1 and kind = 'daily'
             and site_id = $2 and report_date = $3`,
          [MARCO, RIVERSIDE, today()],
        )
      )[0]!.n,
    ).toBe(1);
  }, 60_000);

  it('OK confirms nothing and answers with the open draft link (spec §19 Q82)', async () => {
    const dayId = await remindedToday();
    const [draft] = await database.q<{ id: string }>(
      `insert into reports (org_id, site_id, site_day_id, report_no, status, kind, current_version,
                            reporter_id, received_at, channel, language)
       values ($1, $2, $3, next_report_no($2), 'awaiting_confirmation', 'daily', 1, $4, now(), 'web', 'en')
       returning id`,
      [ORG, RIVERSIDE, dayId, MARCO],
    );
    const since = await stamp();
    const id = await text('ok');
    const sent = await replies(since);
    expect(sent.map((m) => m.copy_key)).toContain('draft_ready');
    expect(sent.find((m) => m.body.includes(draft!.id))!.body).toMatch(
      new RegExp(
        `^Your report is ready to check: https://go\\.sitelog\\.test/r/[A-Z2-9]+/report/${draft!.id}$`,
      ),
    );
    const [row] = await database.q<{ status: string; confirmed_at: string | null }>(
      `select status::text, confirmed_at from reports where id = $1`,
      [draft!.id],
    );
    expect(row).toEqual({ status: 'awaiting_confirmation', confirmed_at: null });
    expect(
      await database.q(
        `select 1 from jobs where type = 'file_report' and payload->>'reportId' = $1`,
        [draft!.id],
      ),
    ).toEqual([]);
    expect((await answered(id))[0]!.diff).toMatchObject({ keyword: 'ok', outcome: 'draft_link' });

    // With the draft gone, WEATHER skips Riverside (a live report there) and OK says nothing.
    const later = await stamp();
    await database.q(`update reports set status = 'void' where id = $1`, [draft!.id]);
    await database.q(
      `insert into reports (org_id, site_id, site_day_id, report_no, status, kind, current_version,
                            reporter_id, received_at, channel, language)
       values ($1, $2, $3, next_report_no($2), 'processing', 'daily', 1, $4, now(), 'web', 'en')`,
      [ORG, RIVERSIDE, dayId, MARCO],
    );
    await text('WEATHER');
    const ok = await text('OK');
    const after = await replies(later);
    expect(after.filter((m) => m.body.includes('Riverside'))).toEqual([]);
    expect(after.map((m) => m.copy_key)).not.toContain('draft_ready');
    expect((await answered(ok))[0]!.diff).toMatchObject({ outcome: 'no_draft' });
  }, 60_000);

  it('"EDIT FRI Apex was 7 not 6" answers with the change and a confirm link; Save change makes version 2', async () => {
    const date = resolveDayReference('FRI', new Date(), TZ)!;
    const reportId = await filedReport(date);
    const since = await stamp();
    const id = await text('EDIT FRI Apex was 7 not 6');
    expect(world.claude.calls.filter((c) => c.tool === 'classify_utterance').at(-1)).toEqual({
      tool: 'classify_utterance',
      fixtureId: 'en-edit-fri-apex',
    });
    const [c] = await database.q<{ id: string; text: string; message_id: string; status: string }>(
      `select id, text, message_id, status from draft_corrections where report_id = $1`,
      [reportId],
    );
    expect(c).toMatchObject({ text: 'Apex was 7 not 6', message_id: id, status: 'listening' });
    // Nothing is texted until the preview is made.
    expect(await replies(since)).toEqual([]);
    expect(await run(await byKey(`correction:${c!.id}`))).toEqual({ ok: true });
    expect(await run(await byKey(jobKeys.smsEditPreview(id, c!.id)))).toEqual({ ok: true });
    const sent = await replies(since);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.copy_key).toBe('edit_preview');
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(`${date}T12:00:00Z`),
    );
    expect(sent[0]!.body).toMatch(
      new RegExp(
        `^${weekday}: Apex Concrete 6 -> 7 workers, 48 -> 56 h\\? Confirm here: https://go\\.sitelog\\.test/r/[A-Z2-9]+/history/${reportId}$`,
      ),
    );
    // Not applied: the report is still version 1 until Save change on the recorder.
    const [before] = await database.q<{ v: number }>(
      `select current_version as v from reports where id = $1`,
      [reportId],
    );
    expect(before!.v).toBe(1);

    // Save change (field-api's reports/:id/correction/:cid/apply) makes version 2 (W2-11).
    const [saved] = await database.q<{ r: { status: string; version: number } }>(
      `select field_save_filed_correction($1, $2, $3, $4, $5) as r`,
      [
        c!.id,
        reportId,
        MARCO,
        'Apex Concrete 6 → 7 workers, 48 → 56 h',
        JSON.stringify({ weekday, change: 'Apex Concrete 6 -> 7 workers, 48 -> 56 h' }),
      ],
    );
    expect(saved!.r).toMatchObject({ status: 'applied', version: 2 });
    const [v2] = await database.q<{ data: StoredReportData }>(
      `select data from report_versions where report_id = $1 and version = 2`,
      [reportId],
    );
    const apex = readReportData(v2!.data).manpower[0]!;
    expect([apex.workers, apex.totalHours]).toEqual([7, 56]);
    // §19 Q80: the typed change cites the reporter, via SMS.
    expect(apex.source).toContainEqual(
      expect.objectContaining({ type: 'reporter_edit', reporterId: MARCO, via: 'sms' }),
    );
    expect((await answered(id)).map((a) => a.diff.outcome)).toEqual([
      'correction_requested',
      'preview',
    ]);
  }, 60_000);

  it('a retry after the settle queues the preview the first run could not (W2-12 review)', async () => {
    const date = resolveDayReference('THU', new Date(), TZ)!;
    await filedReport(date);
    const id = await text('EDIT THU Apex was 8 not 6');
    const [c] = await database.q<{ id: string }>(
      `select id from draft_corrections where message_id = $1`,
      [id],
    );
    // The settle committed, but the preview's job was never queued (its enqueue failed).
    await database.q(`select field_settle_correction($1, 'unclear', '{"reason":"silent"}')`, [
      c!.id,
    ]);
    const key = jobKeys.smsEditPreview(id, c!.id);
    expect(await database.q(`select 1 from jobs where dedupe_key = $1`, [key])).toHaveLength(0);
    // The retry of apply_correction finds it settled and queues the preview's job.
    expect(await run(await byKey(`correction:${c!.id}`))).toEqual({ ok: true });
    const since = await stamp();
    expect(await run(await byKey(key))).toEqual({ ok: true });
    expect((await replies(since)).map((r) => r.copy_key)).toEqual(['edit_unclear']);
  }, 60_000);

  it('an EDIT with no day, or with a consent turned off, changes nothing and points to Past reports', async () => {
    const since = await stamp();
    const id = await text('EDIT Apex was 7');
    const sent = await replies(since);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.copy_key).toBe('edit_unclear');
    expect(sent[0]!.body).toMatch(
      /^I couldn't make that change by text\. Make it in Past reports: https:\/\/go\.sitelog\.test\/r\/[A-Z2-9]+\/history$/,
    );
    expect((await answered(id))[0]!.diff).toMatchObject({ keyword: 'edit', outcome: 'no_day' });
    // A name that starts like a day ("Friedman", "Sunbelt") names no day (W2-12 review).
    const name = await text('EDIT Friedman 4 not 3');
    expect((await answered(name))[0]!.diff).toMatchObject({ keyword: 'edit', outcome: 'no_day' });

    // §19 Q95: a processing consent turned off sends nothing to the model.
    const live = await database.q<{ id: string }>(
      `update consents set revoked_at = now()
        where reporter_id = $1 and type = 'data_processing' and revoked_at is null returning id`,
      [MARCO],
    );
    if (live.length === 0)
      live.push(
        ...(await database.q<{ id: string }>(
          `insert into consents (reporter_id, type, method, text_version, given_at, revoked_at)
           values ($1, 'data_processing', 'web_checkbox', 'v1', now() - interval '1 day', now())
           returning id`,
          [MARCO],
        )),
      );
    try {
      const calls = world.claude.calls.length;
      const off = await text('EDIT FRI Apex was 9 not 6');
      expect(world.claude.calls.length).toBe(calls);
      expect((await answered(off))[0]!.diff).toMatchObject({ outcome: 'consent_revoked' });
    } finally {
      await database.q(`update consents set revoked_at = null where id = any($1::uuid[])`, [
        live.map((r) => r.id),
      ]);
    }
  }, 60_000);

  it('a phone that opted out, or a one-way pack, gets no answer', async () => {
    await remindedToday();
    const since = await stamp();
    await text('WEATHER', { pack: 'TR' });
    await database.q(
      `update reporters set status = 'opted_out', opted_out_at = now() where id = $1`,
      [MARCO],
    );
    try {
      await text('WEATHER');
      await text('EDIT FRI Apex was 7 not 6');
    } finally {
      await database.q(
        `update reporters set status = 'active', opted_out_at = null where id = $1`,
        [MARCO],
      );
    }
    expect(await replies(since)).toEqual([]);
  }, 60_000);
});
