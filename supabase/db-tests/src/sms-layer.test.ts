import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { bootDatabase, probeAs } from './harness.ts';
import { ORG, seedTwoOrgs } from './fixtures/two-orgs.ts';

/**
 * W1-08 (20261014000007_sms_layer.sql): sender ids unique across packs, a message that has only a
 * phone (a text from an unknown number, F13), and the console email store of the Demo phone.
 */

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
});

/** Runs `sql` as the service role in a transaction that is always rolled back. */
async function asService(sql: string, params: unknown[] = []) {
  await db.exec('begin; set local role service_role;');
  try {
    if (params.length === 0) await db.exec(sql);
    else await db.query(sql, params);
  } finally {
    await db.exec('rollback');
  }
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await asService(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message;
  }
}

describe('sender ids across packs (spec §4.6, F13)', () => {
  it('two packs cannot share a sender id; packs without one can', async () => {
    // Both launch packs have no sender here (null = console): the partial index allows that.
    const nulls = await db.query<{ n: number }>(
      `select count(*)::int as n from countries where sms_sender_id is null`,
    );
    expect(nulls.rows[0]!.n).toBeGreaterThanOrEqual(2);
    // A ZZ pack with a long code, then the US pack asking for the same number.
    expect(
      await errorOf(`
        insert into countries (code, default_locale, field_locales, units, paper, currency,
          default_timezone, message_channels, sms_sender_type, sms_sender_id, two_way_sms, sms_links_allowed)
        values ('ZZ', 'en-US', '{en-US}', 'imperial', 'letter', 'USD', 'America/Chicago', '{sms}',
          'long_code', '+18885550142', true, true);
        select set_country_endpoints('US', '+18885550142', null);
      `),
    ).toBe('23505');
    expect(await errorOf(`select set_country_endpoints('US', '+18885550142', null)`)).toBeNull();
  });

  it('sms-webhook can find the pack by the receiving sender id', async () => {
    await db.exec('begin; set local role service_role;');
    try {
      await db.query(`select set_country_endpoints('TR', 'SITELOG', null)`);
      const found = await db.query<{ code: string }>(
        `select code from countries where sms_sender_id = $1`,
        ['SITELOG'],
      );
      expect(found.rows).toEqual([{ code: 'TR' }]);
    } finally {
      await db.exec('rollback');
    }
  });
});

describe('a text from an unknown number (messages_conversation_or_org)', () => {
  it('a message may have only a phone, never nothing', async () => {
    expect(
      await errorOf(
        `insert into messages (direction, channel, phone_e164, provider, provider_message_id, body, status)
         values ('in', 'sms', '+15550194410', 'twilio', 'SMunknown1', 'hello?', 'received')`,
      ),
    ).toBeNull();
    expect(
      await errorOf(
        `insert into messages (direction, channel, provider, body, status)
         values ('in', 'sms', 'twilio', 'nobody', 'received')`,
      ),
    ).toBe('23514');
  });

  it('no office role reads it: it has no org', async () => {
    await db.exec('reset role;');
    await db.exec(`
      insert into messages (id, direction, channel, phone_e164, provider, provider_message_id, body, status)
      values ('eeeeeeee-0000-4000-8000-000000000001', 'in', 'sms', '+15550194410', 'twilio', 'SMunknown2', 'who is this', 'received');
    `);
    for (const role of ['admin', 'pm', 'ops', 'accounts'] as const) {
      const res = await probeAs(
        db,
        { role: 'authenticated', userId: ORG.A.users[role], email: `${role}@x.test` },
        `select count(*)::int as n from messages where id = 'eeeeeeee-0000-4000-8000-000000000001'`,
      );
      expect(res.ok && res.rows[0]!.n).toBe(0);
    }
  });
});

describe('console_emails (Demo phone Email tab)', () => {
  it('admins of the org read it; other roles and orgs do not; no client writes it', async () => {
    const read = async (
      org: 'A' | 'B',
      role: 'admin' | 'pm' | 'ops' | 'accounts',
      target: 'A' | 'B',
    ) => {
      const res = await probeAs(
        db,
        { role: 'authenticated', userId: ORG[org].users[role], email: `${role}@x.test` },
        `select count(*)::int as n from console_emails where id = '${ORG[target].consoleEmail}'`,
      );
      return res.ok ? res.rows[0]!.n : res.code;
    };
    expect(await read('A', 'admin', 'A')).toBe(1);
    expect(await read('A', 'admin', 'B')).toBe(0);
    for (const role of ['pm', 'ops', 'accounts'] as const)
      expect(await read('A', role, 'A')).toBe(0);
    const write = await probeAs(
      db,
      { role: 'authenticated', userId: ORG.A.users.admin, email: 'admin@x.test' },
      `insert into console_emails (org_id, kind, recipients, subject, body_text) values ('${ORG.A.org}', 'x', '{a@b}', 's', 'b')`,
    );
    expect(write.ok ? 'ok' : write.code).toBe('42501');
  });

  it('attachments must be a list', async () => {
    expect(
      await errorOf(
        `insert into console_emails (org_id, kind, recipients, subject, body_text, attachments)
         values ($1, 'report_filed', '{a@b.c}', 's', 'b', '{"a":1}')`,
        [ORG.A.org],
      ),
    ).toBe('23514');
  });
});
