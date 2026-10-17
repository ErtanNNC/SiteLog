import { reportLanguageFor, type OrgLocale, type ReportLanguage } from './locale.ts';

/**
 * The language of the office emails other than the report email (spec §13, §19 Q239): missing,
 * EOT pack ready, weekly digest, unknown contact, edited after sign-off.
 *
 * - `reader` (the recommended default, built in W4-09): each office recipient's panel language,
 *   `org_members.ui_locale`, else the org's locale (§11.2); an address that is no member of the
 *   org (a site recipient, a typed address) gets the org's language.
 * - `org`: the org's language for every email.
 * - `en`: English for every email.
 *
 * The report email follows the report's language and the invoice query the org's report language
 * whatever the policy (§13, Q239). A policy value, changed in code, not env.
 */
export const OFFICE_EMAIL_LANGUAGE_POLICIES = ['reader', 'org', 'en'] as const;
export type OfficeEmailLanguagePolicy = (typeof OFFICE_EMAIL_LANGUAGE_POLICIES)[number];

export const OFFICE_EMAIL_LANGUAGE: OfficeEmailLanguagePolicy = 'reader';

/** One office recipient as the worker lists them: their address and own panel language. */
export interface OfficeReader {
  email: string;
  uiLocale: OrgLocale | null;
}

/** The language one office reader gets an email in. */
export function officeEmailLanguage(
  uiLocale: OrgLocale | null | undefined,
  orgLocale: OrgLocale | null | undefined,
  policy: OfficeEmailLanguagePolicy = OFFICE_EMAIL_LANGUAGE,
): ReportLanguage {
  if (policy === 'en') return 'en';
  const locale = (policy === 'reader' ? uiLocale : null) ?? orgLocale;
  return locale ? reportLanguageFor(locale) : 'en';
}

/**
 * Splits the addresses of one email by the language each reader gets: a member of the org by
 * their panel language, any other address by the org's. Addresses compare case-insensitively and
 * appear once; English first, then Turkish, each in the order given. Empty groups are left out.
 */
export function groupByEmailLanguage(
  to: readonly string[],
  members: readonly OfficeReader[],
  orgLocale: OrgLocale | null | undefined,
  policy: OfficeEmailLanguagePolicy = OFFICE_EMAIL_LANGUAGE,
): Array<{ language: ReportLanguage; to: string[] }> {
  const own = new Map(members.map((m) => [m.email.toLowerCase(), m.uiLocale]));
  const groups: Record<ReportLanguage, string[]> = { en: [], tr: [] };
  const seen = new Set<string>();
  for (const address of to) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    groups[officeEmailLanguage(own.get(key) ?? null, orgLocale, policy)].push(address);
  }
  return (['en', 'tr'] as const)
    .filter((language) => groups[language].length > 0)
    .map((language) => ({ language, to: groups[language] }));
}
