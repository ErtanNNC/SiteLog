import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, bootDatabase, probeAs } from './harness.ts';
import { ORG, seedTwoOrgs } from './fixtures/two-orgs.ts';

/**
 * W3-08 (20261016000290_glossary_rpcs.sql; spec F21, P11): resolve_unknown_company() keeps one
 * glossary row per name (audit "resolve_unknown_company adds a duplicate glossary row on every
 * resolve"), and the panel's Add term is the audited add_glossary_term().
 */

const A = ORG.A;
const B = ORG.B;
let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
});

async function terms(heard: string, org = A.org) {
  const res = await db.query<{
    id: string;
    kind: string;
    official: string | null;
    status: string;
    company_id: string | null;
    language: string;
    times_heard: number;
    scope_site_id: string | null;
  }>(
    `select id, kind, official, status, company_id, language, times_heard, scope_site_id
     from glossary_terms where org_id = $1 and lower(heard) = lower($2) order by first_seen_at, id`,
    [org, heard],
  );
  return res.rows;
}

async function audits(action: string, entityId: string) {
  const res = await db.query<{ actor_id: string; diff: Record<string, unknown> }>(
    `select actor_id, diff from audit_log where action = $1 and entity_id = $2 order by id`,
    [action, entityId],
  );
  return res.rows;
}

describe('resolve_unknown_company: one glossary row per name', () => {
  it('maps the same name twice into one confirmed row', async () => {
    for (let i = 0; i < 2; i++)
      await asUser(db, A.users.ops, (q) =>
        q(`select resolve_unknown_company($1, 'Ridgeway', 'map', $2)`, [A.report, A.company]),
      );
    const rows = await terms('Ridgeway');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'company',
      status: 'confirmed',
      company_id: A.company,
      official: 'Apex A',
    });
  });

  it('confirms the auto-learned row the worker made instead of adding one', async () => {
    await db.query(
      `insert into glossary_terms (org_id, heard, official, kind, status, language)
       values ($1, 'the Kowalski guys', 'Kowalski', 'company', 'needs_review', 'en')`,
      [A.org],
    );
    await asUser(db, A.users.admin, (q) =>
      q(`select resolve_unknown_company($1, 'The Kowalski Guys', 'add', null)`, [A.report]),
    );
    const rows = await terms('the kowalski guys');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'confirmed', official: 'The Kowalski Guys' });
  });
});

describe('add_glossary_term (P11 Add term)', () => {
  const add = (
    user: string,
    heard: string,
    official: string,
    opts: { kind?: string; language?: string; site?: string | null; org?: string } = {},
  ) =>
    probeAs(
      db,
      { role: 'authenticated', userId: user },
      `select add_glossary_term($1, $2, $3, $4::term_kind, $5, $6) as v`,
      [
        opts.org ?? A.org,
        heard,
        official,
        opts.kind ?? 'term',
        opts.language ?? 'tr',
        opts.site ?? null,
      ],
    );
  const commit = (user: string, heard: string, official: string, language = 'tr') =>
    asUser(db, user, (q) =>
      q<{ v: { id: string } }>(`select add_glossary_term($1, $2, $3, 'term', $4, null) as v`, [
        A.org,
        heard,
        official,
        language,
      ]),
    ).then((r) => r.rows[0]!.v.id);

  it('adds a confirmed term, never heard yet, and audits it', async () => {
    const id = await commit(A.users.pm, '  kalıp söktük ', 'Kalıp sökümü yapıldı');
    expect(await terms('kalıp söktük')).toEqual([
      expect.objectContaining({
        id,
        kind: 'term',
        official: 'Kalıp sökümü yapıldı',
        status: 'confirmed',
        language: 'tr',
        times_heard: 0,
        scope_site_id: null,
      }),
    ]);
    expect(await audits('glossary.added', id)).toEqual([
      {
        actor_id: A.users.pm,
        diff: expect.objectContaining({
          heard: 'kalıp söktük',
          official: 'Kalıp sökümü yapıldı',
          kind: 'term',
          language: 'tr',
          existing: false,
        }),
      },
    ]);
  });

  it('the same phrase again updates its row, not a second one', async () => {
    const first = await commit(A.users.ops, 'döküm', 'Döküm');
    const again = await commit(A.users.ops, 'DÖKÜM', 'Beton dökümü');
    expect(again).toBe(first);
    expect(await terms('döküm')).toEqual([
      expect.objectContaining({ id: first, official: 'Beton dökümü', status: 'confirmed' }),
    ]);
    expect((await audits('glossary.added', first)).map((a) => a.diff.existing)).toEqual([
      false,
      true,
    ]);
  });

  it('is for admin, pm and ops of the org, on its own sites, with real values', async () => {
    const denied = await add(A.users.accounts, 'yağmur', 'Yağmur');
    expect(denied).toMatchObject({ ok: false, code: '42501' });
    expect(await add(B.users.admin, 'yağmur', 'Yağmur')).toMatchObject({
      ok: false,
      code: '42501',
    });
    expect(await add(A.users.admin, 'yağmur', 'Yağmur', { site: B.site })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/site not found/),
    });
    expect(await add(A.users.admin, ' ', 'Yağmur')).toMatchObject({ ok: false });
    expect(await add(A.users.admin, 'yağmur', '')).toMatchObject({ ok: false });
    expect(await add(A.users.admin, 'yağmur', 'Yağmur', { language: 'turkish' })).toMatchObject({
      ok: false,
    });
    const scoped = await add(A.users.admin, 'yağmur', 'Yağmur', { site: A.site });
    expect(scoped.ok).toBe(true);
  });
});
