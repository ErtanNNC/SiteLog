import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID } from '@sitelog/shared/demo/kestrel.ts';
import {
  MIGRATIONS_DIR,
  applyMigration,
  asService,
  asUser,
  bootDatabase,
  probeAs,
} from './harness.ts';

/**
 * 20261013000007_schema_expand_v1_2.sql (W1-05 step 9, first half): the orgs column lockdown and
 * the audit of direct org edits, the reporters lockdown and status guard, the Kestrel demo flag on
 * a database deployed before the migration, the relaxed WhatsApp-only constraints and the v1.2
 * keys, the grants of the new tables, realtime on messages and the calls bucket. The role matrix
 * (role-matrix.test.ts) and the anon test cover the new tables, the reporters columns and the
 * v1.2 transcripts per role.
 */

const FILE = '20261013000007_schema_expand_v1_2.sql';

const ADMIN = 'abababab-1111-4111-8111-000000000001';
const PM = 'abababab-1111-4111-8111-000000000002';

/** The columns an org admin may still update directly (the rest: service role and RPCs). */
const ADMIN_COLUMNS = ['address', 'license_no', 'locale', 'name', 'tax_no', 'timezone', 'units'];

let db: PGlite;
let orgId: string;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

const admin = (sql: string, params: unknown[] = []) =>
  probeAs(db, { role: 'authenticated', userId: ADMIN, email: 'admin@expand.test' }, sql, params);

/** The org.updated rows of the test org, oldest first. */
const orgUpdates = () =>
  svc<{ actor_type: string; actor_id: string | null; diff: Record<string, unknown> }>(
    `select actor_type, actor_id, diff from audit_log
     where entity_id = $1 and action = 'org.updated' order by id`,
    [orgId],
  );

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(
    `insert into auth.users (id, email) values ('${ADMIN}', 'admin@expand.test'), ('${PM}', 'pm@expand.test');`,
  );
  orgId = await asUser(
    db,
    ADMIN,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Expand GC', 'America/Chicago') as r`))
        .rows[0]!.r.id,
    'admin@expand.test',
  );
  await svc(`insert into org_members (org_id, user_id, role) values ($1, $2, 'pm')`, [orgId, PM]);
});

describe('orgs column lockdown', () => {
  it('grants UPDATE on the profile columns only, and nothing to anon', async () => {
    const cols = await svc<{ col: string; auth: boolean; anon: boolean }>(`
      select a.attname as col,
             has_column_privilege('authenticated', 'public.orgs', a.attname, 'UPDATE') as auth,
             has_column_privilege('anon', 'public.orgs', a.attname, 'UPDATE') as anon
      from pg_attribute a
      where a.attrelid = 'public.orgs'::regclass and a.attnum > 0 and not a.attisdropped
      order by 1`);
    expect(cols.filter((c) => c.auth).map((c) => c.col)).toEqual(ADMIN_COLUMNS);
    expect(cols.filter((c) => c.anon)).toEqual([]);
    // A column added later (billing_* in step 11) is not covered by a table-level grant.
    const table = await svc<{ auth: boolean; anon: boolean }>(
      `select has_table_privilege('authenticated', 'public.orgs', 'UPDATE') as auth,
              has_table_privilege('anon', 'public.orgs', 'UPDATE') as anon`,
    );
    expect(table[0]).toEqual({ auth: false, anon: false });
  });

  it('lets an admin edit the profile columns directly', async () => {
    const res = await asUser(db, ADMIN, (q) =>
      q(
        `update orgs set name = 'Expand GC LLC', address = '1 Main St', license_no = 'GC-1',
                tax_no = '1234567890', timezone = 'America/Denver', locale = 'tr-TR', units = 'metric'
         where id = $1`,
        [orgId],
      ),
    );
    expect(res.affectedRows).toBe(1);
    expect(
      (
        await svc(
          `select name, address, license_no, tax_no, timezone, locale, units from orgs where id = $1`,
          [orgId],
        )
      )[0],
    ).toEqual({
      name: 'Expand GC LLC',
      address: '1 Main St',
      license_no: 'GC-1',
      tax_no: '1234567890',
      timezone: 'America/Denver',
      locale: 'tr-TR',
      units: 'metric',
    });
  });

  it.each([
    ['is_demo', 'is_demo = true'],
    ['billing_status', `billing_status = 'active'`],
    ['stripe_customer_id', `stripe_customer_id = 'cus_other'`],
    ['stripe_subscription_id', `stripe_subscription_id = 'sub_other'`],
    ['billing_provider', `billing_provider = 'iyzico'`],
    ['billing_customer_id', `billing_customer_id = 'cus_other'`],
    ['billing_subscription_id', `billing_subscription_id = 'sub_other'`],
    ['trial_ends_at', `trial_ends_at = now() + interval '1 year'`],
    ['country', `country = 'TR'`],
    ['currency', `currency = 'TRY'`],
    ['logo_path', `logo_path = 'someone-else/logo.png'`],
    ['a profile column together with a locked one', `name = 'X', is_demo = true`],
  ])('refuses an admin writing %s (42501)', async (_what, set) => {
    const res = await admin(`update orgs set ${set} where id = $1`, [orgId]);
    expect(res.ok ? 'allowed' : res.code).toBe('42501');
  });

  it('keeps update_org() and set_org_logo() working for the admin', async () => {
    await asUser(db, ADMIN, async (q) => {
      await q(`select update_org($1, 'Expand Group', 'America/Chicago', '2 Main St', 'GC-2')`, [
        orgId,
      ]);
      await q(`select set_org_logo($1, $2)`, [orgId, `${orgId}/logo.png`]);
    });
    expect(
      (
        await svc(`select name, timezone, address, license_no, logo_path from orgs where id = $1`, [
          orgId,
        ])
      )[0],
    ).toEqual({
      name: 'Expand Group',
      timezone: 'America/Chicago',
      address: '2 Main St',
      license_no: 'GC-2',
      logo_path: `${orgId}/logo.png`,
    });
  });

  it('audits a direct edit of the profile columns as org.updated', async () => {
    const before = (await orgUpdates()).length;
    const [cur] = await svc<{ locale: string; units: string }>(
      `select locale, units from orgs where id = $1`,
      [orgId],
    );
    const locale = cur!.locale === 'tr-TR' ? 'en-US' : 'tr-TR';
    const res = await asUser(db, ADMIN, (q) =>
      q(`update orgs set locale = $2, units = units where id = $1`, [orgId, locale]),
    );
    expect(res.affectedRows).toBe(1);
    expect((await orgUpdates()).slice(before)).toEqual([
      {
        actor_type: 'user',
        actor_id: ADMIN,
        diff: { locale: { from: cur!.locale, to: locale } },
      },
    ]);
  });

  it('leaves the audit of RPC and service writes to them (no second org.updated)', async () => {
    const before = (await orgUpdates()).length;
    await asUser(db, ADMIN, async (q) => {
      await q(`select update_org($1, 'Audited Group', 'America/Chicago', null, null)`, [orgId]);
      await q(`select set_org_logo($1, null)`, [orgId]);
    });
    await svc(`update orgs set billing_status = 'past_due' where id = $1`, [orgId]);
    const rows = (await orgUpdates()).slice(before);
    // update_org() logs its own row; set_org_logo() logs org.logo_*; the service write nothing.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: ADMIN });
    expect(Object.keys(rows[0]!.diff)).toContain('name');
  });

  it('lets a pm change nothing', async () => {
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: PM },
      `update orgs set name = 'Hijacked' where id = $1`,
      [orgId],
    );
    expect(res).toMatchObject({ ok: true, affectedRows: 0 });
  });

  it('leaves billing and is_demo to the service role', async () => {
    const rows = await svc(
      `update orgs set is_demo = true, billing_status = 'active', country = 'TR', currency = 'TRY'
       where id = $1 returning is_demo, billing_status, country, currency`,
      [orgId],
    );
    expect(rows).toEqual([
      { is_demo: true, billing_status: 'active', country: 'TR', currency: 'TRY' },
    ]);
  });

  it('checks country, locale and units', async () => {
    for (const set of [`country = 'DE'`, `locale = 'fr-FR'`, `units = 'stone'`]) {
      await expect(svc(`update orgs set ${set} where id = $1`, [orgId]), set).rejects.toMatchObject(
        { code: '23514' },
      );
    }
  });

  it('gives a new org and reporter the §6.3 defaults', async () => {
    const [org] = await svc(
      `insert into orgs (name) values ('Defaults Co')
       returning country, locale, units, currency, tax_no, is_demo`,
    );
    expect(org).toEqual({
      country: 'US',
      locale: 'en-US',
      units: 'imperial',
      currency: 'USD',
      tax_no: null,
      is_demo: false,
    });
    const [reporter] = await svc(
      `insert into reporters (org_id, name, phone_e164) values ($1, 'New', '+15550101010')
       returning locale, contact_pref, activated_at, opted_out_at`,
      [orgId],
    );
    expect(reporter).toEqual({
      locale: 'en-US',
      contact_pref: 'link',
      activated_at: null,
      opted_out_at: null,
    });
  });
});

describe('reporters lockdown', () => {
  it('grants UPDATE on status and invited_at only, and no INSERT or DELETE', async () => {
    const cols = await svc<{ col: string }>(`
      select a.attname as col from pg_attribute a
      where a.attrelid = 'public.reporters'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('authenticated', 'public.reporters', a.attname, 'UPDATE')
      order by 1`);
    expect(cols.map((c) => c.col)).toEqual(['invited_at', 'status']);
    const [table] = await svc(
      `select has_table_privilege('authenticated', 'public.reporters', 'INSERT') as ins,
              has_table_privilege('authenticated', 'public.reporters', 'UPDATE') as upd,
              has_table_privilege('authenticated', 'public.reporters', 'DELETE') as del,
              has_table_privilege('anon', 'public.reporters', 'INSERT,UPDATE,DELETE') as anon`,
    );
    expect(table).toEqual({ ins: false, upd: false, del: false, anon: false });
  });

  it('leaves STOP and START to the service, and keeps the opt-out from the office', async () => {
    const [rep] = await svc<{ id: string }>(
      `insert into reporters (org_id, name, phone_e164, status) values ($1, 'Stop', '+15550104040', 'active')
       returning id`,
      [orgId],
    );
    const id = rep!.id;
    const status = async () =>
      (await svc<{ status: string }>(`select status from reporters where id = $1`, [id]))[0]!
        .status;
    // STOP (sms-webhook, service role).
    await svc(`update reporters set status = 'opted_out', opted_out_at = now() where id = $1`, [
      id,
    ]);
    for (const set of [`status = 'invited'`, `status = 'disabled'`, `opted_out_at = null`]) {
      const res = await admin(`update reporters set ${set} where id = $1`, [id]);
      expect(res.ok ? 'allowed' : res.code, set).toBe('42501');
    }
    expect(await status()).toBe('opted_out');
    // START.
    await svc(`update reporters set status = 'active', opted_out_at = null where id = $1`, [id]);
    // The office disables and re-invites; it never marks a reporter active or opted out.
    for (const s of ['disabled', 'invited']) {
      const res = await asUser(db, ADMIN, (q) =>
        q(`update reporters set status = $2, invited_at = now() where id = $1`, [id, s]),
      );
      expect(res.affectedRows, s).toBe(1);
    }
    for (const s of ['active', 'opted_out']) {
      const res = await admin(`update reporters set status = $2 where id = $1`, [id, s]);
      expect(res.ok ? 'allowed' : res.code, s).toBe('42501');
    }
    expect(await status()).toBe('invited');
  });

  it('keeps update_reporter() working for the admin', async () => {
    const [site] = await svc<{ id: string }>(
      `insert into sites (org_id, name, project_code, timezone) values ($1, 'Edit', 'EDT-1', 'UTC') returning id`,
      [orgId],
    );
    const [rep] = await svc<{ id: string }>(
      `insert into reporters (org_id, name, phone_e164) values ($1, 'Ed', '+15550105050') returning id`,
      [orgId],
    );
    await asUser(db, ADMIN, (q) =>
      q(`select update_reporter($1, 'Edward', 'backup', array[$2]::uuid[], '{en,es}')`, [
        rep!.id,
        site!.id,
      ]),
    );
    expect(
      (await svc(`select name, role, languages from reporters where id = $1`, [rep!.id]))[0],
    ).toEqual({ name: 'Edward', role: 'backup', languages: ['en', 'es'] });
  });
});

describe('on a database deployed before the migration', () => {
  const OTHER_ORG = 'abababab-0000-4000-8000-000000000001';
  const ids = {
    reporter: 'abababab-0000-4000-8000-000000000002',
    site: 'abababab-0000-4000-8000-000000000003',
    conversation: 'abababab-0000-4000-8000-000000000004',
    message: 'abababab-0000-4000-8000-000000000005',
    siteDay: 'abababab-0000-4000-8000-000000000006',
    report: 'abababab-0000-4000-8000-000000000007',
  };
  let old: PGlite;

  beforeAll(async () => {
    old = await bootDatabase({ until: FILE });
    await old.exec(`
      insert into orgs (id, name) values ('${DEMO_ORG_ID}', 'Kestrel Build Group'), ('${OTHER_ORG}', 'Customer GC');
      insert into reporters (id, org_id, name, phone_e164, status) values
        ('${ids.reporter}', '${OTHER_ORG}', 'Pat', '+15550102020', 'verified');
      insert into sites (id, org_id, name, project_code, timezone) values
        ('${ids.site}', '${OTHER_ORG}', 'Main St', 'MS-1', 'America/Chicago');
      insert into conversations (id, org_id, reporter_id, phone_e164) values
        ('${ids.conversation}', '${OTHER_ORG}', '${ids.reporter}', '+15550102020');
      insert into messages (id, conversation_id, direction, type, storage_path) values
        ('${ids.message}', '${ids.conversation}', 'in', 'audio', 'x/y/m.ogg');
      insert into transcripts (message_id, text, segments) values ('${ids.message}', 'six from Apex', '[]');
      insert into site_days (id, site_id, date, deadline_at) values ('${ids.siteDay}', '${ids.site}', '2026-10-09', now());
      insert into reports (id, org_id, site_id, site_day_id, report_no) values
        ('${ids.report}', '${OTHER_ORG}', '${ids.site}', '${ids.siteDay}', 'MS-1-0001');
      insert into report_sources (report_id, message_id, kind) values ('${ids.report}', '${ids.message}', 'audio');
    `);
    await applyMigration(old, FILE);
  });

  const q = async <T = Record<string, unknown>>(sql: string) => (await old.query<T>(sql)).rows;

  it('flags the Kestrel demo org only, with an audit row', async () => {
    expect(readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8')).toContain(`'${DEMO_ORG_ID}'`);
    expect(await q(`select id, is_demo from orgs order by name`)).toEqual([
      { id: OTHER_ORG, is_demo: false },
      { id: DEMO_ORG_ID, is_demo: true },
    ]);
    expect(
      await q(
        `select org_id, actor_type, action, entity_id, diff from audit_log where action = 'org.demo_flagged'`,
      ),
    ).toEqual([
      {
        org_id: DEMO_ORG_ID,
        actor_type: 'system',
        action: 'org.demo_flagged',
        entity_id: DEMO_ORG_ID,
        diff: { is_demo: { from: false, to: true } },
      },
    ]);
  });

  it('gives existing rows the defaults and leaves the rest null', async () => {
    expect(
      await q(`select country, locale, units, currency from orgs where id = '${OTHER_ORG}'`),
    ).toEqual([{ country: 'US', locale: 'en-US', units: 'imperial', currency: 'USD' }]);
    expect(await q(`select locale, contact_pref, activated_at from reporters`)).toEqual([
      { locale: 'en-US', contact_pref: 'link', activated_at: null },
    ]);
    expect(await q(`select channel, language, confirmed_via from reports`)).toEqual([
      { channel: null, language: null, confirmed_via: null },
    ]);
    // The source keeps a null created_at instead of the migration's time; new rows get now().
    expect(await q(`select kind, message_id, upload_id, created_at from report_sources`)).toEqual([
      { kind: 'audio', message_id: ids.message, upload_id: null, created_at: null },
    ]);
    const [fresh] = await q<{ created_at: Date | null }>(
      `insert into report_sources (report_id, kind) values ('${ids.report}', 'text') returning created_at`,
    );
    expect(fresh!.created_at).toBeInstanceOf(Date);
  });

  it('keeps the WhatsApp rows as they were', async () => {
    expect(await q(`select conversation_id, type, reporter_id, phone_e164 from messages`)).toEqual([
      { conversation_id: ids.conversation, type: 'audio', reporter_id: null, phone_e164: null },
    ]);
    expect(await q(`select message_id, upload_id, call_id from transcripts`)).toEqual([
      { message_id: ids.message, upload_id: null, call_id: null },
    ]);
  });

  it('flags nothing when there is no Kestrel org', async () => {
    expect(
      (await db.query(`select 1 from audit_log where action = 'org.demo_flagged'`)).rows,
    ).toEqual([]);
  });
});

describe('v1.2 keys and the relaxed WhatsApp-only constraints', () => {
  let siteId: string;
  let reporterId: string;
  let reportId: string;

  beforeAll(async () => {
    const [site] = await svc<{ id: string }>(
      `insert into sites (org_id, name, project_code, timezone) values ($1, 'Keys', 'KEY-1', 'UTC') returning id`,
      [orgId],
    );
    siteId = site!.id;
    const [rep] = await svc<{ id: string }>(
      `insert into reporters (org_id, name, phone_e164) values ($1, 'Marco', '+15550103030') returning id`,
      [orgId],
    );
    reporterId = rep!.id;
    const [day] = await svc<{ id: string }>(
      `insert into site_days (site_id, date, deadline_at) values ($1, '2026-10-09', now()) returning id`,
      [siteId],
    );
    const [report] = await svc<{ id: string }>(
      `insert into reports (org_id, site_id, site_day_id, report_no, channel, language)
       values ($1, $2, $3, 'KEY-1-0001', 'web', 'en') returning id`,
      [orgId, siteId, day!.id],
    );
    reportId = report!.id;
  });

  it('stores an SMS row without a conversation or WhatsApp type (D15)', async () => {
    const [row] = await svc(
      `insert into messages (org_id, reporter_id, phone_e164, direction, provider, provider_message_id, copy_key, body, status)
       values ($1, $2, '+15550103030', 'out', 'twilio', 'SM-expand-1', 'welcome', 'Welcome', 'queued')
       returning conversation_id, type, status`,
      [orgId, reporterId],
    );
    expect(row).toEqual({ conversation_id: null, type: null, status: 'queued' });
    await expect(
      svc(
        `insert into messages (org_id, phone_e164, direction, provider, provider_message_id, body)
         values ($1, '+15550103030', 'out', 'twilio', 'SM-expand-1', 'again')`,
        [orgId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // Undeliverable is a status an SMS row can take (step 8).
    await svc(
      `update messages set status = 'undeliverable' where provider_message_id = 'SM-expand-1'`,
    );
  });

  it('keys transcripts and sources to uploads and calls', async () => {
    const [upload] = await svc<{ id: string }>(
      `insert into uploads (report_id, reporter_id, site_id, kind, storage_path, mime, duration_s)
       values ($1, $2, $3, 'audio', 'k/a.webm', 'audio/webm', 125.4) returning id`,
      [reportId, reporterId, siteId],
    );
    const [call] = await svc<{ id: string }>(
      `insert into calls (org_id, reporter_id, site_id, report_id, direction, transport)
       values ($1, $2, $3, $4, 'inbound', 'web') returning id`,
      [orgId, reporterId, siteId, reportId],
    );
    const [question] = await svc<{ id: string; asked_at: Date | null }>(
      `insert into questions (report_id, channel, field, prompt) values ($1, 'web', 'hours', 'How many?')
       returning id, asked_at`,
      [reportId],
    );
    expect(question!.asked_at).toBeInstanceOf(Date);

    await svc(`insert into transcripts (upload_id, text, segments) values ($1, 'clip', '[]')`, [
      upload!.id,
    ]);
    await svc(`insert into transcripts (call_id, text, segments) values ($1, 'call', '[]')`, [
      call!.id,
    ]);
    await expect(
      svc(`insert into transcripts (upload_id, text, segments) values ($1, 'again', '[]')`, [
        upload!.id,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    // At most one of upload_id / call_id; the exact XOR waits for step 23.
    const [upload2] = await svc<{ id: string }>(
      `insert into uploads (site_id, kind, storage_path, uploaded_by) values ($1, 'photo', 'k/o.jpg', $2) returning id`,
      [siteId, ADMIN],
    );
    const [call2] = await svc<{ id: string }>(
      `insert into calls (org_id, direction) values ($1, 'outbound') returning id`,
      [orgId],
    );
    await expect(
      svc(
        `insert into transcripts (upload_id, call_id, text, segments) values ($1, $2, 'both', '[]')`,
        [upload2!.id, call2!.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const sources = await svc<{ kind: string }>(
      `insert into report_sources (report_id, kind, upload_id, call_id, question_id) values
         ($1, 'voice_note', $2, null, null),
         ($1, 'call', null, $3, null),
         ($1, 'answer', null, null, $4),
         ($1, 'photo', $5, null, null)
       returning kind`,
      [reportId, upload!.id, call!.id, question!.id, upload2!.id],
    );
    expect(sources.map((s) => s.kind)).toEqual(['voice_note', 'call', 'answer', 'photo']);
    await expect(
      svc(`insert into report_sources (report_id, kind) values ($1, 'note')`, [reportId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts every field channel on reports, versions and questions', async () => {
    for (const ch of ['web', 'voice', 'sms', 'office']) {
      await svc(`update reports set channel = $2, confirmed_via = $2 where id = $1`, [
        reportId,
        ch,
      ]);
    }
    await svc(
      `insert into report_versions (report_id, version, data, author, via) values ($1, 1, '{}', 'agent', 'voice')`,
      [reportId],
    );
  });
});

describe('grants of the new tables', () => {
  const ALL = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER';

  it('gives the field-side tables RLS, no policy and no API-role privilege', async () => {
    const rows = await svc<{
      t: string;
      rls: boolean;
      policies: number;
      auth: boolean;
      anon: boolean;
    }>(
      `select c.relname as t, c.relrowsecurity as rls,
              (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::int as policies,
              has_table_privilege('authenticated', c.oid, '${ALL}') as auth,
              has_table_privilege('anon', c.oid, '${ALL}') as anon
       from pg_class c
       where c.oid in ('public.field_links'::regclass, 'public.field_devices'::regclass, 'public.rate_limits'::regclass)
       order by 1`,
    );
    expect(rows).toEqual(
      ['field_devices', 'field_links', 'rate_limits'].map((t) => ({
        t,
        rls: true,
        policies: 0,
        auth: false,
        anon: false,
      })),
    );
  });

  it('lets signed-in users only select the office-readable ones', async () => {
    const rows = await svc<{
      t: string;
      rls: boolean;
      sel: boolean;
      write: boolean;
      anon: boolean;
    }>(
      `select c.relname as t, c.relrowsecurity as rls,
              has_table_privilege('authenticated', c.oid, 'SELECT') as sel,
              has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as write,
              has_table_privilege('anon', c.oid, '${ALL}') as anon
       from pg_class c
       where c.oid in ('public.uploads'::regclass, 'public.calls'::regclass, 'public.consents'::regclass)
       order by 1`,
    );
    expect(rows).toEqual(
      ['calls', 'consents', 'uploads'].map((t) => ({
        t,
        rls: true,
        sel: true,
        write: false,
        anon: false,
      })),
    );
  });
});

describe('platform wiring', () => {
  it('publishes messages to realtime with the earlier tables', async () => {
    const rt = await bootDatabase({ realtime: true });
    const rows = await rt.query<{ t: string }>(
      `select tablename as t from pg_publication_tables where pubname = 'supabase_realtime' order by 1`,
    );
    expect(rows.rows.map((r) => r.t)).toEqual([
      'evidence_packs',
      'messages',
      'notifications',
      'reports',
      'site_days',
      'unknown_contacts',
    ]);
  });

  it('creates the private calls bucket', async () => {
    const st = await bootDatabase({ storage: true });
    const rows = await st.query(`select id, public from storage.buckets where id = 'calls'`);
    expect(rows.rows).toEqual([{ id: 'calls', public: false }]);
  });
});
