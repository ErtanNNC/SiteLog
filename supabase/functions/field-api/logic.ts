import {
  CONSENT_TYPES,
  CORRECTION_LISTEN_TIMEOUT_S,
  DEVICE_COOKIE_MAX_AGE_S,
  REQUIRED_CONSENTS,
  UI_RESOURCES,
  UPLOAD_MAX_BYTES,
  VERIFY_CODE_LENGTH,
  addDays,
  dayOffReportData,
  languageOf,
  reportLanguageFor,
  consentSets,
  deadlineInstant,
  formatDeadline,
  isWorkingDay,
  localDate,
  nextWorkingDay,
  photosLinkExpiresAt,
  previousWorkingDay,
  settingsMessageChannels,
  type AnswerConfirmation,
  type AnswerValue,
  type ConsentRow,
  type ConsentType,
  type CorrectionChange,
  type CorrectionView,
  type CountryPack,
  type DraftCorrectionRow,
  type DailyReportData,
  type DayOffDetails,
  type QuestionRow,
  type ReportView,
  type OrgLocale,
  type UnitSystem,
  type FieldApiErrorCode,
  type FieldCountryView,
  type FieldDeviceRow,
  type FieldLinkRow,
  type FieldSite,
  type OrgSettingsRow,
  type PreferencesResponse,
  type QuestionOption,
  type ReporterLocale,
  type ReporterRow,
  type SiteRow,
} from '@sitelog/shared';

/**
 * field-api's decisions, free of I/O (tested in logic_test.ts): errors, the device cookie and
 * token, a device's 180 days, the one-time code, consent state, the report dates a link allows,
 * Today's default site, the stored-object check, the origin check and the pack subset the field
 * app may see.
 */

/** A refusal with its HTTP status and stable code (`FieldApiErrorBody`). */
export class FieldError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500,
    readonly code: FieldApiErrorCode,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.name = 'FieldError';
  }
}

/** The device cookie's attributes (spec §6.5, F4): first-party through the field host's /api proxy. */
export const DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: DEVICE_COOKIE_MAX_AGE_S,
} as const;

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A device counts as verified for 180 days from its verification (spec §6.5, F4, §19 Q5), the
 * cookie's Max-Age, whatever cookie the browser still sends; revoked never.
 */
export function deviceVerified(
  device: Pick<FieldDeviceRow, 'verified_at' | 'revoked_at'>,
  now: Date,
): boolean {
  if (device.verified_at === null || device.revoked_at !== null) return false;
  return now.getTime() - new Date(device.verified_at).getTime() < DEVICE_COOKIE_MAX_AGE_S * 1000;
}

/** A device token: 32 random bytes, base64url. The database keeps only its SHA-256. */
export function newDeviceToken(randomBytes: (n: number) => Uint8Array): string {
  return toBase64Url(randomBytes(32));
}

/** A uniformly random 6-digit code (rejection sampling over 32-bit values, no modulo bias). */
export function newVerifyCode(randomBytes: (n: number) => Uint8Array): string {
  const space = 10 ** VERIFY_CODE_LENGTH;
  const limit = Math.floor(0x1_0000_0000 / space) * space;
  for (;;) {
    const b = randomBytes(4);
    const n = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (n < limit) return String(n % space).padStart(VERIFY_CODE_LENGTH, '0');
  }
}

/**
 * What `field_devices.code_hash` stores: HMAC-SHA-256 of `device id:code` under
 * LINK_SIGNING_SECRET, so a 6-digit code cannot be read back from the hash by trying all million.
 */
export async function verifyCodeHash(
  secret: string,
  deviceId: string,
  code: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${deviceId}:${code}`));
  return toHex(new Uint8Array(mac));
}

/** The consent types a reporter holds (unrevoked) and those given and revoked with none since. */
export function consentState(rows: readonly ConsentRow[]): {
  held: Set<ConsentType>;
  revoked: Set<ConsentType>;
} {
  return consentSets(rows);
}

/** F4 step 3: the Welcome & consent screen until the required consents are held. */
export function needsConsent(held: ReadonlySet<ConsentType>): boolean {
  return !REQUIRED_CONSENTS.every((t) => held.has(t));
}

/**
 * What Settings shows (F15, `GET` / `PATCH preferences`, `consent/revoke`, `consent/grant`; W2-02):
 * the report mode, the language, the message channel with the pack's built channels (spec §19
 * Q21), every consent type the reporter has given, held or turned off, in `CONSENT_TYPES` order,
 * and the texts consent also when never given while the pack sends texts (its *Turn on*, §19 Q86),
 * and whether the phone opted out of texts (`textsOptedOut`, `textsOptedOut()`).
 */
export function settingsView(
  reporter: Pick<ReporterRow, 'contact_pref' | 'locale' | 'message_channel'>,
  pack: Pick<CountryPack, 'messageChannels'>,
  consents: readonly Pick<ConsentRow, 'type' | 'revoked_at'>[],
  optedOut: boolean,
): PreferencesResponse {
  const { held } = consentSets(consents);
  const shown = new Set(consents.map((c) => c.type));
  if (pack.messageChannels.includes('sms')) shown.add('sms');
  return {
    contactPref: reporter.contact_pref,
    locale: reporter.locale as ReporterLocale,
    messageChannel: reporter.message_channel,
    messageChannels: settingsMessageChannels(pack),
    consents: CONSENT_TYPES.filter((t) => shown.has(t)).map((type) => ({
      type,
      held: held.has(type),
    })),
    textsOptedOut: optedOut,
  };
}

/**
 * Whether the phone opted out of texts on the org's pack (§9.5, F15): the reporter row is
 * `opted_out` (SMS STOP, or the provider's opt-out list), or the phone has an `sms_opt_outs` row on
 * the pack whoever it belonged to then (the Notifier's `phone_opted_out`). A consent never
 * overrides it (spec §19 Q86): only START does.
 */
export function textsOptedOut(
  reporter: Pick<ReporterRow, 'status'>,
  phoneOptedOut: boolean,
): boolean {
  return reporter.status === 'opted_out' || phoneOptedOut;
}

/** The pack subset `resolve` hands the field app (spec §4.6): never the sender id or a provider. */
export function fieldCountryView(pack: CountryPack): FieldCountryView {
  return {
    code: pack.code,
    voiceNumber: pack.voiceNumber,
    fieldLocales: pack.fieldLocales,
    twoWaySms: pack.twoWaySms,
    messageChannels: pack.messageChannels,
    legalKeys: pack.legalKeys,
  };
}

export function fieldSite(s: Pick<SiteRow, 'id' | 'name' | 'timezone' | 'status'>): FieldSite {
  return { id: s.id, name: s.name, timezone: s.timezone, status: s.status };
}

/** A link's sites: a daily or photos link names one; a personal link covers all of them. */
export function scopeSites<S extends Pick<SiteRow, 'id'>>(
  link: Pick<FieldLinkRow, 'site_id'>,
  reporterSites: readonly S[],
): S[] {
  return link.site_id === null
    ? [...reporterSites]
    : reporterSites.filter((s) => s.id === link.site_id);
}

/** "17:30" for a site: its own deadline, else the org's default (create_office_report does the same). */
export function siteDeadline(
  site: Pick<SiteRow, 'deadline'>,
  settings: Pick<OrgSettingsRow, 'default_deadline'> | null,
): string {
  return formatDeadline(site.deadline ?? settings?.default_deadline ?? '17:30');
}

/** F5: before this hour (site time) a personal link may also report the previous working day. */
export const YESTERDAY_UNTIL_HOUR = 12;

/**
 * The report dates a link allows for a site (F5): a daily or photos link its own date; a personal
 * link today in the site's time zone, and before 12:00 there also the previous working day of the
 * org ("before noon: 'Is this for today or yesterday?'"; yesterday as the previous working day is
 * spec §19 Q43). The first is the default.
 */
export function allowedReportDates(
  link: Pick<FieldLinkRow, 'report_date'>,
  site: Pick<SiteRow, 'timezone'>,
  now: Date,
  workingDays: readonly number[] | null | undefined,
): string[] {
  if (link.report_date) return [link.report_date];
  const today = localDate(now, site.timezone);
  if (
    now.getTime() >=
    deadlineInstant(
      today,
      `${String(YESTERDAY_UNTIL_HOUR).padStart(2, '0')}:00`,
      site.timezone,
    ).getTime()
  )
    return [today];
  return [today, previousWorkingDay(today, orgWorkingDays(workingDays))];
}

function orgWorkingDays(workingDays: readonly number[] | null | undefined): number[] {
  return workingDays?.length ? workingDays.map(Number) : [1, 2, 3, 4, 5];
}

/**
 * The instant a personal link stops allowing `date` (`allowedReportDates`): 12:00 site time on the
 * next working day when `date` is a working day (until then it is "yesterday" before noon), else
 * the end of `date` itself.
 */
export function reportWindowEnd(
  date: string,
  site: Pick<SiteRow, 'timezone'>,
  workingDays: readonly number[] | null | undefined,
): Date {
  const days = orgWorkingDays(workingDays);
  if (!isWorkingDay(date, days)) return deadlineInstant(addDays(date, 1), '00:00', site.timezone);
  return deadlineInstant(
    nextWorkingDay(date, days),
    `${String(YESTERDAY_UNTIL_HOUR).padStart(2, '0')}:00`,
    site.timezone,
  );
}

/** Spec §19 Q53: how long after a day's window a clip recorded inside it is still filed under it. */
export const LATE_CLIP_GRACE_HOURS = 48;

/** How far ahead of the server a phone's clock may be and its recording time still count. */
export const RECORDED_AT_SKEW_MS = 5 * 60 * 1000;

/**
 * Spec §19 Q53 (owner, 2026-10-15): a clip recorded on one day that reaches field-api after that
 * day's window has closed (recorded offline in the evening and sent the next afternoon, or
 * "yesterday" picked before noon and sent after it) is still filed under the day it was recorded
 * when the phone's recording time (`recordedAt`, the device clock) was inside that day's window
 * (the day was one `allowedReportDates` allowed at that moment), that time is not in the future,
 * and it arrives within LATE_CLIP_GRACE_HOURS of the window's end. A daily or photos link names
 * its own date, which it always allows, so this is for personal links. field-api audits the
 * upload as late and flags it to the office (`field_flag_late_upload()`).
 */
export function lateClipAllowed(
  link: Pick<FieldLinkRow, 'report_date'>,
  site: Pick<SiteRow, 'timezone'>,
  date: string,
  recordedAt: string | null | undefined,
  now: Date,
  workingDays: readonly number[] | null | undefined,
): boolean {
  if (link.report_date || !recordedAt) return false;
  const recorded = new Date(recordedAt);
  if (Number.isNaN(recorded.getTime())) return false;
  if (recorded.getTime() > now.getTime() + RECORDED_AT_SKEW_MS) return false;
  if (!allowedReportDates(link, site, recorded, workingDays).includes(date)) return false;
  const graceEnd =
    reportWindowEnd(date, site, workingDays).getTime() + LATE_CLIP_GRACE_HOURS * 3600 * 1000;
  return now.getTime() <= graceEnd;
}

/**
 * Spec §19 Q89 (decided 2026-10-16: this default, as built): F9 gives a window for photos only to
 * a photos link texted after a call-filed report. With this on, a report filed on the web takes
 * photos from the Filed screen in the same window, through the reporter's personal link or a daily
 * link of that day; off, only photos links add photos after filing. field_complete_upload() checks the window
 * and the limit again; which links may is decided here.
 */
export const FILED_PHOTOS_ON_WEB_LINKS = true;

/**
 * Whether `link` may add photos to the filed report of `date` at `siteId` (F9): a photos link of
 * that day and site; with FILED_PHOTOS_ON_WEB_LINKS also a daily link of that day and site and a
 * personal link (whose sites the route has already checked).
 */
export function linkMayAddPhotos(
  link: Pick<FieldLinkRow, 'kind' | 'site_id' | 'report_date'>,
  siteId: string,
  date: string,
  webLinks: boolean = FILED_PHOTOS_ON_WEB_LINKS,
): boolean {
  const sameDay = link.report_date === date && (link.site_id === null || link.site_id === siteId);
  if (link.kind === 'photos') return sameDay;
  if (!webLinks) return false;
  if (link.kind === 'daily') return sameDay;
  return link.kind === 'personal';
}

/** F9's window for a filed report of `date`: until 23:59 the next day, site time (ISO). */
export function filedPhotosUntil(date: string, site: Pick<SiteRow, 'timezone'>): string {
  return photosLinkExpiresAt(date, site.timezone);
}

/** What Storage holds at an upload's path (`FieldStore.objectInfo`). */
export interface StoredObject {
  size: number | null;
  contentType: string | null;
}

/**
 * Why a stored object cannot complete its upload, or null (a signed upload URL fixes neither the
 * type nor the size): missing, not the base media type the upload named, or over
 * UPLOAD_MAX_BYTES. An unknown type or size counts as a mismatch.
 */
export function storedObjectProblem(
  declaredMime: string | null,
  object: StoredObject | null,
): 'upload_missing' | 'media_type_not_allowed' | 'upload_too_large' | null {
  if (!object) return 'upload_missing';
  const base = (object.contentType?.split(';')[0] ?? '').trim().toLowerCase();
  if (!declaredMime || base !== declaredMime.toLowerCase()) return 'media_type_not_allowed';
  if (object.size === null || object.size > UPLOAD_MAX_BYTES) return 'upload_too_large';
  return null;
}

/**
 * Today's default site for a personal link with several (F14): the one whose deadline today is
 * nearest to now. Ties keep the reporter's order.
 */
export function nearestDeadlineSite<S extends Pick<SiteRow, 'timezone' | 'deadline'>>(
  sites: readonly S[],
  settings: Pick<OrgSettingsRow, 'default_deadline'> | null,
  now: Date,
): S | null {
  let best: S | null = null;
  let bestGap = Infinity;
  for (const s of sites) {
    const date = localDate(now, s.timezone);
    const gap = Math.abs(
      deadlineInstant(date, siteDeadline(s, settings), s.timezone).getTime() - now.getTime(),
    );
    if (gap < bestGap) {
      best = s;
      bestGap = gap;
    }
  }
  return best;
}

/** The first day of "the last 14 days" in a site's time zone. */
export function historyStart(now: Date, timezone: string, days: number): string {
  return addDays(localDate(now, timezone), -(days - 1));
}

/**
 * Browser origins field-api accepts (an Origin header is optional, a wrong one is refused): the
 * field app (FIELD_APP_URL) and the extra origins (CORS_EXTRA_ORIGINS, e.g. the field preview).
 * Requests come same-origin through the field host's /api proxy, so the browser's Origin is the
 * field host.
 */
export function fieldOrigins(fieldAppUrl: string | undefined, extra: string | undefined): string[] {
  const out: string[] = [];
  for (const candidate of [fieldAppUrl, ...(extra ?? '').split(',')]) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      out.push(new URL(trimmed).origin);
    } catch {
      // a malformed entry is a configuration mistake, not a request error
    }
  }
  return out;
}

export function originAllowed(
  origin: string | null | undefined,
  allowed: readonly string[],
): boolean {
  return !origin || allowed.includes(origin);
}

/** A question's options as the field app shows them: `[{id, label}]`, else null. */
export function questionOptions(options: unknown): { id: string; label: string }[] | null {
  const out = storedQuestionOptions(options).map(({ id, label }) => ({ id, label }));
  return out.length ? out : null;
}

/** One spoken try at a web question (W2-09, `questions.voice_answers`). */
interface VoiceTry {
  uploadId: string;
  status: 'listening' | 'applied' | 'unclear' | 'stale';
}

function voiceTries(value: unknown): VoiceTry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is VoiceTry =>
      !!t &&
      typeof t === 'object' &&
      typeof t.uploadId === 'string' &&
      typeof t.status === 'string',
  );
}

/**
 * The open question's spoken answer as the Question screen shows it (W2-09): `listening` while
 * parse_answer runs, `retry` after a try it could not read (asked once more); else null. Pure.
 */
export function voiceAnswerView(
  question: Pick<QuestionRow, 'voice_answers'>,
): NonNullable<ReportView['question']>['voice'] {
  const tries = voiceTries(question.voice_answers);
  const unclear = tries.filter((t) => t.status === 'unclear').length;
  const last = tries.at(-1);
  if (last?.status === 'listening') return { state: 'listening', unclear };
  if (last?.status === 'unclear') return { state: 'retry', unclear };
  return null;
}

/**
 * The last spoken answer the worker settled (W2-09), for F7's line after it: the latest answered
 * question whose answer came by voice (`answer.voice`, with code's confirmation) or was left
 * unclear (`answer.unclear`). Null when the latest answered question was not spoken. Pure.
 */
export function lastVoiceAnswerView(
  answered: ReadonlyArray<Pick<QuestionRow, 'id' | 'answer' | 'answered_at'>>,
): ReportView['lastVoiceAnswer'] {
  const latest = [...answered]
    .filter((q) => q.answered_at)
    .sort((a, b) => (b.answered_at ?? '').localeCompare(a.answered_at ?? ''))[0];
  const answer = latest?.answer as
    { voice?: unknown; unclear?: boolean; confirmation?: AnswerConfirmation } | null | undefined;
  if (!latest || !answer || typeof answer !== 'object') return null;
  if (answer.unclear === true) return { questionId: latest.id, outcome: 'unclear' };
  if (answer.voice && answer.confirmation && typeof answer.confirmation === 'object') {
    return { questionId: latest.id, outcome: 'applied', confirmation: answer.confirmation };
  }
  return null;
}

/** The crew a question is about (`questions.target.manpowerIndex`), else null (W1-13). */
export function questionManpowerIndex(target: unknown): number | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const index = (target as { manpowerIndex?: unknown }).manpowerIndex;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * A question's options as stored (W1-12, `QuestionOption`): `[{id, label, value?}]`, where `value`
 * is what code applies for a fallback option. Anything else in the column (the WhatsApp worker's
 * buttons have `title`, not `label`) is not an option of the web.
 */
export function storedQuestionOptions(options: unknown): QuestionOption[] {
  if (!Array.isArray(options)) return [];
  const out: QuestionOption[] = [];
  for (const o of options) {
    if (o && typeof o === 'object' && typeof o.id === 'string' && typeof o.label === 'string') {
      const value =
        o.value && typeof o.value === 'object' && !Array.isArray(o.value)
          ? (o.value as AnswerValue)
          : undefined;
      out.push(value ? { id: o.id, label: o.label, value } : { id: o.id, label: o.label });
    }
  }
  return out;
}

/** The words a typed answer is stored with (D28): "5 · full day", "5 · 6 h", "5". */
export function numberAnswerLabel(value: number, hours?: number | 'full_day'): string {
  if (hours === 'full_day') return `${value} · full day`;
  if (typeof hours === 'number') return `${value} · ${hours} h`;
  return String(value);
}

/** The caller's address for consent evidence (best effort: the proxy's header, else the first hop). */
export function clientIp(headers: Headers): string | null {
  const nf = headers.get('x-nf-client-connection-ip')?.trim();
  if (nf) return nf;
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first || null;
}

/** Seconds until `resetAt` (at least 1), for Retry-After. */
export function retryAfterSeconds(resetAt: string, now: Date): number {
  return Math.max(1, Math.ceil((new Date(resetAt).getTime() - now.getTime()) / 1000));
}

/** One answered `questions` row of a recorder day-off (field_report_day_off(), W2-08). */
export interface DayOffQuestion {
  id: string;
  field: 'weather.impact' | 'manpower.workers';
  prompt: string;
  target: { path: string };
  answer: { text: string; parsed: Record<string, string | number>; via: 'web' };
}

/**
 * What `POST day-status` writes (F12, spec §19 Q41; W2-08): the reporter's details as answered
 * web questions, worded as the sheet asked them (the reporter's language, `field.today.daySheet`),
 * and the version data built from them in code (`dayOffReportData`: lost hours and crew hours,
 * each value citing its answer). A no-work day has no details and no questions.
 */
export function dayOffPlan(input: {
  status: 'no_work' | 'weather_day';
  date: string;
  site: Pick<SiteRow, 'name' | 'working_hours'>;
  org: { locale: OrgLocale; units: UnitSystem };
  defaultShiftHours: number;
  reporterLocale: string;
  details: DayOffDetails;
  newId: () => string;
}): { questions: DayOffQuestion[]; data: DailyReportData } {
  const sheet = UI_RESOURCES[languageOf(input.reporterLocale)].field.today.daySheet;
  const questions: DayOffQuestion[] = [];
  const ids = { since: null as string | null, workersBefore: null as string | null };
  if (input.status === 'weather_day') {
    const since = input.details.since;
    if (since) {
      ids.since = input.newId();
      questions.push({
        id: ids.since,
        field: 'weather.impact',
        prompt: sheet.since,
        target: { path: 'weather.periods[0]' },
        answer: {
          text: since === 'never_started' ? sheet.never : since,
          parsed: { since },
          via: 'web',
        },
      });
    }
    const workers = input.details.workersBefore;
    if (workers !== undefined && workers > 0) {
      ids.workersBefore = input.newId();
      questions.push({
        id: ids.workersBefore,
        field: 'manpower.workers',
        prompt: sheet.workersBefore,
        target: { path: 'manpower.workers:site_crew' },
        answer: { text: String(workers), parsed: { workers }, via: 'web' },
      });
    }
  }
  const data = dayOffReportData({
    kind: input.status,
    date: input.date,
    siteName: input.site.name,
    org: { reportLanguage: reportLanguageFor(input.org.locale), units: input.org.units },
    details: input.status === 'weather_day' ? input.details : {},
    questionIds: ids,
    workingHours: input.site.working_hours,
    defaultShiftHours: input.defaultShiftHours,
  });
  return { questions, data };
}

/**
 * A fix of the draft as the Draft screen shows it (W2-10, F8 *Fix by voice*): its status, the
 * preview's lines (code's numbers) once ready, the model's question when it could not tell what to
 * change, and the draft revision the preview was made from. A fix still listening after
 * `CORRECTION_LISTEN_TIMEOUT_S` (its job keeps failing) is shown unclear (`timeout`). Pure.
 */
export function correctionView(
  row: Pick<
    DraftCorrectionRow,
    | 'id'
    | 'status'
    | 'via'
    | 'changes'
    | 'clarification'
    | 'reason'
    | 'base_version'
    | 'base_rev'
    | 'created_at'
  >,
  now: Date,
): CorrectionView {
  const timedOut =
    row.status === 'listening' &&
    now.getTime() - new Date(row.created_at).getTime() > CORRECTION_LISTEN_TIMEOUT_S * 1000;
  const ready = row.status === 'ready';
  return {
    id: row.id,
    status: timedOut ? 'unclear' : row.status,
    via: row.via === 'voice' ? 'voice' : 'text',
    changes:
      ready && Array.isArray(row.changes) ? (row.changes as unknown as CorrectionChange[]) : null,
    clarification: row.status === 'unclear' ? row.clarification : null,
    reason: timedOut ? 'timeout' : row.reason,
    version: ready ? row.base_version : null,
    draftRev: ready ? row.base_rev : null,
  };
}

/** The fix a draft shows (W2-10): the latest one while it is listening, a preview or unclear. */
export function openCorrectionView(
  row: Parameters<typeof correctionView>[0] | null,
  now: Date,
): CorrectionView | null {
  if (!row || !['listening', 'ready', 'unclear'].includes(row.status)) return null;
  return correctionView(row, now);
}
