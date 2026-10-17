import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261016000330_voice_turns.sql (W3-09; spec §7.2, §9.4 `update_draft` / `record_answer`,
 * §10.4 live mode, §19 Q117, Q151):
 * - voice_turn_submit() for `update_draft`: today's report of the call's site created (channel
 *   voice, processing) or merged (a second call the same day), one `call` source per call, the
 *   reporter's lane as the call's live transcript (never shortened), the dialog log, the site-day
 *   processing, one priority `voice_turn` job under the report's lock, audited;
 * - the same words are one turn (§19 Q151: the retry waits for the first); a failed turn runs again
 *   as its next attempt;
 * - `record_answer`: only the open question this call asked, while the report awaits the answer;
 * - refusals: site_required, unknown_caller, call_ended, report_closed, question_closed.
 */

const ID = (n: number) => `cdcd3090-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEY = (c: string) => c.repeat(64);
const KEVIN_PHONE = '+15550142087';
// Fri Jun 7 2030, 17:10 in Chicago: a day the §18 seed has no report for.
const STARTED = '2030-06-07T22:10:00Z';

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

type Submit = {
  turnId: string;
  reportId: string;
  status: string;
  result: unknown;
  error: string | null;
  repeat: boolean;
};

const submit = (callId: string, kind: string, key: string, input: unknown) =>
  svc<{ r: Submit }>(`select voice_turn_submit($1, $2, $3, $4::jsonb) as r`, [
    callId,
    kind,
    key,
    JSON.stringify(input),
  ]).then((rows) => rows[0]!.r);

const segs = (...texts: string[]) => ({
  segments: texts.map((text, i) => ({ start: i * 5, end: i * 5 + 4.5, text })),
});

async function newCall(
  n: number,
  opts: { site?: string | null; reporter?: string | null; started?: string } = {},
) {
  const id = ID(n);
  await svc(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language)
     values ($1, $2, $3, $4, 'inbound', 'web', $5, 'in_progress', $6, $6, $6, 'en-US')`,
    [
      id,
      opts.reporter === null ? null : DEMO_ORG_ID,
      opts.reporter === undefined ? kevin : opts.reporter,
      opts.site === undefined ? northgate : opts.site,
      `call-${id}`,
      opts.started ?? STARTED,
    ],
  );
  return id;
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
});

describe('voice_turn_submit: update_draft', () => {
  let call: string;
  let first: Submit;

  it('creates the day’s report with the call as its source, the live transcript and one priority job', async () => {
    call = await newCall(1);
    first = await submit(
      call,
      'update_draft',
      KEY('a'),
      segs('Northgate, Friday.', 'Apex had three.'),
    );
    expect(first).toMatchObject({ status: 'pending', result: null, repeat: false });

    const [report] = await svc<Record<string, unknown>>(
      `select r.status::text, r.channel::text, r.reporter_id, r.language, sd.date::text, sd.status::text as day
         from reports r join site_days sd on sd.id = r.site_day_id where r.id = $1`,
      [first.reportId],
    );
    expect(report).toMatchObject({
      status: 'processing',
      channel: 'voice',
      reporter_id: kevin,
      language: 'en',
      date: '2030-06-07',
      day: 'processing',
    });
    expect(
      await svc(`select kind, call_id from report_sources where report_id = $1`, [first.reportId]),
    ).toEqual([{ kind: 'call', call_id: call }]);
    const [t] = await svc<{ model: string; text: string; segments: Array<{ speaker: string }> }>(
      `select model, text, segments from transcripts where call_id = $1`,
      [call],
    );
    expect(t!.model).toBe('live');
    expect(t!.text).toBe('Northgate, Friday. Apex had three.');
    expect(t!.segments.map((s) => s.speaker)).toEqual(['reporter', 'reporter']);
    const [c] = await svc<{ report_id: string; site_day_id: string; dialog_log: unknown[] }>(
      `select report_id, site_day_id, dialog_log from calls where id = $1`,
      [call],
    );
    expect(c!.report_id).toBe(first.reportId);
    expect(c!.site_day_id).not.toBeNull();
    expect(c!.dialog_log).toEqual([
      { t: 0, speaker: 'reporter', text: 'Northgate, Friday.', tool: 'update_draft' },
      { t: 5, speaker: 'reporter', text: 'Apex had three.', tool: 'update_draft' },
    ]);

    const jobs = await svc<{ dedupe_key: string; prio: number; lock: string | null }>(
      `select dedupe_key, job_priority(type) as prio, job_lock_key(type, payload) as lock
         from jobs where type = 'voice_turn' and payload ->> 'turnId' = $1`,
      [first.turnId],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.dedupe_key).toBe(`voice_turn:${first.turnId}`);
    // Before every other job (a message is 0), and under the report's (or reporter's) lock.
    expect(jobs[0]!.prio).toBe(-1);
    expect(jobs[0]!.lock).toMatch(/^(report|convo):/);

    const audits = await svc<{ action: string }>(
      `select action from audit_log where (entity = 'call' and entity_id = $1) or (entity = 'report' and entity_id = $2)
       order by id`,
      [call, first.reportId],
    );
    expect(audits.map((a) => a.action)).toEqual(['report.created', 'call.turn']);
  });

  it('answers the same words with the same turn and starts nothing (§19 Q151)', async () => {
    const again = await submit(call, 'update_draft', KEY('a'), segs('Northgate, Friday.'));
    expect(again).toMatchObject({ turnId: first.turnId, repeat: true, status: 'pending' });
    expect(
      await svc(
        `select count(*)::int as n from jobs where type = 'voice_turn' and payload ->> 'turnId' = $1`,
        [first.turnId],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('keeps the longer transcript, appends only new lines to the dialog log', async () => {
    const longer = await submit(
      call,
      'update_draft',
      KEY('b'),
      segs('Northgate, Friday.', 'Apex had three.', 'Eight of ours all day.'),
    );
    expect(longer.repeat).toBe(false);
    expect(longer.reportId).toBe(first.reportId);
    // An older, shorter copy (a late request) under another key never shortens it.
    await submit(call, 'update_draft', KEY('c'), segs('Northgate, Friday.'));
    const [t] = await svc<{ text: string }>(`select text from transcripts where call_id = $1`, [
      call,
    ]);
    expect(t!.text).toBe('Northgate, Friday. Apex had three. Eight of ours all day.');
    const [c] = await svc<{ dialog_log: Array<{ t: number }> }>(
      `select dialog_log from calls where id = $1`,
      [call],
    );
    expect(c!.dialog_log.map((d) => d.t)).toEqual([0, 5, 10]);
    expect(
      await svc(`select count(*)::int as n from report_sources where report_id = $1`, [
        first.reportId,
      ]),
    ).toEqual([{ n: 1 }]);
  });

  it('runs a failed turn again as its next attempt', async () => {
    await svc(`update voice_turns set status = 'failed', error = 'boom' where id = $1`, [
      first.turnId,
    ]);
    const retried = await submit(call, 'update_draft', KEY('a'), segs('Northgate, Friday.'));
    expect(retried).toMatchObject({ turnId: first.turnId, status: 'pending', repeat: true });
    const [turn] = await svc<{ attempts: number; error: string | null }>(
      `select attempts, error from voice_turns where id = $1`,
      [first.turnId],
    );
    expect(turn).toEqual({ attempts: 2, error: null });
    expect(
      await svc(
        `select dedupe_key from jobs where type = 'voice_turn' and payload ->> 'turnId' = $1 order by id`,
        [first.turnId],
      ),
    ).toEqual([
      { dedupe_key: `voice_turn:${first.turnId}` },
      { dedupe_key: `voice_turn:${first.turnId}:2` },
    ]);
  });

  it('merges a second call the same day into the report (§7.2)', async () => {
    const second = await newCall(2);
    const r = await submit(second, 'update_draft', KEY('d'), segs('Forgot: two loads of rebar.'));
    expect(r.reportId).toBe(first.reportId);
    const sources = await svc<{ call_id: string }>(
      `select call_id from report_sources where report_id = $1 order by created_at, call_id`,
      [first.reportId],
    );
    expect(new Set(sources.map((s) => s.call_id))).toEqual(new Set([call, second]));
  });

  it('refuses a call without its site, an unknown caller, an ended call and a filed day', async () => {
    const noSite = await newCall(3, { site: null });
    expect(
      await failure(`select voice_turn_submit($1, 'update_draft', $2, $3::jsonb)`, [
        noSite,
        KEY('e'),
        JSON.stringify(segs('Hi')),
      ]),
    ).toMatch(/site_required/);
    const unknown = await newCall(4, { reporter: null, site: null });
    expect(
      await failure(`select voice_turn_submit($1, 'update_draft', $2, $3::jsonb)`, [
        unknown,
        KEY('e'),
        JSON.stringify(segs('Hi')),
      ]),
    ).toMatch(/unknown_caller/);
    const ended = await newCall(5);
    await svc(`update calls set ended_at = now() where id = $1`, [ended]);
    expect(
      await failure(`select voice_turn_submit($1, 'update_draft', $2, $3::jsonb)`, [
        ended,
        KEY('e'),
        JSON.stringify(segs('Hi')),
      ]),
    ).toMatch(/call_ended/);
    // The seeded Fri Oct 9 report at Northgate is filed: a call that day cannot reopen it.
    const filedDay = await newCall(6, { started: '2026-10-09T22:30:00Z' });
    expect(
      await failure(`select voice_turn_submit($1, 'update_draft', $2, $3::jsonb)`, [
        filedDay,
        KEY('e'),
        JSON.stringify(segs('Hi')),
      ]),
    ).toMatch(/report_closed/);
    expect(
      await failure(`select voice_turn_submit($1, 'update_draft', $2, '{"segments": []}'::jsonb)`, [
        call,
        KEY('f'),
      ]),
    ).toMatch(/invalid_request/);
    expect(
      await failure(`select voice_turn_submit($1, 'apply_correction', $2, '{}'::jsonb)`, [
        call,
        KEY('f'),
      ]),
    ).toMatch(/invalid_request/);
  });
});

describe('voice_turn_submit: record_answer', () => {
  it('takes the open question this call asked, while the report awaits the answer', async () => {
    const call = await newCall(10, { started: '2030-06-10T22:10:00Z' });
    const draft = await submit(call, 'update_draft', KEY('1'), segs('The Delta guys were on two.'));
    const [q] = await svc<{ id: string }>(
      `insert into questions (report_id, field, prompt, target, channel, call_id)
       values ($1, 'manpower.workers', 'Four or five?', '{"path": "manpower.workers:Delta Mechanical"}', 'voice', $2)
       returning id`,
      [draft.reportId, call],
    );
    const answer = { questionId: q!.id, utterance: 'Five, all day.', start: 41.2 };
    // Not yet awaiting the answer (the draft is still processing).
    expect(
      await failure(`select voice_turn_submit($1, 'record_answer', $2, $3::jsonb)`, [
        call,
        KEY('2'),
        JSON.stringify(answer),
      ]),
    ).toMatch(/question_closed/);
    await svc(`update reports set status = 'awaiting_answer' where id = $1`, [draft.reportId]);
    const r = await submit(call, 'record_answer', KEY('2'), answer);
    expect(r).toMatchObject({ reportId: draft.reportId, status: 'pending', repeat: false });
    const [c] = await svc<{ dialog_log: Array<{ tool: string; text: string; t: number }> }>(
      `select dialog_log from calls where id = $1`,
      [call],
    );
    expect(c!.dialog_log.at(-1)).toEqual({
      t: 41.2,
      speaker: 'reporter',
      text: 'Five, all day.',
      tool: 'record_answer',
    });

    // Another call's question, or an answered one, is not this call's to answer.
    const other = await newCall(11, { started: '2030-06-10T22:20:00Z' });
    await svc(`update calls set report_id = $2 where id = $1`, [other, draft.reportId]);
    expect(
      await failure(`select voice_turn_submit($1, 'record_answer', $2, $3::jsonb)`, [
        other,
        KEY('3'),
        JSON.stringify(answer),
      ]),
    ).toMatch(/question_closed/);
    await svc(`update questions set answered_at = now() where id = $1`, [q!.id]);
    expect(
      await failure(`select voice_turn_submit($1, 'record_answer', $2, $3::jsonb)`, [
        call,
        KEY('4'),
        JSON.stringify(answer),
      ]),
    ).toMatch(/question_closed/);
    expect(
      await failure(
        `select voice_turn_submit($1, 'record_answer', $2, '{"utterance": "x"}'::jsonb)`,
        [call, KEY('5')],
      ),
    ).toMatch(/invalid_request/);
  });
});
