import type { CompanyRow, GlossaryTermRow, NewTermV1 } from '@sitelog/shared';
import type { Ctx } from '../context';

/**
 * §F17 step 1 — glossary learning from `newTerms`: auto_learned when confidence ≥ 0.9 and kind = term,
 * needs_review otherwise; times_heard incremented on every repeat. Terms that are already a known
 * company name or alias are skipped (they are not new).
 */
export const AUTO_LEARN_CONFIDENCE = 0.9;

export function termStatusFor(term: NewTermV1): 'auto_learned' | 'needs_review' {
  return term.kind === 'term' && term.confidence >= AUTO_LEARN_CONFIDENCE
    ? 'auto_learned'
    : 'needs_review';
}

function known(term: NewTermV1, companies: CompanyRow[], glossary: GlossaryTermRow[]): boolean {
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
    terms: NewTermV1[];
    companies: CompanyRow[];
    glossary: GlossaryTermRow[];
  },
): Promise<GlossaryTermRow[]> {
  const out: GlossaryTermRow[] = [];
  const seen = new Set<string>();
  for (const term of input.terms) {
    const key = `${term.kind}:${term.heard.trim().toLowerCase()}`;
    if (seen.has(key) || known(term, input.companies, input.glossary)) continue;
    seen.add(key);
    const row = await ctx.db.upsertGlossaryTerm({
      org_id: input.orgId,
      scope_site_id: term.kind === 'area' ? input.siteId : null,
      heard: term.heard.trim(),
      official: term.proposedOfficial.trim() || null,
      kind: term.kind,
      status: termStatusFor(term),
      language: /[áéíóúñ¿¡]/i.test(term.heard) ? 'es' : 'en',
    });
    out.push(row);
  }
  if (out.some((t) => t.status === 'needs_review')) {
    const n = out.filter((t) => t.status === 'needs_review').length;
    await ctx.db.notifyOrg(
      input.orgId,
      'glossary_review',
      `${n} new term${n === 1 ? '' : 's'} to review`,
      out.map((t) => t.heard).join(', '),
      '/glossary',
    );
  }
  return out;
}
