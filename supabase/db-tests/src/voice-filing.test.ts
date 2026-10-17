import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261016000350_voice_filing.sql (W3-10; spec F8 call, §7.2 "yes (call)", §9.4 rule 5, §19 Q119,
 * Q151):
 * - voice_file_report(): the report must be the call's; code's verdict on the words decides
 *   (`not_confirmed`, audited); the read-back's revision must still be the draft's
 *   (`draft_changed`, audited); one filing job per draft revision (`via voice`, audited with the
 *   words); a retry while it runs gets the same job; after the filing, `filed`;
 * - voice_turn_submit(): `apply_correction` on the call's open report, refused before the call has
 *   a draft and once the yes went through.
 */

const ID = (n: number) => `cdcd3500-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEY = (c: string) => c.repeat(64);
const KEVIN_PHONE = '+15550142087';

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

async function newCall(n: number, started: string): Promise<string> {
  const id = ID(n);
  await svc(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language)
     values ($1, $2, $3, $4, 'inbound', 'web', $5, 'in_progress', $6, $6, $6, 'en-US')`,
    [id, DEMO_ORG_ID, kevin, northgate, `call-${id}`, started],
  );
  return id;
}

/** A call whose turn made today's report, read back (awaiting confirmation, a draft at rev 1). */
async function readBackCall(n: number, started: string): Promise<{ call: string; report: string }> {
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
  await svc(
    `update reports set status = 'awaiting_confirmation', current_version = 1 where id = $1`,
    [report],
  );
  // The turn's job is done (the worker read the draft back).
  await svc(`update jobs set status = 'done' where type = 'voice_turn'`);
  return { call, report };
}

type Filing = { status: string; reportNo?: string; jobId?: number; draftRev?: number };

const file = (call: string, report: string, rev: number, words: string, confirmed: boolean) =>
  svc<{ r: Filing }>(`select voice_file_report($1, $2, $3, $4, $5) as r`, [
    call,
    report,
    rev,
    words,
    confirmed,
  ]).then((rows) => rows[0]!.r);

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

describe('voice_file_report (§19 Q119, Q151)', () => {
  let call: string;
  let report: string;

  it('refuses words code did not read as a confirm, audited, nothing queued', async () => {
    ({ call, report } = await readBackCall(1, '2030-06-07T22:10:00Z'));
    const r = await file(call, report, 1, 'sounds good I guess', false);
    expect(r.status).toBe('not_confirmed');
    expect(
      await svc(
        `select count(*)::int as n from jobs where type = 'file_report' and payload ->> 'reportId' = $1`,
        [report],
      ),
    ).toEqual([{ n: 0 }]);
    const [a] = await svc<{ actor_type: string; diff: Record<string, unknown> }>(
      `select actor_type, diff from audit_log where action = 'call.file_refused' and entity_id = $1`,
      [call],
    );
    expect(a).toMatchObject({
      actor_type: 'reporter',
      diff: { reason: 'not_confirmed', utterance: 'sounds good I guess', draft_rev: 1 },
    });
  });

  it('refuses a revision the draft has left (the read-back was of an older draft)', async () => {
    await svc(
      `update report_versions set data = '{"schemaVersion": 2, "x": 1}' where report_id = $1`,
      [report],
    );
    const r = await file(call, report, 1, 'Yes.', true);
    expect(r).toMatchObject({ status: 'draft_changed', draftRev: 2 });
    expect(
      await svc(
        `select count(*)::int as n from jobs where type = 'file_report' and payload ->> 'reportId' = $1`,
        [report],
      ),
    ).toEqual([{ n: 0 }]);
  });

  it('queues one filing of that revision (via voice); a retry while it runs gets the same job', async () => {
    const first = await file(call, report, 2, 'Yes, file it.', true);
    expect(first.status).toBe('queued');
    const again = await file(call, report, 2, 'Yes, file it.', true);
    expect(again).toMatchObject({ status: 'queued', jobId: first.jobId });
    const jobs = await svc<{ dedupe_key: string; payload: Record<string, unknown> }>(
      `select dedupe_key, payload from jobs where type = 'file_report' and payload ->> 'reportId' = $1`,
      [report],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.dedupe_key).toBe(`file:${report}:v1:r2:call:${call}`);
    expect(jobs[0]!.payload).toMatchObject({
      trigger: 'confirm',
      version: 1,
      draftRev: 2,
      via: 'voice',
    });
    const [a] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'report.confirm_requested' and entity_id = $1`,
      [report],
    );
    expect(a!.diff).toMatchObject({ channel: 'voice', call_id: call, utterance: 'Yes, file it.' });
    // While the yes is being filed, nothing changes the draft on the call.
    expect(
      await failure(`select voice_turn_submit($1, 'apply_correction', $2, $3::jsonb)`, [
        call,
        KEY('c'),
        JSON.stringify({ utterance: 'Apex had seven.', start: 30 }),
      ]),
    ).toMatch(/report_closed/);
  });

  it('answers filed after the filing, whatever the request (never a second filing)', async () => {
    await svc(`update reports set status = 'filed' where id = $1`, [report]);
    const r = await file(call, report, 2, 'Yes, file it.', true);
    expect(r.status).toBe('filed');
    expect(r.reportNo).toMatch(/\S/);
    expect(
      await svc(
        `select count(*)::int as n from jobs where type = 'file_report' and payload ->> 'reportId' = $1`,
        [report],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it("refuses another report than the call's, and an ended call", async () => {
    const other = await readBackCall(2, '2030-06-08T22:10:00Z');
    expect(
      await failure(`select voice_file_report($1, $2, 1, 'yes', true)`, [call, other.report]),
    ).toMatch(/out_of_scope/);
    await svc(`update calls set ended_at = now() where id = $1`, [other.call]);
    expect(
      await failure(`select voice_file_report($1, $2, 1, 'yes', true)`, [other.call, other.report]),
    ).toMatch(/call_ended/);
  });
});

describe('voice_turn_submit: apply_correction (F8 on a call)', () => {
  it("takes a change of the call's open draft, with its words in the dialog log", async () => {
    const { call, report } = await readBackCall(3, '2030-06-09T22:10:00Z');
    const [row] = await svc<{ r: { reportId: string; status: string; repeat: boolean } }>(
      `select voice_turn_submit($1, 'apply_correction', $2, $3::jsonb) as r`,
      [call, KEY('b'), JSON.stringify({ utterance: 'No, Apex had seven, not six.', start: 61.5 })],
    );
    expect(row!.r).toMatchObject({ reportId: report, status: 'pending', repeat: false });
    const [c] = await svc<{ dialog_log: Array<Record<string, unknown>> }>(
      `select dialog_log from calls where id = $1`,
      [call],
    );
    expect(c!.dialog_log.at(-1)).toEqual({
      t: 61.5,
      speaker: 'reporter',
      text: 'No, Apex had seven, not six.',
      tool: 'apply_correction',
    });
    const [job] = await svc<{ prio: number }>(
      `select job_priority(type) as prio from jobs where type = 'voice_turn' and status = 'queued'`,
    );
    expect(job!.prio).toBe(-1);
  });

  it('refuses a change before the call has a draft', async () => {
    const call = await newCall(4, '2030-06-11T22:10:00Z');
    expect(
      await failure(`select voice_turn_submit($1, 'apply_correction', $2, $3::jsonb)`, [
        call,
        KEY('d'),
        JSON.stringify({ utterance: 'Apex had seven.', start: 3 }),
      ]),
    ).toMatch(/draft_required/);
  });
});
