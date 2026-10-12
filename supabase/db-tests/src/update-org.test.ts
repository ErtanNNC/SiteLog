import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261013000004_update_org.sql: the setup wizard's company step edits the existing org (admin,
 * audited) instead of calling create_org() again.
 */

const ADMIN = 'bbbbbbbb-1111-4111-8111-111111111111';
const OPS = 'bbbbbbbb-2222-4222-8222-222222222222';
const OUTSIDER = 'bbbbbbbb-3333-4333-8333-333333333333';

let db: PGlite;
let orgId: string;

type OrgRow = { name: string; timezone: string; address: string | null; license_no: string | null };

async function org(): Promise<OrgRow> {
  const r = await asService(db, (q) =>
    q<OrgRow>(`select name, timezone, address, license_no from orgs where id = $1`, [orgId]),
  );
  return r.rows[0]!;
}

async function audit() {
  const r = await asService(db, (q) =>
    q<{ action: string; actor_id: string; diff: Record<string, unknown> }>(
      `select action, actor_id, diff from audit_log where entity_id = $1 and action = 'org.updated' order by id`,
      [orgId],
    ),
  );
  return r.rows;
}

async function orgCount(user: string): Promise<number> {
  const r = await asService(db, (q) =>
    q<{ n: number }>(`select count(*)::int as n from org_members where user_id = $1`, [user]),
  );
  return r.rows[0]!.n;
}

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(
    `insert into auth.users (id, email) values ('${ADMIN}', 'lena@kestrel.test'), ('${OPS}', 'ravi@kestrel.test'), ('${OUTSIDER}', 'x@other.test');`,
  );
  orgId = await asUser(
    db,
    ADMIN,
    async (q) =>
      (
        await q<{ r: { id: string } }>(
          `select create_org('Kestrel Build Group', 'America/Chicago', '1 Main St') as r`,
        )
      ).rows[0]!.r.id,
    'lena@kestrel.test',
  );
  await asUser(db, OUTSIDER, (q) => q(`select create_org('Other GC')`), 'x@other.test');
  await asService(db, (q) =>
    q(
      `insert into org_members (org_id, user_id, role, display_name) values ($1, $2, 'ops', 'Ravi')`,
      [orgId, OPS],
    ),
  );
});

describe('update_org', () => {
  it('saves the company details of the existing org and audits the changed fields', async () => {
    const res = await asUser(db, ADMIN, (q) =>
      q<{ r: { id: string; changed: boolean } }>(
        `select update_org($1, '  Kestrel Build Group LLC ', 'America/Denver', '  ', 'GC-1234') as r`,
        [orgId],
      ),
    );
    expect(res.rows[0]!.r).toMatchObject({ id: orgId, changed: true });
    expect(await org()).toEqual({
      name: 'Kestrel Build Group LLC',
      timezone: 'America/Denver',
      address: null,
      license_no: 'GC-1234',
    });
    expect(await audit()).toEqual([
      {
        action: 'org.updated',
        actor_id: ADMIN,
        diff: {
          name: { from: 'Kestrel Build Group', to: 'Kestrel Build Group LLC' },
          timezone: { from: 'America/Chicago', to: 'America/Denver' },
          address: { from: '1 Main St', to: null },
          license_no: { from: null, to: 'GC-1234' },
        },
      },
    ]);
    // The same org, no second one (create_org() is not involved).
    expect(await orgCount(ADMIN)).toBe(1);
  });

  it('writes no audit row when nothing changed and keeps the time zone when none is given', async () => {
    const res = await asUser(db, ADMIN, (q) =>
      q<{ r: { changed: boolean; timezone: string } }>(
        `select update_org($1, 'Kestrel Build Group LLC', null, null, 'GC-1234') as r`,
        [orgId],
      ),
    );
    expect(res.rows[0]!.r).toMatchObject({ changed: false, timezone: 'America/Denver' });
    expect(await audit()).toHaveLength(1);
  });

  it('refuses non-admins, other orgs and a blank name', async () => {
    await expect(
      asUser(db, OPS, (q) => q(`select update_org($1, 'Hijacked')`, [orgId])),
    ).rejects.toThrow(/not allowed/);
    await expect(
      asUser(db, OUTSIDER, (q) => q(`select update_org($1, 'Hijacked')`, [orgId])),
    ).rejects.toThrow(/not allowed/);
    await expect(
      asUser(db, ADMIN, (q) => q(`select update_org($1, '   ')`, [orgId])),
    ).rejects.toThrow(/company name required/);
    expect((await org()).name).toBe('Kestrel Build Group LLC');
  });
});
