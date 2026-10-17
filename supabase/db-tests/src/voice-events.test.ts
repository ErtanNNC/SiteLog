import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { fillLiveKitFixture } from '@sitelog/shared/livekit/fixture.ts';
import {
  LiveKitWebhookEventSchema,
  toVoiceEvent,
  type VoiceEvent,
  type VoiceEventResult,
} from '@sitelog/shared';
import { asService, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261016000320_voice_events.sql (W3-04; spec §4.2 `voice-events`, §7.3, §19 Q122): the recorded
 * LiveKit events of `fixtures/livekit/`, read by the same code as voice-events (`toVoiceEvent`),
 * through `voice_call_event()`:
 * - each event id once (a redelivery changes nothing);
 * - the SIP line status, never backwards, a final status kept, a hang-up before an answer failed;
 * - the backstop on room_finished for a call the agent never ended: its outcome (not_reached,
 *   filed, draft_saved, abandoned), one post_call_reconcile job (`post_call:<call>`), audited as
 *   system; and the agent's own end arriving after it replaces the guess once;
 * - service role only.
 */

const ID = (n: number) => `cdcd3200-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const room = (n: number) => `call-${ID(n)}`;
const FIXTURES = join(import.meta.dirname, '../../../fixtures/livekit');
const T0 = Math.floor(Date.now() / 1000) - 3600;
const LENA = DEMO_USERS[0]!.id;

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

function event(name: string, n: number, id = `EV_${n}_${name.replace(/\.json$/, '')}`): VoiceEvent {
  const raw = fillLiveKitFixture(readFileSync(join(FIXTURES, name), 'utf8'), {
    room: room(n),
    ts: T0,
    phone: '+15550142087',
    to: '+18885550100',
    id,
  });
  return toVoiceEvent(LiveKitWebhookEventSchema.parse(JSON.parse(raw)), new Date())!;
}

const apply = (ev: VoiceEvent) =>
  svc<{ r: VoiceEventResult }>(
    `select voice_call_event($1, $2, $3, $4, $5::call_status, $6) as r`,
    [ev.eventId, ev.event, ev.room, ev.at, ev.status, JSON.stringify(ev.detail)],
  ).then((rows) => rows[0]!.r);

const call = (id: string) =>
  svc<Record<string, unknown>>(`select * from calls where id = $1`, [id]).then((r) => r[0]!);

const audits = (id: string, action?: string) =>
  svc<{ action: string; diff: Record<string, unknown>; actor_type: string }>(
    `select action, diff, actor_type from audit_log where entity = 'call' and entity_id = $1
       and ($2::text is null or action = $2) order by id`,
    [id, action ?? null],
  );

const jobs = (id: string) =>
  svc<{ type: string; dedupe_key: string }>(
    `select type, dedupe_key from jobs where payload ->> 'callId' = $1`,
    [id],
  );

/** An outbound call row as the worker will create it (W3-17): queued, its room set. */
async function outbound(n: number, extra: { reportId?: string; answered?: boolean } = {}) {
  await svc(
    `insert into calls (id, org_id, reporter_id, site_id, report_id, direction, transport, purpose,
                        provider_call_id, status, answered_at, started_at)
     values ($1, $2, $3, $4, $5, 'outbound', 'pstn', 'reminder', $6,
             case when $7 then 'in_progress' else 'queued' end::call_status,
             case when $7 then now() - interval '2 minutes' end,
             case when $7 then now() - interval '2 minutes' end)`,
    [
      ID(n),
      DEMO_ORG_ID,
      kevin,
      northgate,
      extra.reportId ?? null,
      room(n),
      extra.answered ?? false,
    ],
  );
  return ID(n);
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  kevin = (
    await svc<{ id: string }>(`select id from reporters where phone_e164 = $1 and org_id = $2`, [
      '+15550142087',
      DEMO_ORG_ID,
    ])
  )[0]!.id;
  northgate = (
    await svc<{ id: string }>(`select site_id as id from site_reporters where reporter_id = $1`, [
      kevin,
    ])
  )[0]!.id;
});

describe('voice_call_event: the replayed outbound call', () => {
  it('moves the call ringing → in progress → completed, and the backstop ends it once', async () => {
    const id = await outbound(1);
    const seen: string[] = [];
    const results: VoiceEventResult[] = [];
    for (const f of [
      'outbound-01-room-started.json',
      'outbound-02-agent-joined.json',
      'outbound-03-sip-dialing.json',
      'outbound-04-sip-answered.json',
      'outbound-05-sip-hangup.json',
      'outbound-06-room-finished.json',
    ]) {
      results.push(await apply(event(f, 1)));
      seen.push((await call(id)).status as string);
    }
    expect(seen).toEqual(['queued', 'queued', 'ringing', 'in_progress', 'completed', 'completed']);
    expect(results.map((r) => r.changed)).toEqual([false, false, true, true, true, false]);
    expect(results[5]).toMatchObject({ ended: true, outcome: 'abandoned', callId: id });
    const row = await call(id);
    expect(row.outcome).toBe('abandoned');
    expect(row.ended_at).not.toBeNull();
    expect(new Date(row.answered_at as string).getTime()).toBe((T0 + 9) * 1000);
    // ended at the room's end, 151 s after the answer.
    expect(row.duration_s).toBe(151);
    expect((row.metrics as { backstop: { outcome: string } }).backstop.outcome).toBe('abandoned');
    expect(await jobs(id)).toEqual([
      { type: 'post_call_reconcile', dedupe_key: `post_call:${id}` },
    ]);
    const updates = await audits(id, 'call.updated');
    expect(updates.map((a) => (a.diff.status as { to: string }).to)).toEqual([
      'ringing',
      'in_progress',
      'completed',
    ]);
    expect(updates.every((a) => a.actor_type === 'system')).toBe(true);
    expect(updates[2]!.diff).toMatchObject({
      event: 'participant_left',
      participant: 'sip',
      disconnectReason: 'CLIENT_INITIATED',
    });
    const [ended] = await audits(id, 'call.ended');
    expect(ended).toMatchObject({ actor_type: 'system' });
    expect(ended!.diff).toMatchObject({ outcome: 'abandoned', backstop: true });
    expect(JSON.stringify(await audits(id))).not.toContain('+1555');
    // The events, once each, with their call and no body.
    expect(
      await svc(`select event from livekit_events where call_id = $1 order by event_at`, [id]),
    ).toHaveLength(6);
  });

  it('runs a redelivered event id once', async () => {
    const id = await outbound(2);
    const dialing = event('outbound-03-sip-dialing.json', 2);
    expect(await apply(dialing)).toMatchObject({ duplicate: false, changed: true });
    expect(await apply(dialing)).toMatchObject({ duplicate: true, callId: id, changed: false });
    const finished = event('outbound-06-room-finished.json', 2);
    expect(await apply(finished)).toMatchObject({ ended: true, outcome: 'not_reached' });
    expect(await apply(finished)).toMatchObject({ duplicate: true, ended: false });
    // Another id for the same room's end (a replay): no second end, no second job.
    expect(await apply({ ...finished, eventId: 'EV_2_again' })).toMatchObject({ ended: false });
    expect(await jobs(id)).toHaveLength(1);
    expect(await audits(id, 'call.ended')).toHaveLength(1);
    expect(await audits(id, 'call.updated')).toHaveLength(1);
  });
});

describe('voice_call_event: line status', () => {
  it('never moves backwards and keeps a final status', async () => {
    const id = await outbound(10);
    await apply(event('outbound-04-sip-answered.json', 10));
    await apply(event('outbound-03-sip-dialing.json', 10));
    expect((await call(id)).status).toBe('in_progress');
    await apply(event('outbound-05-sip-hangup.json', 10));
    await apply(event('busy-sip-rejected.json', 10));
    expect((await call(id)).status).toBe('completed');
  });

  it('reads no answer, busy and a hang-up before the answer', async () => {
    const a = await outbound(11);
    await apply(event('no-answer-01-sip-dialing.json', 11));
    await apply(event('no-answer-02-sip-unavailable.json', 11));
    expect((await call(a)).status).toBe('no_answer');
    await apply(event('no-answer-03-room-finished.json', 11));
    expect(await call(a)).toMatchObject({ status: 'no_answer', outcome: 'not_reached' });
    expect((await call(a)).answered_at).toBeNull();

    const b = await outbound(12);
    await apply(event('busy-sip-rejected.json', 12));
    expect((await call(b)).status).toBe('busy');

    const c = await outbound(13);
    await apply(event('outbound-03-sip-dialing.json', 13));
    await apply(event('outbound-05-sip-hangup.json', 13));
    expect((await call(c)).status).toBe('failed');
  });

  it('finds an inbound call by the room uuid before its room is set, and none for another', async () => {
    await svc(
      `insert into calls (id, direction, transport, status, started_at, answered_at)
       values ($1, 'inbound', 'pstn', 'in_progress', now() - interval '1 minute', now() - interval '1 minute')`,
      [ID(14)],
    );
    // An unknown caller (no reporter): ended, no post_call job.
    expect(await apply(event('outbound-06-room-finished.json', 14))).toMatchObject({
      callId: ID(14),
      ended: true,
      outcome: 'abandoned',
      jobId: null,
    });
    expect(await jobs(ID(14))).toEqual([]);
    const none = await apply(event('outbound-06-room-finished.json', 15));
    expect(none).toMatchObject({ callId: null, ended: false });
    expect(await svc(`select call_id from livekit_events where room = $1`, [room(15)])).toEqual([
      { call_id: null },
    ]);
  });

  it('refuses what is not an event of a call room', async () => {
    expect(
      await failure(`select voice_call_event('EV x', 'room_finished', $1, now())`, [room(16)]),
    ).toMatch(/invalid_request/);
    expect(
      await failure(`select voice_call_event('EV_y', 'egress_ended', $1, now())`, [room(16)]),
    ).toMatch(/invalid_request/);
    expect(
      await failure(`select voice_call_event('EV_z', 'room_finished', 'demo-room', now())`),
    ).toMatch(/invalid_request/);
  });
});

describe('voice_call_event: the backstop outcome (§19 Q122)', () => {
  it('is draft_saved when the call left a draft, filed when it was confirmed by voice', async () => {
    const [draft] = await svc<{ id: string }>(
      `select r.id from reports r where r.org_id = $1
          and exists (select 1 from report_versions v where v.report_id = r.id)
        order by r.created_at limit 1`,
      [DEMO_ORG_ID],
    );
    await svc(`update reports set status = 'awaiting_answer' where id = $1`, [draft!.id]);
    const a = await outbound(20, { reportId: draft!.id, answered: true });
    expect(await apply(event('outbound-06-room-finished.json', 20))).toMatchObject({
      ended: true,
      outcome: 'draft_saved',
    });
    expect((await call(a)).status).toBe('completed');

    await svc(
      `update reports set status = 'filed', confirmed_via = 'voice', confirmed_at = now() where id = $1`,
      [draft!.id],
    );
    const b = await outbound(21, { reportId: draft!.id, answered: true });
    expect(await apply(event('outbound-06-room-finished.json', 21))).toMatchObject({
      outcome: 'filed',
    });
    // Filed on the recorder, not on this call: the call itself left nothing.
    await svc(`update reports set confirmed_via = 'web' where id = $1`, [draft!.id]);
    const c = await outbound(22, { reportId: draft!.id, answered: true });
    expect(await apply(event('outbound-06-room-finished.json', 22))).toMatchObject({
      outcome: 'abandoned',
    });
    for (const id of [a, b, c]) expect(await jobs(id)).toHaveLength(1);
  });

  it('leaves a call the agent ended alone', async () => {
    const id = await outbound(23, { answered: true });
    await svc(`select voice_call_end($1, 'callback_requested', '[]', '{"turns": 3}')`, [id]);
    expect(await apply(event('outbound-06-room-finished.json', 23))).toMatchObject({
      ended: false,
    });
    expect((await call(id)).outcome).toBe('callback_requested');
    expect(await jobs(id)).toHaveLength(1);
    expect(await audits(id, 'call.ended')).toHaveLength(1);
  });

  it("takes the agent's end that arrives after the backstop, once, without a second job", async () => {
    const id = await outbound(24, { answered: true });
    await apply(event('outbound-06-room-finished.json', 24));
    const late = await svc<{ r: { ended: boolean; outcome: string } }>(
      `select voice_call_end($1, 'callback_requested', $2, '{"turns": 4}') as r`,
      [id, JSON.stringify([{ t: 1, speaker: 'agent', text: 'Hi' }])],
    );
    expect(late[0]!.r).toMatchObject({ ended: true, outcome: 'callback_requested' });
    const row = await call(id);
    expect(row.outcome).toBe('callback_requested');
    expect(row.metrics).toMatchObject({ turns: 4, backstop: { outcome: 'abandoned' } });
    const again = await svc<{ r: { ended: boolean } }>(
      `select voice_call_end($1, 'filed', '[]', '{}') as r`,
      [id],
    );
    expect(again[0]!.r.ended).toBe(false);
    expect((await call(id)).outcome).toBe('callback_requested');
    expect(await jobs(id)).toHaveLength(1);
    const ends = await audits(id, 'call.ended');
    expect(ends.map((a) => [a.actor_type, a.diff.late ?? false])).toEqual([
      ['system', false],
      ['agent', true],
    ]);
  });
});

describe('access', () => {
  it('lets no signed-in user or anon run voice_call_event or read the events', async () => {
    for (const sql of [
      `select voice_call_event('EV_access', 'room_finished', '${room(1)}', now())`,
      `select id from livekit_events`,
    ]) {
      const asUser = await probeAs(db, { role: 'authenticated', userId: LENA }, sql);
      expect(asUser.ok ? 'ran' : asUser.code, sql).toBe('42501');
      const asAnon = await probeAs(db, { role: 'anon' }, sql);
      expect(asAnon.ok ? 'ran' : asAnon.code, sql).toBe('42501');
    }
  });
});
