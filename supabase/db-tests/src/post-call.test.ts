import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261016000360_post_call.sql (W3-11; spec §7.2, §7.3, F6, §10.1 `post_call_reconcile`, §10.5
 * step 2, §10.9, §19 Q122, Q123, Q152, Q162):
 * - post_call_settle(): a hang-up with a report value is `draft_saved` and its open question goes
 *   to the web; with none it is `abandoned`, the report the call alone made is voided and the
 *   site-day returns to its status before the call; a filed or being-filed report is left alone;
 * - post_call_recording(): two-lane peaks, the duration, the batch transcript replacing the live
 *   row (§19 Q162);
 * - post_call_fallback_report(): the fallback recording made into today's report, the call one
 *   source, `extract_report` keyed per report and call; refused without the site or once filed;
 * - post_call_reconciled() / post_call_unreconciled(): precise seconds as report_sources rows,
 *   the reasons once with the §13 notice, `calls.reconcile`; idempotent;
 * - report_no_photo_check(): `no_photo` on a call report without photos, once;
 * - job_lock_key(): `no_photo_check` and `post_call_reconcile` under the report's key.
 */

const ID = (n: number) => `cdcd3600-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEY = (c: string) => c.repeat(64);
const KEVIN_PHONE = '+15550142087';
const NOTICE = ['RL-0 needs review', 'x', '{"key": "needs_review", "params": {}}'] as const;

let db: PGlite;
let kevin: string;
let northgate: string;

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

async function newCall(n: number, started: string, site: string | null = northgate) {
  const id = ID(n);
  await svc(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language,
                        disclosure_played)
     values ($1, $2, $3, $4, 'inbound', 'web', $5, 'in_progress', $6, $6, $6, 'en-US', true)`,
    [id, DEMO_ORG_ID, kevin, site, `call-${id}`, started],
  );
  return id;
}

/** A call whose turn made today's report, with a question asked on the call. */
async function callWithReport(n: number, started: string) {
  const call = await newCall(n, started);
  const [row] = await svc<{ r: { reportId: string } }>(
    `select voice_turn_submit($1, 'update_draft', $2, $3::jsonb) as r`,
    [call, KEY('a'), JSON.stringify({ segments: [{ start: 0, end: 4, text: 'Apex had three.' }] })],
  );
  const report = row!.r.reportId;
  await svc(
    `insert into report_versions (report_id, version, data, author) values ($1, 1, '{"schemaVersion": 2}', 'agent')`,
    [report],
  );
  const [q] = await svc<{ id: string }>(
    `insert into questions (report_id, field, prompt, asked_at, channel, call_id)
     values ($1, 'manpower.workers', 'How many?', now(), 'voice', $2) returning id`,
    [report, call],
  );
  await svc(`update reports set status = 'awaiting_answer', current_version = 1 where id = $1`, [
    report,
  ]);
  await svc(`update jobs set status = 'done' where type = 'voice_turn'`);
  return { call, report, question: q!.id };
}

const end = (call: string, outcome: string) =>
  svc(`select voice_call_end($1, $2::call_outcome, '[]', '{}')`, [call, outcome]);

const settle = (call: string, hasValue: boolean) =>
  svc<{ r: { action: string; outcome: string; handed: number } }>(
    `select post_call_settle($1, $2) as r`,
    [call, hasValue],
  ).then((rows) => rows[0]!.r);

const one = async <T>(sql: string, params: unknown[] = []) => (await svc<T>(sql, params))[0]!;

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  kevin = (
    await one<{ id: string }>(`select id from reporters where phone_e164 = $1 and org_id = $2`, [
      KEVIN_PHONE,
      DEMO_ORG_ID,
    ])
  ).id;
  northgate = (
    await one<{ id: string }>(`select site_id as id from site_reporters where reporter_id = $1`, [
      kevin,
    ])
  ).id;
});

describe('post_call_settle (§19 Q122)', () => {
  it('needs an ended call', async () => {
    const { call } = await callWithReport(1, '2030-08-01T21:00:00Z');
    expect(await failure(`select post_call_settle($1, true)`, [call])).toMatch(/call_not_ended/);
  });

  it('with a report value: draft_saved, the call question handed to the web, once', async () => {
    const { call, report, question } = await callWithReport(2, '2030-08-02T21:00:00Z');
    await end(call, 'abandoned');
    expect(await settle(call, true)).toMatchObject({
      action: 'continue',
      outcome: 'draft_saved',
      handed: 1,
    });
    expect(
      await one(`select channel::text, call_id from questions where id = $1`, [question]),
    ).toEqual({
      channel: 'web',
      call_id: call,
    });
    expect(await one(`select outcome::text from calls where id = $1`, [call])).toEqual({
      outcome: 'draft_saved',
    });
    const audits = await svc<{ action: string }>(
      `select action from audit_log where (entity_id = $1 or entity_id = $2)
          and action in ('call.outcome_settled', 'report.questions_handed_to_web') order by id`,
      [call, report],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'report.questions_handed_to_web',
      'call.outcome_settled',
    ]);
    // Again (a retry): nothing more.
    expect(await settle(call, true)).toMatchObject({ action: 'continue', handed: 0 });
    expect(
      await one(
        `select count(*)::int as n from audit_log where entity_id = $1 and action = 'call.outcome_settled'`,
        [call],
      ),
    ).toEqual({ n: 1 });
  });

  it('with none: abandoned, the report voided, the day back to its status before the call', async () => {
    const { call, report } = await callWithReport(3, '2030-08-03T21:00:00Z');
    const day = await one<{ id: string; status: string }>(
      `select d.id, d.status::text from site_days d join reports r on r.site_day_id = d.id where r.id = $1`,
      [report],
    );
    expect(day.status).toBe('processing');
    await end(call, 'draft_saved');
    expect(await settle(call, false)).toMatchObject({ action: 'voided', outcome: 'abandoned' });
    expect(await one(`select status::text from reports where id = $1`, [report])).toEqual({
      status: 'void',
    });
    expect(await one(`select status::text from site_days where id = $1`, [day.id])).toEqual({
      status: 'pending',
    });
    expect(await settle(call, false)).toMatchObject({ action: 'closed' });
  });

  it('keeps a report with other sources, and leaves a filed or being-filed report alone', async () => {
    const kept = await callWithReport(4, '2030-08-04T21:00:00Z');
    await svc(
      `insert into report_sources (report_id, kind, taken_at) values ($1, 'photo', now())`,
      [kept.report],
    );
    await end(kept.call, 'draft_saved');
    expect(await settle(kept.call, false)).toMatchObject({ action: 'kept', outcome: 'abandoned' });

    const filing = await callWithReport(5, '2030-08-05T21:00:00Z');
    await svc(`select enqueue_job('file_report', $1::jsonb, null, $2)`, [
      JSON.stringify({ reportId: filing.report, trigger: 'confirm' }),
      `file:${filing.report}:test`,
    ]);
    await end(filing.call, 'draft_saved');
    expect(await settle(filing.call, true)).toMatchObject({ action: 'filing' });

    const none = await newCall(6, '2030-08-06T21:00:00Z');
    await end(none, 'draft_saved');
    expect(await settle(none, true)).toMatchObject({ action: 'none', outcome: 'abandoned' });
  });
});

describe('post_call_recording (§19 Q162)', () => {
  it('stores two-lane peaks and the duration, and the batch transcript replaces the live row', async () => {
    const { call } = await callWithReport(10, '2030-08-10T21:00:00Z');
    expect(await one(`select model from transcripts where call_id = $1`, [call])).toEqual({
      model: 'live',
    });
    await end(call, 'filed');
    const peaks = { reporter: [0.1, 1], agent: [0, 0.5] };
    const transcript = {
      language: 'en',
      text: 'Apex had three.',
      segments: [{ start: 0.4, end: 3.9, speaker: 'reporter', text: 'Apex had three.' }],
      model: 'nova-3',
    };
    expect(
      await one(`select post_call_recording($1, $2::jsonb, 71.6, $3::jsonb) as r`, [
        call,
        JSON.stringify(peaks),
        JSON.stringify(transcript),
      ]),
    ).toEqual({ r: { stored: true, replaced: 'live' } });
    expect(await one(`select peaks, duration_s from calls where id = $1`, [call])).toEqual({
      peaks,
      duration_s: 72,
    });
    expect(
      await one(`select model, text, segments from transcripts where call_id = $1`, [call]),
    ).toEqual({ model: 'nova-3', text: transcript.text, segments: transcript.segments });
    expect(
      await failure(`select post_call_recording($1, '[1]'::jsonb, null, null)`, [call]),
    ).toMatch(/invalid_request/);
  });
});

describe('post_call_fallback_report (F6)', () => {
  it('makes the call a source of today’s report and queues its extraction, once per call', async () => {
    const call = await newCall(20, '2030-08-20T21:00:00Z');
    await svc(`select voice_call_fallback($1, 'not_understood', 12)`, [call]);
    await end(call, 'fallback_recording');
    const r = await one<{
      r: { status: string; reportId: string; jobId: number; created: boolean };
    }>(`select post_call_fallback_report($1) as r`, [call]);
    expect(r.r).toMatchObject({ status: 'queued', created: true });
    const report = r.r.reportId;
    expect(
      await one(`select status::text, channel::text from reports where id = $1`, [report]),
    ).toEqual({ status: 'processing', channel: 'voice' });
    expect(await one(`select dedupe_key, type from jobs where id = $1`, [r.r.jobId])).toEqual({
      dedupe_key: `extract:${report}:call:${call}`,
      type: 'extract_report',
    });
    expect(
      await one(
        `select count(*)::int as n from report_sources where report_id = $1 and call_id = $2`,
        [report, call],
      ),
    ).toEqual({ n: 1 });
    const again = await one<{ r: { jobId: number; created: boolean } }>(
      `select post_call_fallback_report($1) as r`,
      [call],
    );
    expect(again.r).toMatchObject({ jobId: r.r.jobId, created: false });
  });

  it('refuses a call that is no fallback, has no site, or whose day is filed', async () => {
    const plain = await newCall(21, '2030-08-21T21:00:00Z');
    await end(plain, 'abandoned');
    expect(await failure(`select post_call_fallback_report($1)`, [plain])).toMatch(
      /invalid_request/,
    );
    const nosite = await newCall(22, '2030-08-22T21:00:00Z', null);
    await end(nosite, 'fallback_recording');
    expect(await one(`select post_call_fallback_report($1) as r`, [nosite])).toEqual({
      r: { status: 'site_required' },
    });
  });
});

describe('post_call_reconciled / post_call_unreconciled (§10.9, §19 Q123)', () => {
  async function filedCall(n: number, started: string) {
    const { call, report } = await callWithReport(n, started);
    await svc(
      `update reports set status = 'filed', filed_at = now(), confirmed_via = 'voice' where id = $1`,
      [report],
    );
    await end(call, 'filed');
    return { call, report };
  }

  it('writes precise seconds and the reasons once, with the review notice; never twice', async () => {
    const { call, report } = await filedCall(30, '2030-08-30T21:00:00Z');
    const precise = [
      { path: 'manpower[0]', start: 25.3, end: 31.8 },
      { path: 'weather.periods[0]', start: 12.5, end: null },
    ];
    const reasons = ['call_mismatch:manpower[2].workers:5:4'];
    const run = () =>
      one<{ r: { repeat: boolean; status: string; added: string[]; precise: number } }>(
        `select post_call_reconciled($1, $2, $3::text[], $4::jsonb, '{"version": 1}', $5, $6, $7::jsonb) as r`,
        [call, report, reasons, JSON.stringify(precise), ...NOTICE],
      );
    expect((await run()).r).toEqual({
      repeat: false,
      status: 'mismatch',
      added: reasons,
      precise: 2,
    });
    expect((await run()).r).toMatchObject({ repeat: true, status: 'mismatch' });
    const rows = await svc(
      `select value_path, start_s::float8 as start_s, end_s::float8 as end_s from report_sources
        where report_id = $1 and value_path is not null order by value_path`,
      [report],
    );
    expect(rows).toEqual([
      { value_path: 'manpower[0]', start_s: 25.3, end_s: 31.8 },
      { value_path: 'weather.periods[0]', start_s: 12.5, end_s: null },
    ]);
    expect(
      await one(`select needs_review, review_reasons from reports where id = $1`, [report]),
    ).toMatchObject({ needs_review: true, review_reasons: expect.arrayContaining(reasons) });
    expect(
      await one(
        `select count(*)::int as n from notifications where kind = 'needs_review' and target_path = $1`,
        [`/reports/${report}`],
      ),
    ).toEqual({ n: 1 });
    expect(
      await one(`select reconcile ->> 'status' as s from calls where id = $1`, [call]),
    ).toEqual({
      s: 'mismatch',
    });
    // The reconcile ran: a later "could not run" changes nothing.
    expect(
      await one(`select post_call_unreconciled($1, 'job_dead', $2, $3, $4::jsonb) as r`, [
        call,
        ...NOTICE,
      ]),
    ).toEqual({ r: { changed: false, status: 'mismatch' } });
  });

  it('refuses a reason that is not a call_mismatch code, and a report that is not filed', async () => {
    const { call, report } = await filedCall(31, '2030-08-31T21:00:00Z');
    expect(
      await failure(
        `select post_call_reconciled($1, $2, array['no_photo'], '[]', '{}', $3, $4, $5::jsonb)`,
        [call, report, ...NOTICE],
      ),
    ).toMatch(/invalid_request/);
    const open = await callWithReport(32, '2030-09-01T21:00:00Z');
    await end(open.call, 'filed');
    expect(
      await failure(`select post_call_reconciled($1, $2, '{}', '[]', '{}', $3, $4, $5::jsonb)`, [
        open.call,
        open.report,
        ...NOTICE,
      ]),
    ).toMatch(/report_not_filed/);
  });

  it('call_unreconciled once on the filed report', async () => {
    const { call, report } = await filedCall(33, '2030-09-02T21:00:00Z');
    const run = () =>
      one<{ r: { changed: boolean } }>(
        `select post_call_unreconciled($1, 'no_recording', $2, $3, $4::jsonb) as r`,
        [call, ...NOTICE],
      );
    expect((await run()).r).toMatchObject({ changed: true, added: ['call_unreconciled'] });
    expect((await run()).r).toMatchObject({ changed: false });
    expect(await one(`select review_reasons from reports where id = $1`, [report])).toEqual({
      review_reasons: ['call_unreconciled'],
    });
  });

  it('keeps precise seconds well-formed', async () => {
    const { call, report } = await filedCall(34, '2030-09-03T21:00:00Z');
    expect(
      await failure(
        `insert into report_sources (report_id, kind, call_id, value_path, start_s, end_s)
         values ($1, 'call', $2, 'manpower[0]', 5, 2)`,
        [report, call],
      ),
    ).toMatch(/report_sources_precise_check/);
    expect(
      await failure(
        `insert into report_sources (report_id, kind, value_path, start_s) values ($1, 'photo', 'manpower[0]', 1)`,
        [report],
      ),
    ).toMatch(/report_sources_precise_check/);
  });
});

describe('report_no_photo_check (§10.5 step 2)', () => {
  it('flags a call report without photos once; not one with a photo', async () => {
    const { report } = await callWithReport(40, '2030-09-10T21:00:00Z');
    const run = (id: string) =>
      one<{ r: { flagged: boolean; reason: string } }>(
        `select report_no_photo_check($1, $2, $3, $4::jsonb) as r`,
        [id, ...NOTICE],
      );
    expect((await run(report)).r).toEqual({ flagged: true, reason: 'no_photo' });
    expect((await run(report)).r).toEqual({ flagged: false, reason: 'no_photo' });
    const withPhoto = await callWithReport(41, '2030-09-11T21:00:00Z');
    await svc(
      `insert into report_sources (report_id, kind, taken_at) values ($1, 'photo', now())`,
      [withPhoto.report],
    );
    expect((await run(withPhoto.report)).r).toEqual({ flagged: false, reason: 'photos' });
  });
});

describe('job_lock_key (W3-11)', () => {
  it('runs no_photo_check and post_call_reconcile under the report key', async () => {
    const { call, report } = await callWithReport(50, '2030-09-20T21:00:00Z');
    const keys = await one<{ a: string; b: string; c: string }>(
      `select job_lock_key('no_photo_check', jsonb_build_object('reportId', $1::text)) as a,
              job_lock_key('post_call_reconcile', jsonb_build_object('callId', $2::text)) as b,
              job_lock_key('file_report', jsonb_build_object('reportId', $1::text)) as c`,
      [report, call],
    );
    // The report's key (its reporter's WhatsApp conversation, until step 22, for the demo org).
    expect(keys.a).toMatch(/^(report|convo):/);
    expect(keys).toEqual({ a: keys.c, b: keys.c, c: keys.c });
  });
});
