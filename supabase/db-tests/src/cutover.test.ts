import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildSeedSql } from '@sitelog/shared/demo/seed-sql.ts';
import { todayIn } from '@sitelog/shared/demo/calendar.ts';
import { DEMO_ORG_ID, DEMO_TZ } from '@sitelog/shared/demo/kestrel.ts';
import { DEMIR_ORG_ID } from '@sitelog/shared/demo/demir.ts';
import { applyMigration, asUser, bootDatabase, migrationFiles } from './harness.ts';

/**
 * The W1-19 cut-over rehearsed on a database shaped like staging (`abuanbyzttuqksdctqcp`) as the
 * read-only inventory of 2026-10-13 found it (docs/GAP_ANALYSIS.md §8): the 16 v1.0 migrations,
 * one customer org (not the demo org) made by the v1.0 panel's create_org call, one `invited`
 * reporter with a WhatsApp conversation in state `new`, a logo in storage, and two queued jobs
 * (`send_welcome`, `build_evidence_pack`). Then the steps of docs/RUNBOOK.md §2 "Cut-over (W1-19),
 * step by step" that touch the database, in their order:
 *
 *   1. the D19 check (no `verified` reporter outside the demo org) on the v1.0 schema;
 *   2. supabase/ops/discard-backlog.sql;
 *   4. the db push: every later migration, in one go, as `supabase db push` applies them;
 *      then the post-push checks (every org has a pack, every sender id and voice number null);
 *   5. `pnpm seed:demo -- --date today --apply` (the SQL the apply mode runs, for today in Chicago
 *      at the current clock), which must leave the customer org alone.
 *
 * What cannot be rehearsed here (the hosted project, Auth, the edge functions, Netlify) is in the
 * RUNBOOK's verification lines.
 */

/** The first v1.2 migration: staging has every file before it and none from it on. */
const FIRST_V1_2 = '20261013000006_enums_v1_2.sql';
const DISCARD_SQL = readFileSync(
  join(import.meta.dirname, '..', '..', 'ops', 'discard-backlog.sql'),
  'utf8',
);

const OWNER = randomUUID();
let db: PGlite;
let customerOrg: string;
let reporterId: string;
let staleJobs: number[];
let freshJob: number;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

beforeAll(async () => {
  db = await bootDatabase({ until: FIRST_V1_2, storage: true, realtime: true });
  await db.exec(
    `insert into auth.users (id, email) values ('${OWNER}', 'owner@customer.example');`,
  );
  // The deployed v1.0 panel's setup wizard: create_org with its four named arguments.
  customerOrg = await asUser(
    db,
    OWNER,
    async (q) =>
      (
        await q<{ r: { id: string } }>(
          `select create_org(p_name => $1, p_timezone => $2, p_address => $3, p_license_no => $4) as r`,
          ['Customer Build Co', 'America/Chicago', null, null],
        )
      ).rows[0]!.r.id,
    'owner@customer.example',
  );
  const [rep] = await rows<{ id: string }>(
    `insert into reporters (org_id, name, phone_e164, status, invited_at)
     values ($1, 'Real Person', '+15550170001', 'invited', now() - interval '3 days') returning id`,
    [customerOrg],
  );
  reporterId = rep!.id;
  await db.exec(`
    insert into conversations (org_id, reporter_id, phone_e164, state)
      values ('${customerOrg}', '${reporterId}', '+15550170001', 'new');
    insert into storage.objects (bucket_id, name)
      values ('logos', '${customerOrg}/logo.png');
  `);
  const stale = await rows<{ id: number }>(
    `insert into jobs (type, payload, created_at, run_after) values
       ('send_welcome', jsonb_build_object('reporterId', $1::text), now() - interval '2 days', now() - interval '2 days'),
       ('build_evidence_pack', jsonb_build_object('orgId', $2::text), now() - interval '1 day', now() - interval '1 day')
     returning id`,
    [reporterId, customerOrg],
  );
  staleJobs = stale.map((r) => r.id);
  // Not part of staging's inventory: a job queued minutes ago is kept (the one-hour margin).
  const [fresh] = await rows<{ id: number }>(
    `insert into jobs (type, payload, created_at) values ('fetch_weather', '{}'::jsonb, now() - interval '5 minutes') returning id`,
  );
  freshJob = fresh!.id;
});

afterAll(async () => {
  await db.close();
});

describe('the W1-19 cut-over on a staging-shaped database', () => {
  it('starts from the v1.0 schema: no orgs.country, no countries, unknown_senders', async () => {
    const [shape] = await rows<{ country: boolean; countries: boolean; senders: boolean }>(
      `select exists (select 1 from information_schema.columns
                      where table_name = 'orgs' and column_name = 'country') as country,
              to_regclass('public.countries') is not null as countries,
              to_regclass('public.unknown_senders') is not null as senders`,
    );
    expect(shape).toEqual({ country: false, countries: false, senders: true });
  });

  it('step 1: the D19 check finds no verified reporter outside the demo org', async () => {
    // The RUNBOOK's query for the v1.0 schema (no is_demo yet: the Kestrel org by its fixed id).
    const [d19] = await rows<{ n: number }>(
      `select count(*)::int as n from reporters where status = 'verified' and org_id <> $1`,
      [DEMO_ORG_ID],
    );
    expect(d19!.n).toBe(0);
  });

  it('step 2: discard-backlog.sql fails the stale jobs, keeps a fresh one, and audits the counts', async () => {
    await db.exec(DISCARD_SQL);
    const jobs = await rows<{ id: number; status: string; last_error: string | null }>(
      `select id, status::text as status, last_error from jobs order by id`,
    );
    for (const id of staleJobs) {
      const job = jobs.find((j) => j.id === id)!;
      expect(job.status).toBe('failed');
      expect(job.last_error).toMatch(/discarded: queued before the v1.2 cut-over/);
    }
    expect(jobs.find((j) => j.id === freshJob)!.status).toBe('queued');
    const audit = await rows<{ actor_type: string; diff: Record<string, unknown> }>(
      `select actor_type, diff from audit_log where action = 'ops.backlog_discarded'`,
    );
    expect(audit).toEqual([
      {
        actor_type: 'system',
        diff: {
          count: 2,
          by_type: { send_welcome: 1, build_evidence_pack: 1 },
          reason: 'W1-19 cut-over: queued before the v1.2 worker existed',
        },
      },
    ]);
    // Running it again changes nothing and records a zero.
    await db.exec(DISCARD_SQL);
    const again = await rows<{ diff: { count: number; by_type: object } }>(
      `select diff from audit_log where action = 'ops.backlog_discarded' order by id`,
    );
    expect(again.map((r) => [r.diff.count, r.diff.by_type])).toEqual([
      [2, { send_welcome: 1, build_evidence_pack: 1 }],
      [0, {}],
    ]);
  });

  it('step 4: the db push applies every v1.2 migration in one go', async () => {
    const pending = migrationFiles().filter((f) => f >= FIRST_V1_2);
    expect(pending.length).toBeGreaterThan(10);
    for (const file of pending) await applyMigration(db, file);
  });

  it('after the push: the customer org is a US org, not a demo org, with its reporter still invited', async () => {
    const [org] = await rows<{ country: string; is_demo: boolean; locale: string }>(
      `select country, is_demo, locale from orgs where id = $1`,
      [customerOrg],
    );
    expect(org).toEqual({ country: 'US', is_demo: false, locale: 'en-US' });
    const [rep] = await rows<{ status: string }>(
      `select status::text as status from reporters where id = $1`,
      [reporterId],
    );
    expect(rep!.status).toBe('invited');
    const labels = await rows<{ l: string }>(
      `select unnest(enum_range(null::reporter_status))::text as l`,
    );
    expect(labels.map((r) => r.l)).not.toContain('verified');
    const [shape] = await rows<{ contacts: boolean; senders: boolean }>(
      `select to_regclass('public.unknown_contacts') is not null as contacts,
              to_regclass('public.unknown_senders') is not null as senders`,
    );
    expect(shape).toEqual({ contacts: true, senders: false });
  });

  it('after the push: every sender id and voice number is null, so every text goes to console', async () => {
    // The RUNBOOK's post-push check, verbatim.
    const packs = await rows<{
      code: string;
      sms_provider: string;
      sms_sender_id: string | null;
      voice_number: string | null;
    }>(`select code, sms_provider, sms_sender_id, voice_number from countries order by code`);
    expect(packs.map((p) => p.code)).toEqual(expect.arrayContaining(['TR', 'US']));
    for (const p of packs) {
      expect(p.sms_sender_id, p.code).toBeNull();
      expect(p.voice_number, p.code).toBeNull();
    }
  });

  it('after the push: the discarded jobs stay failed and nothing else is queued', async () => {
    const live = await rows<{ id: number; type: string }>(
      `select id, type from jobs where status in ('queued', 'running') order by id`,
    );
    expect(live).toEqual([{ id: freshJob, type: 'fetch_weather' }]);
    const discarded = await rows<{ n: number }>(
      `select count(*)::int as n from jobs where status = 'failed' and id = any($1::bigint[])`,
      [staleJobs],
    );
    expect(discarded[0]!.n).toBe(2);
  });

  it('step 5: the demo seed for today (Chicago) applies next to the customer org and leaves it alone', async () => {
    const snapshot = async () =>
      rows<{ r: string }>(
        `select to_jsonb(o)::text as r from orgs o where id = $1
         union all select to_jsonb(r)::text from reporters r where org_id = $1
         union all select to_jsonb(c)::text from conversations c where org_id = $1
         union all select to_jsonb(m)::text from org_members m where org_id = $1`,
        [customerOrg],
      );
    const before = await snapshot();
    const sql = buildSeedSql({
      date: todayIn(DEMO_TZ),
      clock: new Date().toISOString(),
      linkBase: 'https://sitelog-field-staging.example',
      globalRows: false,
    });
    await db.exec(sql);
    expect(await snapshot()).toEqual(before);
    const demo = await rows<{ id: string; is_demo: boolean; country: string }>(
      `select id, is_demo, country from orgs where is_demo order by name`,
    );
    expect(demo.map((o) => o.id).sort()).toEqual([DEMO_ORG_ID, DEMIR_ORG_ID].sort());
    // The seed writes no pack endpoint: the demo orgs text through console whatever the pack holds.
    const [set] = await rows<{ n: number }>(
      `select count(*)::int as n from countries where sms_sender_id is not null or voice_number is not null`,
    );
    expect(set!.n).toBe(0);
    // Every seeded link points at the field site the apply was given.
    const texts = await rows<{ body: string }>(
      `select body from messages where org_id = $1 and copy_key = 'welcome'`,
      [DEMO_ORG_ID],
    );
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t.body).toContain('https://sitelog-field-staging.example/r/');
  });
});
