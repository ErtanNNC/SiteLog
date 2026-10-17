import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { STARTER_GLOSSARY, buildKeyterms, type GlossaryTermRow } from '@sitelog/shared';
import { asService, asUser, bootDatabase, probeAs } from './harness.ts';

/**
 * W4-08 (20261017000410_starter_glossary.sql; spec §19 Q238, §18.3, F21): a new org starts with
 * the starter glossary of its report language as `built_in` rows, the database's lists equal
 * packages/shared/src/glossary/starter.{en,tr}.ts, a re-run seeds nothing twice, a term the office
 * changed or rejected is never put back, and the rows are what buildKeyterms turns into the voice
 * note's and the call's key terms.
 */

const ELIF = 'dddddddd-1111-4111-8111-111111111111';
let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(`insert into auth.users (id, email) values ('${ELIF}', 'elif@example.test');`);
});

async function createOrg(name: string, country: 'US' | 'TR'): Promise<string> {
  return asUser(
    db,
    ELIF,
    async (q) =>
      (
        await q<{ r: { id: string } }>(`select create_org($1, null, null, null, $2) as r`, [
          name,
          country,
        ])
      ).rows[0]!.r.id,
    'elif@example.test',
  );
}

type Row = Pick<
  GlossaryTermRow,
  | 'heard'
  | 'official'
  | 'kind'
  | 'language'
  | 'status'
  | 'times_heard'
  | 'scope_site_id'
  | 'scope_reporter_id'
  | 'company_id'
  | 'last_seen_at'
>;

async function glossary(orgId: string): Promise<Row[]> {
  const res = await db.query<Row>(
    `select heard, official, kind::text as kind, language, status::text as status, times_heard,
            scope_site_id, scope_reporter_id, company_id, last_seen_at
     from glossary_terms where org_id = $1 order by heard`,
    [orgId],
  );
  return res.rows;
}

const seed = (orgId: string) =>
  asService(db, (q) =>
    q<{ n: number }>(`select seed_starter_glossary($1) as n`, [orgId]).then((r) => r.rows[0]!.n),
  );

describe('starter_glossary_terms() and the shared lists', () => {
  it('holds the same rows as starter.en.ts and starter.tr.ts, in order', async () => {
    for (const language of ['en', 'tr'] as const) {
      const res = await db.query<{ heard: string; official: string; kind: string }>(
        `select heard, official, kind::text as kind from starter_glossary_terms($1)`,
        [language],
      );
      expect(res.rows, language).toEqual(STARTER_GLOSSARY[language]);
    }
    const none = await db.query(`select * from starter_glossary_terms('es')`);
    expect(none.rows).toEqual([]);
  });

  it('lists each heard phrase once per language, about thirty terms, no company or area', () => {
    for (const [language, terms] of Object.entries(STARTER_GLOSSARY)) {
      const keys = terms.map((t) => `${t.kind}:${t.heard.toLowerCase()}`);
      expect(new Set(keys).size, language).toBe(keys.length);
      expect(terms.length, language).toBeGreaterThanOrEqual(25);
      expect(terms.length, language).toBeLessThanOrEqual(35);
      for (const t of terms) {
        expect(['term', 'unit']).toContain(t.kind);
        expect(t.heard.trim()).toBe(t.heard);
        expect(t.official.trim()).toBe(t.official);
      }
    }
  });
});

describe('on_org_created: the starter glossary of the org’s report language', () => {
  let tr: string;
  let us: string;

  beforeAll(async () => {
    tr = await createOrg('Kuzey Yapı A.Ş.', 'TR');
    us = await createOrg('Prairie Builders', 'US');
  });

  it('gives a new TR org the Turkish list as built_in, org-wide, never heard', async () => {
    const rows = await glossary(tr);
    expect(rows).toHaveLength(STARTER_GLOSSARY.tr.length);
    for (const r of rows)
      expect(r).toMatchObject({
        language: 'tr',
        status: 'built_in',
        times_heard: 0,
        scope_site_id: null,
        scope_reporter_id: null,
        company_id: null,
        last_seen_at: null,
      });
    expect(rows).toContainEqual(
      expect.objectContaining({ heard: 'döküm', official: 'Beton dökümü', kind: 'term' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ heard: 'metreküp', official: 'm³', kind: 'unit' }),
    );
    const audit = await db.query<{ actor_type: string; diff: unknown }>(
      `select actor_type, diff from audit_log where org_id = $1 and action = 'glossary.starter_seeded'`,
      [tr],
    );
    expect(audit.rows).toEqual([
      { actor_type: 'system', diff: { language: 'tr', added: STARTER_GLOSSARY.tr.length } },
    ]);
  });

  it('gives a new US org the English list', async () => {
    const rows = await glossary(us);
    expect(rows.map((r) => r.heard).sort()).toEqual(STARTER_GLOSSARY.en.map((t) => t.heard).sort());
    expect(new Set(rows.map((r) => r.language))).toEqual(new Set(['en']));
  });

  it('seeds nothing twice, and never puts back a term the office changed or rejected', async () => {
    expect(await seed(tr)).toBe(0);
    expect(await glossary(tr)).toHaveLength(STARTER_GLOSSARY.tr.length);

    const id = async (heard: string) =>
      (
        await db.query<{ id: string }>(
          `select id from glossary_terms where org_id = $1 and heard = $2`,
          [tr, heard],
        )
      ).rows[0]!.id;
    const review = (termId: string, action: string, official: string | null = null) =>
      asUser(db, ELIF, (q) =>
        q(`select review_glossary_term($1, $2, $3)`, [termId, action, official]),
      );
    await review(await id('perde'), 'reject');
    await review(await id('mikser'), 'change', 'Transmikser (beton mikseri)');
    // A phrase the office deleted (directly, as an old panel could) comes back; the others stay.
    await db.query(`delete from glossary_terms where org_id = $1 and heard = 'şap'`, [tr]);
    expect(await seed(tr)).toBe(1);

    const rows = await glossary(tr);
    expect(rows).toHaveLength(STARTER_GLOSSARY.tr.length);
    expect(rows.find((r) => r.heard === 'perde')).toMatchObject({ status: 'rejected' });
    expect(rows.find((r) => r.heard === 'mikser')).toMatchObject({
      status: 'confirmed',
      official: 'Transmikser (beton mikseri)',
    });
    const audit = await db.query<{ action: string }>(
      `select action from audit_log where org_id = $1 and action like 'glossary.%' order by id`,
      [tr],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'glossary.starter_seeded',
      'glossary.reviewed',
      'glossary.reviewed',
      'glossary.starter_seeded',
    ]);
  });

  it('does not double a phrase the org already has in any case, kind by kind', async () => {
    await db.query(
      `insert into glossary_terms (org_id, heard, official, kind, status, language)
       values ($1, 'Pump Truck', 'Line pump', 'term', 'confirmed', 'en'),
              ($1, 'yards', 'Yards (site area)', 'area', 'confirmed', 'en')`,
      [us],
    );
    await db.query(
      `delete from glossary_terms where org_id = $1 and status = 'built_in' and heard in ('pump truck', 'yards')`,
      [us],
    );
    // 'pump truck' (term) is there in another case; 'yards' only as an area, so the unit returns.
    expect(await seed(us)).toBe(1);
    const rows = await glossary(us);
    expect(rows.filter((r) => r.heard.toLowerCase() === 'pump truck')).toEqual([
      expect.objectContaining({ official: 'Line pump', status: 'confirmed' }),
    ]);
    expect(rows.filter((r) => r.heard === 'yards').map((r) => [r.kind, r.status])).toEqual(
      expect.arrayContaining([
        ['area', 'confirmed'],
        ['unit', 'built_in'],
      ]),
    );
  });

  it('is the service role’s: office users and anon cannot run the seed or read the lists', async () => {
    for (const caller of [
      { role: 'authenticated' as const, userId: ELIF },
      { role: 'anon' as const },
    ]) {
      const s = await probeAs(db, caller, `select seed_starter_glossary($1)`, [tr]);
      expect(s).toMatchObject({ ok: false, code: '42501' });
      const l = await probeAs(db, caller, `select * from starter_glossary_terms('tr')`);
      expect(l).toMatchObject({ ok: false, code: '42501' });
    }
    await expect(
      asService(db, (q) =>
        q(`select seed_starter_glossary('00000000-0000-4000-8000-000000000000')`),
      ),
    ).rejects.toThrow(/org not found/);
  });

  it('the office reads them, and they become the TR reporter’s key terms (voice notes, calls)', async () => {
    const res = await asUser(db, ELIF, (q) =>
      q<
        Pick<GlossaryTermRow, 'heard' | 'official' | 'kind' | 'language' | 'status' | 'times_heard'>
      >(
        `select heard, official, kind, language, status, times_heard from glossary_terms
         where org_id = $1`,
        [tr],
      ),
    );
    expect(res.rows.length).toBe(STARTER_GLOSSARY.tr.length);
    const keyterms = buildKeyterms({
      siteName: 'Kuzey Konutları',
      companies: [],
      glossary: res.rows,
      languages: ['tr'],
    });
    expect(keyterms).toEqual(expect.arrayContaining(['döküm', 'TBM', 'ramak kala', 'metreküp']));
    // Rejected terms are no hint; an English reporter gets none of the Turkish words.
    expect(keyterms).not.toContain('perde');
    expect(
      buildKeyterms({
        siteName: 'Kuzey Konutları',
        companies: [],
        glossary: res.rows,
        languages: ['en'],
      }),
    ).toEqual(['Kuzey Konutları']);
  });
});
