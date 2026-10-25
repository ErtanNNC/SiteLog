import type { CountryRow } from '../db/types.ts';
import { toCountryPack, type CountryPack } from '../countries.ts';

/**
 * The launch country packs as rows, for the modes without a database: the panel's demo mode
 * (`VITE_DEMO`), unit tests, the worker's fake database and the demo builders. The `countries`
 * table is the source of truth (20261014000004_country_packs.sql, spec §4.6, GAP D47);
 * supabase/db-tests/src/countries.test.ts fails until these rows equal the migrated ones, so a
 * migration that adds or changes a pack changes this list in the same commit.
 *
 * `sms_sender_id`, `voice_number`, `whatsapp_sender_id` and `whatsapp_templates` (and, W3-17, `outbound_trunk_id`) are per environment and null here, as the migration seeds
 * them: every pack sends through `console` until its sender is set in a database
 * (set_country_endpoints()). `created_at` is the migration's date; a database row holds the
 * moment the migration ran, which the parity test does not compare.
 */
export const DEMO_COUNTRIES: readonly CountryRow[] = [
  {
    code: 'TR',
    // §19 Q378 (20261025000100_turkish_off.sql): Turkish is off, the pack speaks English.
    default_locale: 'en-US',
    field_locales: ['en-US'],
    units: 'metric',
    paper: 'a4',
    currency: 'TRY',
    default_timezone: 'Europe/Istanbul',
    message_channels: ['push', 'whatsapp'],
    sms_provider: 'twilio',
    whatsapp_provider: 'twilio',
    sms_sender_type: 'long_code',
    sms_sender_id: null,
    two_way_sms: false,
    sms_links_allowed: true,
    voice_number: null,
    whatsapp_sender_id: null,
    whatsapp_templates: null,
    outbound_trunk_id: null,
    legal_keys: {},
    created_at: '2026-10-14T00:00:00.000Z',
  },
  {
    code: 'US',
    default_locale: 'en-US',
    field_locales: ['en-US', 'es-US'],
    units: 'imperial',
    paper: 'letter',
    currency: 'USD',
    default_timezone: 'America/Chicago',
    message_channels: ['push', 'whatsapp'],
    sms_provider: 'twilio',
    whatsapp_provider: 'twilio',
    sms_sender_type: 'toll_free',
    sms_sender_id: null,
    two_way_sms: true,
    sms_links_allowed: true,
    voice_number: null,
    whatsapp_sender_id: null,
    whatsapp_templates: null,
    outbound_trunk_id: null,
    legal_keys: {},
    created_at: '2026-10-14T00:00:00.000Z',
  },
];

/** The TR pack's locales before §19 Q378 turned Turkish off (20261014000004_country_packs.sql). */
export const TR_TURKISH_LOCALES = {
  default_locale: 'tr-TR',
  field_locales: ['tr-TR', 'en-US'],
} as const satisfies Pick<CountryRow, 'default_locale' | 'field_locales'>;

/**
 * The launch packs as a build sees them. With Turkish off (the deployed builds) they are
 * `DEMO_COUNTRIES`; a build with Turkish on (`VITE_TURKISH=true`: the panel's and the field app's
 * tests and e2e builds, §19 Q378) gets the TR pack's Turkish locales back, as the e2e global setup
 * gives the local stack's TR pack.
 */
export function demoCountriesFor(turkish: boolean): readonly CountryRow[] {
  if (!turkish) return DEMO_COUNTRIES;
  return DEMO_COUNTRIES.map((c) =>
    c.code === 'TR'
      ? { ...c, ...TR_TURKISH_LOCALES, field_locales: [...TR_TURKISH_LOCALES.field_locales] }
      : c,
  );
}

/** The demo datasets' packs: Kestrel is a US org (§18.1), Demir Yapı a TR org (§18.2). */
export type DemoCountryCode = 'US' | 'TR';

/** A launch pack from `DEMO_COUNTRIES`, parsed. */
export function demoPack(code: DemoCountryCode): CountryPack {
  const row = DEMO_COUNTRIES.find((c) => c.code === code);
  if (!row) throw new Error(`No demo country pack ${code}`);
  return toCountryPack(row);
}
