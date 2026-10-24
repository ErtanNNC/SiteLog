import { z } from 'zod';
import { fieldLanguagesOf, legalKeyGaps } from './copy/legal/index.ts';
import { smsCopyGaps } from './copy/sms.ts';
import type { CountryRow } from './db/types.ts';
import { MessageChannelSchema, type MessageChannel } from './enums.ts';
import { assertE164, isE164, type E164 } from './format.ts';
import {
  LANGUAGES,
  ORG_LOCALES,
  REPORTER_LOCALES,
  UNIT_SYSTEMS,
  languageOf,
  type Language,
  type OrgLocale,
  type ReporterLocale,
  type UnitSystem,
} from './locale.ts';

/**
 * Country packs (spec §4.6; GAP D47): everything country-specific is a row of the `countries`
 * table (20261014000004_country_packs.sql), and a new country is a new row. The table is the one
 * source of truth: SQL reads it directly (create_org, on_org_created), the panel reads it under
 * RLS, the worker and edge functions with the service role, and the field app only the subset
 * `field-api resolve` returns (`FieldCountryView`, W1-07).
 *
 * This module holds only the row schema (`CountryRowSchema`, which mirrors the table's checks),
 * the camelCase `CountryPack` and pure helpers. The rows themselves are never written here:
 * `demo/countries.ts` keeps a fixture for the modes without a database, which a db-test keeps
 * equal to the migrated rows. Deno-safe: no Node APIs.
 */

/** SMS providers a pack may name (`countries.sms_provider`); `console` is a transport, not a provider. */
export const SMS_PROVIDERS = ['twilio', 'iletimerkezi'] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

/** WhatsApp providers a pack may name (`countries.whatsapp_provider`; the transport is week 2). */
export const WHATSAPP_PROVIDERS = ['twilio'] as const;
export type WhatsappProvider = (typeof WHATSAPP_PROVIDERS)[number];

/** How the pack's SMS sender is registered (§4.4): it decides the sender id's shape and two-way SMS. */
export const SMS_SENDER_TYPES = ['toll_free', 'long_code', 'short_code', 'alphanumeric'] as const;
export type SmsSenderType = (typeof SMS_SENDER_TYPES)[number];

/** PDF paper (§12; `countries.paper`, preset into `org_settings.pdf_paper`). */
export const PAPER_SIZES = ['letter', 'a4'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/** The column defaults of `countries.sms_provider` and `countries.whatsapp_provider` (owner, D48). */
export const DEFAULT_SMS_PROVIDER: SmsProvider = 'twilio';
export const DEFAULT_WHATSAPP_PROVIDER: WhatsappProvider = 'twilio';

/**
 * The legal text slots of a pack (`countries.legal_keys`): the privacy notice and the recording
 * notice (§9.1) and the consent wording (§6.3 `consents.text_version`), each a versioned id
 * `<CC>.<slot>.v<n>` whose texts are `copy/legal` (W4-06, spec §19 Q28, Q50). Counsel's texts are
 * not given yet: every launch pack has `{}` until W4-13's data migration.
 */
export const LegalKeysSchema = z.strictObject({
  privacy_notice: z.string().min(1).optional(),
  recording_notice: z.string().min(1).optional(),
  consent: z.string().min(1).optional(),
});

/** A Twilio Content API id (`HX` and 32 hex digits): an approved WhatsApp template (W2-15). */
export const WHATSAPP_CONTENT_SID_RE = /^HX[0-9a-fA-F]{32}$/;

/**
 * `countries.whatsapp_templates` (W2-15, spec §19 Q39): `{<message key>: {<language>: <content
 * sid>}}`, per environment, as set_country_endpoints() checks it (a key of lower-case letters,
 * digits and underscores; `en`, `es`, `tr`; a content sid). Which keys a template may carry is
 * `WHATSAPP_KEYS` (channels.ts), checked by `pnpm countries:set`.
 */
export const WhatsappTemplatesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'a message key'),
  z.partialRecord(z.enum(LANGUAGES), z.string().regex(WHATSAPP_CONTENT_SID_RE, 'a content sid')),
);
export type WhatsappTemplates = z.infer<typeof WhatsappTemplatesSchema>;

/**
 * A LiveKit outbound SIP trunk id (`ST_` and 4–64 letters or digits), as the table's check and
 * set_country_endpoints() take it (W3-17, spec §19 Q125).
 */
export const OUTBOUND_TRUNK_ID_RE = /^ST_[A-Za-z0-9]{4,64}$/;

/** The shapes `set_country_endpoints()` accepts for a sender id, by the pack's sender type. */
export function isValidSmsSenderId(type: SmsSenderType, senderId: string): boolean {
  switch (type) {
    case 'alphanumeric':
      return /^[A-Za-z0-9 ]{1,11}$/.test(senderId);
    case 'short_code':
      return /^[0-9]{3,8}$/.test(senderId);
    case 'toll_free':
    case 'long_code':
      return isE164(senderId);
  }
}

/** An IANA time zone the runtime knows (`Intl` throws a RangeError otherwise). */
export function isIanaTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/**
 * A `countries` row as Postgres or PostgREST returns it (snake_case), with the table's checks
 * (20261014000004), including the sender id's shape for its type (trimmed, as
 * `set_country_endpoints()` stores it), and a few the database cannot express: no duplicate
 * channel or locale, a time zone the runtime knows. Unknown columns (a later migration) are
 * dropped, not rejected.
 */
export const CountryRowSchema = z
  .object({
    code: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 in capitals'),
    default_locale: z.enum(ORG_LOCALES),
    field_locales: z
      .array(z.enum(REPORTER_LOCALES))
      .min(1)
      .refine(unique, 'field_locales lists a locale twice'),
    units: z.enum(UNIT_SYSTEMS),
    paper: z.enum(PAPER_SIZES),
    currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code in capitals'),
    default_timezone: z.string().refine(isIanaTimeZone, 'not an IANA time zone'),
    message_channels: z
      .array(MessageChannelSchema)
      .min(1)
      .refine(unique, 'message_channels lists a channel twice'),
    sms_provider: z.enum(SMS_PROVIDERS),
    whatsapp_provider: z.enum(WHATSAPP_PROVIDERS),
    sms_sender_type: z.enum(SMS_SENDER_TYPES),
    sms_sender_id: z.string().min(1).nullable(),
    two_way_sms: z.boolean(),
    sms_links_allowed: z.boolean(),
    // The column's check (isE164's pattern); a type guard here would narrow the row type to E164.
    voice_number: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'voice_number must be E.164')
      .nullable(),
    // W2-15 (20261016000210): per environment, null in every migration.
    whatsapp_sender_id: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'whatsapp_sender_id must be E.164')
      .nullable(),
    whatsapp_templates: WhatsappTemplatesSchema.nullable(),
    // W3-17 (20261016000380, §19 Q125): per environment, null in every migration. Optional so a
    // row read before that migration still parses (as no trunk).
    outbound_trunk_id: z
      .string()
      .regex(OUTBOUND_TRUNK_ID_RE, 'outbound_trunk_id must be a LiveKit SIP trunk id (ST_…)')
      .nullable()
      .default(null),
    legal_keys: LegalKeysSchema,
    created_at: z.string(),
  })
  .superRefine((row, ctx) => {
    if (row.sms_sender_type === 'alphanumeric' && row.two_way_sms)
      ctx.addIssue({
        code: 'custom',
        path: ['two_way_sms'],
        message: 'an alphanumeric sender cannot receive replies',
      });
    // The table also refuses `sms_links_allowed = false` outright until a link-free welcome
    // exists (spec §19 Q24, 20261015000004); the schema keeps the general rule, which the channel
    // layer's tests exercise and which applies again once that check is dropped.
    if (!row.sms_links_allowed && !row.message_channels.some((c) => c !== 'sms'))
      ctx.addIssue({
        code: 'custom',
        path: ['message_channels'],
        message: 'a pack without links in SMS needs whatsapp or push',
      });
    // Push is never a person's only channel (spec §9.3, W2-14): another channel follows it.
    if (row.message_channels.at(-1) === 'push')
      ctx.addIssue({
        code: 'custom',
        path: ['message_channels'],
        message: 'push cannot end message_channels: another channel must follow it',
      });
    if (
      row.sms_sender_id !== null &&
      (row.sms_sender_id !== row.sms_sender_id.trim() ||
        !isValidSmsSenderId(row.sms_sender_type, row.sms_sender_id))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['sms_sender_id'],
        message: `not a valid ${row.sms_sender_type} sender id`,
      });
    // §19 Q126 (W3-17): the trunk's calls show the pack's voice number.
    if (row.outbound_trunk_id !== null && row.voice_number === null)
      ctx.addIssue({
        code: 'custom',
        path: ['outbound_trunk_id'],
        message: 'an outbound trunk needs the pack’s voice number (its caller id)',
      });
  });

/** A country pack in camelCase, for code (spec §4.6). Build one with `toCountryPack()`. */
export interface CountryPack {
  /** ISO 3166-1 alpha-2; also the default phone region of the org's numbers. */
  code: string;
  /** The org's locale at creation: report language and the panel's default. */
  defaultLocale: OrgLocale;
  /** Languages TalkOlog texts and speaks with field users; the first is a new reporter's default. */
  fieldLocales: readonly ReporterLocale[];
  units: UnitSystem;
  paper: PaperSize;
  /** ISO 4217. */
  currency: string;
  /** IANA; the org's time zone when the setup wizard leaves it empty. */
  defaultTimezone: string;
  /** The Notifier's order when the person has no preference (§4.5). */
  messageChannels: readonly MessageChannel[];
  smsProvider: SmsProvider;
  whatsappProvider: WhatsappProvider;
  smsSenderType: SmsSenderType;
  /** null = not registered in this environment: SMS goes through `console`. */
  smsSenderId: string | null;
  /** Replies (STOP/HELP/CALL/TEXT, OK) reach TalkOlog; otherwise one-way copy only. */
  twoWaySms: boolean;
  /** Message keys with a link may go by SMS. */
  smsLinksAllowed: boolean;
  /** null = Talk now only (no phone number to call). */
  voiceNumber: E164 | null;
  /**
   * The Twilio WhatsApp sender in this environment (W2-15, §19 Q39); null = `console` for demo
   * orgs, and WhatsApp leaves a real org's order (§19 Q84).
   */
  whatsappSenderId: E164 | null;
  /** The approved template of each key per language in this environment; `{}` = none. */
  whatsappTemplates: WhatsappTemplates;
  /**
   * W3-17 (spec §19 Q125, Q126): the LiveKit outbound SIP trunk in this environment; null = no
   * automated calls for real orgs (a demo org's calls are `console`, §19 Q132). The calls show
   * `voiceNumber`.
   */
  outboundTrunkId: string | null;
  legalKeys: { privacyNotice?: string; recordingNotice?: string; consent?: string };
}

/** A row (from the database or `DEMO_COUNTRIES`) → a pack. Parses first: a bad row throws. */
export function toCountryPack(row: CountryRow): CountryPack {
  const r = CountryRowSchema.parse(row);
  const legalKeys: CountryPack['legalKeys'] = {};
  if (r.legal_keys.privacy_notice !== undefined)
    legalKeys.privacyNotice = r.legal_keys.privacy_notice;
  if (r.legal_keys.recording_notice !== undefined)
    legalKeys.recordingNotice = r.legal_keys.recording_notice;
  if (r.legal_keys.consent !== undefined) legalKeys.consent = r.legal_keys.consent;
  return {
    code: r.code,
    defaultLocale: r.default_locale,
    fieldLocales: r.field_locales,
    units: r.units,
    paper: r.paper,
    currency: r.currency,
    defaultTimezone: r.default_timezone,
    messageChannels: r.message_channels,
    smsProvider: r.sms_provider,
    whatsappProvider: r.whatsapp_provider,
    smsSenderType: r.sms_sender_type,
    smsSenderId: r.sms_sender_id,
    twoWaySms: r.two_way_sms,
    smsLinksAllowed: r.sms_links_allowed,
    voiceNumber: r.voice_number === null ? null : assertE164(r.voice_number),
    whatsappSenderId: r.whatsapp_sender_id === null ? null : assertE164(r.whatsapp_sender_id),
    whatsappTemplates: r.whatsapp_templates ?? {},
    outboundTrunkId: r.outbound_trunk_id,
    legalKeys,
  };
}

/** What `field-api resolve` hands the field app (W1-07): field users never read `countries`. */
export type FieldCountryView = Pick<
  CountryPack,
  'code' | 'voiceNumber' | 'fieldLocales' | 'twoWaySms' | 'messageChannels' | 'legalKeys'
>;

/**
 * The org values `create_org(p_country)` and `on_org_created` preset from a pack (the SQL is the
 * source; this mirrors it for the wizard's preview and the in-memory stores).
 */
export function orgDefaultsFor(pack: CountryPack): {
  country: string;
  locale: OrgLocale;
  units: UnitSystem;
  currency: string;
  timezone: string;
  pdfPaper: PaperSize;
} {
  return {
    country: pack.code,
    locale: pack.defaultLocale,
    units: pack.units,
    currency: pack.currency,
    timezone: pack.defaultTimezone,
    pdfPaper: pack.paper,
  };
}

/** A new reporter's locale and spoken language in a pack: its first field locale. */
export function reporterDefaultsFor(pack: CountryPack): {
  locale: ReporterLocale;
  languages: [Language];
} {
  const locale = pack.fieldLocales[0];
  if (!locale) throw new Error(`Country pack ${pack.code} has no field locale`);
  return { locale, languages: [languageOf(locale)] };
}

/**
 * The field locale for the languages the office says a reporter speaks (F2 "Speaks", F3 "in the
 * reporter's language"): the first of the pack's field locales whose language is among them (a
 * US reporter who speaks Spanish gets es-US; one who speaks English and Spanish, en-US), or null
 * when none matches (the caller falls back to `reporterDefaultsFor`).
 */
export function reporterLocaleFor(
  pack: CountryPack,
  languages: readonly string[] | undefined,
): ReporterLocale | null {
  if (!languages || languages.length === 0) return null;
  const spoken = new Set(languages.map((l) => l.trim().toLowerCase()));
  return pack.fieldLocales.find((locale) => spoken.has(languageOf(locale))) ?? null;
}

/**
 * The copy a pack lacks (spec §4.6: a new country is only a row when its languages have their
 * copy): the SMS copy as `<field locale>.<key>[.<variant>]` (every shared key in each of its field
 * locales, and with two-way SMS also the two-way keys and the welcome's reply hint), and since
 * W4-06 the legal texts its `legal_keys` name as `legal.<slot>.<problem>` (`legalKeyGaps`: a text
 * in each field language, never a placeholder). Empty = the pack has all the copy it can be sent;
 * supabase/db-tests checks it for every `countries` row.
 */
export function packCopyGaps(pack: CountryPack): string[] {
  const sms = pack.fieldLocales.flatMap((locale) =>
    smsCopyGaps(languageOf(locale), { twoWay: pack.twoWaySms }).map((gap) => `${locale}.${gap}`),
  );
  const legal = legalKeyGaps(pack.legalKeys, fieldLanguagesOf(pack.fieldLocales), {
    country: pack.code,
  }).map((gap) => `legal.${gap}`);
  return [...sms, ...legal];
}
