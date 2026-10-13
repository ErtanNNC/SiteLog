import type { Language } from '../locale.ts';
import { smsEn } from './sms.en.ts';
import { smsEs } from './sms.es.ts';
import { smsTr } from './sms.tr.ts';

/**
 * §9.2 SMS copy catalog. Keys are stable ids; the texts live in `sms.{en,es,tr}.ts`.
 *
 * - EN and TR are verbatim from the spec table; ES mirrors EN (§9.2 "Spanish versions mirror EN").
 * - `unknown_number`, `help` and `stop_confirm` are US-only (two-way Twilio): EN and ES only.
 * - TR texts never ask for a reply (one-way alphanumeric sender), and `renderSms` adds nothing.
 * - "No voice number yet" (§9.2): a message with an "or call {number}" clause stores a second
 *   text without that clause, and `renderSms` picks it when `hasVoiceNumber` is false. The texts
 *   are data, so no string surgery happens at send time; a test proves each `withoutNumber` is its
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
] as const;
export type SmsKey = (typeof SMS_KEYS)[number];

/** Keys that exist only for US (two-way) numbers: no Turkish text. */
export const US_ONLY_SMS_KEYS = ['unknown_number', 'help', 'stop_confirm'] as const;
export type UsOnlySmsKey = (typeof US_ONLY_SMS_KEYS)[number];
export type SharedSmsKey = Exclude<SmsKey, UsOnlySmsKey>;

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
} as const satisfies Record<SmsKey, readonly string[]>;

export type SmsVarName<K extends SmsKey> = (typeof SMS_VARS)[K][number];

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
} & { number?: SmsVarValue };

export interface RenderSmsOptions {
  /** False when the org's country has no SiteLog voice number (e.g. `VOICE_NUMBER_TR` empty). */
  hasVoiceNumber: boolean;
}

/** US-only keys accept only the US languages. */
export type SmsLocaleFor<K extends SmsKey> = K extends UsOnlySmsKey ? 'en' | 'es' : SmsLocale;

export const SMS_CATALOGS: {
  en: SmsCatalog<SmsKey>;
  es: SmsCatalog<SmsKey>;
  tr: SmsCatalog<SharedSmsKey>;
} = { en: smsEn, es: smsEs, tr: smsTr };

export function isUsOnlySmsKey(key: SmsKey): key is UsOnlySmsKey {
  return (US_ONLY_SMS_KEYS as readonly string[]).includes(key);
}

/** The raw text for a key, language and voice-number state (placeholders not filled). */
export function smsTemplate(key: SmsKey, locale: SmsLocale, hasVoiceNumber: boolean): string {
  if (!Object.hasOwn(SMS_CATALOGS, locale)) throw new Error(`No SMS copy for locale "${locale}"`);
  const catalog = SMS_CATALOGS[locale] as Partial<Record<SmsKey, string | SmsWithCallOption>>;
  const template = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  if (template === undefined) {
    throw new Error(
      isUsOnlySmsKey(key)
        ? `SMS "${key}" is US-only and has no "${locale}" text`
        : `Unknown SMS key "${key}"`,
    );
  }
  if (typeof template === 'string') return template;
  return hasVoiceNumber ? template.withNumber : template.withoutNumber;
}

/**
 * Render a §9.2 message. Fails loudly (throws) on an unknown key, a US-only key in Turkish, or a
 * variable the text needs that is missing, null or empty. Extra variables are ignored (a caller
 * may always pass `number`). Values are inserted as given; nothing is appended, so a Turkish
 * text never gains a reply prompt.
 */
export function renderSms<K extends SmsKey>(
  key: K,
  locale: SmsLocaleFor<K>,
  vars: SmsVars<K>,
  opts: RenderSmsOptions,
): string {
  const template = smsTemplate(key, locale, opts.hasVoiceNumber);
  const values = vars as Readonly<Record<string, SmsVarValue | null | undefined>>;
  return template.replace(/\{([a-z0-9_]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`SMS "${key}" (${locale}) needs {${name}}`);
    }
    return String(value);
  });
}
