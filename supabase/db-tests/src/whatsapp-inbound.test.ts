import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { bootDatabase, probeAs } from './harness.ts';
import { ORG, seedTwoOrgs } from './fixtures/two-orgs.ts';

/**
 * W2-16 (20261016000230_field_channel_whatsapp.sql, 20261016000240_whatsapp_inbound.sql,
 * 20261016000250_channel_orders.sql): inbound WhatsApp through sms-webhook, STOP / START on
 * WhatsApp as the whatsapp consent (§19 Q40, Q112), the answer's channel, the queue's lock and
 * priority for whatsapp_answer, and the packs' real orders (§19 Q19, Q107).
 */

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
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

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (err) {
    return (err as { code?: string; message?: string }).message ?? 'error';
  }
}

describe('receive_inbound_message (W2-16)', () => {
  it('stores a WhatsApp message with its channel, audits whatsapp.received and enqueues its job', async () => {
    await inService(async (q) => {
      const [{ r }] = (await q<{ r: { id: string; jobId: number; duplicate: boolean } }>(
        `select receive_inbound_message('whatsapp', 'dddddddd-0000-4000-8000-0000000000aa', $1, $2,
           (select phone_e164 from reporters where id = $2), 'twilio', 'SMwa-in-1', '5',
           '{"to":"+15550142299","keyword":null,"pack":"US","opt_out_type":null,"num_media":0}'::jsonb) as r`,
        [ORG.A.org, ORG.A.reporter],
      )) as [{ r: { id: string; jobId: number; duplicate: boolean } }];
      expect(r.duplicate).toBe(false);
      const [msg] = await q<{ channel: string; direction: string; status: string }>(
        `select channel, direction, status from messages where id = $1`,
        [r.id],
      );
      expect(msg).toEqual({ channel: 'whatsapp', direction: 'in', status: 'received' });
      const [audit] = await q<{ action: string; diff: Record<string, unknown> }>(
        `select action, diff from audit_log where entity_id = $1`,
        [r.id],
      );
      expect(audit).toMatchObject({ action: 'whatsapp.received', diff: { media: 0, pack: 'US' } });
      const [job] = await q<{ type: string; lock_key: string; dedupe_key: string }>(
        `select type, lock_key, dedupe_key from jobs where id = $1`,
        [r.jobId],
      );
      expect(job).toMatchObject({ type: 'sms_inbound', dedupe_key: 'sms_inbound:SMwa-in-1' });
      expect(job!.lock_key).toMatch(/^sms:\+/);
      // A whatsapp_answer job of the message runs under the same phone lock, with the report steps.
      const [answer] = await q<{ lock_key: string; priority: number }>(
        `select job_lock_key('whatsapp_answer', jsonb_build_object('messageId', $1::text)) as lock_key,
                job_priority('whatsapp_answer') as priority`,
        [r.id],
      );
      expect(answer).toEqual({ lock_key: job!.lock_key, priority: 1 });
    });
  });

  it('never stores push as inbound; receive_sms_inbound still writes an SMS', async () => {
    expect(
      await code(
        inService((q) =>
          q(`select receive_inbound_message('push', gen_random_uuid(), null, null, '+15550100000',
               'twilio', 'SMpush', 'x', '{}'::jsonb)`),
        ),
      ),
    ).toMatch(/never inbound/);
    await inService(async (q) => {
      const [{ r }] = (await q<{ r: { id: string } }>(
        `select receive_sms_inbound(gen_random_uuid(), null, null, '+15550100000', 'twilio',
           'SMsms1', 'HELP', '{"pack":"US"}'::jsonb) as r`,
      )) as [{ r: { id: string } }];
      const [msg] = await q<{ channel: string }>(`select channel from messages where id = $1`, [
        r.id,
      ]);
      expect(msg!.channel).toBe('sms');
    });
  });
});

describe('inbound_whatsapp_consent (§19 Q40, Q112)', () => {
  it('STOP revokes the whatsapp consent only; START gives it back to one who had given it', async () => {
    await inService(async (q) => {
      const R = ORG.A.reporter;
      await q(
        `insert into consents (reporter_id, type, method, text_version) values
           ($1, 'whatsapp', 'web_checkbox', 'field.consent.v1')`,
        [R],
      );
      const stop = await q<{ r: { changed: boolean } }>(
        `select inbound_whatsapp_consent($1, false, null) as r`,
        [R],
      );
      expect(stop[0]!.r).toEqual({ changed: true });
      const held = await q<{ type: string }>(
        `select distinct type from consents where reporter_id = $1 and revoked_at is null`,
        [R],
      );
      // The SMS consent of the fixture is untouched (§19 Q40: STOP on WhatsApp stops WhatsApp).
      expect(held).toEqual([{ type: 'sms' }]);
      const [revoked] = await q<{ action: string; diff: Record<string, unknown> }>(
        `select action, diff from audit_log where actor_id = $1 and action = 'consent.revoked'`,
        [R],
      );
      expect(revoked!.diff).toMatchObject({ type: 'whatsapp', method: 'whatsapp_keyword' });
      // Again: nothing held, nothing changes.
      expect(
        (await q<{ r: unknown }>(`select inbound_whatsapp_consent($1, false, null) as r`, [R]))[0]!
          .r,
      ).toEqual({ changed: false });
      const start = await q<{ r: { changed: boolean } }>(
        `select inbound_whatsapp_consent($1, true, null) as r`,
        [R],
      );
      expect(start[0]!.r).toMatchObject({ changed: true });
      const [given] = await q<{ method: string; text_version: string }>(
        `select method, text_version from consents
          where reporter_id = $1 and type = 'whatsapp' and revoked_at is null`,
        [R],
      );
      expect(given).toEqual({ method: 'whatsapp_keyword', text_version: 'field.consent.v1' });
      // Never a first opt-in (§19 Q25: Field-02's).
      expect(
        (
          await q<{ r: unknown }>(`select inbound_whatsapp_consent($1, true, null) as r`, [
            ORG.A.reporter2,
          ])
        )[0]!.r,
      ).toEqual({ changed: false });
    });
  });

  it('is the service role’s only', async () => {
    for (const fn of [
      'inbound_whatsapp_consent(uuid,boolean,uuid)',
      'receive_inbound_message(message_channel,uuid,uuid,uuid,text,text,text,text,jsonb)',
    ]) {
      const [row] = (
        await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
          `select has_function_privilege('anon', $1, 'execute') as anon,
                  has_function_privilege('authenticated', $1, 'execute') as authenticated,
                  has_function_privilege('service_role', $1, 'execute') as service`,
          [fn],
        )
      ).rows;
      expect(row, fn).toEqual({ anon: false, authenticated: false, service: true });
    }
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: ORG.A.users.admin },
      `select inbound_whatsapp_consent('${ORG.A.reporter}', false, null)`,
    );
    expect(res).toMatchObject({ ok: false, code: '42501' });
  });
});

describe('field_answer_question with the answer’s channel (§19 Q26)', () => {
  it('takes web or whatsapp only, and a WhatsApp answer only from the reporter’s own message', async () => {
    const call = (channel: string, message: string | null) =>
      inService((q) =>
        q(
          `select field_answer_question($1, gen_random_uuid(), $2, '{}', '{}', '{}', '{}', null,
             $3::field_channel, $4::uuid)`,
          [ORG.A.report, ORG.A.reporter, channel, message],
        ),
      );
    expect(await code(call('voice', null))).toMatch(/invalid_request/);
    expect(await code(call('whatsapp', null))).toMatch(/message_not_found/);
    expect(await code(call('whatsapp', ORG.A.message2))).toMatch(/message_not_found/);
  });
});

describe('the real channel orders (§19 Q19, Q107)', () => {
  it('push then WhatsApp in both packs, no SMS since §19 Q374 (WhatsApp then SMS since Q372)', async () => {
    const rows = await db.query<{ code: string; message_channels: string }>(
      `select code, message_channels::text from countries order by code`,
    );
    expect(rows.rows).toEqual([
      { code: 'TR', message_channels: '{push,whatsapp}' },
      { code: 'US', message_channels: '{push,whatsapp}' },
    ]);
  });
});
