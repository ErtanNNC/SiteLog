import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { JobPayloadSchemas, SMS_STATUS_POLL_OFFSETS_MS, jobKeys } from '@sitelog/shared';
import { bootDatabase } from './harness.ts';
import { ORG, seedTwoOrgs } from './fixtures/two-orgs.ts';

/**
 * W4-11 (20261017000440_sms_status_poll.sql; spec §19 Q237): an outbound İletimerkezi row that
 * becomes `sent` queues the first `sms_status` poll at +2 min under `sms_status:<id>:1`, once,
 * from any writer (the Notifier writes `queued`, then `sent`); no other row queues one.
 */

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
});

/** Runs `sql` as the service role (the worker and the edge functions write messages as it). */
async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec('begin; set local role service_role;');
  try {
    const res = await db.query<T>(sql, params);
    await db.exec('commit');
    return res.rows;
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}

async function outbound(provider: string, status: string, direction = 'out'): Promise<string> {
  const id = randomUUID();
  await svc(
    `insert into messages (id, org_id, reporter_id, channel, phone_e164, direction, provider,
                           provider_message_id, body, status, copy_key)
     values ($1, $2, $3, 'sms', '+905321234567', $4::msg_direction, $5, $6, 'Rapor linkiniz', $7::msg_status,
             'daily_link')`,
    [id, ORG.A.org, ORG.A.reporter, direction, provider, `${provider}:${id}`, status],
  );
  return id;
}

async function polls(messageId: string) {
  return (
    await db.query<{
      type: string;
      payload: unknown;
      dedupe_key: string;
      delay_ms: number;
      sent_lag_ms: number;
    }>(
      `select type, payload, dedupe_key,
              (extract(epoch from (run_after - now())) * 1000)::int as delay_ms,
              (extract(epoch from (now() - (payload->>'sentAt')::timestamptz)) * 1000)::int as sent_lag_ms
       from jobs where type = 'sms_status' and payload->>'messageId' = $1 order by id`,
      [messageId],
    )
  ).rows;
}

describe('enqueue_sms_status_poll() (W4-11)', () => {
  it('queues poll 1 at +2 min when an İletimerkezi row goes queued → sent, once', async () => {
    const id = await outbound('iletimerkezi', 'queued');
    expect(await polls(id)).toEqual([]);
    await svc(`update messages set status = 'sent' where id = $1`, [id]);
    const [job, ...rest] = await polls(id);
    expect(rest).toEqual([]);
    expect(job!.dedupe_key).toBe(jobKeys.smsStatus(id, 1));
    const payload = JobPayloadSchemas.sms_status.parse(job!.payload);
    expect(payload).toMatchObject({ messageId: id, poll: 1 });
    // now() is the transaction's: the first poll at sentAt + 2 min, the same offset as the job's.
    expect(Math.abs(job!.delay_ms - SMS_STATUS_POLL_OFFSETS_MS[0])).toBeLessThan(60_000);
    expect(Math.abs(job!.sent_lag_ms)).toBeLessThan(60_000);

    // Written `sent` again (an error cleared, a retry): the key is taken, nothing more.
    await svc(`update messages set status = 'sent', error = null where id = $1`, [id]);
    await svc(`update messages set status = 'delivered' where id = $1`, [id]);
    expect(await polls(id)).toHaveLength(1);
  });

  it('queues it for a row inserted sent too', async () => {
    const id = await outbound('iletimerkezi', 'sent');
    expect(await polls(id)).toHaveLength(1);
  });

  it('queues nothing for Twilio, console, inbound or failed rows', async () => {
    const ids = [
      await outbound('twilio', 'sent'),
      await outbound('console', 'delivered'),
      await outbound('iletimerkezi', 'failed'),
      await outbound('iletimerkezi', 'received', 'in'),
    ];
    for (const id of ids) expect(await polls(id), id).toEqual([]);
  });

  it('runs as the writer cannot: the trigger function is not callable by anon or users', async () => {
    const res = await db.query<{ anon: boolean; authenticated: boolean }>(
      `select has_function_privilege('anon', 'enqueue_sms_status_poll()', 'execute') as anon,
              has_function_privilege('authenticated', 'enqueue_sms_status_poll()', 'execute')
                as authenticated`,
    );
    expect(res.rows[0]).toEqual({ anon: false, authenticated: false });
  });
});
