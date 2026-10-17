import { renderVoice } from './copy/voice.ts';
import { formatTimeInTz } from './format.ts';
import type { Language } from './locale.ts';
import { insideWindow, type QuietWindow } from './schedule/remind.ts';
import type { DailyReportData } from './schemas/report.ts';
import { voiceNumber } from './voice-tools.ts';

/**
 * The special requests on a call (W3-14; spec F6 "Special intents during the call", §9.4 rule 6,
 * §9.5, F3, F10, F12, F13, F15, §19 Q120, Q124, Q128, Q129, Q136): the pure pieces field-api's
 * `voice_special.ts` answers with. Every line is code's, in the call language, with code's
 * numbers (the lost hours of a weather day come from `dayOffReportData`, never the model).
 * Node, browser and Deno (WebCrypto, Intl).
 */

/** §19 Q124: an unknown caller leaves at most this much recording … */
export const UNKNOWN_CALLER_MAX_RECORDING_S = 60;
/** … and a snippet this long on `unknown_contacts` (the office's Team alert) … */
export const UNKNOWN_CALLER_SNIPPET_MAX = 160;
/** … both deleted after this many days unless the office links the number. */
export const UNKNOWN_CALLER_RETENTION_DAYS = 30;

/**
 * §19 Q128 as a parameter: one callback the reporter asked for per site-day, inside the call
 * window, before the missing step. `available` is false until a pack places outbound calls
 * (W3-17): `schedule_callback` then answers 400 `not_available` and the agent says
 * `callback_unavailable`.
 */
export const VOICE_CALLBACK_POLICY = { available: false, perSiteDay: 1 } as const satisfies {
  available: boolean;
  perSiteDay: number;
};

/**
 * An unknown caller's words as the office reads them (F13 step 2): whitespace collapsed, at most
 * `UNKNOWN_CALLER_SNIPPET_MAX` characters (cut at a word, with "…"). Never sent to a model.
 */
export function unknownCallerSnippet(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length <= UNKNOWN_CALLER_SNIPPET_MAX) return flat;
  const cut = flat.slice(0, UNKNOWN_CALLER_SNIPPET_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > UNKNOWN_CALLER_SNIPPET_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * An unknown caller's recording in the `calls` bucket (§19 Q124): outside every org's folder, so
 * no office user reads it (a call's recording is `{org}/{call}.ogg`, `callRecordingPath`).
 */
export function unknownCallRecordingPath(callId: string): string {
  return `unknown/${callId}.ogg`;
}

/** F12's details as a call sends them (`set_day_status`). */
export interface CallDayOffDetails {
  since?: string;
  workersBefore?: number;
}

/**
 * The key of a day-off read-back (W3-14): SHA-256 (hex) of the call, the status and the details,
 * so the yes that comes back logs exactly what was read back; different details are a new
 * read-back. WebCrypto.
 */
export async function dayOffConfirmKey(input: {
  callId: string;
  status: 'no_work' | 'weather_day';
  details: CallDayOffDetails;
}): Promise<string> {
  const canonical = JSON.stringify([
    'sitelog/day_off/v1',
    input.callId.toLowerCase(),
    input.status,
    input.status === 'weather_day' ? (input.details.since ?? null) : null,
    input.status === 'weather_day' ? (input.details.workersBefore ?? null) : null,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The day off read back before it is logged (F12 call; §19 Q136's "No work today?"): the site,
 * and for a weather day when work stopped (or that the crew never started), the headcount said,
 * and the lost hours of the version code built (`dayOffReportData`). Ends with "Shall I log it?"
 * (or "Say yes or no." for no work). Pure.
 */
export function dayOffReadBack(input: {
  status: 'no_work' | 'weather_day';
  siteName: string;
  details: CallDayOffDetails;
  data: DailyReportData | null;
  language: Language;
}): string {
  const { language } = input;
  const site = input.siteName;
  if (input.status === 'no_work') return renderVoice('day_off_confirm_no_work', language, { site });
  const lost = input.data?.weather.periods[0]?.lostHours ?? 0;
  const hours = voiceNumber(lost, language);
  const workers = input.details.workersBefore;
  const crew = workers !== undefined && workers > 0;
  if (input.details.since === 'never_started' || !input.details.since) {
    return crew
      ? renderVoice('day_off_confirm_never_crew', language, {
          site,
          workers: voiceNumber(workers, language),
          hours,
        })
      : renderVoice('day_off_confirm_never', language, { site, hours });
  }
  const time = input.details.since;
  return crew
    ? renderVoice('day_off_confirm_weather_crew', language, {
        site,
        time,
        workers: voiceNumber(workers, language),
        hours,
      })
    : renderVoice('day_off_confirm_weather', language, { site, time, hours });
}

/** What a callback request would do (§19 Q128; W3-17 places it, `VOICE_CALLBACK_POLICY`). */
export type CallbackPlan =
  | { status: 'scheduled'; at: string; localTime: string }
  | { status: 'outside_window'; windowEnd: string | null }
  | { status: 'limit_reached' };

/**
 * §19 Q128: one callback the reporter asked for per site-day, inside the call window (site time),
 * and before the missing step (`notAfter`, when the day is still open). Pure; W3-17 queues the
 * `place_call` job this plans.
 */
export function callbackPlan(input: {
  now: Date;
  minutes: number;
  timezone: string;
  window: QuietWindow;
  /** Callbacks of this reporter and site-day asked for already. */
  requestedToday: number;
  notAfter?: Date | null;
}): CallbackPlan {
  if (input.requestedToday >= VOICE_CALLBACK_POLICY.perSiteDay) return { status: 'limit_reached' };
  const at = new Date(input.now.getTime() + input.minutes * 60_000);
  const sameDay = formatDay(at, input.timezone) === formatDay(input.now, input.timezone);
  if (
    !sameDay ||
    !insideWindow(at, input.timezone, input.window) ||
    (input.notAfter && at.getTime() > input.notAfter.getTime())
  ) {
    return { status: 'outside_window', windowEnd: input.window.end.slice(0, 5) || null };
  }
  return {
    status: 'scheduled',
    at: at.toISOString(),
    localTime: formatTimeInTz(at, input.timezone),
  };
}

function formatDay(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(at);
}
