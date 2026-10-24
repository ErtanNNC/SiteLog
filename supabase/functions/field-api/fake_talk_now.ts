import type { CallRow } from '@sitelog/shared';
import { talkNowParticipantToken } from '@sitelog/shared';
import type { FakeFieldStore } from './fake_store.ts';
import { FieldDbError } from './store.ts';
import type { LiveKitApi, OrgBilling, TalkNowStore } from './talk_now.ts';

/**
 * Talk now's fakes (W3-13) for the Deno tests: a LiveKit that records the rooms, dispatches and
 * tokens (and can refuse), and a TalkNowStore on FakeFieldStore's rows that does what
 * 20261016000340_talk_now.sql does (the SQL itself is tested on PGlite, `talk-now.test.ts`).
 */

/** A local test pair: never a real project's. */
export const TEST_LIVEKIT = {
  url: 'wss://sitelog-test.livekit.invalid',
  apiKey: 'APItalknowtest',
  apiSecret: 'talk-now-test-secret-0123456789abcdef',
};

export class FakeLiveKitApi implements LiveKitApi {
  readonly url = TEST_LIVEKIT.url;
  rooms: { name: string; metadata: string; emptyTimeoutS: number }[] = [];
  dispatches: { room: string; agentName: string; metadata: string }[] = [];
  tokens: { room: string; callId: string; token: string }[] = [];
  /** Refuse this step (LiveKit down). */
  fail: 'createRoom' | 'dispatchAgent' | null = null;

  constructor(private readonly now: () => Date) {}

  createRoom(input: { name: string; metadata: string; emptyTimeoutS: number }) {
    if (this.fail === 'createRoom') return Promise.reject(new Error('LiveKit CreateRoom: 503'));
    this.rooms.push(input);
    return Promise.resolve();
  }
  dispatchAgent(input: { room: string; agentName: string; metadata: string }) {
    if (this.fail === 'dispatchAgent') {
      return Promise.reject(new Error('LiveKit CreateDispatch: 503'));
    }
    this.dispatches.push(input);
    return Promise.resolve();
  }
  async participantToken(input: { room: string; callId: string }) {
    const token = await talkNowParticipantToken({
      apiKey: TEST_LIVEKIT.apiKey,
      apiSecret: TEST_LIVEKIT.apiSecret,
      room: input.room,
      callId: input.callId,
      now: this.now(),
    });
    this.tokens.push({ ...input, token });
    return token;
  }
}

export class FakeTalkNowStore implements TalkNowStore {
  /** Each org's billing (default: active). */
  billing = new Map<string, OrgBilling>();

  constructor(
    private readonly store: FakeFieldStore,
    private readonly now: () => Date,
  ) {}

  orgBilling(orgId: string) {
    return Promise.resolve(
      this.billing.get(orgId) ?? { billingStatus: 'active', pastDueSince: null, graceDays: 14 },
    );
  }

  startTalkNow(input: { reporterId: string; siteId: string; deviceId: string }) {
    const s = this.store;
    s.calls.push('startTalkNow');
    const rep = s.reporters.find((r) => r.id === input.reporterId);
    if (!rep) return Promise.reject(new FieldDbError('reporter_not_found'));
    if (rep.status === 'disabled') return Promise.reject(new FieldDbError('reporter_disabled'));
    const site = s.sites.find(
      (x) =>
        x.id === input.siteId &&
        x.org_id === rep.org_id &&
        s.siteReporters.some((l) => l.site_id === x.id && l.reporter_id === rep.id),
    );
    if (!site) return Promise.reject(new FieldDbError('site_not_found'));
    if (site.status !== 'active') return Promise.reject(new FieldDbError('wrong_state'));
    const held = new Set(
      s.consents.filter((c) => c.reporter_id === rep.id && !c.revoked_at).map((c) => c.type),
    );
    if (!held.has('recording') || !held.has('data_processing')) {
      return Promise.reject(new FieldDbError('consent_required'));
    }
    const id = crypto.randomUUID();
    const room = `call-${id}`;
    const row: CallRow = {
      id,
      org_id: rep.org_id,
      reporter_id: rep.id,
      site_id: site.id,
      report_id: null,
      direction: 'inbound',
      transport: 'web',
      purpose: 'daily_report',
      provider_call_id: room,
      from_e164: null,
      to_e164: null,
      status: 'queued',
      outcome: null,
      disclosure_played: false,
      disclosure_version: null,
      started_at: null,
      answered_at: null,
      ended_at: null,
      duration_s: null,
      recording_path: null,
      peaks: null,
      dialog_log: null,
      metrics: null,
      created_at: this.now().toISOString(),
      language: rep.locale,
      call_token_issued_at: null,
      attempt: null,
      site_day_id: null,
      fallback: null,
      reconcile: null,
      consent_declined_at: null,
    };
    s.callRows.push(row);
    s.audits.push({
      orgId: rep.org_id,
      actorType: 'reporter',
      actorId: rep.id,
      action: 'call.requested',
      entity: 'call',
      entityId: id,
      diff: {
        direction: 'inbound',
        transport: 'web',
        purpose: 'daily_report',
        site_id: site.id,
        device_id: input.deviceId,
        room,
      },
    });
    return Promise.resolve({ callId: id, room });
  }

  failTalkNow(callId: string, reason: string) {
    const s = this.store;
    s.calls.push('failTalkNow');
    const c = s.callRows.find((x) => x.id === callId && x.transport === 'web');
    if (!c) return Promise.reject(new FieldDbError('call_not_found'));
    if (c.ended_at) return Promise.resolve();
    Object.assign(c, {
      status: 'failed',
      outcome: 'not_reached',
      ended_at: this.now().toISOString(),
      metrics: { talkNowFailed: reason },
    });
    s.audits.push({
      orgId: c.org_id,
      actorType: 'system',
      actorId: null,
      action: 'call.ended',
      entity: 'call',
      entityId: c.id,
      diff: { outcome: 'not_reached', status: 'failed', transport: 'web', reason },
    });
    return Promise.resolve();
  }
}
