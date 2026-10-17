import { useQuery } from '@tanstack/react-query';
import { reporterDefaultsFor, toCountryPack, type CountryPack } from '@sitelog/shared/countries.ts';
import type { CountryRow } from '@sitelog/shared/db/types.ts';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { reportLanguageFor, type OrgLocale } from '@sitelog/shared/locale.ts';
import { phoneCountryFor } from '@/components/sitelog/PhoneInput';
import { copy } from '@/copy/en';
import { supabase, type Db } from '@/lib/supabase';

/**
 * The setup wizard's country packs (spec §4.6, GAP D47). The `countries` table is the one source
 * of truth: in Supabase mode the wizard reads it under RLS (every signed-in user may, since the
 * wizard runs before the user has an org); without a database (`VITE_DEMO`, unit tests) it lists
 * `DEMO_COUNTRIES`, which supabase/db-tests keeps equal to the migrated rows. A new country is a
 * new row: the wizard lists it with its name from the browser (`Intl.DisplayNames`), no code.
 */

/** The packs without a database, by code (the order of the database query). */
export const DEMO_PACKS: readonly CountryPack[] = [...DEMO_COUNTRIES]
  .sort((a, b) => a.code.localeCompare(b.code))
  .map(toCountryPack);

/**
 * Every pack this panel build understands, by code. A row it cannot parse (a later migration
 * named a locale, unit or provider this build has no code for) is left out with a warning
 * rather than failing the list: the wizard cannot show its presets. No pack at all is an error.
 */
export async function loadCountryPacks(db: Db | null): Promise<CountryPack[]> {
  if (!db) return [...DEMO_PACKS];
  const { data, error } = await db.from('countries').select('*').order('code');
  if (error) throw new Error(error.message);
  const packs: CountryPack[] = [];
  for (const row of (data ?? []) as CountryRow[]) {
    try {
      packs.push(toCountryPack(row));
    } catch (err) {
      console.warn(`[setup] country pack ${row.code} is not understood by this panel`, err);
    }
  }
  if (packs.length === 0) throw new Error(copy.setup.company.noCountries);
  return packs;
}

export const COUNTRIES_QUERY_KEY = ['countries'] as const;

/** The packs, cached for the session (they change only by migration). */
export function useCountryPacks() {
  return useQuery({
    queryKey: COUNTRIES_QUERY_KEY,
    queryFn: () => loadCountryPacks(supabase),
    // Demo mode and tests have them at once: no loading state without a database.
    initialData: supabase ? undefined : [...DEMO_PACKS],
    staleTime: Infinity,
  });
}

/** The browser's language tags, most preferred first (`navigator.languages`); none outside one. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * Spec §19 Q32 (M10, W4-01): before an org exists the wizard preselects the pack whose code is the
 * browser's region: the first language tag that names a region with a pack (`tr-TR` → TR; `en`
 * names none and is skipped; `de-DE` has no pack and is skipped). Null when none does (then US).
 */
export function browserPackCountry(
  packs: readonly CountryPack[] | undefined,
  languages: readonly string[] = browserLanguages(),
): string | null {
  const codes = new Set((packs ?? []).map((p) => p.code));
  for (const tag of languages) {
    let region: string | undefined;
    try {
      region = new Intl.Locale(tag).region;
    } catch {
      continue;
    }
    if (region && codes.has(region)) return region;
  }
  return null;
}

export function packFor(
  packs: readonly CountryPack[] | undefined,
  code: string,
): CountryPack | undefined {
  return packs?.find((p) => p.code === code);
}

/**
 * "TR" → "Türkiye" in English (the Setup page is English-only); the code if the browser has none.
 * ICU decides the name ("Türkiye" or "Turkey"), so the selects show the code beside it.
 */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The report language an org locale sets (§9.6: `orgs.locale`, a pack's `defaultLocale`), named
 * in English as the reporter language chips name it: "Turkish". Report languages are code
 * (`REPORT_LANGUAGES`), so their names are copy, not the browser's. Without a locale (an older
 * cached org summary) the column default, English.
 */
export function reportLanguageName(locale: OrgLocale | undefined): string {
  return copy.team.invite.languageNames[reportLanguageFor(locale ?? 'en-US')];
}

/** A new site manager's defaults in a pack's country: its phone country and first field language. */
export interface SiteDefaults {
  /** A region libphonenumber knows: the pack's country, or US for one it does not know. */
  phoneCountry: string;
  languages: string[];
}

/** Without a pack (none loaded): today's defaults, a US number in English. */
export const FALLBACK_SITE_DEFAULTS: SiteDefaults = { phoneCountry: 'US', languages: ['en'] };

export function siteDefaultsFor(pack: CountryPack | undefined): SiteDefaults {
  if (!pack) return FALLBACK_SITE_DEFAULTS;
  return {
    phoneCountry: phoneCountryFor(pack.code, FALLBACK_SITE_DEFAULTS.phoneCountry),
    languages: [...reporterDefaultsFor(pack).languages],
  };
}
