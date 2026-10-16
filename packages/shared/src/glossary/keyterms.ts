import type { CompanyRow, GlossaryTermRow } from '../db/types.ts';

/**
 * §10.2 speech-recognition hints (Deepgram `keyterm`, Nova-3), one list for every way a site
 * manager talks to SiteLog (spec F21: "confirmed terms are used both by extraction and as
 * speech-recognition hints for calls and voice notes"): the worker's batch transcription of a
 * voice note (`transcribe_upload`) and, on a call, `get_context`'s `keyterms` for the agent's
 * streaming STT (W3-03, §9.4). Moved here from the worker in W3-08 so both get the same list.
 * Pure: no I/O, Node, browser and Deno.
 */

/** Deepgram counts key-term tokens (500 at most per request); stay well inside it. */
export const KEYTERMS_MAX = 100;
export const KEYTERMS_MAX_WORDS = 400;
/** `get_context`'s schema caps each key term at 100 characters; a hint is a phrase, not a sentence. */
export const KEYTERM_MAX_CHARS = 60;
/** §10.2: the top 50 confirmed glossary terms. */
export const KEYTERMS_GLOSSARY_TOP = 50;

export interface VocabularyContext {
  /**
   * The site's name; a list when the site is not known yet (a call before `pick_site`: each of
   * the reporter's sites, in order).
   */
  siteName: string | readonly string[];
  companies: ReadonlyArray<Pick<CompanyRow, 'name' | 'aliases'>>;
  glossary: ReadonlyArray<
    Pick<GlossaryTermRow, 'heard' | 'status' | 'times_heard'> &
      Partial<Pick<GlossaryTermRow, 'kind' | 'official' | 'language'>>
  >;
  /** The reporter's languages (`es`, `en`, `tr`): glossary terms in other languages are left out. */
  languages?: readonly string[];
}

function base(tag: string | null | undefined): string {
  return (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
}

/** A run of 7 or more digits (a phone number, an account number): never sent to a provider. */
function hasLongNumber(term: string): boolean {
  return term.replace(/[\s().+-]/g, '').match(/\d{7,}/) !== null;
}

/** Confirmed by the office, or SiteLog's own: the only terms that become hints (F21). */
export function isUsableTerm(status: GlossaryTermRow['status']): boolean {
  return status === 'confirmed' || status === 'built_in';
}

/**
 * §10.2 hints as Deepgram key terms: the site name(s), company names and aliases, the site's areas
 * (glossary terms of kind `area`, heard and official), and the top 50 confirmed glossary terms in
 * the reporter's languages. Deduplicated (case-insensitive), capped, and never a phone number.
 */
export function buildKeyterms(ctx: VocabularyContext): string[] {
  const langs = new Set((ctx.languages ?? []).map(base).filter(Boolean));
  const inLanguage = (l: string | undefined) => !l || langs.size === 0 || langs.has(base(l));
  const glossary = ctx.glossary.filter((g) => isUsableTerm(g.status));
  const areas = glossary
    .filter((g) => g.kind === 'area')
    .flatMap((g) => [g.heard, ...(g.official ? [g.official] : [])]);
  const terms = glossary
    .filter((g) => g.kind !== 'area' && inLanguage(g.language))
    .sort((a, b) => b.times_heard - a.times_heard)
    .slice(0, KEYTERMS_GLOSSARY_TOP)
    .map((g) => g.heard);
  const sites = typeof ctx.siteName === 'string' ? [ctx.siteName] : ctx.siteName;
  const candidates = [
    ...sites,
    ...ctx.companies.flatMap((c) => [c.name, ...c.aliases]),
    ...areas,
    ...terms,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  let words = 0;
  for (const raw of candidates) {
    const term = raw.replace(/\s+/g, ' ').trim();
    if (term.length < 2 || term.length > KEYTERM_MAX_CHARS || hasLongNumber(term)) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    const n = term.split(' ').length;
    if (out.length >= KEYTERMS_MAX || words + n > KEYTERMS_MAX_WORDS) break;
    seen.add(key);
    out.push(term);
    words += n;
  }
  return out;
}
