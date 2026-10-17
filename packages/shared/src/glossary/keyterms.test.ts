import { describe, expect, it } from 'vitest';
import { buildDemirDemo } from '../demo/demir.ts';
import { buildKeyterms, KEYTERMS_MAX } from './keyterms.ts';

/** §10.2 key terms (moved from apps/worker/src/ai/transcriber.test.ts with buildKeyterms, W3-08). */
describe('key terms (§10.2)', () => {
  const glossary = [
    {
      heard: 'pour on four',
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 9,
      language: 'en',
    },
    {
      heard: 'llovió',
      kind: 'term' as const,
      status: 'built_in' as const,
      times_heard: 3,
      language: 'es',
    },
    {
      heard: 'döküm',
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 5,
      language: 'tr',
    },
    {
      heard: 'the deck',
      kind: 'term' as const,
      status: 'rejected' as const,
      times_heard: 50,
      language: 'en',
    },
    {
      heard: 'east wing',
      official: 'East wing (Level 2)',
      kind: 'area' as const,
      status: 'confirmed' as const,
      times_heard: 1,
      language: 'en',
    },
    {
      heard: 'call me at 512 555 0142',
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 99,
      language: 'en',
    },
  ];

  it('site, companies and aliases, areas (heard and official), then confirmed terms in the reporter languages', () => {
    const terms = buildKeyterms({
      siteName: 'Riverside Lofts — Block B',
      companies: [
        { name: 'Delta Mechanical', aliases: ['the Delta guys', 'Delta'] },
        { name: 'Apex Concrete', aliases: ['apex concrete'] },
      ],
      glossary,
      languages: ['es', 'en'],
    });
    expect(terms).toEqual([
      'Riverside Lofts — Block B',
      'Delta Mechanical',
      'the Delta guys',
      'Delta',
      'Apex Concrete',
      'east wing',
      'East wing (Level 2)',
      'pour on four',
      'llovió',
    ]);
    // Never a phone number, never a rejected term, never another language's term.
    expect(terms.join(' ')).not.toMatch(/555|the deck|döküm/);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      heard: `term ${i}`,
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 300 - i,
    }));
    const companies = Array.from({ length: 200 }, (_, i) => ({
      name: `Company ${i}`,
      aliases: [],
    }));
    const terms = buildKeyterms({ siteName: 'S', companies, glossary: many });
    expect(terms.length).toBeLessThanOrEqual(KEYTERMS_MAX);
  });
});

describe('key terms for calls and voice notes (F21, W3-08)', () => {
  it('a call before its site is known gives each of the reporter sites', () => {
    expect(
      buildKeyterms({
        siteName: ['Kartal Konutları — B Blok', 'Ataşehir Ofis Binası'],
        companies: [],
        glossary: [],
      }),
    ).toEqual(['Kartal Konutları — B Blok', 'Ataşehir Ofis Binası']);
  });

  it('a term the office approves becomes a hint; one waiting for review does not', () => {
    const demir = buildDemirDemo();
    const reporter = demir.reporters.find((r) => r.name === 'Emre Yıldız')!;
    const site = demir.sites.find((s) => s.project_code === 'KK-1203')!;
    const learned = {
      heard: 'kalıpçılar',
      official: 'Kalıp ekibi',
      kind: 'company' as const,
      language: 'tr',
      status: 'needs_review' as const,
      times_heard: 1,
    };
    const vocabulary = (status: 'needs_review' | 'confirmed') => ({
      siteName: site.name,
      companies: demir.companies,
      glossary: [...demir.glossary, { ...learned, status }],
      languages: reporter.languages,
    });
    expect(buildKeyterms(vocabulary('needs_review'))).not.toContain('kalıpçılar');
    const approved = buildKeyterms(vocabulary('confirmed'));
    expect(approved).toContain('kalıpçılar');
    // §18.2's seeds, the crew word among them (spec §19 Q138: kind `company`).
    expect(approved).toEqual(
      expect.arrayContaining(['döküm', 'kalıp söktük', 'demirci ekibi', 'TBM', 'tool box']),
    );
    expect(approved[0]).toBe('Kartal Konutları — B Blok');
  });
});
