import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectStack, STACK_DB_URL } from './db.ts';

/**
 * The last-admin guard under concurrency (W1-05 step 9; 20261014000001_queue_rls_fixes.sql;
 * docs/AUDIT_BACKLOG.md "org_members update and delete policies allow an org with zero admins"):
 * two admins of one org demote each other from the panel at the same moment. Each transaction
 * alone leaves an admin, so without the guard's lock on the org both would commit and leave none.
 * Needs real Postgres: PGlite is one session.
 */

const describeStack = STACK_DB_URL ? describe : describe.skip;
/** Two office users of the seeded Kestrel org (supabase/seed.sql), made admins of a test org. */
const EMAILS = ['lena@kestrelbuild.example', 'sam@kestrelbuild.example'];

describeStack('last-admin guard on real Postgres', () => {
  let sql: Sql;
  let orgId: string | undefined;
  let users: string[] = [];

  beforeAll(async () => {
    sql = connectStack(4);
    const rows = await sql<{ id: string; email: string }[]>`
      select id::text, email from auth.users where email in ${sql(EMAILS)} order by email`;
    users = rows.map((r) => r.id);
    expect(users, 'seeded office users').toHaveLength(2);
    const [org] = await sql<{ id: string }[]>`
      insert into orgs (name) values (${`test:stack last admin ${Date.now()}`}) returning id`;
    orgId = org!.id;
    for (const user of users)
      await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${user}, 'admin')`;
  });

  afterAll(async () => {
    // Deleting the org cascades through the guard.
    if (orgId) await sql`delete from orgs where id = ${orgId}`;
    await sql?.end({ timeout: 5 });
  });

  it('lets one of two admins demoting each other at once through, never both', async () => {
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => (release = resolve));
    const demote = (actor: string, target: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${actor}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor, role: 'authenticated' })}, true)`;
        await tx`set local role authenticated`;
        if (++started === 2) release();
        await allStarted;
        const rows = await tx`
          update org_members set role = 'ops' where org_id = ${orgId!} and user_id = ${target}`;
        await tx`select pg_sleep(0.1)`;
        return rows.count;
      });
    const results = await Promise.allSettled([
      demote(users[0]!, users[1]!),
      demote(users[1]!, users[0]!),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.flatMap((r) =>
      r.status === 'rejected' ? [(r.reason as { code?: string }).code] : [],
    );
    expect(ok).toHaveLength(1);
    expect(refused).toEqual(['P0001']);
    const admins = await sql`
      select user_id from org_members where org_id = ${orgId!} and role = 'admin'`;
    expect(admins).toHaveLength(1);
  });
});
