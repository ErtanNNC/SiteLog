import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261016000370_voice_special_intents.sql (W3-14; spec F3, F10, F12, F13, F15 on a call, §19
 * Q79, Q81, Q99, Q120, Q124, Q129):
 * - voice_report_day_off(): the call's site and day, a weather-day report with channel voice and
 *   the call as its source, filed by its job; once; refused while the day's report is live (Q79),
 *   for a paused site, an unknown caller and an ended call;
 * - voice_request_filed_correction() / voice_save_filed_correction(): a filed report's change said
 *   on a call (the call seconds as its source), the same words once, version n+1 via voice only
 *   after code's yes, a report older than 14 days locked;
 * - voice_record_consent(): yes stores the three consents with voice_yes and the call as evidence
 *   and activates the reporter; no marks the call; a yes after the no is refused;
 * - voice_no_calls_today(): the end of today in the org's time zone, audited;
 * - voice_unknown_caller() / voice_unknown_recording() / purge_unknown_callers(): F13's snippet,
 *   the org guessed from one org's history, the recording outside every org's folder, the 30-day
 *   purge.
 */

const ID = (n: number) => `cdcd3700-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEVIN_PHONE = '+15550142087';
const VOICE_NUMBER = '+15550142290';
const STRANGER = '+15550199001';

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

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await svc<{ r: T }>(sql, params);
  return row!.r;
}

/** A call of Kevin's on Northgate that started at `started` (Northgate's day, Chicago time). */
async function newCall(n: number, started: string, extra: { reporter?: string | null } = {}) {
  const id = ID(n);
  const reporter = extra.reporter === undefined ? kevin : extra.reporter;
  await svc(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language,
                        from_e164, to_e164)
     values ($1, $2, $3, $4, 'inbound', 'pstn', $5, 'in_progress', $6, $6, $6, 'en-US', $7, $8)`,
    [
      id,
      reporter ? DEMO_ORG_ID : null,
      reporter,
      reporter ? northgate : null,
      `call-${id}`,
      started,
      reporter ? KEVIN_PHONE : STRANGER,
      VOICE_NUMBER,
    ],
  );
  return id;
}

const WEATHER = JSON.stringify({
  schemaVersion: 2,
  summary: 'Weather day: work stopped at 11:00.',
});

type DayOff = {
  siteDayId: string;
  status: string;
  changed: boolean;
  report: { id: string; reportNo: string } | null;
};

const dayOff = (
  call: string,
  status: string,
  details: unknown,
  data: string | null,
  words: string,
) =>
  one<DayOff>(`select voice_report_day_off($1, $2, $3::jsonb, $4::jsonb, $5) as r`, [
    call,
    status,
    JSON.stringify(details),
    data,
    words,
  ]);

/** A filed report of Northgate on `date` (a weather day logged on a call, then filed). */
async function filedReport(n: number, started: string): Promise<string> {
  const call = await newCall(n, started);
  const made = await dayOff(call, 'weather_day', { since: '11:00' }, WEATHER, 'yes');
  await svc(`update reports set status = 'filed', filed_at = now() where id = $1`, [
    made.report!.id,
  ]);
  await svc(`update calls set ended_at = now() where id = $1`, [call]);
  return made.report!.id;
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  kevin = (
    await svc<{ id: string }>(`select id from reporters where phone_e164 = $1 and org_id = $2`, [
      KEVIN_PHONE,
      DEMO_ORG_ID,
    ])
  )[0]!.id;
  northgate = (
    await svc<{ id: string }>(`select site_id as id from site_reporters where reporter_id = $1`, [
      kevin,
    ])
  )[0]!.id;
  await svc(`update countries set voice_number = $1 where code = 'US'`, [VOICE_NUMBER]);
});

describe('voice_report_day_off (F12 call, §19 Q79)', () => {
  it('logs a weather day once: the report by voice with the call as its source, and its filing', async () => {
    const call = await newCall(1, '2030-07-01T18:00:00Z');
    const r = await dayOff(
      call,
      'weather_day',
      { since: '11:00', workersBefore: 12 },
      WEATHER,
      'Yes.',
    );
    expect(r).toMatchObject({ status: 'weather_day', changed: true });
    const [rep] = await svc<{ channel: string; kind: string; status: string }>(
      `select channel, kind, status from reports where id = $1`,
      [r.report!.id],
    );
    expect(rep).toEqual({ channel: 'voice', kind: 'weather_day', status: 'processing' });
    expect(
      await svc(`select kind, call_id from report_sources where report_id = $1`, [r.report!.id]),
    ).toEqual([{ kind: 'call', call_id: call }]);
    expect(
      await svc(`select author, via from report_versions where report_id = $1`, [r.report!.id]),
    ).toEqual([{ author: 'reporter', via: 'voice' }]);
    expect(
      await svc(
        `select dedupe_key from jobs where type = 'file_report' and payload ->> 'reportId' = $1`,
        [r.report!.id],
      ),
    ).toEqual([{ dedupe_key: `file:${r.report!.id}:v1:weather_day` }]);
    expect(await svc(`select report_id from calls where id = $1`, [call])).toEqual([
      { report_id: r.report!.id },
    ]);
    const [a] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'site_day.weather_day' and entity_id = $1`,
      [r.siteDayId],
    );
    expect(a!.diff).toMatchObject({ channel: 'voice', call_id: call, utterance: 'Yes.' });

    // The agent's retry: what the first one made.
    const again = await dayOff(call, 'weather_day', { since: '11:00' }, WEATHER, 'Yes.');
    expect(again).toMatchObject({ changed: false, report: r.report });
    expect(
      await svc(`select count(*)::int as n from reports where site_day_id = $1`, [r.siteDayId]),
    ).toEqual([{ n: 1 }]);
  });

  it('a no-work day without a no-work PDF is the site-day only', async () => {
    const call = await newCall(2, '2030-07-02T18:00:00Z');
    const r = await dayOff(call, 'no_work', {}, null, 'yes');
    expect(r).toMatchObject({ status: 'no_work', changed: true, report: null });
  });

  it("refuses while the day's report is on its way (§19 Q79), and a filed day", async () => {
    const call = await newCall(3, '2030-07-03T18:00:00Z');
    await svc(`select voice_turn_submit($1, 'update_draft', $2, $3::jsonb)`, [
      call,
      'a'.repeat(64),
      JSON.stringify({ segments: [{ start: 0, end: 3, text: 'Apex had six.' }] }),
    ]);
    expect(
      await failure(`select voice_report_day_off($1, 'no_work', '{}'::jsonb, null, 'yes')`, [call]),
    ).toMatch(/report_in_progress/);
    await svc(
      `update reports set status = 'filed' where id = (select report_id from calls where id = $1)`,
      [call],
    );
    expect(
      await failure(`select voice_report_day_off($1, 'no_work', '{}'::jsonb, null, 'yes')`, [call]),
    ).toMatch(/report_filed/);
  });

  it('refuses a paused site, an unknown caller and an ended call', async () => {
    const call = await newCall(4, '2030-07-04T18:00:00Z');
    await svc(`update sites set status = 'paused' where id = $1`, [northgate]);
    expect(
      await failure(`select voice_report_day_off($1, 'no_work', '{}'::jsonb, null, 'yes')`, [call]),
    ).toMatch(/site_inactive/);
    await svc(`update sites set status = 'active' where id = $1`, [northgate]);
    const unknown = await newCall(5, '2030-07-04T18:00:00Z', { reporter: null });
    expect(
      await failure(`select voice_report_day_off($1, 'no_work', '{}'::jsonb, null, 'yes')`, [
        unknown,
      ]),
    ).toMatch(/unknown_caller/);
    await svc(`update calls set ended_at = now() where id = $1`, [call]);
    expect(
      await failure(`select voice_report_day_off($1, 'no_work', '{}'::jsonb, null, 'yes')`, [call]),
    ).toMatch(/call_ended/);
  });
});

describe('F10 on a call: voice_request_filed_correction / voice_save_filed_correction', () => {
  let report: string;
  let call: string;
  let correction: string;

  it('takes a change of a filed report with the call seconds as its source, once', async () => {
    report = await filedReport(10, '2030-07-06T18:00:00Z');
    call = await newCall(11, '2030-07-07T18:00:00Z');
    const r = await one<{ id: string; status: string; repeat?: boolean }>(
      `select voice_request_filed_correction($1, $2, $3, 12.5, 15) as r`,
      [call, report, 'Apex was seven'],
    );
    expect(r.status).toBe('listening');
    correction = r.id;
    const [row] = await svc<Record<string, unknown>>(
      `select via, text, after_filing, call_id, source from draft_corrections where id = $1`,
      [correction],
    );
    expect(row).toEqual({
      via: 'voice',
      text: 'Apex was seven',
      after_filing: true,
      call_id: call,
      source: { type: 'call', callId: call, start: 12.5, end: 15 },
    });
    expect(
      await svc(
        `select dedupe_key from jobs where type = 'apply_correction' and payload ->> 'correctionId' = $1`,
        [correction],
      ),
    ).toEqual([{ dedupe_key: `correction:${correction}` }]);
    // The same words again (asked again after `pending`): the same change.
    const again = await one<{ id: string; repeat: boolean }>(
      `select voice_request_filed_correction($1, $2, $3, 20) as r`,
      [call, report, 'Apex was seven'],
    );
    expect(again).toMatchObject({ id: correction, repeat: true });
    // Other words while it is being read: one at a time.
    expect(
      await failure(`select voice_request_filed_correction($1, $2, 'BrightLine was four', 30)`, [
        call,
        report,
      ]),
    ).toMatch(/correction_pending/);
  });

  it('saves version 2 via voice only after code read a yes', async () => {
    await svc(`select field_settle_correction($1, 'ready', $2::jsonb)`, [
      correction,
      JSON.stringify({
        data: { schemaVersion: 2, summary: 'Weather day: work stopped at 11:00.' },
        changes: [],
        baseVersion: 1,
        baseRev: 1,
      }),
    ]);
    const no = await one<{ status: string }>(
      `select voice_save_filed_correction($1, $2, 'sounds good I guess', false, 'Apex Concrete 6 → 7 workers') as r`,
      [call, correction],
    );
    expect(no.status).toBe('not_confirmed');
    expect(
      await svc(
        `select count(*)::int as n from audit_log where action = 'call.save_refused' and entity_id = $1`,
        [call],
      ),
    ).toEqual([{ n: 1 }]);
    const yes = await one<{ status: string; version: number }>(
      `select voice_save_filed_correction($1, $2, 'yes', true, 'Apex Concrete 6 → 7 workers',
                                          '{"weekday": "Friday", "change": "Apex Concrete 6 -> 7 workers"}'::jsonb) as r`,
      [call, correction],
    );
    expect(yes).toMatchObject({ status: 'applied', version: 2 });
    expect(
      await svc(
        `select author, via, author_reporter_id, change_note from report_versions where report_id = $1 and version = 2`,
        [report],
      ),
    ).toEqual([
      {
        author: 'reporter',
        via: 'voice',
        author_reporter_id: kevin,
        change_note: 'Apex Concrete 6 → 7 workers',
      },
    ]);
    const [job] = await svc<{ payload: Record<string, unknown> }>(
      `select payload from jobs where dedupe_key = $1`,
      [`render_pdf:${report}:2`],
    );
    expect(job!.payload).toMatchObject({
      version: 2,
      editApplied: { reporterId: kevin, weekday: 'Friday' },
    });
    const [a] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'report.correction_saved' and entity_id = $1`,
      [report],
    );
    expect(a!.diff).toMatchObject({ channel: 'voice', call_id: call, version: 2 });
    // The agent's retry: the version it made.
    const repeat = await one<{ status: string; version: number; repeat: boolean }>(
      `select voice_save_filed_correction($1, $2, 'yes', true, 'x') as r`,
      [call, correction],
    );
    expect(repeat).toMatchObject({ status: 'applied', version: 2, repeat: true });
  });

  it('refuses a report older than 14 days, another site, and another call’s change', async () => {
    const old = await filedReport(12, '2020-01-06T18:00:00Z');
    expect(
      await failure(`select voice_request_filed_correction($1, $2, 'Apex was seven', 1)`, [
        call,
        old,
      ]),
    ).toMatch(/report_locked/);
    const other = await newCall(13, '2030-07-08T18:00:00Z');
    expect(
      await failure(`select voice_save_filed_correction($1, $2, 'yes', true, 'x')`, [
        other,
        correction,
      ]),
    ).toMatch(/correction_not_found/);
    const [elsewhere] = await svc<{ id: string }>(
      `select r.id from reports r where r.site_id <> $1 and r.status in ('filed', 'signed_off') limit 1`,
      [northgate],
    );
    if (elsewhere) {
      expect(
        await failure(`select voice_request_filed_correction($1, $2, 'Apex was seven', 1)`, [
          call,
          elsewhere.id,
        ]),
      ).toMatch(/out_of_scope/);
    }
  });
});

describe('voice_record_consent (F3 call, §19 Q120)', () => {
  let invited: string;

  beforeAll(async () => {
    invited = (
      await svc<{ id: string }>(
        `insert into reporters (org_id, name, phone_e164, status, locale)
         values ($1, 'Dana Field', '+15550177001', 'invited', 'en-US') returning id`,
        [DEMO_ORG_ID],
      )
    )[0]!.id;
    await svc(`insert into site_reporters (site_id, reporter_id) values ($1, $2)`, [
      northgate,
      invited,
    ]);
  });

  it('yes stores recording, data processing and texts by voice, with the call, and activates', async () => {
    const call = await newCall(20, '2030-07-10T18:00:00Z', { reporter: invited });
    const r = await one<{ status: string; given: string[]; smsBefore: boolean }>(
      `select voice_record_consent($1, 'yes', 7.25, 'voice.consent.v1') as r`,
      [call],
    );
    expect(r).toMatchObject({ status: 'given', smsBefore: false });
    expect(r.given.sort()).toEqual(['data_processing', 'recording', 'sms']);
    const rows = await svc<{
      type: string;
      method: string;
      text_version: string;
      evidence: unknown;
    }>(
      `select type, method, text_version, evidence from consents where reporter_id = $1 order by type`,
      [invited],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        method: 'voice_yes',
        text_version: 'voice.consent.v1',
        evidence: { call_id: call, at: 7.25 },
      });
    }
    expect(
      await svc(`select status, activated_at is not null as active from reporters where id = $1`, [
        invited,
      ]),
    ).toEqual([{ status: 'active', active: true }]);
    expect(
      await svc(
        `select count(*)::int as n from audit_log where action = 'consent.given' and diff ->> 'call_id' = $1`,
        [call],
      ),
    ).toEqual([{ n: 3 }]);
    // Said again: nothing new.
    const again = await one<{ given: string[] }>(
      `select voice_record_consent($1, 'yes', 9, 'voice.consent.v1') as r`,
      [call],
    );
    expect(again.given).toEqual([]);
  });

  it('no marks the call and tells whether texts were consented before; a yes after it is refused', async () => {
    const call = await newCall(21, '2030-07-11T18:00:00Z', { reporter: invited });
    await svc(`update calls set recording_path = $2 where id = $1`, [
      call,
      `${DEMO_ORG_ID}/${call}.ogg`,
    ]);
    const r = await one<{ status: string; smsBefore: boolean; recordingPath: string }>(
      `select voice_record_consent($1, 'no', 4, 'voice.consent.v1') as r`,
      [call],
    );
    expect(r).toEqual({
      status: 'declined',
      smsBefore: true,
      recordingPath: `${DEMO_ORG_ID}/${call}.ogg`,
      given: [],
    });
    expect(
      await svc(`select consent_declined_at is not null as declined from calls where id = $1`, [
        call,
      ]),
    ).toEqual([{ declined: true }]);
    expect(
      await failure(`select voice_record_consent($1, 'yes', 9, 'voice.consent.v1')`, [call]),
    ).toMatch(/wrong_state/);
  });
});

describe('voice_no_calls_today (§19 Q129)', () => {
  it("sets the end of today in the org's time zone, once, audited", async () => {
    const call = await newCall(30, '2030-07-12T18:00:00Z');
    const r = await one<{ until: string; changed: boolean }>(
      `select voice_no_calls_today($1) as r`,
      [call],
    );
    expect(r.changed).toBe(true);
    const [check] = await svc<{ ok: boolean }>(
      `select $1::timestamptz = ((((now() at time zone o.timezone)::date + 1)::timestamp) at time zone o.timezone) as ok
         from orgs o where o.id = $2`,
      [r.until, DEMO_ORG_ID],
    );
    expect(check!.ok).toBe(true);
    const again = await one<{ changed: boolean }>(`select voice_no_calls_today($1) as r`, [call]);
    expect(again.changed).toBe(false);
    expect(
      await svc(
        `select count(*)::int as n from audit_log where action = 'reporter.preferences_changed'
           and entity_id = $1 and diff ->> 'call_id' = $2`,
        [kevin, call],
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe('unknown callers (F13, §19 Q124)', () => {
  it('keeps a snippet on unknown_contacts once per call, never for a known caller', async () => {
    const call = await newCall(40, '2030-07-13T18:00:00Z', { reporter: null });
    const r = await one<{ id: string; orgId: string | null; created: boolean }>(
      `select voice_unknown_caller($1, $2) as r`,
      [call, 'Sam from Apex at Northgate. '.repeat(10)],
    );
    expect(r).toMatchObject({ orgId: null, created: true });
    const [row] = await svc<{ channel: string; call_id: string; len: number; status: string }>(
      `select channel, call_id, length(snippet) as len, status from unknown_contacts where id = $1`,
      [r.id],
    );
    expect(row).toEqual({ channel: 'voice', call_id: call, len: 160, status: 'pending' });
    const again = await one<{ id: string; created: boolean }>(
      `select voice_unknown_caller($1, 'again') as r`,
      [call],
    );
    expect(again).toMatchObject({ id: r.id, created: false });
    const known = await newCall(41, '2030-07-13T18:00:00Z');
    expect(await failure(`select voice_unknown_caller($1, 'hi')`, [known])).toMatch(/out_of_scope/);
    expect(await one<{ path: string }>(`select voice_unknown_recording($1) as r`, [call])).toEqual({
      path: `unknown/${call}.ogg`,
    });
    expect(await failure(`select voice_unknown_recording($1)`, [known])).toMatch(/out_of_scope/);
  });

  it("guesses the org from one org's history (a disabled reporter's number)", async () => {
    await svc(
      `insert into reporters (org_id, name, phone_e164, status) values ($1, 'Old Hand', $2, 'disabled')`,
      [DEMO_ORG_ID, '+15550199002'],
    );
    // The demo org is never guessed for a real caller (§19 Q44): make it real for this check.
    await svc(`update orgs set is_demo = false where id = $1`, [DEMO_ORG_ID]);
    const id = ID(42);
    await svc(
      `insert into calls (id, direction, transport, provider_call_id, status, started_at,
                          call_token_issued_at, from_e164, to_e164)
       values ($1, 'inbound', 'pstn', $2, 'in_progress', now(), now(), '+15550199002', $3)`,
      [id, `call-${id}`, VOICE_NUMBER],
    );
    const r = await one<{ orgId: string | null }>(
      `select voice_unknown_caller($1, 'Old Hand') as r`,
      [id],
    );
    expect(r.orgId).toBe(DEMO_ORG_ID);
    await svc(`update orgs set is_demo = true where id = $1`, [DEMO_ORG_ID]);
  });

  it('purges a contact the office did not link after 30 days, with its call media', async () => {
    const old = await newCall(43, '2030-07-14T18:00:00Z', { reporter: null });
    await svc(`select voice_unknown_caller($1, 'old message')`, [old]);
    await svc(`select voice_unknown_recording($1)`, [old]);
    await svc(
      `update calls set dialog_log = '[{"t": 1, "speaker": "reporter", "text": "hi"}]' where id = $1`,
      [old],
    );
    await svc(
      `update unknown_contacts set created_at = now() - interval '31 days' where call_id = $1`,
      [old],
    );
    const linked = await newCall(44, '2030-07-14T18:00:00Z', { reporter: null });
    await svc(`select voice_unknown_caller($1, 'linked one')`, [linked]);
    await svc(
      `update unknown_contacts set created_at = now() - interval '31 days', status = 'linked' where call_id = $1`,
      [linked],
    );
    const purged = await svc<{ call_id: string; recording_path: string | null }>(
      `select call_id, recording_path from purge_unknown_callers(now() - interval '30 days')`,
    );
    expect(purged).toEqual([{ call_id: old, recording_path: `unknown/${old}.ogg` }]);
    expect(
      await svc(`select count(*)::int as n from unknown_contacts where call_id = $1`, [old]),
    ).toEqual([{ n: 0 }]);
    expect(await svc(`select dialog_log, recording_path from calls where id = $1`, [old])).toEqual([
      { dialog_log: null, recording_path: null },
    ]);
    expect(
      await svc(`select count(*)::int as n from unknown_contacts where call_id = $1`, [linked]),
    ).toEqual([{ n: 1 }]);
  });
});
