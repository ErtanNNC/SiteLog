import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * W4-05 (20261017000510_settings_field_channels.sql; spec F22, P12, §19 Q231–Q233): the two new
 * org_settings columns (defaults, checks, the admin's write under RLS, the `settings.updated`
 * audit), update_org()'s report language and units (admin only, audited), and the test message's
 * claim (service only, five an hour per org, the number masked).
 */

const ADMIN = 'ffffffff-1111-4111-8111-000000000001';
const OPS = 'ffffffff-1111-4111-8111-000000000002';
const OUTSIDER = 'ffffffff-1111-4111-8111-000000000003';

let db: PGlite;
let orgId: string;
let otherOrg: string;

const as = <T>(user: string, sql: string, params: unknown[] = []) =>
  asUser(db, user, (q) => q<T>(sql, params));

async function settings() {
  const r = await asService(db, (q) =>
    q<{ default_contact_pref: string; daily_link_ttl_hours: number | null }>(
      `select default_contact_pref::text, daily_link_ttl_hours from org_settings where org_id = $1`,
      [orgId],
    ),
  );
  return r.rows[0]!;
}

async function audits(action: string, org = orgId) {
  const r = await asService(db, (q) =>
    q<{ actor_id: string | null; diff: Record<string, unknown> }>(
      `select actor_id, diff from audit_log where org_id = $1 and action = $2 order by id`,
      [org, action],
    ),
  );
  return r.rows;
}

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'lena@kestrel.test'), ('${OPS}', 'sam@kestrel.test'), ('${OUTSIDER}', 'x@other.test');
  `);
  orgId = await asUser(
    db,
    ADMIN,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Kestrel', 'America/Chicago') as r`))
        .rows[0]!.r.id,
    'lena@kestrel.test',
  );
  otherOrg = await asUser(
    db,
    OUTSIDER,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Other GC') as r`)).rows[0]!.r.id,
    'x@other.test',
  );
  await db.exec('reset role;');
  await db.exec(
    `insert into org_members (org_id, user_id, role) values ('${orgId}', '${OPS}', 'ops');`,
  );
});

describe('org_settings: default_contact_pref and daily_link_ttl_hours (§19 Q231)', () => {
  it('starts every org at link and the environment expiry', async () => {
    expect(await settings()).toEqual({ default_contact_pref: 'link', daily_link_ttl_hours: null });
  });

  it('lets the admin change both, audited settings.updated', async () => {
    await as(
      ADMIN,
      `update org_settings set default_contact_pref = 'call', daily_link_ttl_hours = 24 where org_id = $1`,
      [orgId],
    );
    expect(await settings()).toEqual({ default_contact_pref: 'call', daily_link_ttl_hours: 24 });
    const [row] = (await audits('settings.updated')).slice(-1);
    expect(row).toEqual({
      actor_id: ADMIN,
      diff: { default_contact_pref: 'call', daily_link_ttl_hours: 24 },
    });
  });

  it('refuses an expiry outside 1–168 hours and a preference that is not one', async () => {
    for (const v of [0, 169]) {
      await expect(
        as(ADMIN, `update org_settings set daily_link_ttl_hours = $2 where org_id = $1`, [
          orgId,
          v,
        ]),
      ).rejects.toThrow(/daily_link_ttl_hours_check/);
    }
    await expect(
      as(ADMIN, `update org_settings set default_contact_pref = 'whatsapp' where org_id = $1`, [
        orgId,
      ]),
    ).rejects.toThrow(/invalid input value for enum contact_pref/);
  });

  it('changes nothing for ops or another org’s admin (RLS)', async () => {
    const ops = await as(
      OPS,
      `update org_settings set daily_link_ttl_hours = 1 where org_id = $1 returning org_id`,
      [orgId],
    );
    const outsider = await as(
      OUTSIDER,
      `update org_settings set default_contact_pref = 'link' where org_id = $1 returning org_id`,
      [orgId],
    );
    expect([ops.rows, outsider.rows]).toEqual([[], []]);
    expect(await settings()).toEqual({ default_contact_pref: 'call', daily_link_ttl_hours: 24 });
  });
});

describe('update_org: the report language and units (§19 Q233)', () => {
  it('saves both for the admin, audited org.updated with the changed fields', async () => {
    const res = await as<{ r: Record<string, unknown> }>(
      ADMIN,
      `select update_org($1, 'Kestrel', p_locale => 'tr-TR', p_units => 'metric') as r`,
      [orgId],
    );
    expect(res.rows[0]!.r).toMatchObject({ locale: 'tr-TR', units: 'metric', changed: true });
    expect((await audits('org.updated')).at(-1)).toEqual({
      actor_id: ADMIN,
      diff: {
        locale: { from: 'en-US', to: 'tr-TR' },
        units: { from: 'imperial', to: 'metric' },
      },
    });
  });

  it('keeps both when they are not given (the wizard’s five-argument call)', async () => {
    const res = await as<{ r: Record<string, unknown> }>(
      ADMIN,
      `select update_org($1, 'Kestrel', 'America/Chicago', null, null) as r`,
      [orgId],
    );
    expect(res.rows[0]!.r).toMatchObject({ locale: 'tr-TR', units: 'metric', changed: false });
  });

  it('refuses another value, ops and another org’s admin', async () => {
    await expect(
      as(ADMIN, `select update_org($1, 'Kestrel', p_locale => 'es-US')`, [orgId]),
    ).rejects.toThrow(/invalid_locale/);
    await expect(
      as(ADMIN, `select update_org($1, 'Kestrel', p_units => 'si')`, [orgId]),
    ).rejects.toThrow(/invalid_units/);
    await expect(
      as(OPS, `select update_org($1, 'Kestrel', p_locale => 'en-US')`, [orgId]),
    ).rejects.toThrow(/not allowed/);
    await expect(
      as(OUTSIDER, `select update_org($1, 'Kestrel', p_units => 'imperial')`, [orgId]),
    ).rejects.toThrow(/not allowed/);
  });
});

describe('settings_test_message_claim (§19 Q232)', () => {
  const claim = (org: string) =>
    asService(db, (q) =>
      q<{ r: { allowed: boolean; retry_at?: string } }>(
        `select settings_test_message_claim($1, $2, '+1 ••• ••• 0142', 'console', 'en') as r`,
        [org, ADMIN],
      ),
    ).then((r) => r.rows[0]!.r);

  it('allows five an hour per org, each audited with the masked number', async () => {
    for (let i = 0; i < 5; i++) expect(await claim(orgId)).toEqual({ allowed: true });
    const sixth = await claim(orgId);
    expect(sixth.allowed).toBe(false);
    expect(typeof sixth.retry_at).toBe('string');
    const rows = await audits('settings.test_message');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      actor_id: ADMIN,
      diff: { to: '+1 ••• ••• 0142', driver: 'console', language: 'en' },
    });
    // Another org has its own five.
    expect(await claim(otherOrg)).toEqual({ allowed: true });
  });

  it('is the service role’s only', async () => {
    await expect(
      as(ADMIN, `select settings_test_message_claim($1, $2, 'x', 'console', 'en')`, [orgId, ADMIN]),
    ).rejects.toThrow(/permission denied/);
  });
});
