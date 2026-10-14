import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { buildSeedSql, PRUNED_TABLES } from '@sitelog/shared/demo/seed-sql.ts';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { DEMIR_ORG_ID } from '@sitelog/shared/demo/demir.ts';
import { connectStack, STACK_DB_URL } from './db.ts';

/**
 * `pnpm seed:demo -- --apply` (GAP D8) on the real Postgres of the local stack, which
 * `supabase start` already seeded with supabase/seed.sql: the script the apply runs gives the
 * same rows twice (Supabase's own triggers and grants included), moves the demo to a live date
 * and back, and refuses an org with a demo id that is not a demo org. It leaves the stack as
 * seeded, for the e2e:supabase specs that run after it.
 */

const describeStack = STACK_DB_URL ? describe : describe.skip;
// The queue is left out: other processes of the stack may add jobs between two snapshots (the
// PGlite test checks which jobs an apply drops).
const TABLES = ['orgs', 'org_members', ...PRUNED_TABLES.filter((t) => t !== 'jobs')];
const APPLY = buildSeedSql({ globalRows: false });

describeStack('seed:demo --apply on real Postgres', () => {
  let sql: Sql;

  /** The demo orgs' rows of every seeded table, and the demo users, as sorted JSON. */
  async function snapshot(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of TABLES) {
      const rows = await sql.unsafe<{ r: unknown }[]>(`select to_jsonb(x) as r from ${t} x`);
      out[t] = rows
        .map((r) => JSON.stringify(r.r))
        .filter((r) => r.includes(DEMO_ORG_ID) || r.includes(DEMIR_ORG_ID) || t !== 'orgs')
        .sort();
    }
    const users = await sql<{ r: unknown }[]>`
      select to_jsonb(u) - 'encrypted_password' - 'updated_at' - 'last_sign_in_at' as r
      from auth.users u where id in ${sql(DEMO_USERS.map((u) => u.id))} order by id`;
    out['auth.users'] = users.map((r) => JSON.stringify(r.r));
    return out;
  }

  beforeAll(() => {
    sql = connectStack(1);
  });

  afterAll(async () => {
    // Back to the seeded state whatever happened above.
    await sql.unsafe('rollback').catch(() => undefined);
    await sql.unsafe(`update orgs set is_demo = true where id = '${DEMIR_ORG_ID}'`);
    await sql.unsafe(APPLY);
    await sql?.end({ timeout: 5 });
  });

  it('gives the same rows when applied twice over the seeded stack', async () => {
    await sql.unsafe(APPLY);
    const first = await snapshot();
    expect(first.reports!.length).toBeGreaterThan(60);
    await sql.unsafe(APPLY);
    expect(await snapshot()).toEqual(first);
  });

  it('moves the demo to a live date and back (D36)', async () => {
    const oct9 = await snapshot();
    await sql.unsafe(buildSeedSql({ date: '2026-10-16', globalRows: false }));
    const today = await sql<{ status: string; n: number }[]>`
      select sd.status::text as status, count(*)::int as n
      from site_days sd join sites s on s.id = sd.site_id
      where s.org_id = ${DEMO_ORG_ID} and sd.date = '2026-10-16' group by 1 order by 1`;
    expect(today).toEqual([
      { status: 'filed', n: 1 },
      { status: 'pending', n: 5 },
    ]);
    await sql.unsafe(APPLY);
    expect(await snapshot()).toEqual(oct9);
  });

  it('refuses an org with a demo id that is not a demo org and writes nothing', async () => {
    const before = await snapshot();
    await sql.unsafe(`update orgs set is_demo = false where id = '${DEMIR_ORG_ID}'`);
    await expect(
      sql.unsafe(buildSeedSql({ date: '2026-10-16', globalRows: false })),
    ).rejects.toThrow(/is not a demo org/);
    await sql.unsafe('rollback').catch(() => undefined);
    await sql.unsafe(`update orgs set is_demo = true where id = '${DEMIR_ORG_ID}'`);
    expect(await snapshot()).toEqual(before);
  });
});
