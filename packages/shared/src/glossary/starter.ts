import type { GlossaryTermRow } from '../db/types.ts';
import type { TermKind } from '../enums.ts';
import type { ReportLanguage } from '../locale.ts';
import { STARTER_GLOSSARY_EN } from './starter.en.ts';
import { STARTER_GLOSSARY_TR } from './starter.tr.ts';

/**
 * Spec §19 Q238 (W4-08, the recommended default): every new org starts with SiteLog's short
 * built-in glossary in its report language (§9.6: `en-US` → English, `tr-TR` → Turkish), seeded
 * `built_in` by `on_org_created()` through `seed_starter_glossary()`
 * (20261017000410_starter_glossary.sql). Built-in terms count as confirmed (`isUsableTerm`): they
 * reach the extraction prompt and the speech-recognition key terms of voice notes and calls
 * (`buildKeyterms`, `get_context`), and the office changes or rejects them on the glossary page
 * (`review_glossary_term`, audited). The lists are in spec §18.3 for the native-speaker read (Q63).
 * Pure: no I/O, Node, browser and Deno.
 */
export interface StarterTerm {
  /** The phrase as a site manager says it. */
  heard: string;
  /** How the report writes it. */
  official: string;
  /** Never `company` or `area`: those are the org's own. */
  kind: Extract<TermKind, 'term' | 'unit'>;
}

export const STARTER_GLOSSARY: Readonly<Record<ReportLanguage, readonly StarterTerm[]>> = {
  en: STARTER_GLOSSARY_EN,
  tr: STARTER_GLOSSARY_TR,
};

/** The starter list of a report language. */
export function starterGlossaryFor(language: ReportLanguage): readonly StarterTerm[] {
  return STARTER_GLOSSARY[language];
}

/** The key the seed matches an existing row on: the kind and the heard phrase in any case. */
export function starterTermKey(term: { heard: string; kind: TermKind }): string {
  return `${term.kind}:${term.heard.toLowerCase()}`;
}

/**
 * The org's built-in rows as `seed_starter_glossary()` writes them, for data built in code (the
 * §18 demo orgs): the language's starter terms the org has no row for yet (same kind and heard
 * phrase in any case, at any scope), `built_in`, never heard, org-wide.
 */
export function starterGlossaryRows(input: {
  orgId: string;
  language: ReportLanguage;
  /** The org's rows already there: a starter term never doubles one. */
  existing: ReadonlyArray<Pick<GlossaryTermRow, 'heard' | 'kind'>>;
  /** `first_seen_at`: when the org was created. */
  at: string;
  /** The row id of a term (the demo's deterministic ids). */
  id: (term: StarterTerm) => string;
}): GlossaryTermRow[] {
  const taken = new Set(input.existing.map(starterTermKey));
  return starterGlossaryFor(input.language)
    .filter((term) => !taken.has(starterTermKey(term)))
    .map((term) => ({
      id: input.id(term),
      org_id: input.orgId,
      scope_site_id: null,
      scope_reporter_id: null,
      heard: term.heard,
      official: term.official,
      language: input.language,
      kind: term.kind,
      company_id: null,
      status: 'built_in',
      times_heard: 0,
      first_seen_at: input.at,
      last_seen_at: null,
    }));
}
