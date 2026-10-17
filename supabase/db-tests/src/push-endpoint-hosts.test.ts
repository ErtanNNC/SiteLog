import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { PUSH_ENDPOINT_RE } from '@sitelog/shared';
import { applyMigration, bootDatabase } from './harness.ts';
import { ORG, seedTwoOrgs } from './fixtures/two-orgs.ts';

/**
 * W2-14 review (20261016000260_push_endpoint_hosts.sql, spec §19 Q115): a live push subscription
 * names one of the known push services, the rule of field-api's request schema. A database that
 * already holds a subscription on another host gets it revoked, not a failed migration.
 */

const MIGRATION = '20261016000260_push_endpoint_hosts.sql';
const ALLOWED = [
  'https://fcm.googleapis.com/fcm/send/abc',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
  'https://wns2-par02p.notify.windows.com/w/?token=BQ',
  'https://web.push.apple.com/QGuQ',
];
const REFUSED = [
  'https://push.test/x',
  'https://169.254.169.254/latest/meta-data',
  'https://fcm.googleapis.com.evil.test/x',
  'https://fcm.googleapis.com:8443/x',
  'https://user@fcm.googleapis.com/x',
  'https://push.apple.com/x',
];

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ storage: true, until: MIGRATION });
  await seedTwoOrgs(db);
  // A subscription stored before the rule: on a host that is no push service.
  await db.query(
    `insert into push_subscriptions (id, org_id, reporter_id, endpoint, p256dh, auth) values
       ('eeeeeeee-0000-4000-8000-000000000260', $1, $2, 'https://169.254.169.254/latest', 'k', 'a')`,
    [ORG.B.org, ORG.B.reporter],
  );
  await applyMigration(db, MIGRATION);
});

async function insertLive(endpoint: string): Promise<string> {
  try {
    await db.exec('begin');
    await db.query(
      `insert into push_subscriptions (org_id, reporter_id, endpoint, p256dh, auth)
       values ($1, $2, $3, 'k', 'a')`,
      [ORG.A.org, ORG.A.reporter2, endpoint],
    );
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'error';
  } finally {
    await db.exec('rollback');
  }
}

describe('push subscription hosts (W2-14 review, §19 Q115)', () => {
  it('revoked the existing row on another host, audited; the one on FCM stays live', async () => {
    const rows = (
      await db.query<{ endpoint: string; revoked_reason: string | null }>(
        `select endpoint, revoked_reason from push_subscriptions order by endpoint`,
      )
    ).rows;
    expect(rows).toContainEqual({
      endpoint: 'https://169.254.169.254/latest',
      revoked_reason: 'endpoint_not_allowed',
    });
    expect(rows.find((r) => r.endpoint.startsWith('https://fcm.'))?.revoked_reason).toBeNull();
    const audit = (
      await db.query<{ action: string; actor_type: string; org_id: string }>(
        `select action, actor_type, org_id from audit_log
          where entity_id = 'eeeeeeee-0000-4000-8000-000000000260'`,
      )
    ).rows;
    expect(audit).toEqual([
      { action: 'push.endpoint_not_allowed', actor_type: 'system', org_id: ORG.B.org },
    ]);
  });

  it.each(ALLOWED)('takes a live row on %s', async (endpoint) => {
    expect(PUSH_ENDPOINT_RE.test(endpoint)).toBe(true);
    expect(await insertLive(endpoint)).toBe('ok');
  });

  it.each(REFUSED)('refuses a live row on %s, as field-api does', async (endpoint) => {
    expect(PUSH_ENDPOINT_RE.test(endpoint)).toBe(false);
    expect(await insertLive(endpoint)).toBe('23514');
  });

  it('field_push_subscribe cannot store one either', async () => {
    await db.exec('begin; set local role service_role;');
    try {
      await expect(
        db.query(
          `select field_push_subscribe($1, null, 'https://push.test/x', 'k', 'a', null, 'v1', '{}')`,
          [ORG.A.reporter2],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await db.exec('rollback');
    }
  });
});
