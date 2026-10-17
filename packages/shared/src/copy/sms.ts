import type { Language, UnitSystem } from '../locale.ts';
import {
  inToMm,
  mphToKmh,
  type SiteDayWeather,
  weatherUnitLabels,
  WEATHER_THRESHOLDS,
} from '../weather/observed.ts';
import { smsEn, smsHelpPrivacyEn, smsReplyHintEn, smsWeatherPhraseEn } from './sms.en.ts';
import { smsEs, smsHelpPrivacyEs, smsReplyHintEs, smsWeatherPhraseEs } from './sms.es.ts';
import { smsHelpPrivacyTr, smsTr, smsWeatherPhraseTr } from './sms.tr.ts';

/**
 * §9.2 SMS copy catalog. Keys are stable ids; the texts live in `sms.{en,es,tr}.ts`. WhatsApp
 * templates and push texts reuse these keys from week 2 (spec §4.5, `MessageKey`).
 *
 * Which variant a message gets is the country pack's business (spec §4.6), never the driver's:
 * - Two-way packs only (`two_way_sms`): the keys `unknown_number`, `help`, `stop_confirm`,
 *   `pref_call_ok` and `pref_text_ok` (EN and ES text only), and the welcome's reply clause (`SMS_REPLY_HINT`, EN and ES), which
 *   `renderSms` appends. One-way packs never get reply instructions: those keys throw and the
 *   welcome goes out without the clause. Catalogue text + hint is the §9.2 cell, byte for byte.
 * - Packs without links in SMS (`sms_links_allowed` false): the keys with a link
 *   (`MESSAGE_KEYS_WITH_LINK`) throw, so no SMS path can send a link the pack forbids.
 * - EN and TR are verbatim from the spec table; ES mirrors EN (§9.2 "Spanish versions mirror EN").
 *   TR has no two-way text, so a two-way pack with Turkish fails `packCopyGaps()`.
 * - "No voice number" (§9.2): a message with an "or call {number}" clause stores a second text
 *   without that clause, and `renderSms` picks it when the pack has no voice number. The texts are
 *   data, so no string surgery happens at send time; a test proves each `withoutNumber` is its
 *   `withNumber` minus exactly one clause that holds `{number}`.
 */

export const SMS_KEYS = [
  'welcome',
  'verify_code',
  'daily_link',
  'call_coming',
  'weather_headsup',
  'reminder_1',
  'reminder_2',
  'missed_call',
  'question_ready',
  'draft_ready',
  'filed',
  'photos_link',
  'edit_applied',
  'finish_report',
  'site_paused',
  'unknown_number',
  'help',
  'stop_confirm',
  'pref_call_ok',
  'pref_text_ok',
  'day_off_link',
  'edit_preview',
  'edit_unclear',
  'whatsapp_use_link',
  'whatsapp_stop_confirm',
] as const;
export type SmsKey = (typeof SMS_KEYS)[number];

/**
 * The replies to the report keywords (W2-12, spec §19 Q83, Q102): NO WORK / WEATHER's day sheet
 * link, EDIT's preview with its confirm link, and an EDIT that made no preview. Two-way packs (and
 * WhatsApp, week 2) only, with text in EN, ES and TR, since a two-way TR pack or WhatsApp in Turkey
 * gets them too.
 */
export const KEYWORD_REPLY_SMS_KEYS = ['day_off_link', 'edit_preview', 'edit_unclear'] as const;
export type KeywordReplySmsKey = (typeof KEYWORD_REPLY_SMS_KEYS)[number];

/**
 * Replies that exist on WhatsApp only (W2-16): a voice note or photo sent on WhatsApp gets the link
 * once a day (spec §19 Q85), and STOP on WhatsApp stops WhatsApp only (§19 Q40, the first option),
 * so its confirmation names WhatsApp. Never sent by SMS (`smsReplyAllowed`).
 */
export const WHATSAPP_REPLY_KEYS = ['whatsapp_use_link', 'whatsapp_stop_confirm'] as const;
export type WhatsappReplyKey = (typeof WHATSAPP_REPLY_KEYS)[number];

/**
 * What a reply to an inbound text may say (`SmsNotifier.reply`): the two-way keys, `draft_ready`,
 * the answer to OK (spec §19 Q82: the draft link, never a confirmation), and `question_ready`, the
 * question's link again after a WhatsApp answer code could not apply (W2-16, spec §19 Q113).
 */
export type ReplySmsKey = TwoWaySmsKey | 'draft_ready' | 'question_ready';

/**
 * Keys sent only on packs with two-way SMS (replies to STOP, HELP, CALL and TEXT, and to an
 * unknown sender, §9.5; CALL and TEXT confirmed per spec §19 Q46): EN and ES text only; and the
 * report keywords' replies (W2-12), EN, ES and TR.
 */
export const TWO_WAY_SMS_KEYS = [
  'unknown_number',
  'help',
  'stop_confirm',
  'pref_call_ok',
  'pref_text_ok',
  ...KEYWORD_REPLY_SMS_KEYS,
  ...WHATSAPP_REPLY_KEYS,
] as const;
export type TwoWaySmsKey = (typeof TWO_WAY_SMS_KEYS)[number];
/** Keys every pack can send, in every language. */
export type SharedSmsKey = Exclude<SmsKey, TwoWaySmsKey>;

/** SMS languages (§9.6): a reporter's language, from `reporters.locale`. */
export type SmsLocale = Language;

/** The variables each message takes, as they appear in braces in the text. */
export const SMS_VARS = {
  welcome: ['first', 'company', 'site', 'deadline', 'number', 'link'],
  verify_code: ['code'],
  daily_link: ['site', 'link', 'number'],
  call_coming: ['time', 'link'],
  weather_headsup: ['deadline', 'weather_phrase'],
  reminder_1: ['site', 'link'],
  reminder_2: ['time', 'link', 'number'],
  missed_call: ['number', 'link'],
  question_ready: ['link'],
  draft_ready: ['link'],
  filed: ['report_no', 'pdf_link'],
  photos_link: ['link'],
  edit_applied: ['weekday', 'change', 'v'],
  finish_report: ['link'],
  site_paused: ['site'],
  unknown_number: [],
  help: ['company', 'link', 'number'],
  stop_confirm: [],
  pref_call_ok: [],
  pref_text_ok: [],
  day_off_link: ['site', 'link'],
  edit_preview: ['weekday', 'change', 'link'],
  edit_unclear: ['link'],
  whatsapp_use_link: ['link'],
  whatsapp_stop_confirm: [],
} as const satisfies Record<SmsKey, readonly string[]>;

export type SmsVarName<K extends SmsKey> = (typeof SMS_VARS)[K][number];

/** Keys whose text carries a link (`{link}` or `{pdf_link}`). */
export type MessageKeyWithLink = {
  [K in SmsKey]: [Extract<SmsVarName<K>, 'link' | 'pdf_link'>] extends [never] ? never : K;
}[SmsKey];

/**
 * The keys a pack without links in SMS (`sms_links_allowed = false`) cannot send by SMS (spec
 * §4.5; §19 Q24). Derived from `SMS_VARS`, so a new key with a link joins it.
 */
export const MESSAGE_KEYS_WITH_LINK: readonly MessageKeyWithLink[] = SMS_KEYS.filter((key) =>
  (SMS_VARS[key] as readonly string[]).some((v) => v === 'link' || v === 'pdf_link'),
) as MessageKeyWithLink[];

export function messageKeyHasLink(key: SmsKey): key is MessageKeyWithLink {
  return (MESSAGE_KEYS_WITH_LINK as readonly string[]).includes(key);
}

/** Keys whose text offers "or call {number}". */
export type SmsKeyWithNumber = {
  [K in SmsKey]: 'number' extends SmsVarName<K> ? K : never;
}[SmsKey];

/** A text with the call option, and the same text without it (no voice number). */
export interface SmsWithCallOption {
  withNumber: string;
  withoutNumber: string;
}

export type SmsTemplate<K extends SmsKey> = K extends SmsKeyWithNumber ? SmsWithCallOption : string;

export type SmsCatalog<K extends SmsKey> = { readonly [P in K]: SmsTemplate<P> };

export type SmsVarValue = string | number;

/**
 * Variables for a key. `number` is optional because it is needed only when the org has a voice
 * number; `renderSms` fails when it is needed and missing.
 */
export type SmsVars<K extends SmsKey> = {
  [P in Exclude<SmsVarName<K>, 'number'>]: SmsVarValue;
} & { number?: SmsVarValue } & (K extends 'help' ? { privacy_link?: SmsVarValue } : unknown);

/**
 * The variant of a message, from the org's country pack (`smsRenderOptions(pack)` in
 * `channels.ts`). Every field is required, so no caller falls into a reply prompt or a link by
 * default.
 */
export interface RenderSmsOptions {
  /** False when the org's pack has no voice number (`countries.voice_number` null): Talk now only. */
  hasVoiceNumber: boolean;
  /** The pack's `two_way_sms`: the two-way keys and the welcome's reply clause exist only then. */
  twoWay: boolean;
  /** The pack's `sms_links_allowed`: a key that carries a link renders only then (§19 Q24). */
  linksAllowed: boolean;
}

/**
 * The languages a key has text in: every key in every language since W2-16, which gave the two-way
 * replies Turkish text for WhatsApp (a TR reporter gets STOP, HELP, CALL and TEXT there, though TR
 * SMS is one-way).
 */
export type SmsLocaleFor<_K extends SmsKey> = SmsLocale;

/** The keys the Turkish catalogue has: every key (W2-16). */
export type TrSmsKey = SmsKey;

export const SMS_CATALOGS: {
  en: SmsCatalog<SmsKey>;
  es: SmsCatalog<SmsKey>;
  tr: SmsCatalog<TrSmsKey>;
} = { en: smsEn, es: smsEs, tr: smsTr };

/**
 * The `welcome` reply clause, appended only for packs with two-way SMS (§9.2). Turkish has none:
 * the TR pack is one-way.
 */
export const SMS_REPLY_HINT: Readonly<Partial<Record<SmsLocale, string>>> = {
  en: smsReplyHintEn,
  es: smsReplyHintEs,
};

/**
 * W4-06 (spec §9.1 "linked from the consent screen and the SMS HELP text"): the HELP reply's
 * privacy clause, `{privacy_link}` the pack's privacy notice page (`legalPageUrl`). `renderSms`
 * appends it to `help` only when the caller passes `privacy_link`, which `sms/inbound.ts` does
 * only when the pack names a `legal_keys.privacy_notice`; with none the text is as before.
 */
export const SMS_HELP_PRIVACY: Readonly<Record<SmsLocale, string>> = {
  en: smsHelpPrivacyEn,
  es: smsHelpPrivacyEs,
  tr: smsHelpPrivacyTr,
};

export function isTwoWaySmsKey(key: SmsKey): key is TwoWaySmsKey {
  return (TWO_WAY_SMS_KEYS as readonly string[]).includes(key);
}

/**
 * The raw text for a key, language and pack variant (placeholders not filled). Throws on an
 * unknown key or language, a two-way key for a one-way pack or in a language without its text, a
 * key with a link for a pack that forbids links in SMS, and a two-way welcome in a language
 * without a reply hint.
 */
export function smsTemplate(key: SmsKey, locale: SmsLocale, opts: RenderSmsOptions): string {
  if (!Object.hasOwn(SMS_CATALOGS, locale)) throw new Error(`No SMS copy for locale "${locale}"`);
  const catalog = SMS_CATALOGS[locale] as Partial<Record<SmsKey, string | SmsWithCallOption>>;
  const template = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  if (template === undefined) {
    throw new Error(
      isTwoWaySmsKey(key)
        ? `SMS "${key}" exists only for packs with two-way SMS and has no "${locale}" text`
        : `Unknown SMS key "${key}"`,
    );
  }
  if (isTwoWaySmsKey(key) && !opts.twoWay) {
    throw new Error(`SMS "${key}" exists only for packs with two-way SMS`);
  }
  if (messageKeyHasLink(key) && !opts.linksAllowed) {
    throw new Error(`SMS "${key}" carries a link and the pack forbids links in SMS`);
  }
  const text =
    typeof template === 'string'
      ? template
      : opts.hasVoiceNumber
        ? template.withNumber
        : template.withoutNumber;
  if (key !== 'welcome' || !opts.twoWay) return text;
  const hint = Object.hasOwn(SMS_REPLY_HINT, locale) ? SMS_REPLY_HINT[locale] : undefined;
  if (hint === undefined) {
    throw new Error(`SMS "welcome" has no "${locale}" reply hint for a pack with two-way SMS`);
  }
  return text + hint;
}

/** Where `smsCopyGaps` reads the copy: the catalogues and reply hints, by language. */
export interface SmsCopySource {
  catalogs: Readonly<Record<string, Partial<Record<SmsKey, string | SmsWithCallOption>>>>;
  hints: Readonly<Partial<Record<string, string>>>;
}

/**
 * The copy one language lacks for a pack (spec §4.6: a new country is only a row when its
 * languages have their copy): every shared key, in both call-option variants; with two-way SMS
 * also the two-way keys and the welcome's reply hint. A missing or empty text is a gap. Entries
 * are `<key>[.<variant>]` (`withNumber`, `withoutNumber`, `replyHint`); empty means complete.
 * `packCopyGaps()` runs it for each of a pack's field locales; `source` defaults to this
 * catalogue (tests pass a partial one).
 */
export function smsCopyGaps(
  locale: string,
  opts: { twoWay: boolean },
  source: SmsCopySource = { catalogs: SMS_CATALOGS, hints: SMS_REPLY_HINT },
): string[] {
  const catalog = Object.hasOwn(source.catalogs, locale) ? source.catalogs[locale]! : {};
  const gaps: string[] = [];
  for (const key of SMS_KEYS) {
    if (isTwoWaySmsKey(key) && !opts.twoWay) continue;
    const template = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
    if (template === undefined || template === '') {
      gaps.push(key);
    } else if (typeof template !== 'string') {
      if (!template.withNumber) gaps.push(`${key}.withNumber`);
      if (!template.withoutNumber) gaps.push(`${key}.withoutNumber`);
    }
  }
  const hint = Object.hasOwn(source.hints, locale) ? source.hints[locale] : undefined;
  if (opts.twoWay && !hint) gaps.push('welcome.replyHint');
  return gaps;
}

/**
 * Render a §9.2 message. Fails loudly (throws) where `smsTemplate` does, and on a variable the
 * text needs that is missing, null or empty. Extra variables are ignored (a caller may always pass
 * `number`). Values are inserted as given; the only additions are the welcome's reply clause on a
 * two-way pack, so a one-way pack's text never gains a reply prompt, and HELP's privacy clause
 * when `privacy_link` is given (W4-06, `SMS_HELP_PRIVACY`).
 */
export function renderSms<K extends SmsKey>(
  key: K,
  locale: SmsLocaleFor<K>,
  vars: SmsVars<K>,
  opts: RenderSmsOptions,
): string {
  const values = vars as Readonly<Record<string, SmsVarValue | null | undefined>>;
  const privacy = key === 'help' ? values.privacy_link : undefined;
  const template =
    smsTemplate(key, locale, opts) +
    (privacy !== undefined && privacy !== null && String(privacy).trim() !== ''
      ? SMS_HELP_PRIVACY[locale]
      : '');
  return template.replace(/\{([a-z0-9_]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`SMS "${key}" (${locale}) needs {${name}}`);
    }
    return String(value);
  });
}

/**
 * The pieces of the heads-up's `{weather_phrase}` in one language (W2-06): rain in the morning,
 * the afternoon or across the day with `{amount}`, gusts with `{speed}` (`gustsAfterRain` when
 * joined after rain by `and`), the `fallback` when the snapshot names neither, and the decimal
 * separator of the amount.
 */
export interface SmsWeatherPhrases {
  rainMorning: string;
  rainAfternoon: string;
  rainDay: string;
  gusts: string;
  gustsAfterRain: string;
  and: string;
  fallback: string;
  decimal: string;
}

export const SMS_WEATHER_PHRASES: Readonly<Record<SmsLocale, SmsWeatherPhrases>> = {
  en: smsWeatherPhraseEn,
  es: smsWeatherPhraseEs,
  tr: smsWeatherPhraseTr,
};

/**
 * The heads-up's `{weather_phrase}` in the reporter's language and the org's units (W2-06;
 * `weatherPhrase` is its English, imperial original): rain when the working hours had more than
 * the threshold, with when it fell and the day's total; gusts above the threshold in the working
 * hours. The snapshot is imperial (`SiteDayWeather.units`); a metric org gets mm and km/h.
 */
export function renderWeatherPhrase(
  w: SiteDayWeather,
  locale: SmsLocale,
  units: UnitSystem,
): string {
  if (!Object.hasOwn(SMS_WEATHER_PHRASES, locale)) {
    throw new Error(`No SMS copy for locale "${locale}"`);
  }
  const c = SMS_WEATHER_PHRASES[locale];
  const label = weatherUnitLabels(units);
  const rainHours = w.hours.filter((h) => h.precipIn > 0.01);
  let rain: string | null = null;
  if (w.summary.precipWorkingHoursIn > WEATHER_THRESHOLDS.precipIn && rainHours.length) {
    const first = Number(rainHours[0]!.time.slice(0, 2));
    const last = Number(rainHours[rainHours.length - 1]!.time.slice(0, 2));
    const template = last < 12 ? c.rainMorning : first >= 12 ? c.rainAfternoon : c.rainDay;
    const value = units === 'metric' ? inToMm(w.summary.precipIn) : w.summary.precipIn;
    const amount = `${value.toFixed(1).replace('.', c.decimal)} ${label.precip}`;
    rain = template.replace('{amount}', amount);
  }
  let gusts: string | null = null;
  if (w.summary.maxGustWorkingHoursMph > WEATHER_THRESHOLDS.gustMph) {
    const mph = w.summary.maxGustWorkingHoursMph;
    const speed = `${units === 'metric' ? mphToKmh(mph) : mph} ${label.wind}`;
    gusts = (rain ? c.gustsAfterRain : c.gusts).replace('{speed}', speed);
  }
  if (rain && gusts) return `${rain}${c.and}${gusts}`;
  return rain ?? gusts ?? c.fallback;
}
