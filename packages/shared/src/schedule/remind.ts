import { IMPLEMENTED_MESSAGE_CHANNELS, messageChannelOrder } from '../channels.ts';
import { messageKeyHasLink } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import {
  isActiveReporterStatus,
  type ConsentType,
  type ContactPref,
  type MessageChannel,
} from '../enums.ts';
import { addDays, formatDateInTz, formatTimeInTz } from '../format.ts';
import { noCallsToday } from '../voice-outbound.ts';
import { deadlineInstant } from './reminders.ts';

/**
 * §7.4 / F11 reminder decisions (spec §4.5 `remind(reporter, pack, stage)`: "pure decision
 * function (M6), unit-tested"; W2-05). For one reporter of one site-day and one ladder stage, what
 * TalkOlog does: a message (its §9.2 key), an outbound call, or nothing (with the reason, so the
 * caller can audit it). `scheduler-tick` asks it per reporter when it claims a stage (W2-06).
 *
 * The stages a reporter hears about are the daily link, the weather heads-up, R1 and R2; the
 * missing step is the office's (`planMissing`). The daily link is not a `site_days.reminder_stage`
 * value (§6.3 numbers 1–4 only): it is tracked by its Notifier dedupe key
 * `notify:daily_link:<site_day>:<reporter>` (`ladderDedupeKey`).
 *
 * What decides:
 * - the stage's enabled flag (`org_settings.heads_up_enabled`, `reminder1/2_enabled`);
 * - the reporter: active only (`reporters.status`), and `contact_pref` (`link` or `call`);
 * - the pack: its channel order (`message_channels`, the person's `message_channel` first) and
 *   links in SMS (`sms_links_allowed`, §19 Q24): a key with a link needs a built channel that may
 *   carry it. Two-way SMS never matters here (no ladder text carries a reply instruction), and
 *   the voice number only picks `reminder_2`'s variant with "or call {number}", which `renderSms`
 *   does from the pack (`smsRenderOptions`);
 * - whether the org places calls (W3-17, spec §19 Q51, Q125, Q132: a pack with an outbound trunk
 *   here, or a demo org on the `console` telephony), and for a call the org's `auto_call_enabled`,
 *   the reporter's own `auto_call` consent (§19 Q131), the call window and "Don't call me today"
 *   (`reporters.no_calls_until`, §19 Q129: the messages a link reporter gets instead);
 * - weather: the heads-up only when the 12:00 or 16:30 snapshot observed weather;
 * - two owner questions, as parameters with the defaults the owner decided on 2026-10-16
 *   (`REMIND_POLICY_DEFAULTS`):
 *   spec §19 Q76 (the daily link for call-preferring reporters while no call is placed), Q77
 *   (ladder messages that fall outside the quiet hours, which are the org's call window, Q30) and
 *   Q130 (`call_coming` at the daily-link time only when the R1 call will really be placed).
 *
 * Consent and opt-out for a message are the Notifier's, at send time (`deliverableChannels`): it
 * audits `notify.skipped` with the reason. `remind()` does not repeat them.
 */

/** The ladder stages a reporter hears about (the missing step is the office's). */
export const REMIND_STAGES = ['daily_link', 'heads_up', 'reminder_1', 'reminder_2'] as const;
export type RemindStage = (typeof REMIND_STAGES)[number];

/** The §9.2 key of each stage's message. */
export const REMIND_STAGE_KEY = {
  daily_link: 'daily_link',
  heads_up: 'weather_headsup',
  reminder_1: 'reminder_1',
  reminder_2: 'reminder_2',
} as const satisfies Record<RemindStage, string>;
/**
 * The keys a ladder stage sends: the stage's own, and `call_coming` at the daily-link time for a
 * call reporter whose R1 call will be placed (W3-17, §19 Q130).
 */
export type RemindKey = (typeof REMIND_STAGE_KEY)[RemindStage] | 'call_coming';

/** The `site_days.reminder_stage` value a stage sets (the daily link sets none). */
export const REMIND_STAGE_NUMBER: Readonly<Record<RemindStage, number | null>> = {
  daily_link: null,
  heads_up: 1,
  reminder_1: 2,
  reminder_2: 3,
};

/** Why a reporter gets nothing at a stage (audited with the stage's claim, W2-06). */
export const REMIND_SKIP_REASONS = [
  /** The org turned the stage off (`heads_up_enabled`, `reminder1/2_enabled`). */
  'stage_disabled',
  /** The reporter is not active (invited, opted out, disabled). */
  'inactive',
  /** The heads-up with no weather observed today. */
  'no_weather',
  /**
   * A call reporter at the daily-link time whose call comes at R1 with §19 Q130 set to `none`, or
   * with no call coming and §19 Q76 set to `none`.
   */
  'call_reporter',
  /** No built channel of the order may carry the key (e.g. a link where the pack forbids links). */
  'no_channel',
  /** Outside the quiet hours (the org's call window, §19 Q30), per §19 Q77 `skip`. */
  'quiet_hours',
] as const;
export type RemindSkipReason = (typeof REMIND_SKIP_REASONS)[number];

export type RemindAction =
  /**
   * Send `key` through the Notifier. `channels` would narrow the order; the ladder leaves the
   * order to the Notifier (the person's preference, then the pack's), so it is never set today.
   */
  | { kind: 'message'; key: RemindKey; channels?: readonly MessageChannel[] }
  /**
   * Place an outbound call (`calls.purpose 'reminder'`, M8); `message` goes out as well (R2:
   * "second call … plus a message", §7.4).
   */
  | { kind: 'call'; purpose: 'reminder'; message?: RemindKey }
  | { kind: 'none'; reason: RemindSkipReason };

/**
 * The two owner questions as parameters (W2-05). The defaults are the plan's recommendations,
 * decided 2026-10-16 by the owner as built (spec §19 Q76, Q77).
 */
export interface RemindPolicy {
  /**
   * §19 Q76: what a call-preferring reporter gets at the daily-link time while their pack places no
   * outbound calls. `daily_link`: the same 17:00 link as link reporters (recommended);
   * `none`: nothing until R1, as §7.4 reads with calls. Never `call_coming` before M8: it
   * promises a call nobody places.
   */
  callReporterDailyLink: 'daily_link' | 'none';
  /**
   * §19 Q130 (W3-17): what a call reporter gets at the daily-link time when the R1 call will
   * really be placed (calls placed, `auto_call`, R1 inside the window, not "Don't call me
   * today"). `call_coming`: "I'll call you at {time}…" with the link (recommended); `none`.
   */
  callComing: 'call_coming' | 'none';
  /**
   * §19 Q77: a ladder message (daily link, heads-up, R1, R2; W2-07's nudge) that would go out
   * outside the quiet-hours window. `skip`: not sent, audited (recommended); `send`: sent anyway.
   * Messages that answer the reporter's own action (device code, filed, edit applied, a reply)
   * never pass through `remind()` and always go out.
   */
  quietHours: 'skip' | 'send';
}

export const REMIND_POLICY_DEFAULTS: RemindPolicy = {
  callReporterDailyLink: 'daily_link',
  callComing: 'call_coming',
  quietHours: 'skip',
};

/** The window outside which the ladder is quiet: the org's `call_window_*` (§19 Q30). */
export interface QuietWindow {
  /** "HH:MM" or "HH:MM:SS", site time (`org_settings.call_window_start`, default 07:00). */
  start: string;
  /** "HH:MM" or "HH:MM:SS", site time (`org_settings.call_window_end`, default 20:00). */
  end: string;
}

/** The column defaults of `org_settings.call_window_start/end` (20261013000007), for nulls. */
export const DEFAULT_CALL_WINDOW: QuietWindow = { start: '07:00', end: '20:00' };
/** The column default of `org_settings.daily_link_time` (20261013000007), for a null. */
export const DEFAULT_DAILY_LINK_TIME = '17:00';

/** The org's ladder flags `remind()` reads. */
export interface RemindSettings {
  headsUpEnabled: boolean;
  reminder1Enabled: boolean;
  reminder2Enabled: boolean;
  /** `org_settings.second_call_enabled` (null = the column default, true). */
  secondCallEnabled: boolean;
  /** `org_settings.auto_call_enabled` (W3-17; omitted = the column default, true). */
  autoCallEnabled?: boolean;
  callWindow: QuietWindow;
}

export interface RemindReporter {
  status: string;
  contactPref: ContactPref;
  /** `reporters.message_channel`; null = the pack's order. */
  messageChannel: MessageChannel | null;
  /** Unrevoked consent types; only `auto_call` matters here (message consent is the Notifier's). */
  consents: ReadonlySet<ConsentType>;
  /** §19 Q129 (W3-17): `reporters.no_calls_until`; while it is ahead, no calls ("not today"). */
  noCallsUntil?: Date | string | null;
}

export interface RemindContext {
  /** When the stage runs. */
  now: Date;
  /** The site's IANA time zone: the call window is wall-clock time at the site. */
  tz: string;
  settings: RemindSettings;
  /** The site-day's snapshot observed weather (`isWeatherObserved`). */
  weatherObserved: boolean;
  /**
   * Whether the org places outbound calls (W3-17, `placesCalls()`: an outbound trunk in the pack
   * here, or a demo org's `console` calls; spec §19 Q51, Q125, Q132). Without it, never a `call`.
   */
  outboundTrunk: boolean;
  /**
   * When R1 runs (the deadline + `reminder1_offset_min`): at the daily-link time the R1 call is
   * announced (`call_coming`, §19 Q130) only if R1 falls inside the call window and before the
   * end of "not today". Omitted: `now`.
   */
  r1At?: Date;
  /** Built message channels (default `IMPLEMENTED_MESSAGE_CHANNELS`). */
  implemented?: readonly MessageChannel[];
  policy?: RemindPolicy;
}

/** Wall-clock "HH:MM" of a time column ("17:00:00" → "17:00"). */
function hhmm(time: string): string {
  return time.slice(0, 5);
}

/**
 * Whether `now` is inside the window at the site (start inclusive, end exclusive). A window whose
 * end is before its start runs over midnight; an empty window (start = end) contains nothing.
 * Local wall-clock time through the site's time zone, so a DST day moves nothing.
 */
export function insideWindow(now: Date, tz: string, window: QuietWindow): boolean {
  const t = formatTimeInTz(now, tz);
  const start = hhmm(window.start);
  const end = hhmm(window.end);
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * The built channels of the reporter's order that may carry `key`: the person's preference first
 * when the pack offers it, then the pack's order (`messageChannelOrder`), with SMS dropped for a
 * key with a link when the pack forbids links in SMS (§19 Q24). Consent and opt-out are left to
 * the Notifier.
 */
export function remindChannels(
  pack: CountryPack,
  reporter: Pick<RemindReporter, 'messageChannel'>,
  key: RemindKey,
  implemented: readonly MessageChannel[] = IMPLEMENTED_MESSAGE_CHANNELS,
): MessageChannel[] {
  return messageChannelOrder(pack, reporter.messageChannel).filter(
    (c) =>
      implemented.includes(c) && (c !== 'sms' || !messageKeyHasLink(key) || pack.smsLinksAllowed),
  );
}

/** The §7.4 decision for one reporter, pack and stage (see the module comment). */
export function remind(
  reporter: RemindReporter,
  pack: CountryPack,
  stage: RemindStage,
  ctx: RemindContext,
): RemindAction {
  const policy = ctx.policy ?? REMIND_POLICY_DEFAULTS;
  const s = ctx.settings;
  if (
    (stage === 'heads_up' && !s.headsUpEnabled) ||
    (stage === 'reminder_1' && !s.reminder1Enabled) ||
    (stage === 'reminder_2' && !s.reminder2Enabled)
  ) {
    return { kind: 'none', reason: 'stage_disabled' };
  }
  if (!isActiveReporterStatus(reporter.status)) return { kind: 'none', reason: 'inactive' };
  if (stage === 'heads_up' && !ctx.weatherObserved) return { kind: 'none', reason: 'no_weather' };

  const inWindow = insideWindow(ctx.now, ctx.tz, s.callWindow);
  const message = (key: RemindKey): RemindAction => {
    if (remindChannels(pack, reporter, key, ctx.implemented).length === 0) {
      return { kind: 'none', reason: 'no_channel' };
    }
    if (!inWindow && policy.quietHours === 'skip') return { kind: 'none', reason: 'quiet_hours' };
    return { kind: 'message', key };
  };

  if (reporter.contactPref === 'call') {
    // Calls only where the org places them, with its switch on, the reporter's own auto_call
    // consent, inside the call window and not on a "Don't call me today" day (F11, §19 Q129, Q131).
    const callsAt = (when: Date) =>
      ctx.outboundTrunk &&
      s.autoCallEnabled !== false &&
      reporter.consents.has('auto_call') &&
      insideWindow(when, ctx.tz, s.callWindow) &&
      !noCallsToday(reporter.noCallsUntil, when);
    const canCall = callsAt(ctx.now);
    switch (stage) {
      case 'daily_link':
        // §19 Q130: "I'll call you at {time}" only when the R1 call will really be placed;
        // otherwise the daily link as before (§19 Q76).
        if (callsAt(ctx.r1At ?? ctx.now)) {
          return policy.callComing === 'call_coming'
            ? message('call_coming')
            : { kind: 'none', reason: 'call_reporter' };
        }
        if (policy.callReporterDailyLink === 'none') {
          return { kind: 'none', reason: 'call_reporter' };
        }
        return message('daily_link');
      case 'heads_up':
        return message('weather_headsup');
      case 'reminder_1':
        // §7.4: an outbound call if auto-call consent and inside the call window, else a message.
        return canCall ? { kind: 'call', purpose: 'reminder' } : message('reminder_1');
      case 'reminder_2': {
        // §7.4: a second call if `second_call_enabled`, plus a message.
        if (canCall && s.secondCallEnabled) {
          const text = message('reminder_2');
          return text.kind === 'message'
            ? { kind: 'call', purpose: 'reminder', message: 'reminder_2' }
            : { kind: 'call', purpose: 'reminder' };
        }
        return message('reminder_2');
      }
    }
  }
  return message(REMIND_STAGE_KEY[stage]);
}

/**
 * When the quiet hours begin after `now`: the next instant the site's wall clock reads the
 * window's end (today's, or tomorrow's once today's has passed). A ladder message queued inside
 * the window carries it as its guard's `notAfter` (W2-06, §19 Q77 `skip`), so a job still waiting
 * at that time (retries, a worker outage) sends nothing.
 */
export function windowEndAfter(now: Date, tz: string, window: QuietWindow): Date {
  const today = formatDateInTz(now, tz);
  const end = deadlineInstant(today, hhmm(window.end), tz);
  return end.getTime() > now.getTime()
    ? end
    : deadlineInstant(addDays(today, 1), hhmm(window.end), tz);
}

/** When the daily link is due: `daily_link_time` (default 17:00) on the site-day's date, site time. */
export function dailyLinkInstant(date: string, dailyLinkTime: string | null, tz: string): Date {
  return deadlineInstant(date, dailyLinkTime ?? DEFAULT_DAILY_LINK_TIME, tz);
}

/**
 * Whether the daily link is due now (W2-06): from `dailyLinkAt` while the day has not reached R1
 * (`reminder_stage` below 2). A tick that finds both due (the first tick after an outage, or a
 * daily link time after R1's) sends the daily link first, then R1. Whether it went out already is
 * its claim's business (once per site-day).
 */
export function dailyLinkDue(input: {
  now: Date;
  dailyLinkAt: Date;
  currentStage: number;
}): boolean {
  return input.now.getTime() >= input.dailyLinkAt.getTime() && input.currentStage < 2;
}

/**
 * The Notifier dedupe key of a ladder message (and its `notify` job's key): per key, site-day and
 * reporter, so each stage texts each reporter once (`notify:daily_link:<site_day>:<reporter>`).
 * The claim RPC builds the same key in SQL (`claim_site_day_reminder`, W2-06).
 */
export function ladderDedupeKey(key: RemindKey, siteDayId: string, reporterId: string): string {
  return `notify:${key}:${siteDayId}:${reporterId}`;
}
