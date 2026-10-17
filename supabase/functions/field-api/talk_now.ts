import type { Context, Hono } from 'hono';
import {
  FIELD_RATE_LIMITS,
  LiveKitApiError,
  VoiceTokenRequestSchema,
  liveKitConfigFrom,
  liveKitTwirp,
  talkNowParticipantToken,
  type LiveKitConfig,
  type LiveKitVideoGrant,
  type FieldDeviceRow,
  type FieldLinkRow,
  type ReporterRow,
  type SiteRow,
  type VoiceTokenResponse,
} from '@sitelog/shared';
import { effectiveBilling, isBillingBlocked } from '../_shared/billing.ts';
import { formatIssues } from '../_shared/http.ts';
import { errorMessage, logError } from '../_shared/log.ts';
import type { AppClient } from '../_shared/supabase.ts';
import { FieldError, retryAfterSeconds } from './logic.ts';
import { FieldDbError } from './store.ts';

/**
 * Talk now (W3-13; spec §9.3 Today, §9.4 "How a call starts", Appendix B `POST /field/voice/token`,
 * §19 Q121, Q157). A browser call from the recorder to the voice agent over WebRTC:
 *
 * - `talkNowAvailable()`: what `resolve` and `today` answer as `talkNow` (Q121): this environment
 *   has LiveKit configured (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) and the org is
 *   not billing-blocked (canceled, paused, or past due beyond its grace days: the scheduler's rule,
 *   `isBillingBlocked`). Every reporter sees it.
 * - `POST voice/token {siteId}`: link code + verified device + the recording and data-processing
 *   consents (the call is recorded and processed) + one of the link's active sites (a photos link
 *   takes photos only, F9: 400 `kind_not_allowed`); 3 starts an
 *   hour per device. Creates the `calls` row (`field_talk_now_start()`: web, inbound, queued,
 *   audited `call.requested`), the room `call-{callId}` with the call id in its metadata, the
 *   explicit dispatch of `LIVEKIT_AGENT_NAME`, and the participant token (identity the call id,
 *   never the phone). LiveKit failing ends the call at once (`field_talk_now_failed()`) and answers
 *   502 `voice_unavailable`. The agent then starts the call with `POST /voice/calls/start {room,
 *   callId, transport: web}` (W3-03), and `voice-events` finds the row by its room (W3-04).
 *
 * Its own module (field-api's `app.ts` mounts it), with its own store and the `LiveKitApi`
 * interface: Twirp over `fetch` with WebCrypto tokens in production, `FakeLiveKitApi` in tests.
 */

// ───────────────────────────── LiveKit ─────────────────────────────

/** The LiveKit calls Talk now needs (RoomService.CreateRoom, AgentDispatchService.CreateDispatch). */
export interface LiveKitApi {
  /** The project's WebSocket URL the browser connects to (`LIVEKIT_URL`). */
  readonly url: string;
  createRoom(input: { name: string; metadata: string; emptyTimeoutS: number }): Promise<void>;
  dispatchAgent(input: { room: string; agentName: string; metadata: string }): Promise<void>;
  /** The browser's token for its one room (identity the call id). */
  participantToken(input: { room: string; callId: string }): Promise<string>;
}

/**
 * The LiveKit config from env, or null when any of the three is unset (then no Talk now here).
 * A URL that is not ws(s)/http(s) counts as unset (`liveKitConfigFrom`, shared with the worker's
 * outbound calls, W3-17).
 */
export function liveKitConfig(env: (name: string) => string | undefined): LiveKitConfig | null {
  return liveKitConfigFrom(env);
}

export { LiveKitApiError, type LiveKitConfig };

/** How long LiveKit keeps a Talk now room nobody joined (then `room_finished`: the backstop). */
export const TALK_NOW_EMPTY_TIMEOUT_S = 120;

/** LiveKit's Twirp API with short server tokens minted here (no SDK; `liveKitTwirp`, shared). */
export function liveKitHttpApi(
  cfg: LiveKitConfig,
  opts: { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number } = {},
): LiveKitApi {
  const call = liveKitTwirp(cfg, opts);
  const now = opts.now ?? (() => new Date());
  async function twirp(
    service: string,
    method: string,
    body: unknown,
    video: LiveKitVideoGrant,
  ): Promise<void> {
    // The body is LiveKit's (room or dispatch info): nothing in it is needed.
    await call(service, method, body, { video });
  }
  return {
    url: cfg.url,
    createRoom: ({ name, metadata, emptyTimeoutS }) =>
      twirp(
        'RoomService',
        'CreateRoom',
        { name, metadata, empty_timeout: emptyTimeoutS },
        { roomCreate: true },
      ),
    dispatchAgent: ({ room, agentName, metadata }) =>
      twirp(
        'AgentDispatchService',
        'CreateDispatch',
        { room, agent_name: agentName, metadata },
        { roomAdmin: true, room },
      ),
    participantToken: ({ room, callId }) =>
      talkNowParticipantToken({
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        room,
        callId,
        now: now(),
      }),
  };
}

// ───────────────────────────── Store ─────────────────────────────

export interface OrgBilling {
  billingStatus: string | null;
  /** When the org last went past due (the audited `billing.status_changed`), if it is. */
  pastDueSince: string | null;
  graceDays: number;
  /** §19 Q235 `block`: a lapsed trial blocks at once. */
  noGrace?: boolean;
}

export interface TalkNowStore {
  orgBilling(orgId: string): Promise<OrgBilling>;
  /** field_talk_now_start(): the call row and its room name; refusals throw FieldDbError. */
  startTalkNow(input: {
    reporterId: string;
    siteId: string;
    deviceId: string;
  }): Promise<{ callId: string; room: string }>;
  /** field_talk_now_failed(): the call ends at once (failed, not_reached). */
  failTalkNow(callId: string, reason: string): Promise<void>;
}

const TALK_NOW_DB_ERRORS = [
  'reporter_disabled',
  'site_not_found',
  'wrong_state',
  'consent_required',
  'call_not_found',
  'invalid_request',
] as const;

/** TalkNowStore on the service-role client (field-api in production). */
export function supabaseTalkNowStore(admin: AppClient): TalkNowStore {
  async function rpc<T>(
    call: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T> {
    const { data, error } = await call;
    if (error) {
      if ((TALK_NOW_DB_ERRORS as readonly string[]).includes(error.message)) {
        throw new FieldDbError(error.message);
      }
      throw new Error(`field-api rpc: ${error.message}`);
    }
    return data as T;
  }
  return {
    async orgBilling(orgId) {
      const [{ data: org }, { data: settings }] = await Promise.all([
        admin
          .from('orgs')
          .select(
            'billing_status, trial_ends_at, billing_provider, billing_subscription_id, is_demo',
          )
          .eq('id', orgId)
          .single()
          .throwOnError(),
        admin
          .from('org_settings')
          .select('past_due_grace_days')
          .eq('org_id', orgId)
          .maybeSingle()
          .throwOnError(),
      ]);
      let pastDueSince: string | null = null;
      if (org.billing_status === 'past_due') {
        const { data } = await admin
          .from('audit_log')
          .select('created_at')
          .eq('org_id', orgId)
          .eq('action', 'billing.status_changed')
          .eq('diff->>to', 'past_due')
          .order('created_at', { ascending: false })
          .limit(1)
          .throwOnError();
        pastDueSince = data[0]?.created_at ?? null;
      }
      // W4-10 (§19 Q235): a trial that ended with no subscription is past due from its end.
      const state = effectiveBilling({ ...org, past_due_since: pastDueSince }, new Date());
      return {
        billingStatus: state.status,
        pastDueSince: state.pastDueSince,
        noGrace: state.noGrace,
        graceDays: settings?.past_due_grace_days ?? 14,
      };
    },
    startTalkNow: ({ reporterId, siteId, deviceId }) =>
      rpc(
        admin.rpc('field_talk_now_start', {
          p_reporter_id: reporterId,
          p_site_id: siteId,
          p_device_id: deviceId,
        }),
      ),
    async failTalkNow(callId, reason) {
      await rpc(admin.rpc('field_talk_now_failed', { p_call_id: callId, p_reason: reason }));
    },
  };
}

// ───────────────────────────── Routes ─────────────────────────────

export interface TalkNowDeps {
  store: TalkNowStore;
  /** LiveKit when configured here, else null (no Talk now: `talkNow` false, the route 403). */
  livekit: () => LiveKitApi | null;
  /** LIVEKIT_AGENT_NAME (default `sitelog-voice`). */
  agentName: () => string;
  now: () => Date;
}

/** Q121: LiveKit configured here and the org not billing-blocked. */
export async function talkNowAvailable(deps: TalkNowDeps, orgId: string): Promise<boolean> {
  if (!deps.livekit()) return false;
  const billing = await deps.store.orgBilling(orgId);
  return !isBillingBlocked(billing, deps.now(), billing.graceDays);
}

/** What `voice/token` needs from field-api's authentication (`app.ts`). */
export interface TalkNowAuth {
  authenticate: (c: Context) => Promise<{
    link: Pick<FieldLinkRow, 'kind'>;
    reporter: ReporterRow;
    device: FieldDeviceRow;
  }>;
  /** The site a write is for: one of the link's active sites (404, 409 `site_inactive`). */
  writeSite: (c: Context, siteId: string) => SiteRow;
  rateLimit: (
    key: string,
    limit: number,
    windowSeconds: number,
  ) => Promise<{ allowed: boolean; resetAt: string }>;
}

// deno-lint-ignore no-explicit-any
type AnyHono = Hono<any>;

export function registerTalkNowRoutes(app: AnyHono, deps: TalkNowDeps, auth: TalkNowAuth): void {
  app.post('/voice/token', async (c) => {
    const ctx = await auth.authenticate(c);
    // A photos link takes photos only (F9), as `uploads` refuses its voice notes.
    if (ctx.link.kind === 'photos') {
      throw new FieldError(400, 'kind_not_allowed', 'A photos link takes photos only (F9)');
    }
    const livekit = deps.livekit();
    if (!livekit || !(await talkNowAvailable(deps, ctx.reporter.org_id))) {
      throw new FieldError(403, 'talk_now_unavailable');
    }
    let raw: unknown = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new FieldError(400, 'invalid_request', 'Body must be valid JSON');
      }
    }
    const parsed = VoiceTokenRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FieldError(400, 'invalid_request', 'Invalid request', {
        details: formatIssues(parsed.error),
      });
    }
    const site = auth.writeSite(c, parsed.data.siteId);

    const { limit, windowSeconds } = FIELD_RATE_LIMITS.talkNow;
    const rl = await auth.rateLimit(`talk:${ctx.device.id}`, limit, windowSeconds);
    if (!rl.allowed) {
      throw new FieldError(429, 'rate_limited', undefined, {
        retryAfter: retryAfterSeconds(rl.resetAt, deps.now()),
      });
    }

    const { callId, room } = await deps.store.startTalkNow({
      reporterId: ctx.reporter.id,
      siteId: site.id,
      deviceId: ctx.device.id,
    });
    // The agent reads the call id from the room or the dispatch; nothing else (no name, no number).
    const metadata = JSON.stringify({ callId, transport: 'web' });
    let token: string;
    try {
      await livekit.createRoom({
        name: room,
        metadata,
        emptyTimeoutS: TALK_NOW_EMPTY_TIMEOUT_S,
      });
      await livekit.dispatchAgent({ room, agentName: deps.agentName(), metadata });
      token = await livekit.participantToken({ room, callId });
    } catch (err) {
      logError('field-api.talk_now.livekit', err, { callId, message: errorMessage(err) });
      await deps.store.failTalkNow(callId, 'livekit_unavailable');
      throw new FieldError(502, 'voice_unavailable');
    }
    const body: VoiceTokenResponse = { livekitUrl: livekit.url, token, room, callId };
    return c.json(body, 201);
  });
}
