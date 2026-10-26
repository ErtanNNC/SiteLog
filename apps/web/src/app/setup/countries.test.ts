import { afterEach, describe, expect, it, vi } from 'vitest';
import { toCountryPack } from '@sitelog/shared/countries.ts';
import { demoCountriesFor } from '@sitelog/shared/demo/countries.ts';
import type { CountryRow } from '@sitelog/shared/db/types.ts';
import { copy } from '@/copy/en';
import { i18n } from '@/i18n/i18n';
import { translate } from '@/i18n/useCopy';
import type { Db } from '@/lib/supabase';
import {
  browserPackCountry,
  countryName,
  DEMO_PACKS,
  FALLBACK_SITE_DEFAULTS,
  loadCountryPacks,
  packFor,
  reportLanguageName,
  siteDefaultsFor,
} from './countries';
import { TIMEZONES, timezoneOptions } from './timezones';

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

// The tests run with Turkish on (§19 Q378): the TR pack has its Turkish locales.
const DEMO_COUNTRIES = demoCountriesFor(true);
const US = DEMO_COUNTRIES.find((c) => c.code === 'US')!;
const TR = DEMO_COUNTRIES.find((c) => c.code === 'TR')!;
const demoPack = (code: 'US' | 'TR') => toCountryPack(code === 'US' ? US : TR);
const ALL_PACKS = DEMO_PACKS;
const LAUNCH_PACKS = DEMO_PACKS.filter((p) => p.code === 'TR' || p.code === 'US');
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
    // §19 Q379: every country, the launch packs among them.
    expect(packs).toEqual([...DEMO_PACKS]);
    expect(packs.map((p) => p.code)).toEqual(packs.map((p) => p.code).sort());
    expect(packs.length).toBeGreaterThan(200);
    expect(packs.filter((p) => p.code === 'TR' || p.code === 'US')).toEqual([
      demoPack('TR'),
      demoPack('US'),
    ]);
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
    // W4-02: in the panel's language (the browser's names).
    expect(countryName('DE', 'tr')).toBe(
      new Intl.DisplayNames(['tr'], { type: 'region' }).of('DE'),
    );
    expect(countryName('DE', 'tr')).not.toBe(countryName('DE', 'en'));
  });

  it('names the report language of an org locale (§9.6) from copy, as the language chips do', async () => {
    expect(reportLanguageName(translate, demoPack('US').defaultLocale)).toBe('English');
    expect(reportLanguageName(translate, demoPack('TR').defaultLocale)).toBe('Turkish');
    expect(reportLanguageName(translate, 'tr-TR')).toBe(copy.team.invite.languageNames.tr);
    // An org summary without its locale (an older cached list): the column default.
    expect(reportLanguageName(translate, undefined)).toBe('English');
    await i18n.changeLanguage('tr');
    try {
      expect(reportLanguageName(translate, 'tr-TR')).toBe('Türkçe');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('gives a new site manager the pack’s phone country, first field language and locale', () => {
    expect(siteDefaultsFor(demoPack('US'))).toEqual({
      phoneCountry: 'US',
      languages: ['en'],
      locale: 'en-US',
    });
    expect(siteDefaultsFor(demoPack('TR'))).toEqual({
      phoneCountry: 'TR',
      languages: ['tr'],
      locale: 'tr-TR',
    });
    // A new pack needs no picker code (W4-01): any region libphonenumber knows is its own.
    const nl = { ...demoPack('US'), code: 'NL' };
    expect(siteDefaultsFor(nl)).toEqual({ phoneCountry: 'NL', languages: ['en'], locale: 'en-US' });
    // A synthetic row libphonenumber does not know keeps a US number; Spanish first.
    const zz = { ...demoPack('US'), code: 'ZZ', fieldLocales: ['es-US'] as const };
    expect(siteDefaultsFor(zz)).toEqual({ phoneCountry: 'US', languages: ['es'], locale: 'es-US' });
    expect(siteDefaultsFor(undefined)).toBe(FALLBACK_SITE_DEFAULTS);
  });

  it('preselects the pack of the browser’s region before the org exists (spec §19 Q32)', () => {
    // §19 Q379: every region has a pack now; the rules below run on the launch packs.
    const DEMO_PACKS = LAUNCH_PACKS;
    expect(browserPackCountry(ALL_PACKS, ['de-DE', 'en'])).toBe('DE');
    expect(browserPackCountry(DEMO_PACKS, ['tr-TR', 'en-US'])).toBe('TR');
    expect(browserPackCountry(DEMO_PACKS, ['en-US', 'tr-TR'])).toBe('US');
    // A tag without a region, or a region without a pack, is skipped.
    expect(browserPackCountry(DEMO_PACKS, ['tr', 'de-DE', 'en-TR'])).toBe('TR');
    expect(browserPackCountry(DEMO_PACKS, ['de-DE', 'en'])).toBeNull();
    expect(browserPackCountry(DEMO_PACKS, ['not a tag', 'es-US'])).toBe('US');
    expect(browserPackCountry(DEMO_PACKS, [])).toBeNull();
    expect(browserPackCountry(undefined, ['tr-TR'])).toBeNull();
    // A new pack is a row: preselected with no code.
    const xx = { ...demoPack('US'), code: 'NL' };
    expect(browserPackCountry([...DEMO_PACKS, xx], ['nl-NL'])).toBe('NL');
  });

  it('lists every pack’s default time zone in the setup selects', () => {
    // The launch packs' zones are in the list; any other pack's is added as the select's value.
    for (const pack of LAUNCH_PACKS) expect(TIMEZONES).toContain(pack.defaultTimezone);
    for (const pack of ALL_PACKS)
      expect(timezoneOptions(pack.defaultTimezone)).toContain(pack.defaultTimezone);
  });
});
