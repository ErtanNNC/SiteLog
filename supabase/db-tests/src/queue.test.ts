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

  it('gives report jobs the reporter’s conversation key', async () => {
    const [r] = await svc<{ report_id: string; convo_id: string }>(
      `select r.id as report_id, c.id as convo_id from reports r
         join reporters rp on rp.id = r.reporter_id
         join conversations c on c.phone_e164 = rp.phone_e164 limit 1`,
    );
    await enqueue('decide_next', { reportId: r!.report_id });
    await enqueue('render_pdf', { reportId: r!.report_id, version: 1 });
    const rows = await svc<{ type: string; lock_key: string | null }>(
      `select type, lock_key from jobs order by id`,
    );
    expect(rows).toEqual([
      { type: 'decide_next', lock_key: `convo:${r!.convo_id}` },
      { type: 'render_pdf', lock_key: null },
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

/**
 * 20261014000001_queue_rls_fixes.sql (W1-05 step 9, from W1-10): NOTIFY on enqueue, the
 * 'report:<id>' lock key, the §10.1 job names in job_priority, the 10-minute stale lock.
 */
describe('job queue for v1.2 (spec §10.1)', () => {
  it('keeps one enqueue_job with the same four arguments and defaults', async () => {
    const rows = await svc<{ sig: string; args: string; defaults: number }>(
      `select p.oid::regprocedure::text as sig, pg_get_function_arguments(p.oid) as args,
              p.pronargdefaults as defaults
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
       where p.proname = 'enqueue_job'`,
    );
    expect(rows).toEqual([
      {
        sig: 'enqueue_job(text,jsonb,timestamp with time zone,text)',
        args: 'p_type text, p_payload jsonb, p_run_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_dedupe_key text DEFAULT NULL::text',
        defaults: 2,
      },
    ]);
  });

  it('notifies channel jobs with the id of a new job that is due, and only then', async () => {
    const heard: string[] = [];
    const unlisten = await db.listen('jobs', (payload) => heard.push(payload));
    try {
      const due = await enqueue('render_pdf', { reportId: 'r1', version: 1 });
      const [dup] = await svc<{ id: string }>(
        `select enqueue_job('extract_report', '{}'::jsonb, null, 'notify:1') as id`,
      );
      const [again] = await svc<{ id: string }>(
        `select enqueue_job('extract_report', '{}'::jsonb, null, 'notify:1') as id`,
      );
      expect(again!.id).toBe(dup!.id);
      await svc(`select enqueue_job('fetch_weather', '{}'::jsonb, now() + interval '1 hour')`);
      // NOTIFY is sent on commit: a rolled-back enqueue wakes no one.
      await db.exec('begin');
      await db.query(`select enqueue_job('render_pdf', '{}'::jsonb)`);
      await db.exec('rollback');
      await new Promise((r) => setTimeout(r, 50));
      expect(heard).toEqual([String(due), String(dup!.id)]);
    } finally {
      await unlisten();
    }
  });

  it('serialises the jobs of one report without a WhatsApp conversation under report:<id>', async () => {
    const [site] = await svc<{ id: string; org_id: string }>(
      `select id, org_id from sites order by id limit 1`,
    );
    const [day] = await svc<{ id: string }>(
      `insert into site_days (site_id, date, deadline_at) values ($1, '2030-02-04', '2030-02-04T23:30:00Z') returning id`,
      [site!.id],
    );
    const [report] = await svc<{ id: string }>(
      `insert into reports (org_id, site_id, site_day_id, report_no, channel) values ($1, $2, $3, 'LK-0001', 'web') returning id`,
      [site!.org_id, site!.id, day!.id],
    );
    const r = report!.id;
    const [upload] = await svc<{ id: string }>(
      `insert into uploads (report_id, site_id, kind, storage_path) values ($1, $2, 'audio', 'x/y/z.webm') returning id`,
      [r, site!.id],
    );
    const [loose] = await svc<{ id: string }>(
      `insert into uploads (site_id, kind, storage_path) values ($1, 'audio', 'x/y/loose.webm') returning id`,
      [site!.id],
    );
    const [call] = await svc<{ id: string }>(
      `insert into calls (org_id, site_id, report_id, direction) values ($1, $2, $3, 'inbound') returning id`,
      [site!.org_id, site!.id, r],
    );
    await enqueue('transcribe_upload', { uploadId: upload!.id });
    await enqueue('extract_report', { reportId: r });
    await enqueue('decide_next', { reportId: r });
    await enqueue('file_report', { reportId: r, via: 'web' });
    await enqueue('post_call_reconcile', { callId: call!.id });
    await enqueue('transcribe_upload', { uploadId: loose!.id });
    await enqueue('render_pdf', { reportId: r, version: 1 });
    await enqueue('send_sms', { reporterId: r, key: 'filed' });
    const rows = await svc<{ type: string; lock_key: string | null }>(
      `select type, lock_key from jobs order by id`,
    );
    const key = `report:${r}`;
    expect(rows).toEqual([
      { type: 'transcribe_upload', lock_key: key },
      { type: 'extract_report', lock_key: key },
      { type: 'decide_next', lock_key: key },
      { type: 'file_report', lock_key: key },
      { type: 'post_call_reconcile', lock_key: key },
      { type: 'transcribe_upload', lock_key: null }, // no report yet
      { type: 'render_pdf', lock_key: null },
      { type: 'send_sms', lock_key: null },
    ]);
    // One at a time, in order.
    expect(
      (await claim('w1')).filter((j) => j.type !== 'render_pdf' && j.type !== 'send_sms'),
    ).toEqual([
      { id: expect.any(Number) as number, type: 'transcribe_upload' },
      { id: expect.any(Number) as number, type: 'transcribe_upload' },
    ]);
  });

  it('ranks the §10.1 job names without moving the existing ones', async () => {
    const [row] = await svc<{ ranks: Record<string, number> }>(
      `select jsonb_object_agg(t, job_priority(t)) as ranks from unnest($1::text[]) t`,
      [
        [
          // WhatsApp-era names, unchanged (20261012000004_queue_fairness.sql).
          'inbound_message',
          'send_message',
          'send_template',
          'send_welcome',
          'parse_reply',
          'decide_next',
          'file_report',
          'render_pdf',
          'send_email',
          'transcribe_audio',
          'extract_report',
          'weekly_digest',
          'retention_cleanup',
          // v1.2 (§10.1).
          'send_sms',
          'place_call',
          'transcribe_upload',
          'post_call_reconcile',
          'fetch_weather',
          'build_evidence_pack',
        ],
      ],
    );
    expect(row!.ranks).toEqual({
      inbound_message: 0,
      send_message: 0,
      send_template: 0,
      send_welcome: 0,
      parse_reply: 1,
      decide_next: 1,
      file_report: 1,
      render_pdf: 1,
      send_email: 1,
      transcribe_audio: 2,
      extract_report: 2,
      weekly_digest: 3,
      retention_cleanup: 3,
      send_sms: 0,
      place_call: 0,
      transcribe_upload: 2,
      post_call_reconcile: 2,
      fetch_weather: 3,
      build_evidence_pack: 3,
    });
  });

  it('reclaims a running job after 10 minutes, not before (GAP D18)', async () => {
    const id = await enqueue('render_pdf', { reportId: 'r', version: 1 });
    expect((await claim('w1')).map((j) => j.id)).toEqual([id]);
    await svc(`update jobs set locked_at = now() - interval '9 minutes 50 seconds' where id = $1`, [
      id,
    ]);
    expect(await claim('w2')).toEqual([]);
    await svc(
      `update jobs set locked_at = now() - interval '10 minutes 10 seconds' where id = $1`,
      [id],
    );
    expect((await claim('w2')).map((j) => j.id)).toEqual([id]);
  });

  it('reclaims a stale job of a key alone, and the next job of its key waits for it', async () => {
    const convo = await conversation('+15550100006');
    const a1 = await enqueue('inbound_message', { messageId: await message(convo) });
    const a2 = await enqueue('inbound_message', { messageId: await message(convo) });
    expect((await claim('w1')).map((j) => j.id)).toEqual([a1]);
    await svc(`update jobs set locked_at = now() - interval '9 minutes' where id = $1`, [a1]);
    expect(await claim('w2')).toEqual([]);
    // Stale: a1 goes to another worker, and a2 still waits (one claim used to return both).
    await svc(`update jobs set locked_at = now() - interval '11 minutes' where id = $1`, [a1]);
    expect((await claim('w2')).map((j) => j.id)).toEqual([a1]);
    expect(await claim('w3')).toEqual([]);
    await svc(`select complete_job($1)`, [a1]);
    expect((await claim('w3')).map((j) => j.id)).toEqual([a2]);
  });

  it('keeps a reclaimed key serialised on a later claim too, also for report:<id> keys', async () => {
    const r = '00000000-0000-4000-8000-0000000000aa';
    const b1 = await enqueue('extract_report', { reportId: r });
    const b2 = await enqueue('decide_next', { reportId: r });
    expect((await claim('w1')).map((j) => j.id)).toEqual([b1]);
    await svc(`update jobs set locked_at = now() - interval '11 minutes' where id = $1`, [b1]);
    // One slot per claim: the stale job first, then nothing while it runs again.
    expect((await claim('w2', 1)).map((j) => j.id)).toEqual([b1]);
    expect(await claim('w3', 1)).toEqual([]);
    await svc(`select complete_job($1)`, [b1]);
    expect((await claim('w3', 1)).map((j) => j.id)).toEqual([b2]);
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
