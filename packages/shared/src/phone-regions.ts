/**
 * The panel's phone-country picker (spec §4.6, M10, W4-01): every region libphonenumber knows,
 * with its calling code, its name in the reader's language and an example mobile number. A new
 * country pack needs no code here: its country is listed as soon as libphonenumber knows the
 * region. Node, browser and Deno (no Node-only API).
 *
 * Names come from `Intl.DisplayNames` (ICU), so they follow the language asked for ("Türkiye",
 * "Almanya" in Turkish) and are not copy. The examples are libphonenumber's mobile examples, about
 * 1.5 kB gzip; a region without one shows "+{code} …".
 */
import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import mobileExamples from 'libphonenumber-js/mobile/examples';
import { parseE164, type E164 } from './format.ts';

export interface PhoneRegion {
  /** ISO 3166-1 alpha-2, as libphonenumber names it ("TR", "US"; also "AC", "XK"). */
  code: string;
  /** Without the "+": "90", "1". */
  callingCode: string;
  /** In the language asked for; the code when the runtime has no name for it. */
  name: string;
  /** International format: "+90 501 234 56 78", or "+{code} …" without a mobile example. */
  example: string;
  /** National format for the number field's placeholder ("0501 234 56 78"), or null. */
  nationalExample: string | null;
}

/** The fallback region for a code libphonenumber does not know (today's default, spec §19 Q32). */
export const DEFAULT_PHONE_REGION = 'US';

/** A region libphonenumber knows (so it can parse national numbers typed for it). */
export function isPhoneRegion(code: string | null | undefined): code is CountryCode {
  return !!code && /^[A-Z]{2}$/.test(code) && isSupportedCountry(code);
}

/**
 * The picker's region for a country (`countries.code`, an org's or the wizard's): that country
 * when libphonenumber knows it, otherwise `fallback` (a synthetic pack row such as `XX`).
 */
export function phoneRegionFor(
  country: string | null | undefined,
  fallback: string = DEFAULT_PHONE_REGION,
): string {
  return isPhoneRegion(country) ? country : fallback;
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

/** "TR" → "Türkiye" (en, tr), "DE" → "Almanya" (tr); the code when the runtime has no name. */
export function phoneRegionName(code: string, language: string): string {
  let names = displayNames.get(language);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([language], { type: 'region', fallback: 'code' });
    } catch {
      names = null;
    }
    displayNames.set(language, names);
  }
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

function exampleFor(code: CountryCode, callingCode: string) {
  const example = getExampleNumber(code, mobileExamples);
  return example
    ? { example: example.formatInternational(), nationalExample: example.formatNational() }
    : { example: `+${callingCode} …`, nationalExample: null };
}

/** One region, named in `language`; null when libphonenumber does not know the code. */
export function phoneRegion(code: string, language: string): PhoneRegion | null {
  if (!isPhoneRegion(code)) return null;
  const callingCode = getCountryCallingCode(code);
  return {
    code,
    callingCode,
    name: phoneRegionName(code, language),
    ...exampleFor(code, callingCode),
  };
}

const sorted = new Map<string, readonly PhoneRegion[]>();

/**
 * Every region, named and sorted in `language` (`Intl.Collator`), with `first` (the org's pack
 * country) on top when libphonenumber knows it. Cached per language.
 */
export function phoneRegions(language: string, first?: string | null): PhoneRegion[] {
  let all = sorted.get(language);
  if (!all) {
    const collator = new Intl.Collator(language);
    all = getCountries()
      .map((code) => phoneRegion(code, language)!)
      .sort((a, b) => collator.compare(a.name, b.name) || a.code.localeCompare(b.code));
    sorted.set(language, all);
  }
  if (!isPhoneRegion(first)) return [...all];
  const top = all.find((r) => r.code === first)!;
  return [top, ...all.filter((r) => r.code !== first)];
}

/** Case and accent folded, with the Turkish dotless i read as i: "Türkiye" → "turkiye". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i');
}

/**
 * The picker's search: a name (from its start first, then anywhere in it), an ISO code ("tr") or
 * a calling code ("+90", "90", "1"). The list keeps its order within each rank; an empty query
 * returns it unchanged.
 */
export function searchPhoneRegions(regions: readonly PhoneRegion[], query: string): PhoneRegion[] {
  const q = query.trim();
  if (!q) return [...regions];
  const digits = q.replace(/[\s+()-]/g, '');
  if (/^\d+$/.test(digits)) return regions.filter((r) => r.callingCode.startsWith(digits));
  const f = fold(q);
  const code = q.length === 2 ? q.toUpperCase() : null;
  const byCode = regions.filter((r) => r.code === code);
  const starts = regions.filter((r) => r.code !== code && fold(r.name).startsWith(f));
  const within = regions.filter(
    (r) => r.code !== code && !fold(r.name).startsWith(f) && fold(r.name).includes(f),
  );
  return [...byCode, ...starts, ...within];
}

/**
 * Typed input → E.164 for the picked region (national numbers with its trunk prefix, "0532 …"
 * in TR), or null. A region libphonenumber does not know reads as US.
 */
export function parsePhoneIn(raw: string, region: string): E164 | null {
  return parseE164(raw, { defaultCountry: phoneRegionFor(region) as CountryCode });
}

/**
 * The region a stored number belongs to. libphonenumber's "min" metadata cannot always tell
 * regions that share a calling code apart (+1, +44, +7) for numbers outside known ranges (the
 * fictional 555-01xx demo numbers); then the picked region counts when it has that calling code,
 * else the calling code's main region. Null for something that is not a phone number.
 */
export function numberRegion(e164: string, picked?: string | null): string | null {
  const parsed = parsePhoneNumberFromString(e164.trim());
  if (!parsed) return null;
  if (parsed.country) return parsed.country;
  if (isPhoneRegion(picked) && getCountryCallingCode(picked) === parsed.countryCallingCode)
    return picked;
  return parsed.getPossibleCountries()[0] ?? null;
}

/**
 * Spec §19 Q23 (decided: the org's pack applies, warn at invite, never block): the number's region
 * when it differs from the org's pack country, else null. A pack libphonenumber does not know
 * (a synthetic row) has nothing to compare against: null.
 */
export function foreignNumberRegion(
  e164: string,
  packCountry: string | null | undefined,
  picked?: string | null,
): string | null {
  if (!isPhoneRegion(packCountry)) return null;
  const region = numberRegion(e164, picked);
  return region && region !== packCountry ? region : null;
}
