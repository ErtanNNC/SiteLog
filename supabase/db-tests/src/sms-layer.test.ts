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

describe('receive_sms_inbound (sms-webhook, 20261014000008)', () => {
  type Received = { id: string; duplicate: boolean; handled: boolean; jobId: number | null };
  /** Runs `fn` as the service role in a transaction that is always rolled back. */
  async function inService<T>(
    fn: (q: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
  ): Promise<T> {
    await db.exec('begin; set local role service_role;');
    try {
      return await fn(
        async <R>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows,
      );
    } finally {
      await db.exec('rollback');
    }
  }
  const receive = (
    q: <R>(sql: string, params?: unknown[]) => Promise<R[]>,
    over: { id?: string; sid?: string; provider?: string; reporter?: string | null } = {},
  ) =>
    q<{ r: Received }>(
      `select receive_sms_inbound($1, $2, $3, '+15550145521', $4, $5, 'STOP', $6::jsonb) as r`,
      [
        over.id ?? 'dddddddd-0000-4000-8000-000000000001',
        ORG.A.org,
        over.reporter === undefined ? ORG.A.reporter : over.reporter,
        over.provider ?? 'twilio',
        over.sid ?? 'SMrecv1',
        JSON.stringify({ to: '+18885550142', keyword: 'stop', pack: 'US', opt_out_type: null }),
      ],
    ).then((rows) => rows[0]!.r);

  it('stores the text, audits it and enqueues its job in one call; a redelivery joins the job', async () => {
    await inService(async (q) => {
      const first = await receive(q);
      expect(first).toMatchObject({
        id: 'dddddddd-0000-4000-8000-000000000001',
        duplicate: false,
        handled: false,
      });
      expect(first.jobId).toEqual(expect.any(Number));
      const [msg] = await q<Record<string, unknown>>(
        `select org_id, reporter_id, phone_e164, channel, direction, provider, status, body
         from messages where id = $1`,
        [first.id],
      );
      expect(msg).toEqual({
        org_id: ORG.A.org,
        reporter_id: ORG.A.reporter,
        phone_e164: '+15550145521',
        channel: 'sms',
        direction: 'in',
        provider: 'twilio',
        status: 'received',
        body: 'STOP',
      });
      const [job] = await q<{
        type: string;
        payload: unknown;
        dedupe_key: string;
        lock_key: string;
      }>(`select type, payload, dedupe_key, lock_key from jobs where id = $1`, [first.jobId]);
      expect(job).toEqual({
        type: 'sms_inbound',
        payload: { messageId: first.id },
        dedupe_key: 'sms_inbound:SMrecv1',
        lock_key: 'sms:+15550145521',
      });
      const audits = await q<{ actor_type: string; actor_id: string; diff: unknown }>(
        `select actor_type, actor_id, diff from audit_log where action = 'sms.received' and entity_id = $1`,
        [first.id],
      );
      expect(audits).toEqual([
        {
          actor_type: 'reporter',
          actor_id: ORG.A.reporter,
          diff: { provider: 'twilio', keyword: 'stop', pack: 'US' },
        },
      ]);

      // Twilio delivers it again before the worker ran: the same row and job, no second audit.
      const again = await receive(q, { id: 'dddddddd-0000-4000-8000-000000000002' });
      expect(again).toEqual({ ...first, duplicate: true });
      // Handled to the end: a late redelivery enqueues nothing.
      await q(
        `update messages set payload = payload || '{"handled_at":"2026-10-09T23:00:00Z"}' where id = $1`,
        [first.id],
      );
      await q(`select complete_job($1)`, [first.jobId]);
      expect(await receive(q)).toEqual({ ...first, duplicate: true, handled: true, jobId: null });
      expect(
        (
          await q<{ n: number }>(
            `select count(*)::int as n from audit_log where action = 'sms.received' and entity_id = $1`,
            [first.id],
          )
        )[0]!.n,
      ).toBe(1);
    });
  });

  it('a redelivery of a text whose job died enqueues it again; a console row gets no job', async () => {
    await inService(async (q) => {
      const first = await receive(q);
      await q(`update jobs set status = 'dead' where id = $1`, [first.jobId]);
      const again = await receive(q);
      expect(again.jobId).not.toBe(first.jobId);
      expect(again.jobId).toEqual(expect.any(Number));
      const demo = await receive(q, {
        id: 'dddddddd-0000-4000-8000-000000000003',
        sid: 'console:abc',
        provider: 'console',
        reporter: null,
      });
      expect(demo).toMatchObject({ duplicate: false, handled: false, jobId: null });
      const [audit] = await q<{ actor_type: string }>(
        `select actor_type from audit_log where action = 'sms.received' and entity_id = $1`,
        [demo.id],
      );
      expect(audit).toEqual({ actor_type: 'system' });
    });
  });

  it('refuses a provider it does not know', async () => {
    expect(
      await errorOf(
        `select receive_sms_inbound(gen_random_uuid(), null, null, '+15550145521', 'meta', 'x1', 'hi', '{}')`,
      ),
    ).toBe('22023');
  });

  it('is the service role’s only', async () => {
    const fn = 'receive_sms_inbound(uuid,uuid,uuid,text,text,text,text,jsonb)';
    const rows = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as authenticated,
              has_function_privilege('service_role', $1, 'execute') as service`,
      [fn],
    );
    expect(rows.rows).toEqual([{ anon: false, authenticated: false, service: true }]);
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: ORG.A.users.admin, email: 'admin@x.test' },
      `select receive_sms_inbound(gen_random_uuid(), null, null, '+15550145521', 'twilio', 'x2', 'hi', '{}')`,
    );
    expect(res).toMatchObject({ ok: false, code: '42501' });
  });
});
