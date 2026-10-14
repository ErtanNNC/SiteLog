import type { CountryRow } from '../db/types.ts';
import { toCountryPack, type CountryPack } from '../countries.ts';

/**
 * The launch country packs as rows, for the modes without a database: the panel's demo mode
 * (`VITE_DEMO`), unit tests, the worker's fake database and the demo builders. The `countries`
 * table is the source of truth (20261014000004_country_packs.sql, spec §4.6, GAP D47);
 * supabase/db-tests/src/countries.test.ts fails until these rows equal the migrated ones, so a
 * migration that adds or changes a pack changes this list in the same commit.
 *
 * `sms_sender_id` and `voice_number` are per environment and null here, as the migration seeds
 * them: every pack sends through `console` until its sender is set in a database
 * (set_country_endpoints()). `created_at` is the migration's date; a database row holds the
 * moment the migration ran, which the parity test does not compare.
 */
export const DEMO_COUNTRIES: readonly CountryRow[] = [
  {
    code: 'TR',
    default_locale: 'tr-TR',
    field_locales: ['tr-TR', 'en-US'],
    units: 'metric',
    paper: 'a4',
    currency: 'TRY',
    default_timezone: 'Europe/Istanbul',
    message_channels: ['sms'],
    sms_provider: 'iletimerkezi',
    whatsapp_provider: 'twilio',
    sms_sender_type: 'alphanumeric',
    sms_sender_id: null,
    two_way_sms: false,
    sms_links_allowed: true,
    voice_number: null,
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
    message_channels: ['sms'],
    sms_provider: 'twilio',
    whatsapp_provider: 'twilio',
    sms_sender_type: 'toll_free',
    sms_sender_id: null,
    two_way_sms: true,
    sms_links_allowed: true,
    voice_number: null,
    legal_keys: {},
    created_at: '2026-10-14T00:00:00.000Z',
  },
];

/** The demo datasets' packs: Kestrel is a US org (§18.1), Demir Yapı a TR org (§18.2). */
export type DemoCountryCode = 'US' | 'TR';

/** A launch pack from `DEMO_COUNTRIES`, parsed. */
export function demoPack(code: DemoCountryCode): CountryPack {
  const row = DEMO_COUNTRIES.find((c) => c.code === code);
  if (!row) throw new Error(`No demo country pack ${code}`);
  return toCountryPack(row);
}
