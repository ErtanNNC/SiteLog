import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '../demo/kestrel.ts';
import { buildKeyterms } from './keyterms.ts';
import {
  STARTER_GLOSSARY,
  starterGlossaryFor,
  starterGlossaryRows,
  starterTermKey,
} from './starter.ts';

/** W4-08 (spec §19 Q238): the starter glossary lists and the rows built from them. */

const AT = '2026-10-17T06:00:00.000Z';

describe('STARTER_GLOSSARY', () => {
  it('has a list per report language, each phrase once, no company or area', () => {
    expect(Object.keys(STARTER_GLOSSARY).sort()).toEqual(['en', 'tr']);
    for (const language of ['en', 'tr'] as const) {
      const terms = starterGlossaryFor(language);
      expect(terms.length, language).toBeGreaterThanOrEqual(25);
      const keys = terms.map(starterTermKey);
      expect(new Set(keys).size, language).toBe(keys.length);
      for (const t of terms) {
        expect(['term', 'unit']).toContain(t.kind);
        expect(t.heard.length).toBeGreaterThanOrEqual(2);
        // A phrase, never a sentence, and never a number (no phone number can be a key term).
        expect(t.heard.length).toBeLessThanOrEqual(60);
        expect(t.heard).not.toMatch(/\d/);
        expect(t.official.length).toBeGreaterThan(0);
      }
    }
  });

  it('writes Turkish in Turkish (the §18.2 words, İSG, units in m³)', () => {
    const tr = new Map(STARTER_GLOSSARY.tr.map((t) => [t.heard, t.official]));
    expect(tr.get('döküm')).toBe('Beton dökümü');
    expect(tr.get('TBM')).toBe('İş güvenliği bilgilendirmesi');
    expect(tr.get('tool box')).toBe('İş güvenliği bilgilendirmesi');
    expect(tr.get('metreküp')).toBe('m³');
    expect(tr.get('İSG')).toBe('İş sağlığı ve güvenliği');
  });
});

describe('starterGlossaryRows', () => {
  it('builds built_in, org-wide, never-heard rows in the language', () => {
    const rows = starterGlossaryRows({
      orgId: 'org-1',
      language: 'tr',
      existing: [],
      at: AT,
      id: (t) => `id:${t.heard}`,
    });
    expect(rows).toHaveLength(STARTER_GLOSSARY.tr.length);
    expect(rows[0]).toEqual({
      id: 'id:döküm',
      org_id: 'org-1',
      scope_site_id: null,
      scope_reporter_id: null,
      heard: 'döküm',
      official: 'Beton dökümü',
      language: 'tr',
      kind: 'term',
      company_id: null,
      status: 'built_in',
      times_heard: 0,
      first_seen_at: AT,
      last_seen_at: null,
    });
  });

  it('skips a phrase the org has in any case with the same kind, not another kind', () => {
    const rows = starterGlossaryRows({
      orgId: 'org-1',
      language: 'en',
      existing: [
        { heard: 'The Deck', kind: 'term' },
        { heard: 'yards', kind: 'area' },
      ],
      at: AT,
      id: (t) => t.heard,
    });
    expect(rows.map((r) => r.heard)).not.toContain('the deck');
    expect(rows.find((r) => r.heard === 'yards')).toMatchObject({ kind: 'unit' });
    expect(rows).toHaveLength(STARTER_GLOSSARY.en.length - 1);
  });

  it('feeds buildKeyterms for a reporter of that language only', () => {
    const rows = starterGlossaryRows({
      orgId: 'org-1',
      language: 'tr',
      existing: [],
      at: AT,
      id: (t) => t.heard,
    });
    const tr = buildKeyterms({
      siteName: 'Kartal',
      companies: [],
      glossary: rows,
      languages: ['tr'],
    });
    expect(tr).toEqual(['Kartal', ...STARTER_GLOSSARY.tr.map((t) => t.heard)]);
    expect(
      buildKeyterms({ siteName: 'Kartal', companies: [], glossary: rows, languages: ['es'] }),
    ).toEqual(['Kartal']);
  });

  it('gives the Kestrel demo the English list less its own phrases', () => {
    const d = kestrelDemo();
    const builtIn = d.glossary.filter((g) => g.status === 'built_in' && g.org_id === d.org.id);
    const own = new Set(
      d.glossary
        .filter((g) => g.org_id === d.org.id && g.status !== 'built_in')
        .map(starterTermKey),
    );
    expect(builtIn.map((g) => g.heard)).toEqual(
      STARTER_GLOSSARY.en.filter((t) => !own.has(starterTermKey(t))).map((t) => t.heard),
    );
    expect(builtIn.map((g) => g.heard)).toEqual(expect.arrayContaining(['the iron', 'PPE']));
    expect(builtIn.map((g) => g.heard)).not.toContain('the deck');
  });
});
