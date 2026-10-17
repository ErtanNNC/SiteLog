import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261012000003_ops.sql: platform admins, the ops RPCs behind /ops (queue stats, dead jobs,
 * retry / discard with audit) and the cost-per-report inputs, baseline and outlier list.
 */

const OPERATOR = 'bbbbbbbb-1111-4111-8111-111111111111'; // SiteLog staff, no org membership
const ORG_ADMIN = 'bbbbbbbb-2222-4222-8222-222222222222'; // customer admin
const UUID_A = 'cccccccc-1111-4111-8111-111111111111';

let db: PGlite;
let orgId: string;
let siteId: string;

type Q = typeof db.query;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function job(
  type: string,
  payload: Record<string, unknown>,
  fields: Partial<{
    status: string;
    attempts: number;
    last_error: string;
    dedupe_key: string;
    run_after: string;
  }> = {},
): Promise<number> {
  const rows = await svc<{ id: number }>(
    `insert into jobs (type, payload, status, attempts, last_error, dedupe_key, run_after, finished_at)
     values ($1, $2, coalesce($3, 'queued')::job_status, coalesce($4, 0), $5, $6, coalesce($7::timestamptz, now()),
             case when $3 = 'dead' then now() end)
     returning id`,
    [
      type,
      JSON.stringify(payload),
      fields.status ?? null,
      fields.attempts ?? null,
      fields.last_error ?? null,
      fields.dedupe_key ?? null,
      fields.run_after ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

let reportSeq = 0;
async function report(opts: { date: string; kind?: string; filedAt?: string }) {
  const sd = await svc<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at, status) values ($1, $2, $3, 'filed')
     on conflict (site_id, date) do update set status = excluded.status returning id`,
    [siteId, opts.date, `${opts.date}T22:30:00Z`],
  );
  const r = await svc<{ id: string }>(
    `insert into reports (org_id, site_id, site_day_id, report_no, status, kind, filed_at, language)
     values ($1, $2, $3, $4, 'filed', $5, $6, 'en') returning id`,
    [
      orgId,
      siteId,
      sd[0]!.id,
      `RL-2041-${String(++reportSeq).padStart(4, '0')}`,
      opts.kind ?? 'daily',
      opts.filedAt ?? `${opts.date}T22:00:00Z`,
    ],
  );
  return { id: r[0]!.id, siteDayId: sd[0]!.id };
}

async function cost(
  reportId: string,
  cents: number,
  filedAt: string,
  kind = 'daily',
  outlier = false,
) {
  await svc(
    `insert into report_costs (report_id, org_id, kind, filed_at, cost_cents, outlier, median_cents, sample, detail)
     values ($1, $2, $3, $4, $5, $6, case when $6 then 5 end, case when $6 then 24 else 0 end,
             '{"aiUsd":0.41,"waTemplates":2,"waTemplateUsd":0.004,"jobs":7}')
     on conflict (report_id) do update set cost_cents = excluded.cost_cents, outlier = excluded.outlier`,
    [reportId, orgId, kind, filedAt, cents, outlier],
  );
}

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(
    `insert into auth.users (id, email) values ('${OPERATOR}', 'oncall@sitelog.test'), ('${ORG_ADMIN}', 'lena@kestrel.test');`,
  );
  orgId = await asUser(
    db,
    ORG_ADMIN,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Kestrel Build Group') as r`)).rows[0]!.r
        .id,
    'lena@kestrel.test',
  );
  siteId = (
    await svc<{ id: string }>(
      `insert into sites (org_id, name, project_code, timezone) values ($1, 'Riverside Lofts — Block B', 'RL-2041', 'America/Chicago') returning id`,
      [orgId],
    )
  )[0]!.id;
  await svc(`insert into platform_admins (user_id, note) values ($1, 'on-call')`, [OPERATOR]);
});

describe('platform admins', () => {
  it('is_platform_admin() is true only for operators; the table is hidden from everyone', async () => {
    const check = (user: string) =>
      asUser(
        db,
        user,
        async (q) => (await q<{ ok: boolean }>(`select is_platform_admin() as ok`)).rows[0]!.ok,
      );
    expect(await check(OPERATOR)).toBe(true);
    expect(await check(ORG_ADMIN)).toBe(false);
    // `revoke all … from anon, authenticated` (20261012000003_ops.sql): not even RLS is reached.
    for (const user of [OPERATOR, ORG_ADMIN]) {
      await expect(asUser(db, user, (q) => q(`select * from platform_admins`))).rejects.toThrow(
        /permission denied for table platform_admins/,
      );
    }
    await expect(
      asUser(db, ORG_ADMIN, (q) =>
        q(`insert into platform_admins (user_id) values ($1)`, [ORG_ADMIN]),
      ),
    ).rejects.toThrow(/permission denied for table platform_admins/);
    // Anonymous callers (no JWT) are never platform admins.
    expect((await svc<{ ok: boolean }>(`select is_platform_admin() as ok`))[0]!.ok).toBe(false);
  });

  it('refuses every ops RPC for a customer org admin', async () => {
    const dead = await job(
      'render_pdf',
      { reportId: UUID_A, version: 1 },
      { status: 'dead', attempts: 5 },
    );
    for (const sql of [
      `select * from ops_queue_stats()`,
      `select * from ops_dead_jobs()`,
      `select ops_retry_job(${dead})`,
      `select ops_discard_job(${dead})`,
      `select * from ops_cost_outliers()`,
      `select * from ops_outbound_call_share()`,
    ]) {
      await expect(
        asUser(db, ORG_ADMIN, (q) => q(sql)),
        sql,
      ).rejects.toThrow(/not allowed/);
    }
    const after = await svc<{ status: string }>(`select status from jobs where id = $1`, [dead]);
    expect(after[0]!.status).toBe('dead');
    await svc(`delete from jobs`);
  });
});

describe('ops: queue and dead jobs', () => {
  it('counts queued / running / dead per type with the age of the oldest due job', async () => {
    await job(
      'transcribe_audio',
      { messageId: UUID_A },
      { run_after: new Date(Date.now() - 90_000).toISOString() },
    );
    await job(
      'transcribe_audio',
      { messageId: UUID_A },
      { run_after: new Date(Date.now() + 600_000).toISOString(), attempts: 2 },
    );
    await job('transcribe_audio', { messageId: UUID_A }, { status: 'running', attempts: 1 });
    await job('render_pdf', { reportId: UUID_A, version: 1 }, { status: 'dead', attempts: 5 });
    await job('send_email', { kind: 'report_filed' }, { status: 'done' });
    const rows = await asUser(db, OPERATOR, (q: Q) =>
      q<{
        type: string;
        queued: number;
        running: number;
        dead: number;
        oldest_due_s: number | null;
      }>(`select * from ops_queue_stats()`),
    );
    expect(rows.rows.map((r) => r.type)).toEqual(['render_pdf', 'transcribe_audio']);
    const t = rows.rows.find((r) => r.type === 'transcribe_audio')!;
    expect(t).toMatchObject({ queued: 2, running: 1, dead: 0 });
    expect(t.oldest_due_s).toBeGreaterThanOrEqual(89);
    expect(t.oldest_due_s).toBeLessThan(200);
    expect(rows.rows.find((r) => r.type === 'render_pdf')).toMatchObject({
      queued: 0,
      running: 0,
      dead: 1,
      oldest_due_s: null,
    });
    await svc(`delete from jobs`);
  });

  it('lists dead jobs with ids only and redacted errors', async () => {
    const id = await job(
      'send_template',
      {
        conversationId: UUID_A,
        template: 'sitelog_reminder_1',
        vars: { '1': 'Marco', '2': 'Riverside Lofts' },
        freeFormText: 'Marco, call me on +1 555 014 3378',
        to: ['lena@kestrel.test'],
        phone: '+15550143378',
        siteDayId: 'not-a-uuid',
        stage: 1,
        metrics: { estCostUsd: 0.01 },
      },
      {
        status: 'dead',
        attempts: 5,
        last_error:
          'Error: (#131030) Recipient +15550143378 not in allowed list; also 5550143378, (555) 014-3378 and lena@kestrel.test; job 2026-10-12 id cccccccc-1111-4111-8111-111111111111',
      },
    );
    const rows = await asUser(db, OPERATOR, (q: Q) =>
      q<{ id: number; type: string; attempts: number; last_error: string; payload: unknown }>(
        `select * from ops_dead_jobs()`,
      ),
    );
    expect(rows.rows).toHaveLength(1);
    const dead = rows.rows[0]!;
    expect(Number(dead.id)).toBe(id);
    expect(dead).toMatchObject({ type: 'send_template', attempts: 5 });
    expect(dead.payload).toEqual({
      conversationId: UUID_A,
      template: 'sitelog_reminder_1',
      stage: 1,
    });
    expect(dead.last_error).not.toMatch(/555|014|3378|lena|kestrel/);
    expect(dead.last_error).toContain('[phone]');
    expect(dead.last_error).toContain('[email]');
    expect(dead.last_error).toContain('2026-10-12');
    expect(dead.last_error).toContain('cccccccc-1111-4111-8111-111111111111');
    expect(dead.last_error).toContain('#131030');
  });

  it('retries a dead job (queued, attempts reset, due now) and audits the operator', async () => {
    const [{ id }] = (await svc<{ id: number }>(`select id from jobs where status = 'dead'`)) as [
      { id: number },
    ];
    const res = await asUser(db, OPERATOR, (q: Q) =>
      q<{ r: { id: number; status: string } }>(`select ops_retry_job($1) as r`, [id]),
    );
    expect(res.rows[0]!.r).toMatchObject({ status: 'queued' });
    const after = await svc<{
      status: string;
      attempts: number;
      due: boolean;
      finished_at: string | null;
    }>(`select status, attempts, run_after <= now() as due, finished_at from jobs where id = $1`, [
      id,
    ]);
    expect(after[0]).toEqual({ status: 'queued', attempts: 0, due: true, finished_at: null });
    const audit = await svc<{
      org_id: string | null;
      actor_type: string;
      actor_id: string;
      action: string;
      entity: string;
      diff: Record<string, unknown>;
    }>(
      `select org_id, actor_type, actor_id, action, entity, diff from audit_log where action like 'ops.%'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      org_id: null,
      actor_type: 'user',
      actor_id: OPERATOR,
      action: 'ops.job_retried',
      entity: 'job',
    });
    expect(audit[0]!.diff).toMatchObject({
      job_id: Number(id),
      type: 'send_template',
      attempts: 5,
    });
    expect(JSON.stringify(audit[0]!.diff)).not.toMatch(/555|lena/);
    // Customers never see platform audit rows (org_id null).
    const visible = await asUser(db, ORG_ADMIN, (q: Q) =>
      q(`select * from audit_log where action like 'ops.%'`),
    );
    expect(visible.rows).toEqual([]);
    // Only dead jobs can be retried.
    await expect(
      asUser(db, OPERATOR, (q: Q) => q(`select ops_retry_job($1)`, [id])),
    ).rejects.toThrow(/only dead jobs/);
    await expect(asUser(db, OPERATOR, (q: Q) => q(`select ops_retry_job(999999)`))).rejects.toThrow(
      /job not found/,
    );
    await svc(`delete from jobs`);
  });

  it('retries the one job of a dedupe key: no second job can hold it (D16)', async () => {
    const dead = await job(
      'render_pdf',
      { reportId: UUID_A, version: 2 },
      {
        status: 'dead',
        attempts: 6,
        dedupe_key: 'render_pdf:x:2',
      },
    );
    // Before D16 the key was free again once the job died; now it stays the dead job's.
    await expect(
      job('render_pdf', { reportId: UUID_A, version: 2 }, { dedupe_key: 'render_pdf:x:2' }),
    ).rejects.toThrow(/jobs_dedupe_key_key/);
    expect(
      await svc<{ id: number }>(
        `select enqueue_job('render_pdf', '{}'::jsonb, null, 'render_pdf:x:2')::int as id`,
      ),
    ).toEqual([{ id: dead }]);
    await asUser(db, OPERATOR, (q: Q) => q(`select ops_retry_job($1)`, [dead]));
    expect(
      await svc<{ status: string; attempts: number; dedupe_key: string }>(
        `select status::text, attempts, dedupe_key from jobs where id = $1`,
        [dead],
      ),
    ).toEqual([{ status: 'queued', attempts: 0, dedupe_key: 'render_pdf:x:2' }]);
    await svc(`delete from jobs`);
  });

  it('discards a dead job (kept as failed, off the list) with an audit row', async () => {
    const id = await job(
      'extract_report',
      { reportId: UUID_A },
      { status: 'dead', attempts: 5, last_error: 'boom' },
    );
    const res = await asUser(db, OPERATOR, (q: Q) =>
      q<{ r: { status: string } }>(`select ops_discard_job($1) as r`, [id]),
    );
    expect(res.rows[0]!.r).toMatchObject({ status: 'failed' });
    expect(
      (await svc<{ status: string }>(`select status from jobs where id = $1`, [id]))[0]!.status,
    ).toBe('failed');
    const list = await asUser(db, OPERATOR, (q: Q) => q(`select * from ops_dead_jobs()`));
    expect(list.rows).toEqual([]);
    const audit = await svc<{ actor_id: string; diff: Record<string, unknown> }>(
      `select actor_id, diff from audit_log where action = 'ops.job_discarded'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: OPERATOR,
      diff: { job_id: id, type: 'extract_report', last_error: 'boom' },
    });
    await expect(
      asUser(db, OPERATOR, (q: Q) => q(`select ops_discard_job($1)`, [id])),
    ).rejects.toThrow(/only dead jobs/);
    await svc(`delete from jobs`);
  });
});

describe('cost per report', () => {
  it('sums AI cost of the jobs that reference the report or its sources, and billable templates', async () => {
    const r = await report({ date: '2026-10-09' });
    const other = await report({ date: '2026-10-08' });
    const convo = (
      await svc<{ id: string }>(
        `insert into conversations (org_id, phone_e164, state) values ($1, '+15550143378', 'idle') returning id`,
        [orgId],
      )
    )[0]!.id;
    const msg = async (
      direction: string,
      type: string,
      payload: Record<string, unknown>,
      status = 'sent',
    ) =>
      (
        await svc<{ id: string }>(
          `insert into messages (conversation_id, direction, type, payload, status) values ($1, $2::msg_direction, $3::msg_type, $4, $5::msg_status) returning id`,
          [convo, direction, type, JSON.stringify(payload), status],
        )
      )[0]!.id;
    const audio = await msg('in', 'audio', {}, 'received');
    await svc(`insert into report_sources (report_id, message_id, kind) values ($1, $2, 'audio')`, [
      r.id,
      audio,
    ]);

    await job(
      'inbound_message',
      { messageId: audio, metrics: { audioSeconds: 168 } },
      { status: 'done' },
    );
    await job(
      'transcribe_audio',
      { messageId: audio, reportId: r.id, metrics: { estCostUsd: 0.0168 } },
      { status: 'done' },
    );
    await job(
      'extract_report',
      { reportId: r.id, metrics: { estCostUsd: 0.05, costUsdTotal: 0.1 } },
      { status: 'done' },
    );
    await job(
      'parse_reply',
      { reportId: r.id, messageId: UUID_A, metrics: { estCostUsd: 'n/a' } },
      { status: 'done' },
    );
    await job(
      'extract_report',
      { reportId: other.id, metrics: { estCostUsd: 9 } },
      { status: 'done' },
    );

    await msg('out', 'template', { kind: 'sitelog_reminder_1', siteDayId: r.siteDayId });
    await msg(
      'out',
      'template',
      { kind: 'sitelog_reminder_2', siteDayId: r.siteDayId },
      'delivered',
    );
    await msg('out', 'template', { kind: 'edit_hint', reportId: r.id });
    await msg('out', 'template', { kind: 'sitelog_reminder_2', siteDayId: r.siteDayId }, 'failed');
    await msg('out', 'text', { kind: 'filed', reportId: r.id });
    await msg('out', 'template', { kind: 'sitelog_reminder_1', siteDayId: other.siteDayId });
    // W2-15: the Notifier's messages about the report, by channel (payload.report_id).
    const notifier = async (
      channel: string,
      provider: string,
      status: string,
      payload: Record<string, unknown>,
    ) =>
      svc(
        `insert into messages (phone_e164, channel, direction, provider, status, body, payload)
         values ('+15550100000', $1::message_channel, 'out', $2, $3::msg_status, 'x', $4)`,
        [channel, provider, status, JSON.stringify(payload)],
      );
    await notifier('sms', 'twilio', 'delivered', { report_id: r.id });
    await notifier('sms', 'twilio', 'undeliverable', { report_id: r.id });
    await notifier('sms', 'console', 'delivered', { report_id: r.id });
    await notifier('whatsapp', 'twilio', 'read', { report_id: r.id, whatsapp_mode: 'template' });
    await notifier('whatsapp', 'twilio', 'sent', { report_id: r.id, whatsapp_mode: 'session' });
    await notifier('sms', 'twilio', 'sent', { report_id: other.id });

    const inputs = await svc<{
      ai_usd: string;
      job_count: number;
      wa_templates: number;
      sms_messages: number;
      whatsapp_templates: number;
    }>(`select * from report_cost_inputs($1)`, [r.id]);
    expect(Number(inputs[0]!.ai_usd)).toBeCloseTo(0.1168, 6);
    expect(inputs[0]).toMatchObject({
      job_count: 4,
      wa_templates: 3,
      sms_messages: 1,
      whatsapp_templates: 1,
    });
    const none = await svc<{ ai_usd: string; job_count: number; wa_templates: number }>(
      `select * from report_cost_inputs($1)`,
      ['00000000-0000-4000-8000-000000000000'],
    );
    expect(none[0]).toMatchObject({ job_count: 0, wa_templates: 0 });
    expect(Number(none[0]!.ai_usd)).toBe(0);
    await svc(`delete from jobs`);
  });

  it('computes the median of the previous 30 days of the same kind, excluding the report itself', async () => {
    const base = Date.parse('2026-10-01T22:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(base - i * 86_400_000).toISOString();
      const r = await report({ date: d.slice(0, 10), filedAt: d });
      ids.push(r.id);
      await cost(r.id, [4, 6, 5, 7, 3, 100][i]!, d);
    }
    const old = await report({ date: '2026-08-01' });
    await cost(old.id, 1000, '2026-08-01T22:00:00Z');
    // Its own site-day: a site-day has at most one live report (20261012000004_queue_fairness.sql).
    const noWork = await report({
      date: '2026-09-20',
      kind: 'no_work',
      filedAt: '2026-09-20T23:00:00Z',
    });
    await cost(noWork.id, 0, '2026-09-20T23:00:00Z', 'no_work');

    const baseline = async (kind: string, before: string, exclude: string | null) =>
      (
        await svc<{ median_cents: string | null; sample: number }>(
          `select * from report_cost_baseline($1, $2, $3, 30)`,
          [kind, before, exclude],
        )
      )[0]!;
    // 4, 6, 5, 7, 3, 100 → median 5.5 over six reports; Aug 1 is outside the window.
    const all = await baseline('daily', '2026-10-02T00:00:00Z', null);
    expect(all.sample).toBe(6);
    expect(Number(all.median_cents)).toBe(5.5);
    // Excluding the 100-cent report: 3, 4, 5, 6, 7 → 5.
    const without = await baseline('daily', '2026-10-02T00:00:00Z', ids[5]!);
    expect(without.sample).toBe(5);
    expect(Number(without.median_cents)).toBe(5);
    // Strictly before: the Oct 1 report is not part of its own baseline.
    expect((await baseline('daily', '2026-10-01T22:00:00Z', null)).sample).toBe(5);
    expect(await baseline('no_work', '2026-10-02T00:00:00Z', null)).toMatchObject({ sample: 1 });
    const empty = await baseline('weather_day', '2026-10-02T00:00:00Z', null);
    expect(empty).toEqual({ median_cents: null, sample: 0 });
  });

  it('lists flagged outliers with org and site for operators only; costs stay hidden from customers', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const r = await report({ date: recent.slice(0, 10), filedAt: recent });
    await cost(r.id, 41, recent, 'daily', true);
    const rows = await asUser(db, OPERATOR, (q: Q) =>
      q<{
        report_id: string;
        report_no: string;
        org_name: string;
        site_name: string;
        cost_cents: number;
        median_cents: string;
        sample: number;
        detail: Record<string, unknown>;
      }>(`select * from ops_cost_outliers(30)`),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      report_id: r.id,
      org_name: 'Kestrel Build Group',
      site_name: 'Riverside Lofts — Block B',
      cost_cents: 41,
      sample: 24,
    });
    expect(Number(rows.rows[0]!.median_cents)).toBe(5);
    expect(rows.rows[0]!.detail).toMatchObject({ waTemplates: 2 });
    const hidden = await asUser(db, ORG_ADMIN, (q: Q) => q(`select * from report_costs`));
    expect(hidden.rows).toEqual([]);
  });
});

// 20261015000040_unknown_contacts_support.sql (spec §19 Q44, W1-16): org-less unknown contacts
// are SiteLog support's, never every org's.
describe('org-less unknown contacts for SiteLog support', () => {
  async function contact(orgId: string | null = null): Promise<string> {
    const rows = await svc<{ id: string }>(
      `insert into unknown_contacts (org_id, phone_e164, snippet, channel, status)
       values ($1, '+15550100999', 'Hi, this is Sam from the Elm St. crew', 'sms', 'pending')
       returning id`,
      [orgId],
    );
    return rows[0]!.id;
  }
  const asOperator = <T>(sql: string, params: unknown[] = []) =>
    asUser(db, OPERATOR, (q: Q) => q<T>(sql, params));

  it('lists the pending ones with no org to operators only', async () => {
    const orphan = await contact();
    const owned = await contact(orgId);
    const list = await asOperator<{ id: string; channel: string; snippet: string }>(
      `select * from ops_unknown_contacts()`,
    );
    const ids = list.rows.map((r) => r.id);
    expect(ids).toContain(orphan);
    expect(ids).not.toContain(owned);
    expect(list.rows.find((r) => r.id === orphan)).toMatchObject({ channel: 'sms' });
    await expect(
      asUser(db, ORG_ADMIN, (q: Q) => q(`select * from ops_unknown_contacts()`)),
    ).rejects.toThrow(/not allowed/);
    // RLS: the org admin cannot read the org-less row either.
    const seen = await asUser(db, ORG_ADMIN, (q: Q) =>
      q(`select id from unknown_contacts where id = $1`, [orphan]),
    );
    expect(seen.rows).toEqual([]);
  });

  it('assigns one to a real org, which then sees it; audited', async () => {
    const id = await contact();
    await expect(
      asUser(db, ORG_ADMIN, (q: Q) => q(`select ops_assign_unknown_contact($1, $2)`, [id, orgId])),
    ).rejects.toThrow(/not allowed/);
    await asOperator(`select ops_assign_unknown_contact($1, $2)`, [id, orgId]);
    const seen = await asUser(db, ORG_ADMIN, (q: Q) =>
      q<{ id: string }>(`select id from unknown_contacts where id = $1`, [id]),
    );
    expect(seen.rows).toEqual([{ id }]);
    const audit = await svc<{ actor_id: string; org_id: string }>(
      `select actor_id, org_id from audit_log
       where action = 'ops.unknown_contact_assigned' and entity_id = $1`,
      [id],
    );
    expect(audit).toEqual([{ actor_id: OPERATOR, org_id: orgId }]);
    // Once it has an org it is the org's: support neither reassigns nor ignores it.
    await expect(
      asOperator(`select ops_assign_unknown_contact($1, $2)`, [id, orgId]),
    ).rejects.toThrow(/only a pending contact with no organisation/);
    await expect(asOperator(`select ops_ignore_unknown_contact($1)`, [id])).rejects.toThrow(
      /only a pending contact with no organisation/,
    );
  });

  it('never assigns to a demo org, and ignores one with an audit row', async () => {
    const demo = (
      await svc<{ id: string }>(
        `insert into orgs (name, is_demo) values ('Demo Org', true) returning id`,
      )
    )[0]!.id;
    const id = await contact();
    await expect(
      asOperator(`select ops_assign_unknown_contact($1, $2)`, [id, demo]),
    ).rejects.toThrow(/demo organisation/);
    const orgs = await asOperator<{ id: string; name: string }>(`select * from ops_real_orgs()`);
    expect(orgs.rows.map((o) => o.id)).toContain(orgId);
    expect(orgs.rows.map((o) => o.id)).not.toContain(demo);
    await expect(
      asUser(db, ORG_ADMIN, (q: Q) => q(`select * from ops_real_orgs()`)),
    ).rejects.toThrow(/not allowed/);
    await asOperator(`select ops_ignore_unknown_contact($1)`, [id]);
    const row = await svc<{ status: string }>(`select status from unknown_contacts where id = $1`, [
      id,
    ]);
    expect(row[0]!.status).toBe('ignored');
    const audit = await svc(
      `select 1 from audit_log where action = 'ops.unknown_contact_ignored' and entity_id = $1`,
      [id],
    );
    expect(audit).toHaveLength(1);
  });
});
