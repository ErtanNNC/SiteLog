import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_SITELOG_NUMBER } from '@sitelog/shared/demo/kestrel.ts';
import { fillLiveKitFixture } from '@sitelog/shared/livekit/fixture.ts';
import {
  LiveKitWebhookEventSchema,
  toVoiceEvent,
  type VoiceEvent,
  type VoiceEventResult,
} from '@sitelog/shared';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261016000390_inbound_call_rooms.sql (§19 Q227; spec §9.4 "How a call starts", §4.2
 * `voice-events`): an inbound phone call's room is named by LiveKit's SIP dispatch rule
 * (`{prefix}_{caller}_{random}`), so the call is keyed by the room's sid (`RM_…`):
 * - voice_call_start() takes a room sid for an inbound phone call (a new call id, the sid as its
 *   `provider_call_id`, a repeat the same call), never for Talk now or an outbound call, and never
 *   a dispatch rule's room name;
 * - voice_call_event() finds such a call by its sid (the recorded inbound events of
 *   `fixtures/livekit/inbound-*`), and `livekit_events.room` holds the sid, never the name;
 * - Talk now and outbound rooms (`call-{uuid}`) work as before.
 */

const ID = (n: number) => `cdcd3900-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SID = (n: number) => `Q227room${n.toString().padStart(4, '0')}`;
const FIXTURES = join(import.meta.dirname, '../../../fixtures/livekit');
const T0 = Math.floor(Date.now() / 1000) - 3600;
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

type StartResult = { callId: string; reporterId: string | null; repeat: boolean };

const start = (room: string, opts: { transport?: string; callId?: string } = {}) =>
  svc<{ r: StartResult }>(`select voice_call_start($1, $2::call_transport, $3, $4, $5) as r`, [
    room,
    opts.transport ?? 'pstn',
    opts.callId ?? null,
    opts.callId ? null : KEVIN_PHONE,
    opts.callId ? null : DEMO_SITELOG_NUMBER,
  ]).then((rows) => rows[0]!.r);

function event(name: string, roomSid: string, room = 'call-unused'): VoiceEvent {
  const raw = fillLiveKitFixture(readFileSync(join(FIXTURES, name), 'utf8'), {
    room,
    roomSid,
    ts: T0,
    phone: KEVIN_PHONE,
    to: DEMO_SITELOG_NUMBER,
    id: `EV_${roomSid}_${name.replace(/\.json$/, '')}`,
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

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await svc(`update countries set voice_number = $1 where code = 'US'`, [DEMO_SITELOG_NUMBER]);
  await svc(`update orgs set is_demo = false where id = $1`, [DEMO_ORG_ID]);
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

describe('voice_call_start: a room the dispatch rule named (Q227)', () => {
  it('starts an inbound phone call by its room sid, with a new call id', async () => {
    const r = await start(`RM_${SID(1)}`);
    expect(r).toMatchObject({ reporterId: kevin, repeat: false });
    const row = await call(r.callId);
    expect(row).toMatchObject({
      direction: 'inbound',
      transport: 'pstn',
      provider_call_id: `RM_${SID(1)}`,
      site_id: northgate,
      from_e164: KEVIN_PHONE,
    });
    const [a] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where entity = 'call' and entity_id = $1 and action = 'call.started'`,
      [r.callId],
    );
    expect(a!.diff).toMatchObject({ room: `RM_${SID(1)}` });
    expect(JSON.stringify(a!.diff)).not.toContain(KEVIN_PHONE);
    // The agent's retry: the same call, once.
    expect(await start(`RM_${SID(1)}`)).toMatchObject({ callId: r.callId, repeat: true });
  });

  it('never takes a dispatch rule room name, and a sid only for an inbound phone call', async () => {
    expect(
      await failure(`select voice_call_start($1, 'pstn', null, $2, $3)`, [
        `sip_${KEVIN_PHONE}_Xq7Lm2Pz9Kd4`,
        KEVIN_PHONE,
        DEMO_SITELOG_NUMBER,
      ]),
    ).toMatch(/invalid_request/);
    await svc(
      `insert into calls (id, org_id, reporter_id, site_id, direction, transport, purpose, status)
       values ($1, $2, $3, $4, 'inbound', 'web', 'daily_report', 'queued')`,
      [ID(2), DEMO_ORG_ID, kevin, northgate],
    );
    expect(
      await failure(`select voice_call_start($1, 'web', $2)`, [`RM_${SID(2)}`, ID(2)]),
    ).toMatch(/invalid_request/);
    expect(
      await failure(`select voice_call_start($1, 'pstn', $2)`, [`RM_${SID(2)}`, ID(2)]),
    ).toMatch(/invalid_request/);
    // Talk now keeps its `call-{id}` room.
    expect(await start(`call-${ID(2)}`, { transport: 'web', callId: ID(2) })).toMatchObject({
      callId: ID(2),
      reporterId: kevin,
    });
  });
});

describe('voice_call_event: an inbound phone call by its room sid (Q227)', () => {
  it('replays the recorded inbound call onto the call its sid names', async () => {
    const r = await start(`RM_${SID(3)}`);
    const sid = SID(3);
    const first = event('inbound-01-room-started.json', sid);
    expect(first.room).toBe(`RM_${sid}`);
    expect(await apply(first)).toMatchObject({ callId: r.callId, duplicate: false });
    expect(await apply(event('inbound-02-sip-joined.json', sid))).toMatchObject({
      callId: r.callId,
    });
    expect(await apply(event('inbound-03-sip-hangup.json', sid))).toMatchObject({
      callId: r.callId,
      changed: true,
    });
    expect(await apply(event('inbound-04-room-finished.json', sid))).toMatchObject({
      callId: r.callId,
      ended: true,
    });
    expect(await call(r.callId)).toMatchObject({ status: 'completed' });
    const rooms = await svc<{ room: string }>(
      `select distinct room from livekit_events where call_id = $1`,
      [r.callId],
    );
    expect(rooms).toEqual([{ room: `RM_${sid}` }]);
    const stored = JSON.stringify(
      await svc(`select * from livekit_events where call_id = $1`, [r.callId]),
    );
    expect(stored).not.toMatch(/1555|Xq7Lm2Pz9Kd4|sip_/);
    const audit = JSON.stringify(
      await svc(`select diff from audit_log where entity = 'call' and entity_id = $1`, [r.callId]),
    );
    expect(audit).not.toMatch(/1555|Xq7Lm2Pz9Kd4/);
  });

  it('keeps an event of a sid with no call yet, and never a room name', async () => {
    expect(await apply(event('inbound-01-room-started.json', SID(4)))).toMatchObject({
      callId: null,
      duplicate: false,
    });
    expect(
      await failure(
        `insert into livekit_events (id, event, room, event_at) values ('EV_q227x', 'room_started', $1, now())`,
        [`sip_${KEVIN_PHONE}_Xq7Lm2Pz9Kd4`],
      ),
    ).toMatch(/livekit_events_room_check/);
    expect(
      await failure(`select voice_call_event('EV_q227y', 'room_started', $1, now())`, [
        `sip_${KEVIN_PHONE}_Xq7Lm2Pz9Kd4`,
      ]),
    ).toMatch(/invalid_request/);
  });

  it('finds a Talk now call by its call-{uuid} room as before', async () => {
    await svc(
      `insert into calls (id, org_id, reporter_id, site_id, direction, transport, purpose, status)
       values ($1, $2, $3, $4, 'inbound', 'web', 'daily_report', 'queued')`,
      [ID(5), DEMO_ORG_ID, kevin, northgate],
    );
    const ev = event('outbound-01-room-started.json', 'unused', `call-${ID(5)}`);
    expect(ev.room).toBe(`call-${ID(5)}`);
    expect(await apply(ev)).toMatchObject({ callId: ID(5) });
  });
});
