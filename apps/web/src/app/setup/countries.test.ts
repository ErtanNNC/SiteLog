import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_COUNTRIES, demoPack } from '@sitelog/shared/demo/countries.ts';
import type { CountryRow } from '@sitelog/shared/db/types.ts';
import { copy } from '@/copy/en';
import type { Db } from '@/lib/supabase';
import {
  countryName,
  DEMO_PACKS,
  FALLBACK_SITE_DEFAULTS,
  loadCountryPacks,
  packFor,
  reportLanguageName,
  siteDefaultsFor,
} from './countries';
import { TIMEZONES } from './timezones';

/** PostgREST as loadCountryPacks() meets it: `from(t).select(cols).order(col)`. */
function fakeDb(result: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      return {
        select(cols: string) {
          return {
            order(col: string) {
              calls.push(`${table}: select ${cols} order ${col}`);
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Db, calls };
}

const US = DEMO_COUNTRIES.find((c) => c.code === 'US')!;
const TR = DEMO_COUNTRIES.find((c) => c.code === 'TR')!;
/** A pack no code knows about (spec §4.6: a new country is a new row). */
const ZZ: CountryRow = {
  ...US,
  code: 'ZZ',
  default_locale: 'en-US',
  field_locales: ['es-US'],
  units: 'metric',
  paper: 'a4',
  currency: 'EUR',
  default_timezone: 'UTC',
  message_channels: ['whatsapp', 'sms'],
  sms_sender_type: 'alphanumeric',
  two_way_sms: false,
  sms_links_allowed: false,
};

afterEach(() => vi.restoreAllMocks());

describe('loadCountryPacks', () => {
  it('lists DEMO_COUNTRIES without a database (demo mode, tests), by code', async () => {
    const packs = await loadCountryPacks(null);
    expect(packs.map((p) => p.code)).toEqual(['TR', 'US']);
    expect(packs).toEqual([...DEMO_PACKS]);
    expect(packs).toEqual([demoPack('TR'), demoPack('US')]);
  });

  it('reads every row of the countries table under RLS, parsed into packs', async () => {
    const { db, calls } = fakeDb({ data: [TR, US, ZZ], error: null });
    const packs = await loadCountryPacks(db);
    expect(calls).toEqual(['countries: select * order code']);
    expect(packs.map((p) => p.code)).toEqual(['TR', 'US', 'ZZ']);
    expect(packFor(packs, 'ZZ')).toMatchObject({
      defaultLocale: 'en-US',
      units: 'metric',
      paper: 'a4',
      currency: 'EUR',
      defaultTimezone: 'UTC',
    });
  });

  it('leaves out a row this build cannot read, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const later = { ...ZZ, code: 'ZY', default_locale: 'de-DE' } as unknown as CountryRow;
    const { db } = fakeDb({ data: [TR, later, US], error: null });
    expect((await loadCountryPacks(db)).map((p) => p.code)).toEqual(['TR', 'US']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('country pack ZY'),
      expect.anything(),
    );
  });

  it('fails on a PostgREST error and when no pack is readable', async () => {
    await expect(
      loadCountryPacks(fakeDb({ data: null, error: { message: 'permission denied' } }).db),
    ).rejects.toThrow('permission denied');
    await expect(loadCountryPacks(fakeDb({ data: [], error: null }).db)).rejects.toThrow(
      'No country is set up',
    );
  });
});

describe('pack labels and defaults', () => {
  it('names a country from the browser, never from copy (ICU decides "Türkiye" or "Turkey")', () => {
    for (const code of ['US', 'TR']) {
      expect(countryName(code)).not.toBe('');
      expect(countryName(code)).not.toBe(code);
    }
    // Not a region code at all: the code itself.
    expect(countryName('not-a-region')).toBe('not-a-region');
  });

  it('names the report language of an org locale (§9.6) from copy, as the language chips do', () => {
    expect(reportLanguageName(demoPack('US').defaultLocale)).toBe('English');
    expect(reportLanguageName(demoPack('TR').defaultLocale)).toBe('Turkish');
    expect(reportLanguageName('tr-TR')).toBe(copy.team.invite.languageNames.tr);
    // An org summary without its locale (an older cached list): the column default.
    expect(reportLanguageName(undefined)).toBe('English');
  });

  it('gives a new site manager the pack’s phone country and first field language', () => {
    expect(siteDefaultsFor(demoPack('US'))).toEqual({ phoneCountry: 'US', languages: ['en'] });
    expect(siteDefaultsFor(demoPack('TR'))).toEqual({ phoneCountry: 'TR', languages: ['tr'] });
    // A pack whose country the phone picker does not list keeps a US number; Spanish first.
    const zz = { ...demoPack('US'), code: 'ZZ', fieldLocales: ['es-US'] as const };
    expect(siteDefaultsFor(zz)).toEqual({ phoneCountry: 'US', languages: ['es'] });
    expect(siteDefaultsFor(undefined)).toBe(FALLBACK_SITE_DEFAULTS);
  });

  it('lists every pack’s default time zone in the setup selects', () => {
    for (const pack of DEMO_PACKS) expect(TIMEZONES).toContain(pack.defaultTimezone);
  });
});
