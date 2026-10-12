import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261012000004_queue_fairness.sql: one job per conversation at a time, conversational jobs
 * claimed first, and at most one live report per site-day.
 */

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function conversation(phone: string): Promise<string> {
  const [row] = await svc<{ id: string }>(
    `insert into conversations (phone_e164) values ($1) returning id`,
    [phone],
  );
  return row!.id;
}

async function message(conversationId: string, type = 'audio'): Promise<string> {
  const [row] = await svc<{ id: string }>(
    `insert into messages (conversation_id, direction, type) values ($1, 'in', $2) returning id`,
    [conversationId, type],
  );
  return row!.id;
}

async function enqueue(type: string, payload: Record<string, unknown>): Promise<number> {
  const [row] = await svc<{ id: number }>(`select enqueue_job($1, $2::jsonb) as id`, [
    type,
    JSON.stringify(payload),
  ]);
  return Number(row!.id);
}

async function claim(worker: string, limit = 10): Promise<Array<{ id: number; type: string }>> {
  return (
    await svc<{ id: string; type: string }>(`select id, type from claim_jobs($1, $2)`, [
      worker,
      limit,
    ])
  ).map((r) => ({ id: Number(r.id), type: r.type }));
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
}, 60_000);

beforeEach(async () => {
  await svc(`delete from jobs`);
});

describe('job queue fairness', () => {
  it('derives a per-conversation lock key for message jobs only', async () => {
    const convo = await conversation('+15550100001');
    const msg = await message(convo);
    await enqueue('inbound_message', { messageId: msg });
    await enqueue('transcribe_audio', { messageId: msg, reportId: null });
    await enqueue('fetch_weather', { siteId: 'x' });
    const rows = await svc<{ type: string; lock_key: string | null }>(
      `select type, lock_key from jobs order by id`,
    );
    expect(rows).toEqual([
      { type: 'inbound_message', lock_key: `convo:${convo}` },
      { type: 'transcribe_audio', lock_key: `convo:${convo}` },
      { type: 'fetch_weather', lock_key: null },
    ]);
  });

  it('runs one conversation’s messages one at a time, in order, while others proceed', async () => {
    const a = await conversation('+15550100002');
    const b = await conversation('+15550100003');
    const a1 = await enqueue('inbound_message', { messageId: await message(a) });
    const a2 = await enqueue('inbound_message', { messageId: await message(a, 'image') });
    const b1 = await enqueue('inbound_message', { messageId: await message(b) });

    // Two workers poll at once: each conversation's first message only.
    const first = [...(await claim('w1')), ...(await claim('w2'))].map((j) => j.id).sort();
    expect(first).toEqual([a1, b1].sort());
    expect(await claim('w3')).toEqual([]);

    await svc(`select complete_job($1)`, [a1]);
    expect((await claim('w3')).map((j) => j.id)).toEqual([a2]);
  });

  it('a failed job in backoff does not hold its conversation forever', async () => {
    const a = await conversation('+15550100004');
    const a1 = await enqueue('inbound_message', { messageId: await message(a) });
    const a2 = await enqueue('inbound_message', { messageId: await message(a) });
    expect((await claim('w1')).map((j) => j.id)).toEqual([a1]);
    await svc(`select fail_job($1, 'boom')`, [a1]); // back to queued, run_after = now() + 30 s
    expect((await claim('w1')).map((j) => j.id)).toEqual([a2]);
  });

  it('claims acknowledgements before transcription, extraction and background jobs', async () => {
    const convo = await conversation('+15550100005');
    await enqueue('fetch_weather', { siteId: 'x' });
    await enqueue('extract_report', { reportId: 'r1' });
    await enqueue('decide_next', { reportId: 'r1' });
    await enqueue('inbound_message', { messageId: await message(convo) });
    expect((await claim('w1', 4)).map((j) => j.type)).toEqual([
      'inbound_message',
      'decide_next',
      'extract_report',
      'fetch_weather',
    ]);
  });
});

describe('reports', () => {
  it('allows one live report per site-day; a voided one does not count', async () => {
    const [site] = await svc<{ id: string; org_id: string }>(
      `select id, org_id from sites limit 1`,
    );
    const [day] = await svc<{ id: string; site_id: string; org_id: string }>(
      `insert into site_days (site_id, date, deadline_at) values ($1, '2030-01-07', '2030-01-07T23:30:00Z')
       returning id, site_id, $2::uuid as org_id`,
      [site!.id, site!.org_id],
    );
    const insert = (no: string) =>
      svc<{ id: string }>(
        `insert into reports (org_id, site_id, site_day_id, report_no) values ($1, $2, $3, $4) returning id`,
        [day!.org_id, day!.site_id, day!.id, no],
      );
    const [first] = await insert('T-0001');
    await expect(insert('T-0002')).rejects.toThrow(/reports_one_live_per_site_day/);
    await svc(`update reports set status = 'void' where id = $1`, [first!.id]);
    await expect(insert('T-0003')).resolves.toHaveLength(1);
  });
});
