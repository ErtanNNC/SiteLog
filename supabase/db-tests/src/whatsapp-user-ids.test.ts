import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { bootDatabase, probeAs } from './harness.ts';
import { ORG, seedTwoOrgs } from './fixtures/two-orgs.ts';

/**
 * §19 Q372 (20261020000200_whatsapp_user_ids.sql): reporters.whatsapp_user_id, the person's
 * WhatsApp business-scoped user id that sms-webhook learns from Twilio's `ExternalUserId`. Its
 * format check, record_whatsapp_user_id() (every real reporter row of the number; off any other
 * number's rows; audited without the value), the phone change that drops it, and the lockdown:
 * the office cannot write it, anon reads no reporter, only the service role runs the RPC.
 */

const A = ORG.A;
const B = ORG.B;
const BSUID = 'TR.968122199252486';
const DEMO_ORG = 'dddddddd-0000-4000-8000-000000000001';
const DEMO_REPORTER = 'dddddddd-0000-4000-8000-000000000002';
const B_TWIN = 'bbbbbbbb-0000-4000-8000-0000000000f1';

let db: PGlite;
let phoneA: string;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
  phoneA = (
    await db.query<{ phone_e164: string }>(`select phone_e164 from reporters where id = $1`, [
      A.reporter,
    ])
  ).rows[0]!.phone_e164;
  // The same person in org B, and in a demo org.
  await db.query(
    `insert into reporters (id, org_id, name, phone_e164, status) values ($1, $2, 'Twin B', $3, 'active')`,
    [B_TWIN, B.org, phoneA],
  );
  await db.query(`insert into orgs (id, name, is_demo) values ($1, 'Demo Co', true)`, [DEMO_ORG]);
  await db.query(
    `insert into reporters (id, org_id, name, phone_e164, status) values ($1, $2, 'Demo twin', $3, 'active')`,
    [DEMO_REPORTER, DEMO_ORG, phoneA],
  );
});

type Q = <R>(sql: string, params?: unknown[]) => Promise<R[]>;

/** Runs `fn` as the service role in a transaction that is always rolled back. */
async function inService<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  await db.exec('begin; set local role service_role;');
  try {
    return await fn(
      async <R>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows,
    );
  } finally {
    await db.exec('rollback');
  }
}

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (err) {
    return (err as { message?: string }).message ?? 'error';
  }
}

const idsOf = (q: Q) =>
  q<{ id: string; whatsapp_user_id: string | null }>(
    `select id, whatsapp_user_id from reporters where id = any($1::uuid[]) order by id`,
    [[A.reporter, A.reporter2, B_TWIN, DEMO_REPORTER]],
  );

describe('reporters.whatsapp_user_id (§19 Q372)', () => {
  it('is nullable and takes only `CC.<id>` (two capitals, a dot, 1-128 alphanumerics)', async () => {
    await inService(async (q) => {
      const [row] = await q<{ whatsapp_user_id: string | null }>(
        `select whatsapp_user_id from reporters where id = $1`,
        [A.reporter],
      );
      expect(row!.whatsapp_user_id).toBeNull();
      await q(`update reporters set whatsapp_user_id = $1 where id = $2`, [
        `US.${'a1'.repeat(64)}`,
        A.reporter2,
      ]);
    });
    for (const bad of [
      'whatsapp:TR.1',
      'tr.1',
      'TR.',
      'TR.12-34',
      'TUR.1',
      `US.${'a'.repeat(129)}`,
    ]) {
      expect(
        await failure(
          inService((q) =>
            q(`update reporters set whatsapp_user_id = $1 where id = $2`, [bad, A.reporter]),
          ),
        ),
        bad,
      ).toMatch(/reporters_whatsapp_user_id_format/);
    }
  });

  it('record_whatsapp_user_id(): every real row of the number, never a demo org, audited without the id', async () => {
    await inService(async (q) => {
      const [{ r }] = (await q<{ r: { set: number; cleared: number } }>(
        `select record_whatsapp_user_id($1, $2) as r`,
        [phoneA, BSUID],
      )) as [{ r: { set: number; cleared: number } }];
      expect(r).toEqual({ set: 2, cleared: 0 });
      const rows = await idsOf(q);
      expect(Object.fromEntries(rows.map((x) => [x.id, x.whatsapp_user_id]))).toEqual({
        [A.reporter]: BSUID,
        [A.reporter2]: null,
        [B_TWIN]: BSUID,
        [DEMO_REPORTER]: null,
      });
      const audits = await q<{ org_id: string; action: string; entity_id: string; diff: unknown }>(
        `select org_id, action, entity_id, diff from audit_log
          where action like 'reporter.whatsapp_user_id%' order by org_id`,
      );
      expect(audits).toEqual([
        {
          org_id: A.org,
          action: 'reporter.whatsapp_user_id_set',
          entity_id: A.reporter,
          diff: { source: 'twilio_whatsapp' },
        },
        {
          org_id: B.org,
          action: 'reporter.whatsapp_user_id_set',
          entity_id: B_TWIN,
          diff: { source: 'twilio_whatsapp' },
        },
      ]);
      expect(JSON.stringify(audits)).not.toContain('968122199252486');
      // Again: nothing changes, nothing is audited.
      const [{ again }] = (await q<{ again: unknown }>(
        `select record_whatsapp_user_id($1, $2) as again`,
        [phoneA, BSUID],
      )) as [{ again: unknown }];
      expect(again).toEqual({ set: 0, cleared: 0 });

      // The id seen with another number moves there: the old number's rows let it go.
      const [{ moved }] = (await q<{ moved: unknown }>(
        `select record_whatsapp_user_id((select phone_e164 from reporters where id = $1), $2) as moved`,
        [A.reporter2, BSUID],
      )) as [{ moved: unknown }];
      expect(moved).toEqual({ set: 1, cleared: 2 });
      const after = await idsOf(q);
      expect(Object.fromEntries(after.map((x) => [x.id, x.whatsapp_user_id]))).toEqual({
        [A.reporter]: null,
        [A.reporter2]: BSUID,
        [B_TWIN]: null,
        [DEMO_REPORTER]: null,
      });
      const cleared = await q<{ n: number }>(
        `select count(*)::int as n from audit_log where action = 'reporter.whatsapp_user_id_cleared'`,
      );
      expect(cleared[0]!.n).toBe(2);
    });
    expect(
      await failure(inService((q) => q(`select record_whatsapp_user_id($1, 'tr.1')`, [phoneA]))),
    ).toMatch(/invalid_whatsapp_user_id/);
    expect(
      await failure(
        inService((q) => q(`select record_whatsapp_user_id('905321234567', $1)`, [BSUID])),
      ),
    ).toMatch(/invalid_phone/);
  });

  it("a reporter's new phone number drops the id (it was the old number's person's)", async () => {
    await inService(async (q) => {
      await q(`update reporters set whatsapp_user_id = $1 where id = $2`, [BSUID, A.reporter]);
      await q(`update reporters set name = 'Renamed' where id = $1`, [A.reporter]);
      expect((await idsOf(q)).find((x) => x.id === A.reporter)!.whatsapp_user_id).toBe(BSUID);
      await q(`update reporters set phone_e164 = '+15550007777' where id = $1`, [A.reporter]);
      expect((await idsOf(q)).find((x) => x.id === A.reporter)!.whatsapp_user_id).toBeNull();
    });
  });

  it('the office cannot write it or run the RPC; anon reads no reporter and runs nothing', async () => {
    for (const role of ['admin', 'ops'] as const) {
      const write = await probeAs(
        db,
        { role: 'authenticated', userId: A.users[role] },
        `update reporters set whatsapp_user_id = 'US.123' where id = '${A.reporter}'`,
      );
      expect(write, role).toMatchObject({ ok: false, code: '42501' });
      const rpc = await probeAs(
        db,
        { role: 'authenticated', userId: A.users[role] },
        `select record_whatsapp_user_id('${phoneA}', 'US.123')`,
      );
      expect(rpc, role).toMatchObject({ ok: false, code: '42501' });
    }
    const read = await probeAs(db, { role: 'anon' }, `select whatsapp_user_id from reporters`);
    expect(read.ok ? read.rows : read.code).toEqual(read.ok ? [] : '42501');
    const rpc = await probeAs(
      db,
      { role: 'anon' },
      `select record_whatsapp_user_id('${phoneA}', 'US.123')`,
    );
    expect(rpc).toMatchObject({ ok: false, code: '42501' });
  });
});
