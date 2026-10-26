import { assert, assertEquals, assertExists } from '@std/assert';
import { signLiveKitWebhook } from '@sitelog/shared';
import { fillLiveKitFixture } from '@sitelog/shared/livekit/fixture.ts';
import { createVoiceEvents } from './app.ts';
import { fakeVoiceEventsStore } from './fake_store.ts';
import outbound01RoomStarted from '../../../fixtures/livekit/outbound-01-room-started.json' with { type: 'json' };
import outbound02AgentJoined from '../../../fixtures/livekit/outbound-02-agent-joined.json' with { type: 'json' };
import outbound03SipDialing from '../../../fixtures/livekit/outbound-03-sip-dialing.json' with { type: 'json' };
import outbound04SipAnswered from '../../../fixtures/livekit/outbound-04-sip-answered.json' with { type: 'json' };
import outbound05SipHangup from '../../../fixtures/livekit/outbound-05-sip-hangup.json' with { type: 'json' };
import outbound06RoomFinished from '../../../fixtures/livekit/outbound-06-room-finished.json' with { type: 'json' };
import noAnswer01SipDialing from '../../../fixtures/livekit/no-answer-01-sip-dialing.json' with { type: 'json' };
import noAnswer02SipUnavailable from '../../../fixtures/livekit/no-answer-02-sip-unavailable.json' with { type: 'json' };
import noAnswer03RoomFinished from '../../../fixtures/livekit/no-answer-03-room-finished.json' with { type: 'json' };
import busySipRejected from '../../../fixtures/livekit/busy-sip-rejected.json' with { type: 'json' };
import inbound01RoomStarted from '../../../fixtures/livekit/inbound-01-room-started.json' with { type: 'json' };
import inbound02SipJoined from '../../../fixtures/livekit/inbound-02-sip-joined.json' with { type: 'json' };
import inbound03SipHangup from '../../../fixtures/livekit/inbound-03-sip-hangup.json' with { type: 'json' };
import inbound04RoomFinished from '../../../fixtures/livekit/inbound-04-room-finished.json' with { type: 'json' };

/**
 * voice-events (W3-04) on the recorded LiveKit events of `fixtures/livekit/`, signed with a test
 * key and secret (never a real one): the signature, each event, redelivery, the backstop.
 */

const KEY = 'APIvoiceEventsTest';
const SECRET = 'voice-events-test-secret-0123456789abcdef';
const T0 = new Date('2026-10-16T22:00:00Z');
const CALL = '0e0e0e0e-0000-4000-8000-000000000001';
const ROOM = `call-${CALL}`;
const REPORTER = '0e0e0e0e-0000-4000-8000-0000000000aa';
const PHONE = '+15550142087';
/**
 * The fixtures as JSON modules (CI runs these tests without --allow-read), by file name. Every
 * placeholder sits inside a JSON string, so the parsed body re-serialised fills the same way.
 */
const FIXTURES: Record<string, unknown> = {
  'outbound-01-room-started.json': outbound01RoomStarted,
  'outbound-02-agent-joined.json': outbound02AgentJoined,
  'outbound-03-sip-dialing.json': outbound03SipDialing,
  'outbound-04-sip-answered.json': outbound04SipAnswered,
  'outbound-05-sip-hangup.json': outbound05SipHangup,
  'outbound-06-room-finished.json': outbound06RoomFinished,
  'no-answer-01-sip-dialing.json': noAnswer01SipDialing,
  'no-answer-02-sip-unavailable.json': noAnswer02SipUnavailable,
  'no-answer-03-room-finished.json': noAnswer03RoomFinished,
  'busy-sip-rejected.json': busySipRejected,
  'inbound-01-room-started.json': inbound01RoomStarted,
  'inbound-02-sip-joined.json': inbound02SipJoined,
  'inbound-03-sip-hangup.json': inbound03SipHangup,
  'inbound-04-room-finished.json': inbound04RoomFinished,
};

function fixture(
  name: string,
  opts: { room?: string; roomSid?: string; id?: string } = {},
): string {
  const template = FIXTURES[name];
  if (!template) throw new Error(`no fixture ${name}`);
  return fillLiveKitFixture(JSON.stringify(template), {
    room: opts.room ?? ROOM,
    ...(opts.roomSid ? { roomSid: opts.roomSid } : {}),
    ts: T0.getTime() / 1000,
    phone: PHONE,
    to: '+18885550100',
    id: opts.id ?? `EV_${name.replace(/\.json$/, '')}`,
  });
}

function harness(clock = new Date(T0.getTime() + 60_000)) {
  const fake = fakeVoiceEventsStore();
  const handler = createVoiceEvents({
    store: fake.store,
    apiKey: () => KEY,
    apiSecret: () => SECRET,
    now: () => clock,
  });
  async function post(
    body: string,
    opts: { secret?: string; key?: string; token?: string | null } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const token =
      opts.token === undefined
        ? await signLiveKitWebhook(body, {
            apiKey: opts.key ?? KEY,
            apiSecret: opts.secret ?? SECRET,
            now: clock,
          })
        : opts.token;
    const res = await handler(
      new Request('http://localhost/voice-events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/webhook+json',
          ...(token === null ? {} : { Authorization: token }),
        },
        body,
      }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  return { fake, post, handler };
}

const OUTBOUND = [
  'outbound-01-room-started.json',
  'outbound-02-agent-joined.json',
  'outbound-03-sip-dialing.json',
  'outbound-04-sip-answered.json',
  'outbound-05-sip-hangup.json',
  'outbound-06-room-finished.json',
];

Deno.test(
  'a forged, missing or foreign signature is refused with 401 and nothing runs',
  async () => {
    const h = harness();
    h.fake.addCall({ id: CALL, room: ROOM, reporterId: REPORTER, status: 'queued' });
    const body = fixture('outbound-03-sip-dialing.json');
    for (const opts of [
      { secret: 'not-the-secret' },
      { key: 'APIsomeoneElse' },
      { token: null },
      { token: 'garbage' },
    ]) {
      const res = await h.post(body, opts);
      assertEquals(res.status, 401);
      assertEquals(res.json.error, 'invalid_signature');
    }
    // A good token for another body (the body changed on the way).
    const token = await signLiveKitWebhook(body, { apiKey: KEY, apiSecret: SECRET, now: T0 });
    const tampered = body.replace('"dialing"', '"active"');
    assertEquals((await h.post(tampered, { token })).status, 401);
    assertEquals(h.fake.events.size, 0);
    assertEquals(h.fake.calls.get(CALL)!.status, 'queued');
  },
);

Deno.test('a token captured earlier is refused once it expired (a replay)', async () => {
  const h = harness(new Date(T0.getTime() + 60 * 60_000));
  const body = fixture('outbound-03-sip-dialing.json');
  const old = await signLiveKitWebhook(body, { apiKey: KEY, apiSecret: SECRET, now: T0 });
  assertEquals((await h.post(body, { token: old })).status, 401);
});

Deno.test(
  'the replayed outbound call: ringing, in progress, completed; the backstop ends it once',
  async () => {
    const h = harness();
    const call = h.fake.addCall({ id: CALL, room: ROOM, reporterId: REPORTER, status: 'queued' });
    const statuses: string[] = [];
    const answers: Array<Record<string, unknown>> = [];
    for (const name of OUTBOUND) {
      const res = await h.post(fixture(name));
      assertEquals(res.status, 200, name);
      answers.push(res.json);
      statuses.push(call.status);
    }
    assertEquals(statuses, [
      'queued',
      'queued',
      'ringing',
      'in_progress',
      'completed',
      'completed',
    ]);
    assertEquals(call.answeredAt?.toISOString(), new Date(T0.getTime() + 9_000).toISOString());
    // room_finished without end_call: the backstop, nothing said → abandoned (§19 Q122).
    assertEquals(answers[5], {
      received: true,
      duplicate: false,
      callId: CALL,
      changed: false,
      ended: true,
      outcome: 'abandoned',
      jobId: 1,
    });
    assertEquals(call.outcome, 'abandoned');
    assertEquals([...h.fake.jobs.keys()], [`post_call:${CALL}`]);
    // Every change audited as system, with the event; never a number.
    assertEquals(
      h.fake.audits.map((a) => a.action),
      ['call.updated', 'call.updated', 'call.updated', 'call.ended'],
    );
    assert(!JSON.stringify(h.fake.audits).includes(PHONE));
    assert(!JSON.stringify(answers).includes(PHONE));
  },
);

Deno.test('a redelivered event is acknowledged and runs nothing again', async () => {
  const h = harness();
  const call = h.fake.addCall({ id: CALL, room: ROOM, reporterId: REPORTER, status: 'ringing' });
  call.answeredAt = T0;
  const finished = fixture('outbound-06-room-finished.json');
  const first = await h.post(finished);
  const again = await h.post(finished);
  assertEquals(first.json.ended, true);
  assertEquals(again.status, 200);
  assertEquals(again.json, {
    received: true,
    duplicate: true,
    callId: CALL,
    changed: false,
    ended: false,
    outcome: null,
    jobId: null,
  });
  // A second room_finished under another id (LiveKit never sends one, a replay could): no second end.
  const other = await h.post(fixture('outbound-06-room-finished.json', { id: 'EV_other' }));
  assertEquals(other.json.ended, false);
  assertEquals(h.fake.jobs.size, 1);
  assertEquals(h.fake.audits.filter((a) => a.action === 'call.ended').length, 1);
});

Deno.test(
  'a database error is a 500 (LiveKit delivers again) and the redelivery applies',
  async () => {
    const h = harness();
    const call = h.fake.addCall({ id: CALL, room: ROOM, reporterId: REPORTER, status: 'queued' });
    const body = fixture('outbound-03-sip-dialing.json');
    h.fake.failOnce();
    assertEquals((await h.post(body)).status, 500);
    assertEquals(call.status, 'queued');
    assertEquals((await h.post(body)).status, 200);
    assertEquals(call.status, 'ringing');
  },
);

Deno.test('statuses never move backwards, and a final one stays', async () => {
  const h = harness();
  const call = h.fake.addCall({ id: CALL, room: ROOM, reporterId: REPORTER, status: 'queued' });
  await h.post(fixture('outbound-04-sip-answered.json'));
  assertEquals(call.status, 'in_progress');
  await h.post(fixture('outbound-03-sip-dialing.json'));
  assertEquals(call.status, 'in_progress');
  await h.post(fixture('outbound-05-sip-hangup.json'));
  assertEquals(call.status, 'completed');
  await h.post(fixture('busy-sip-rejected.json'));
  assertEquals(call.status, 'completed');
});

Deno.test(
  'no answer and busy: the SIP disconnect reason; the backstop is not_reached',
  async () => {
    const h = harness();
    const call = h.fake.addCall({ id: CALL, room: ROOM, reporterId: REPORTER, status: 'queued' });
    for (const name of [
      'no-answer-01-sip-dialing.json',
      'no-answer-02-sip-unavailable.json',
      'no-answer-03-room-finished.json',
    ]) {
      assertEquals((await h.post(fixture(name))).status, 200);
    }
    assertEquals(call.status, 'no_answer');
    assertEquals(call.outcome, 'not_reached');
    assertEquals(h.fake.jobs.size, 1);

    const busyCall = '0e0e0e0e-0000-4000-8000-000000000002';
    const busy = h.fake.addCall({ id: busyCall, room: `call-${busyCall}`, status: 'ringing' });
    await h.post(fixture('busy-sip-rejected.json', { room: `call-${busyCall}`, id: 'EV_busy' }));
    assertEquals(busy.status, 'busy');
  },
);

Deno.test('a hang-up before anyone answered is failed, not completed', async () => {
  const h = harness();
  const call = h.fake.addCall({ id: CALL, room: ROOM, reporterId: REPORTER, status: 'queued' });
  await h.post(fixture('outbound-03-sip-dialing.json'));
  await h.post(fixture('outbound-05-sip-hangup.json'));
  assertEquals(call.status, 'failed');
});

Deno.test('the backstop: a draft is draft_saved, a report filed by voice is filed', async () => {
  const h = harness();
  const draft = h.fake.addCall({
    id: CALL,
    room: ROOM,
    reporterId: REPORTER,
    status: 'in_progress',
    answeredAt: T0,
    report: { status: 'awaiting_answer', confirmedVia: null, confirmedAt: null, hasVersion: true },
  });
  await h.post(fixture('outbound-06-room-finished.json'));
  assertEquals(draft.outcome, 'draft_saved');

  const filedId = '0e0e0e0e-0000-4000-8000-000000000003';
  const filed = h.fake.addCall({
    id: filedId,
    room: `call-${filedId}`,
    reporterId: REPORTER,
    status: 'in_progress',
    answeredAt: T0,
    report: {
      status: 'filed',
      confirmedVia: 'voice',
      confirmedAt: new Date(T0.getTime() + 90_000),
      hasVersion: true,
    },
  });
  await h.post(
    fixture('outbound-06-room-finished.json', { room: `call-${filedId}`, id: 'EV_filed' }),
  );
  assertEquals(filed.outcome, 'filed');
  assertEquals(h.fake.jobs.size, 2);
});

Deno.test('a call the agent ended is left alone: no second end, no second job', async () => {
  const h = harness();
  const call = h.fake.addCall({
    id: CALL,
    room: ROOM,
    reporterId: REPORTER,
    status: 'in_progress',
    answeredAt: T0,
  });
  assert(h.fake.agentEnd(CALL, 'filed', new Date(T0.getTime() + 120_000)));
  const res = await h.post(fixture('outbound-06-room-finished.json'));
  assertEquals(res.json.ended, false);
  assertEquals(call.outcome, 'filed');
  assertEquals(h.fake.jobs.size, 1);
});

Deno.test('an inbound call: the row named by the room uuid before its room is set', async () => {
  const h = harness();
  const call = h.fake.addCall({ id: CALL, room: null, reporterId: null, status: 'in_progress' });
  call.answeredAt = T0;
  const res = await h.post(fixture('outbound-06-room-finished.json'));
  assertEquals(res.json.callId, CALL);
  // An unknown caller (F13): ended, no post_call job.
  assertEquals(call.outcome, 'abandoned');
  assertEquals(h.fake.jobs.size, 0);
});

const INBOUND = [
  'inbound-01-room-started.json',
  'inbound-02-sip-joined.json',
  'inbound-03-sip-hangup.json',
  'inbound-04-room-finished.json',
];

Deno.test(
  'an inbound phone call (§19 Q227): the room the dispatch rule named, found by its sid',
  async () => {
    const h = harness();
    // calls/start keyed the call by the room's sid (the agent sent `RM_…`, never the name).
    const call = h.fake.addCall({
      id: CALL,
      room: 'RM_Q227inbound1',
      reporterId: REPORTER,
      status: 'in_progress',
    });
    call.answeredAt = T0;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      for (const name of INBOUND) {
        const body = fixture(name, { roomSid: 'Q227inbound1' });
        assert(body.includes(`sip_${PHONE}_`), 'the fixture room carries the number');
        const res = await h.post(body);
        assertEquals(res.status, 200, name);
        assertEquals(res.json.callId, CALL, name);
      }
    } finally {
      console.log = log;
    }
    assertEquals([call.status, call.outcome], ['completed', 'abandoned']);
    assertEquals(h.fake.jobs.size, 1);
    // The room name (the caller's number, the random suffix) is never logged nor audited.
    assert(lines.some((l) => l.includes('RM_Q227inbound1')));
    for (const text of [...lines, JSON.stringify(h.fake.audits)]) {
      assert(!text.includes('5550142087') && !text.includes('Xq7Lm2Pz9Kd4'), text);
    }
  },
);

Deno.test('a dispatch rule room with no call yet is acknowledged by its sid only', async () => {
  const h = harness();
  // A Talk now row named by a uuid is never found by a room sid.
  h.fake.addCall({ id: CALL, room: null, reporterId: REPORTER, status: 'queued' });
  const res = await h.post(fixture('inbound-01-room-started.json', { roomSid: 'Q227none' }));
  assertEquals([res.status, res.json.callId, res.json.ignored], [200, null, undefined]);
  // A room with neither a call-{uuid} name nor a sid: ignored.
  const noSid = JSON.stringify({
    event: 'room_finished',
    id: 'EV_nosid',
    createdAt: String(T0.getTime() / 1000),
    room: { name: `sip_${PHONE}_Xq7Lm2Pz9Kd4` },
  });
  assertEquals((await h.post(noSid)).json, { received: true, ignored: true });
});

Deno.test('a room with no call row, another room or another event: acknowledged', async () => {
  const h = harness();
  const none = await h.post(fixture('outbound-06-room-finished.json'));
  assertEquals(none.status, 200);
  assertEquals(none.json.callId, null);

  const otherRoom = JSON.stringify({
    event: 'room_finished',
    id: 'EV_demo',
    createdAt: String(T0.getTime() / 1000),
    room: { name: 'livekit-playground' },
  });
  assertEquals((await h.post(otherRoom)).json, { received: true, ignored: true });

  const egress = JSON.stringify({ event: 'egress_ended', id: 'EV_eg', room: { name: ROOM } });
  assertEquals((await h.post(egress)).json, { received: true, ignored: true });
});

Deno.test('a signed body that is not an event is 400; a GET is 405', async () => {
  const h = harness();
  assertEquals((await h.post('not json')).status, 400);
  assertEquals((await h.post(JSON.stringify({ hello: 'world' }))).status, 400);
  const res = await h.handler(new Request('http://localhost/voice-events'));
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

Deno.test('the fixtures exist and fill', () => {
  for (const name of [...OUTBOUND, ...INBOUND]) assertExists(JSON.parse(fixture(name)).event);
});
