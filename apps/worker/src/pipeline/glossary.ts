import { noticeData } from '@sitelog/shared';
import type { CompanyRow, GlossaryTermRow, NewTerm, NewTermV1 } from '@sitelog/shared';
import type { Ctx } from '../context';

type AnyNewTerm = NewTerm | NewTermV1;

/**
 * §F17 step 1 — glossary learning from `newTerms`: auto_learned when confidence ≥ 0.9 and kind = term,
 * needs_review otherwise. Terms that are already a known company name or alias are skipped (they
 * are not new). A term counts once per report (W3-08, audit "Re-extractions inflate glossary
 * times_heard…"): a re-extraction of the same report (another clip, an answer, a retry) passes the
 * previous draft's `newTerms` as `counted`, and those are not heard again; `times_heard` rises
 * when another report proposes the term. The `glossary_review` notice names only the terms this
 * call added as new rows waiting for review, so a term already in the queue never notifies twice.
 */
export const AUTO_LEARN_CONFIDENCE = 0.9;

export function termStatusFor(term: AnyNewTerm): 'auto_learned' | 'needs_review' {
  return term.kind === 'term' && term.confidence >= AUTO_LEARN_CONFIDENCE
    ? 'auto_learned'
    : 'needs_review';
}

function known(term: AnyNewTerm, companies: CompanyRow[], glossary: GlossaryTermRow[]): boolean {
  const heard = term.heard.trim().toLowerCase();
  if (!heard) return true;
  for (const c of companies) {
    if (c.name.toLowerCase() === heard || c.aliases.some((a) => a.toLowerCase() === heard))
      return true;
  }
  return glossary.some(
    (g) =>
      g.heard.toLowerCase() === heard &&
      (g.status === 'confirmed' || g.status === 'rejected' || g.status === 'built_in'),
  );
}

export async function learnTerms(
  ctx: Ctx,
  input: {
    orgId: string;
    siteId: string | null;
    reporterId?: string | null;
    terms: AnyNewTerm[];
    companies: CompanyRow[];
    glossary: GlossaryTermRow[];
    /** The terms this report's earlier extraction proposed (its previous draft): already counted. */
    counted?: readonly AnyNewTerm[] | null;
  },
): Promise<GlossaryTermRow[]> {
  const out: GlossaryTermRow[] = [];
  const added: GlossaryTermRow[] = [];
  const seen = new Set((input.counted ?? []).map(termKey));
  for (const term of input.terms) {
    const key = termKey(term);
    if (seen.has(key) || known(term, input.companies, input.glossary)) continue;
    seen.add(key);
    const { row, inserted } = await ctx.db.upsertGlossaryTerm({
      org_id: input.orgId,
      scope_site_id: term.kind === 'area' ? input.siteId : null,
      heard: term.heard.trim(),
      official: term.proposedOfficial.trim() || null,
      kind: term.kind,
      status: termStatusFor(term),
      language: termLanguage(term),
    });
    out.push(row);
    if (inserted && row.status === 'needs_review') added.push(row);
  }
  if (added.length > 0) {
    const n = added.length;
    await ctx.db.notifyOrg(
      input.orgId,
      'glossary_review',
      `${n} new term${n === 1 ? '' : 's'} to review`,
      added.map((t) => t.heard).join(', '),
      '/glossary',
      null,
      noticeData('glossary_review', { count: n }),
    );
  }
  return out;
}

/** One term per kind and heard phrase (any case, trimmed). */
function termKey(term: AnyNewTerm): string {
  return `${term.kind}:${term.heard.trim().toLowerCase()}`;
}

/** The language a term was heard in: v2's `heardLanguage` (en, es, tr), else guessed as before. */
export function termLanguage(term: AnyNewTerm): string {
  const said = 'heardLanguage' in term ? term.heardLanguage.slice(0, 2).toLowerCase() : '';
  if (said === 'en' || said === 'es' || said === 'tr') return said;
  if (/[çğıöşüİ]/i.test(term.heard)) return 'tr';
  return /[áéíóúñ¿¡]/i.test(term.heard) ? 'es' : 'en';
}
