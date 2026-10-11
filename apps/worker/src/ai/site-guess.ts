import { z } from 'zod';
import { similarity, toolInputSchema } from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient } from './claude';
import { buildSiteGuessUserMessage, SITE_GUESS_SYSTEM_PROMPT } from './prompts/replies';

/** §F11 / §F12 — which site is this message about? */

export interface SiteCandidate {
  id: string;
  name: string;
  projectCode: string;
  address?: string | null;
  orgId?: string;
}

export interface SiteGuess {
  siteId: string | null;
  confidence: number;
  method: 'code' | 'name' | 'fuzzy' | 'model' | 'none';
}

export const SITE_INFER_THRESHOLD = 0.85;

const SiteGuessSchema = z.object({
  siteId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
});

export const SITE_GUESS_TOOL = {
  name: 'guess_site',
  description: 'Pick the candidate site the message refers to, or null when unclear.',
} as const;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[—–-]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministic match on project code / site name / distinctive words (no model). */
export function matchSiteByText(text: string, sites: SiteCandidate[]): SiteGuess {
  const t = norm(text);
  if (!t || sites.length === 0) return { siteId: null, confidence: 0, method: 'none' };
  const codeHits = sites.filter((s) => s.projectCode && t.includes(norm(s.projectCode)));
  if (codeHits.length === 1) return { siteId: codeHits[0]!.id, confidence: 1, method: 'code' };
  const nameHits = sites.filter((s) => t.includes(norm(s.name)));
  if (nameHits.length === 1) return { siteId: nameHits[0]!.id, confidence: 0.95, method: 'name' };
  // Distinctive first word of the site name ("Riverside", "Oakmont") as a whole word.
  const words = new Set(t.split(' '));
  const firstWordHits = sites.filter((s) => {
    const w = norm(s.name)
      .split(' ')
      .filter((x) => x.length >= 4)[0];
    return !!w && words.has(w);
  });
  if (firstWordHits.length === 1)
    return { siteId: firstWordHits[0]!.id, confidence: 0.9, method: 'name' };
  let best: { id: string; score: number } | null = null;
  for (const s of sites) {
    const score = Math.max(
      ...norm(s.name)
        .split(' ')
        .filter((w) => w.length >= 5)
        .map((w) => Math.max(...t.split(' ').map((x) => similarity(w, x)))),
      0,
    );
    if (!best || score > best.score) best = { id: s.id, score };
  }
  if (best && best.score >= 0.8)
    return { siteId: best.id, confidence: Math.min(0.84, best.score), method: 'fuzzy' };
  return { siteId: null, confidence: 0, method: 'none' };
}

export async function guessSite(
  client: MessagesClient | null,
  model: string,
  text: string,
  sites: SiteCandidate[],
  log?: Logger,
): Promise<SiteGuess> {
  const quick = matchSiteByText(text, sites);
  if (quick.confidence >= SITE_INFER_THRESHOLD || !client || sites.length === 0 || !text.trim())
    return quick;
  try {
    const res = await callTool(
      client,
      {
        model,
        system: [{ text: SITE_GUESS_SYSTEM_PROMPT, cache: true }],
        messages: [
          {
            role: 'user',
            content: buildSiteGuessUserMessage({
              text,
              sites: sites.map((s) => ({
                id: s.id,
                name: s.name,
                projectCode: s.projectCode,
                address: s.address,
              })),
            }),
          },
        ],
        tool: { ...SITE_GUESS_TOOL, inputSchema: toolInputSchema(SiteGuessSchema) },
        schema: SiteGuessSchema,
        maxTokens: 256,
        effort: 'low',
      },
      log,
    );
    const siteId =
      res.data.siteId && sites.some((s) => s.id === res.data.siteId) ? res.data.siteId : null;
    return { siteId, confidence: siteId ? res.data.confidence : 0, method: 'model' };
  } catch (err) {
    log?.warn('site guess failed', { err });
    return quick;
  }
}
