import type { CountryPack } from './countries.ts';
import type { CallStatus } from './enums.ts';

/**
 * Outbound reminder calls (W3-17, M8; spec §7.4, F6 step 1, F11, §9.4 "Calls policy", §10.1
 * `place_call`, §19 Q125–Q132). Pure rules shared by scheduler-tick (which plans the calls),
 * field-api (`placesCalls`, callbacks) and the worker (`place_call`). Deno-safe.
 *
 * Who places calls (§19 Q51, Q125, Q132): a demo org always, on the `console` telephony (the call
 * rings the panel's Demo phone; no real phone is ever dialled for a demo org, §19 Q116); a real
 * org when its pack has an outbound trunk in this environment (`countries.outbound_trunk_id`), on
 * LiveKit (`CreateSIPParticipant` on that trunk, the pack's voice number as the caller id, §19
 * Q126). The SQL twin is `org_places_calls()` (20261016000380).
 */

/** How an outbound call is placed. */
export const TELEPHONY_DRIVERS = ['livekit', 'console'] as const;
export type TelephonyDriver = (typeof TELEPHONY_DRIVERS)[number];

/** Whether the org places automated calls (§19 Q51's `placesCalls`): demo, or a trunk here. */
export function placesCalls(
  org: { isDemo: boolean },
  pack: Pick<CountryPack, 'outboundTrunkId'>,
): boolean {
  return org.isDemo || pack.outboundTrunkId !== null;
}

/** The telephony an org's calls use (§19 Q132: `console` for a demo org), or null: none placed. */
export function telephonyFor(
  org: { isDemo: boolean },
  pack: Pick<CountryPack, 'outboundTrunkId'>,
): TelephonyDriver | null {
  if (org.isDemo) return 'console';
  return pack.outboundTrunkId !== null ? 'livekit' : null;
}

/**
 * The owner's decisions as parameters (§19 Q127, Q128; decided 2026-10-16 with the recommended
 * defaults). `maxConcurrent` is `VOICE_MAX_CONCURRENT_CALLS`' default (LiveKit Build: 5 agent
 * sessions, one kept for inbound calls and Talk now); a call waiting for capacity tries again
 * every `capacityWaitS` until `giveUpAfterMin` after its stage (then the stage's message,
 * audited `call.skipped capacity`). `ringTimeoutS`: how long the phone rings before no answer;
 * `consoleRingS`: how long a demo call rings in the Demo phone (`CONSOLE_CALL_RING_S`).
 */
export const OUTBOUND_CALL_POLICY = {
  maxConcurrent: 4,
  capacityWaitS: 60,
  giveUpAfterMin: 30,
  ringTimeoutS: 30,
  consoleRingS: 30,
  /** §9.4 "max call 12 min". */
  maxCallS: 12 * 60,
} as const;

/** The calls of a site-day (§19 Q128): R1, R2 (with `second_call_enabled`) and one callback. */
export const OUTBOUND_CALL_STAGES = ['reminder_1', 'reminder_2', 'callback'] as const;
export type OutboundCallStage = (typeof OUTBOUND_CALL_STAGES)[number];

/** `calls.attempt` of each stage (R1 = 1, R2 = 2, the callback = 3; one each per site-day). */
export const OUTBOUND_CALL_ATTEMPT: Readonly<Record<OutboundCallStage, 1 | 2 | 3>> = {
  reminder_1: 1,
  reminder_2: 2,
  callback: 3,
};

/** The `place_call` job of a stage: `call:<site_day>:<reporter>:<stage>` (`:w<n>` while waiting). */
export function outboundCallKey(
  siteDayId: string,
  reporterId: string,
  stage: OutboundCallStage,
  wait = 0,
): string {
  const base = `call:${siteDayId}:${reporterId}:${stage}`;
  return wait > 0 ? `${base}:w${wait}` : base;
}

/** The `missed_call` step of a call not reached (`place_call {phase: missed}`). */
export const missedCallJobKey = (callId: string) => `call_missed:${callId}`;
/** The end of a console call's ring (`place_call {phase: ring_end}`). */
export const ringEndJobKey = (callId: string) => `call_ring:${callId}`;
/** The `missed_call` text's Notifier key: one per call. */
export const missedCallNotifyKey = (callId: string) => `notify:missed_call:${callId}`;

/** Why a call was not placed (audited `call.skipped`; `outbound_call_start()` answers most). */
export const CALL_SKIP_REASONS = [
  /** The day was filed, is being reported, closed, or its reminders were paused. */
  'stale_stage',
  /** Outside the org's call window at the site (§9.4), or past the stage's `notAfter`. */
  'outside_window',
  'inactive',
  /** A ladder call for a reporter who now prefers a link. */
  'not_call_reporter',
  /** §19 Q131: no `auto_call` consent of the reporter's own. */
  'no_consent',
  /** §19 Q129: "Don't call me today". */
  'no_calls_today',
  /** Neither a demo org nor a pack with an outbound trunk here (§19 Q38, Q125). */
  'no_trunk',
  /** The org turned automated calls off (`org_settings.auto_call_enabled`, M10's control). */
  'org_calls_off',
  /** LiveKit is not configured in this environment (a trunk without `LIVEKIT_*`). */
  'telephony_unavailable',
  /** §19 Q128: the attempt was used already. */
  'attempt_used',
  /** §19 Q127: no capacity until the stage's give-up time. */
  'capacity',
] as const;
export type CallSkipReason = (typeof CALL_SKIP_REASONS)[number];

/**
 * Whether a skipped ladder call becomes the stage's message (R1's `reminder_1`; R2's message went
 * with the claim): the reporter would hear nothing otherwise (§19 Q127, Q129: "the ladder then
 * sends the messages a link reporter gets"). Not for a day that left the ladder, the quiet hours,
 * an inactive reporter or an attempt already used. A callback never falls back to a message.
 */
export function skipSendsMessage(reason: CallSkipReason): boolean {
  return [
    'not_call_reporter',
    'no_consent',
    'no_calls_today',
    'no_trunk',
    'org_calls_off',
    'telephony_unavailable',
    'capacity',
  ].includes(reason);
}

/**
 * Team's _Call now_ (W4-04; spec F3 edge cases, P10, §19 Q230, Q330; the recommended defaults
 * until the owner answers): admin and ops, only where the org places calls, after the office's
 * attestation that the person agreed to get calls from TalkOlog for the daily report, stored as an
 * `auto_call` consent `office_attested` (the office user and `attestVersion`). One call (purpose
 * `daily_report`) inside the site's call window, refused when the day is filed or a call to the
 * reporter is live; outside §19 Q128's ladder attempts (`calls.attempt` null) and at most
 * `maxPerDay` a site-day and reporter (§19 Q330); no `missed_call` text when it is not reached
 * (the office sees the outcome on Team). The ladder never uses the attestation (§19 Q131). The
 * SQL twin is `office_call_start()` (20261017000500).
 */
export const OFFICE_CALL_POLICY = {
  roles: ['admin', 'ops'],
  maxPerDay: 3,
  /** The attestation's wording version (`consents.text_version`). */
  attestVersion: 'team.call_now.v1',
  missedCallText: false,
} as const;

/** Why office_call_start() placed no call (`{status: 'refused', reason}`); the panel words each. */
export const OFFICE_CALL_REFUSALS = [
  'attestation_required',
  /** Neither a demo org nor a pack with an outbound trunk here. */
  'no_trunk',
  /** Disabled, or opted out of texts. */
  'reporter_inactive',
  /** The reporter turned automated calls off themselves (their own `auto_call` revoked). */
  'calls_turned_off',
  /** §19 Q129: "Don't call me today". */
  'no_calls_today',
  'site_not_active',
  /** §9.4: outside the org's call window at the site. */
  'outside_window',
  /** Today's report is filed (or a weather day, or no work). */
  'day_filed',
  /** A call to the reporter is queued, ringing or in progress. */
  'call_live',
  /** §19 Q330: `maxPerDay` office calls today already. */
  'limit_reached',
] as const;
export type OfficeCallRefusal = (typeof OFFICE_CALL_REFUSALS)[number];

/** What office_call_start() answers. */
export type OfficeCallStart =
  | { status: 'requested'; callId: string; consentId: string; siteDayId: string }
  | { status: 'refused'; reason: OfficeCallRefusal };

/** The `place_call {phase: office}` job of the nth office call of a site-day and reporter. */
export function officeCallKey(siteDayId: string, reporterId: string, n: number): string {
  return `call:${siteDayId}:${reporterId}:office:${n}`;
}

/**
 * Whether a `calls` row is an office _Call now_ (W4-04): an outbound call about the daily report
 * (the ladder's are `reminder`, the callback's `callback`).
 */
export function isOfficeCall(call: { direction: string; purpose: string | null }): boolean {
  return call.direction === 'outbound' && call.purpose === 'daily_report';
}

/**
 * Settings' _Call me now_ (W4-05; spec P12, §19 Q232's recommended default, §19 Q350): an admin's
 * short scripted test call to a number typed in the sheet and attested as their own (never stored:
 * the call row holds it only until the dial, every audit row has it masked), only where the org
 * places calls. The agent says the disclosure, one line and goodbye, records nothing and offers no
 * report tool. At most `maxPerHour` an org (its own budget beside the test message's) and one at a
 * time; no call window (the admin asks for a call to their own phone, now). The SQL twin is
 * `settings_test_call_start()` (20261017000530).
 */
export const SETTINGS_TEST_CALL_POLICY = {
  roles: ['admin'],
  maxPerHour: 5,
  /** `calls.purpose` of a test call. */
  purpose: 'settings_test',
  /** A test call not dialled within this long is dropped (`stale`). */
  staleAfterMin: 10,
} as const;

/** Why settings_test_call_start() placed no call (`{status: 'refused', reason}`). */
export const SETTINGS_TEST_CALL_REFUSALS = [
  'attestation_required',
  'invalid_phone',
  /** Neither a demo org nor a pack with an outbound trunk here. */
  'no_trunk',
  /** A test call of the org is queued, ringing or in progress. */
  'call_live',
  /** `maxPerHour` test calls in the last hour. */
  'rate_limited',
] as const;
export type SettingsTestCallRefusal = (typeof SETTINGS_TEST_CALL_REFUSALS)[number];

/** What settings_test_call_start() answers. */
export type SettingsTestCallStart =
  | { status: 'requested'; callId: string; telephony: TelephonyDriver }
  | { status: 'refused'; reason: SettingsTestCallRefusal; retry_at?: string };

/** The `place_call {phase: settings_test}` job of a test call. */
export const settingsTestCallKey = (callId: string) => `call:settings_test:${callId}`;

/** Whether a `calls` row is Settings' test call (W4-05): outbound, purpose `settings_test`. */
export function isSettingsTestCall(call: { direction: string; purpose: string | null }): boolean {
  return call.direction === 'outbound' && call.purpose === SETTINGS_TEST_CALL_POLICY.purpose;
}

/**
 * The reporter's own consents (§19 Q131, W4-04): the office's `auto_call` attestation allows only
 * the office's Call now, so it never counts as the reporter's consent where the reporter's own is
 * read (the recorder's Settings and Welcome, the call's context).
 */
export function reporterOwnConsents<T extends { type: string; method?: string | null }>(
  rows: readonly T[],
): T[] {
  return rows.filter((r) => !(r.type === 'auto_call' && r.method === 'office_attested'));
}

/** How Team and Site detail word a call's progress (W4-04), from `calls.status`. */
export type CallProgress = 'requested' | 'ringing' | 'answered' | 'not_reached' | 'failed';

export function callProgress(status: CallStatus): CallProgress {
  switch (status) {
    case 'queued':
      return 'requested';
    case 'ringing':
      return 'ringing';
    case 'in_progress':
    case 'completed':
      return 'answered';
    case 'failed':
      return 'failed';
    default:
      return 'not_reached';
  }
}

/** How a dial that never reached the reporter ended (`calls.status`). */
export type UnansweredStatus = Extract<CallStatus, 'no_answer' | 'busy' | 'failed' | 'voicemail'>;

/**
 * The status of a SIP dial that failed, from its SIP status code (LiveKit's
 * `CreateSIPParticipant` with `wait_until_answered` answers it in the error's `sip_status_code`):
 * busy (486, 600, 603 declined), no answer (408, 480, 487), else failed (the trunk, a bad number).
 */
export function unansweredStatusOf(sipStatus: number | null): UnansweredStatus {
  if (sipStatus === 486 || sipStatus === 600 || sipStatus === 603) return 'busy';
  if (sipStatus === 408 || sipStatus === 480 || sipStatus === 487) return 'no_answer';
  return 'failed';
}

/**
 * After a call not reached (F6 step 1, F11): `missed_call` when the phone rang (no answer, busy,
 * a voicemail greeting; §19 Q128 "a voicemail or no answer uses the attempt"), the stage's own
 * message when the dial failed before ringing (the trunk, LiveKit), since "missed you" would be
 * untrue.
 */
export function afterUnanswered(status: UnansweredStatus): 'missed_call' | 'stage_message' {
  return status === 'failed' ? 'stage_message' : 'missed_call';
}

/** §19 Q129: "Don't call me today" holds at `now` (`reporters.no_calls_until`). */
export function noCallsToday(noCallsUntil: string | Date | null | undefined, now: Date): boolean {
  if (!noCallsUntil) return false;
  const until =
    typeof noCallsUntil === 'string' ? Date.parse(noCallsUntil) : noCallsUntil.getTime();
  return Number.isFinite(until) && until > now.getTime();
}

/** The LiveKit room metadata of an outbound call (the agent reads `callId`, W3-12). */
export function outboundRoomMetadata(callId: string): string {
  return JSON.stringify({ callId, transport: 'pstn', direction: 'outbound' });
}

/**
 * The M8 measure (§16.2: "≥ 85 % of call reporters' reports done by an outbound call without
 * office help"): per org and week, the site-days TalkOlog called a reporter about and the share
 * filed by the reporter's yes on such a call. null when nothing was called.
 */
export function outboundCallShare(row: {
  call_days: number;
  filed_by_call: number;
}): number | null {
  return row.call_days > 0 ? row.filed_by_call / row.call_days : null;
}

/** M8's target share (§16.2). */
export const M8_TARGET_SHARE = 0.85;
