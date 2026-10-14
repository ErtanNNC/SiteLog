import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID } from '@sitelog/shared/demo/kestrel.ts';
import { DEMIR_ORG_ID } from '@sitelog/shared/demo/demir.ts';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { bootDatabase } from './harness.ts';

/**
 * supabase/ops/inventory.sql is the read-only staging inventory the Deploy workflow runs with psql
 * (W1-01 step 0). These tests run it against the migrated + seeded schema so a wrong column or
 * table fails here, not on the owner-approved run against staging.
 */

const SCRIPT_PATH = join(import.meta.dirname, '..', '..', 'ops', 'inventory.sql');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');

type Flags = {
  has_storage: boolean;
  has_cron: boolean;
  has_vault: boolean;
  has_is_demo: boolean;
  has_unknown_contacts: boolean;
};

/** The script's own flag query (the one psql ends with \gset). */
const FLAG_QUERY = /select\s+coalesce[\s\S]*?as has_unknown_contacts/.exec(SCRIPT)![0];
type Row = [
  section: string,
  label: string,
  demo: number | null,
  other: number | null,
  total: string,
];

/**
 * The psql meta-commands the script uses, for PGlite: `\gset` ends the flag query, `\if :flag`,
 * `\else` and `\endif` keep or drop lines by the flags the test passes in.
 */
function forPglite(sql: string, flags: Flags): string {
  const out: string[] = [];
  const stack: boolean[] = [];
  for (const line of sql.split('\n')) {
    const meta = /^\\(\w+)\s*:?(\w+)?/.exec(line.trim());
    if (meta) {
      const [, cmd, arg] = meta;
      if (cmd === 'if') stack.push(flags[arg as keyof Flags]);
      else if (cmd === 'else') stack.push(!stack.pop());
      else if (cmd === 'endif') stack.pop();
      else if (cmd === 'gset') out.push(';');
      else throw new Error(`unexpected psql command \\${cmd}`);
      continue;
    }
    if (stack.every(Boolean)) out.push(line);
  }
  return out.join('\n');
}

/** The first column of each query the script ends with \gset. */
const GSET_COLUMNS = new Set(['has_storage', 'demo_orgs']);

async function runInventory(db: PGlite, flags: Flags): Promise<Row[]> {
  const results = await db.exec(forPglite(SCRIPT, flags), { rowMode: 'array' });
  await db.exec('reset default_transaction_read_only');
  return (
    results
      // psql prints nothing for a \gset query (the flags, the demo org set): leave those out.
      .filter((r) => r.fields.length === 5 && !GSET_COLUMNS.has(r.fields[0]!.name))
      .flatMap((r) => r.rows as unknown as Row[])
      .map(([s, l, d, o, t]) => [
        s,
        l,
        d === null ? null : Number(d),
        o === null ? null : Number(o),
        t,
      ])
  );
}

function section(rows: Row[], name: string): Map<string, Row> {
  return new Map(rows.filter((r) => r[0] === name).map((r) => [r[1], r]));
}

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
});

afterAll(async () => {
  await db.close();
});

describe('supabase/ops/inventory.sql', () => {
  it('names the seeded Kestrel org by its fixed id, for a database without orgs.is_demo', () => {
    expect(DEMO_ORG_ID).toBe(demoId('org:kestrel'));
    expect(SCRIPT).toContain(`set local sitelog.demo_orgs = '{${DEMO_ORG_ID}}';`);
  });

  it('only reads: every statement is a select, set, begin or rollback inside a read-only transaction', () => {
    const statements = SCRIPT.replace(/--[^\n]*/g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('\\'))
      .join('\n')
      .split(';')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    for (const s of statements) expect(s).toMatch(/^(select|set|begin|rollback)\b/);
    expect(statements[0]).toBe('set default_transaction_read_only = on');
    expect(statements[1]).toBe('begin transaction isolation level repeatable read, read only');
    expect(statements.at(-1)).toBe('rollback');
    expect(SCRIPT).not.toMatch(/from\s+vault\.decrypted_secrets/i);
  });

  it('counts the seeded tables, split into the demo orgs (is_demo) and the rest', async () => {
    // A customer org next to the two demo orgs, with one reporter.
    await db.exec(`
      insert into orgs (id, name) values ('0c000000-0000-4000-8000-000000000001', 'Customer Builders');
      insert into reporters (org_id, name, phone_e164, status)
        values ('0c000000-0000-4000-8000-000000000001', 'Customer Person', '+15550107777', 'invited');
    `);
    const flags = await db.query<Flags>(FLAG_QUERY);
    expect(flags.rows[0]).toEqual({
      has_storage: false,
      has_cron: false,
      has_vault: false,
      has_is_demo: true,
      has_unknown_contacts: true,
    });
    const rows = await runInventory(db, flags.rows[0]!);
    for (const r of rows) {
      expect(r).toHaveLength(5);
      expect(typeof r[0]).toBe('string');
      expect(typeof r[1]).toBe('string');
    }

    // Both seeded demo orgs (Kestrel and the TR org Demir Yapı) by is_demo; the customer is the rest.
    expect(section(rows, 'Orgs').get('demo orgs by')).toEqual([
      'Orgs',
      'demo orgs by',
      null,
      null,
      'is_demo',
    ]);
    expect(section(rows, 'Orgs').get('orgs')).toEqual(['Orgs', 'orgs', 2, 1, '3']);

    const seeded = await db.query<{ t: string; n: number }>(`
      select 'messages' as t, count(*)::int as n from messages union all
      select 'demo_reporters', count(*)::int from reporters where org_id in ('${DEMO_ORG_ID}', '${DEMIR_ORG_ID}') union all
      select 'reports', count(*)::int from reports union all
      select 'reporters', count(*)::int from reporters union all
      select 'versions', count(*)::int from report_versions union all
      select 'sources', count(*)::int from report_sources union all
      select 'notifications', count(*)::int from notifications union all
      select 'transcripts', count(*)::int from transcripts union all
      select 'unknown', count(*)::int from unknown_contacts union all
      select 'conversations', count(*)::int from conversations union all
      select 'jobs', count(*)::int from jobs`);
    const n = Object.fromEntries(seeded.rows.map((r) => [r.t, r.n]));

    const all = (name: string) => section(rows, name).get('all');
    expect(all('Messages by type and conversation')?.[4]).toBe(String(n.messages));
    expect(all('Reports by status')?.[4]).toBe(String(n.reports));
    expect(all('Reporters by status')).toEqual([
      'Reporters by status',
      'all',
      n.demo_reporters,
      1,
      String(n.reporters),
    ]);
    expect(n.demo_reporters).toBe(9); // Kestrel's 7 and Demir Yapı's 2
    // The TR demo org's texts are demo rows too: every SMS row is a demo org's.
    const sms = section(rows, 'Messages by type and conversation').get('sms · no conversation')!;
    expect(sms[3]).toBe(0);
    expect(all('Report versions by data schemaVersion')?.[4]).toBe(String(n.versions));
    expect(all('Report sources by kind')?.[4]).toBe(String(n.sources));
    expect(all('Notifications by kind')?.[4]).toBe(String(n.notifications));
    expect(all('Unknown contacts by status')?.[4]).toBe(String(n.unknown));
    expect(all('Conversations by state')?.[4]).toBe(String(n.conversations));
    expect(all('Jobs by type and status')).toEqual([
      'Jobs by type and status',
      'all',
      null,
      null,
      String(n.jobs),
    ]);
    expect(section(rows, 'Transcripts').get('transcripts')?.[4]).toBe(String(n.transcripts));

    // Labels are enum values and fixed names.
    expect([...section(rows, 'Reporters by status').keys()]).toEqual(
      expect.arrayContaining(['active', 'all']),
    );
    expect(section(rows, 'Report versions by data schemaVersion').has('schemaVersion 1')).toBe(
      true,
    );
    // The seeded texts are SMS rows: no WhatsApp type, no conversation (W1-06).
    expect([...section(rows, 'Messages by type and conversation').keys()]).toContain(
      'sms · no conversation',
    );

    // Without storage, pg_cron or Vault (plain Postgres), those sections say so instead of failing.
    expect(section(rows, 'Storage objects by bucket').get('storage.objects')?.[4]).toBe(
      'not readable',
    );
    expect(section(rows, 'Scheduler (pg_cron)').get('cron.job')?.[4]).toBe('not readable');
    expect(section(rows, 'Vault secrets for scheduler-tick').get('vault.secrets')?.[4]).toBe(
      'not readable',
    );
  });

  it('reads storage, pg_cron and Vault on a Supabase-shaped database, and prints no contents', async () => {
    await db.exec(`
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean default false);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets, name text);
      insert into storage.buckets (id, name) values ('audio', 'audio'), ('photos', 'photos'), ('pdfs', 'pdfs');
      insert into storage.objects (bucket_id, name) values
        ('audio', '${DEMO_ORG_ID}/site/2026-10-09/private-voice-note.ogg'),
        ('audio', '_unknown/+15550001111/private-unknown-note.ogg'),
        ('photos', '${DEMO_ORG_ID}/site/office/private-photo.jpg');
      create schema cron;
      create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean);
      insert into cron.job (jobname, schedule, command, active)
        values ('sitelog-scheduler-tick', '*/5 * * * *', 'select private_command()', true);
      create schema vault;
      create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text);
      insert into vault.secrets (name, secret) values ('scheduler_tick_url', 'https://private-secret.example/tick');
    `);
    const flags = await db.query<Flags>(FLAG_QUERY);
    expect(flags.rows[0]).toEqual({
      has_storage: true,
      has_cron: true,
      has_vault: true,
      has_is_demo: true,
      has_unknown_contacts: true,
    });

    const rows = await runInventory(db, flags.rows[0]!);

    expect([...section(rows, 'Storage objects by bucket').values()]).toEqual([
      ['Storage objects by bucket', 'audio', 1, 1, '2'],
      ['Storage objects by bucket', 'pdfs', 0, 0, '0'],
      ['Storage objects by bucket', 'photos', 1, 0, '1'],
      ['Storage objects by bucket', 'all', 2, 1, '3'],
    ]);
    expect(section(rows, 'Scheduler (pg_cron)').get('job sitelog-scheduler-tick')?.[4]).toBe(
      'present, active',
    );
    expect([...section(rows, 'Vault secrets for scheduler-tick').values()]).toEqual([
      ['Vault secrets for scheduler-tick', 'scheduler_secret', null, null, 'missing'],
      ['Vault secrets for scheduler-tick', 'scheduler_tick_url', null, null, 'present'],
    ]);

    // Nothing but labels and counts: no object paths, secrets, cron commands, names or phones.
    const printed = JSON.stringify(rows);
    expect(printed).not.toMatch(/private|\+1555|@|http/);
    const people = await db.query<{ v: string }>(
      `select name as v from reporters union select phone_e164 from reporters union select name from orgs`,
    );
    for (const { v } of people.rows) expect(printed).not.toContain(v);
  });

  it('reads a database from before W1-05 step 11 (staging until the cut-over re-run, W1-19)', async () => {
    const old = await bootDatabase({ until: '20261014000003_renames_billing.sql' });
    try {
      // is_demo exists (step 9 flagged the Kestrel org on staging); a second demo org counts too.
      await old.exec(`
        insert into orgs (id, name, is_demo) values
          ('${DEMO_ORG_ID}', 'Kestrel', true), ('${DEMIR_ORG_ID}', 'Demir', true),
          (gen_random_uuid(), 'Customer', false);
        insert into reporters (org_id, name, phone_e164, status)
          select id, 'R', '+15550109999', 'verified' from orgs where name = 'Customer';
        insert into unknown_senders (org_id, phone_e164) values
          ('${DEMO_ORG_ID}', '+15550108888'), ('${DEMIR_ORG_ID}', '+905320009999');
      `);
      const flags = await old.query<Flags>(FLAG_QUERY);
      expect(flags.rows[0]!.has_unknown_contacts).toBe(false);
      expect(flags.rows[0]!.has_is_demo).toBe(true);
      const rows = await runInventory(old, flags.rows[0]!);
      expect(section(rows, 'Orgs').get('orgs')).toEqual(['Orgs', 'orgs', 2, 1, '3']);
      expect(section(rows, 'Unknown contacts by status').get('pending')).toEqual([
        'Unknown contacts by status',
        'pending',
        2,
        0,
        '2',
      ]);
      // D19: a verified reporter outside the demo orgs stops the cut-over (docs/RUNBOOK.md §2).
      expect(section(rows, 'Reporters by status').get('verified')).toEqual([
        'Reporters by status',
        'verified',
        0,
        1,
        '1',
      ]);
    } finally {
      await old.close();
    }
  });

  it('reads the staging v1.0 schema (no orgs.is_demo): the Kestrel org by its fixed id', async () => {
    const v10 = await bootDatabase({ until: '20261013000006_enums_v1_2.sql' });
    try {
      // Another org is not a demo org here, whatever its id: only the fixed Kestrel id is.
      await v10.exec(`
        insert into orgs (id, name) values
          ('${DEMO_ORG_ID}', 'Kestrel'), ('${DEMIR_ORG_ID}', 'Demir'), (gen_random_uuid(), 'Customer');
        insert into reporters (org_id, name, phone_e164, status)
          select id, 'R', '+15550109999', 'verified' from orgs where name = 'Customer';
        insert into reporters (org_id, name, phone_e164, status)
          values ('${DEMO_ORG_ID}', 'K', '+15550109998', 'verified');
        insert into unknown_senders (org_id, phone_e164) values
          ('${DEMO_ORG_ID}', '+15550108888'), ('${DEMIR_ORG_ID}', '+905320009999');
      `);
      const flags = await v10.query<Flags>(FLAG_QUERY);
      expect(flags.rows[0]).toEqual({
        has_storage: false,
        has_cron: false,
        has_vault: false,
        has_is_demo: false,
        has_unknown_contacts: false,
      });
      const rows = await runInventory(v10, flags.rows[0]!);
      expect(section(rows, 'Orgs').get('demo orgs by')).toEqual([
        'Orgs',
        'demo orgs by',
        null,
        null,
        'fixed Kestrel id (no is_demo column)',
      ]);
      expect(section(rows, 'Orgs').get('orgs')).toEqual(['Orgs', 'orgs', 1, 2, '3']);
      expect(section(rows, 'Unknown contacts by status').get('pending')).toEqual([
        'Unknown contacts by status',
        'pending',
        1,
        1,
        '2',
      ]);
      expect(section(rows, 'Reporters by status').get('verified')).toEqual([
        'Reporters by status',
        'verified',
        1,
        1,
        '2',
      ]);
      // Every section ran: the read-only transaction got to the end.
      expect(section(rows, 'Vault secrets for scheduler-tick').get('vault.secrets')?.[4]).toBe(
        'not readable',
      );
    } finally {
      await v10.close();
    }
  });
});
