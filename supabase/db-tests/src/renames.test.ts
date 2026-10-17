import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { CONTACT_STATUSES, REPORTER_STATUSES, VERSION_AUTHORS } from '@sitelog/shared/enums.ts';
import { applyMigration, asService, bootDatabase, probeAs, type Caller } from './harness.ts';

/**
 * 20261014000003_renames_billing.sql (W1-05 step 11; GAP §7, D19, Appendix 9.1 and 9.3) on a
 * database as deployed before it, with rows in every renamed place: the labels and the table carry
 * their rows, every dependent object (policies, grants, realtime, constraints, indexes, functions)
 * follows the new names, and the billing columns are filled and kept equal to the legacy stripe_*
 * columns whichever generation of writer writes them.
 */

const FILE = '20261014000003_renames_billing.sql';
const ORG_A = 'c1c1c1c1-0000-4000-8000-000000000001';
const ORG_B = 'c1c1c1c1-0000-4000-8000-000000000002';
const ADMIN = 'c1c1c1c1-0000-4000-8000-000000000011';
const OPS = 'c1c1c1c1-0000-4000-8000-000000000012';
const PM = 'c1c1c1c1-0000-4000-8000-000000000013';
const OPS_B = 'c1c1c1c1-0000-4000-8000-000000000014';
const SITE = 'c1c1c1c1-0000-4000-8000-000000000021';
const REPORTER = 'c1c1c1c1-0000-4000-8000-000000000031';
const INVITED = 'c1c1c1c1-0000-4000-8000-000000000032';
const CONVO = 'c1c1c1c1-0000-4000-8000-000000000041';
const MESSAGE = 'c1c1c1c1-0000-4000-8000-000000000042';
const CONTACT = 'c1c1c1c1-0000-4000-8000-000000000051';
const CONTACT_B = 'c1c1c1c1-0000-4000-8000-000000000052';
const SITE_DAY = 'c1c1c1c1-0000-4000-8000-000000000061';
const REPORT = 'c1c1c1c1-0000-4000-8000-000000000071';

/** Names and labels the migration retires, as they would appear in SQL text or object names. */
const OLD_NAMES = /unknown_senders|first_message_id|sender_status|reporter_reply|'verified'/;

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

const user = (userId: string): Caller => ({ role: 'authenticated', userId });

beforeAll(async () => {
  db = await bootDatabase({ realtime: true, until: FILE });
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'admin@renames.test'), ('${OPS}', 'ops@renames.test'),
      ('${PM}', 'pm@renames.test'), ('${OPS_B}', 'ops-b@renames.test');
    insert into orgs (id, name, stripe_customer_id, stripe_subscription_id, billing_status) values
      ('${ORG_A}', 'Org A', 'cus_A', 'sub_A', 'active');
    insert into orgs (id, name) values ('${ORG_B}', 'Org B');
    insert into org_members (org_id, user_id, role) values
      ('${ORG_A}', '${ADMIN}', 'admin'), ('${ORG_A}', '${OPS}', 'ops'), ('${ORG_A}', '${PM}', 'pm'),
      ('${ORG_B}', '${OPS_B}', 'ops');
    insert into sites (id, org_id, name, project_code, timezone) values
      ('${SITE}', '${ORG_A}', 'Elm St.', 'ES-1', 'America/Chicago');
    insert into reporters (id, org_id, name, phone_e164, status, invited_at, verified_at) values
      ('${REPORTER}', '${ORG_A}', 'Priya', '+15550101010', 'verified', now(), now()),
      ('${INVITED}', '${ORG_A}', 'Jorge', '+15550101011', 'invited', now(), null);
    insert into conversations (id, org_id, phone_e164) values ('${CONVO}', null, '+15550194410');
    insert into messages (id, conversation_id, direction, type, body) values
      ('${MESSAGE}', '${CONVO}', 'in', 'text', 'this is Luis, covering Elm St.');
    insert into unknown_senders (id, org_id, phone_e164, first_message_id, snippet, guessed_site_id) values
      ('${CONTACT}', '${ORG_A}', '+15550194410', '${MESSAGE}', 'this is Luis', '${SITE}');
    insert into unknown_senders (id, org_id, phone_e164, status) values
      ('${CONTACT_B}', '${ORG_B}', '+15550194411', 'ignored');
    insert into site_days (id, site_id, date, status, deadline_at) values
      ('${SITE_DAY}', '${SITE}', '2026-10-09', 'filed', '2026-10-09T22:30:00Z');
    insert into reports (id, org_id, site_id, site_day_id, report_no, status, reporter_id, filed_at, language) values
      ('${REPORT}', '${ORG_A}', '${SITE}', '${SITE_DAY}', 'ES-1-0001', 'filed', '${REPORTER}', now(), 'en');
    insert into report_versions (report_id, version, data, author, change_note) values
      ('${REPORT}', 1, '{}', 'agent', null),
      ('${REPORT}', 2, '{}', 'reporter_reply', 'Apex 6 → 7');
    insert into notifications (org_id, kind, title) values ('${ORG_A}', 'unknown_sender', 'Unknown number');
  `);
  await applyMigration(db, FILE);
});

afterAll(async () => {
  await db.close();
});

describe('enum labels (§6.2)', () => {
  it('renames the labels in place, in the spec order, and carries every row', async () => {
    const labels = await svc<{ t: string; l: string[] }>(
      `select t.typname as t, array_agg(e.enumlabel order by e.enumsortorder) as l
       from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname in ('reporter_status', 'version_author', 'contact_status', 'sender_status')
       group by 1 order by 1`,
    );
    expect(labels).toEqual([
      { t: 'contact_status', l: [...CONTACT_STATUSES] },
      { t: 'reporter_status', l: [...REPORTER_STATUSES] },
      { t: 'version_author', l: [...VERSION_AUTHORS] },
    ]);
    expect(
      await svc(`select id, status::text from reporters where org_id = $1 order by name`, [ORG_A]),
    ).toEqual([
      { id: INVITED, status: 'invited' },
      { id: REPORTER, status: 'active' },
    ]);
    expect(
      await svc(
        `select version, author::text from report_versions where report_id = $1 order by 1`,
        [REPORT],
      ),
    ).toEqual([
      { version: 1, author: 'agent' },
      { version: 2, author: 'reporter' },
    ]);
  });

  it('accepts only the new labels from now on', async () => {
    const insert = (status: string) =>
      probeAs(db, { role: 'authenticated', userId: ADMIN }, `select $1::reporter_status as s`, [
        status,
      ]);
    expect(await insert('active')).toMatchObject({ ok: true });
    expect(await insert('verified')).toMatchObject({ ok: false, code: '22P02' });
    const author = await probeAs(db, user(ADMIN), `select 'reporter_reply'::version_author`);
    expect(author).toMatchObject({ ok: false, code: '22P02' });
  });

  it("keeps the reporter status guard: 'active' is SiteLog's to set, not the office's", async () => {
    const res = await probeAs(
      db,
      user(OPS),
      `update reporters set status = 'active' where id = $1`,
      [INVITED],
    );
    expect(res.ok ? 'allowed' : res.code).toBe('42501');
    const [row] = await svc<{ status: string }>(
      `update reporters set status = 'active', activated_at = now() where id = $1 returning status::text`,
      [INVITED],
    );
    expect(row!.status).toBe('active');
    await svc(`update reporters set status = 'invited', activated_at = null where id = $1`, [
      INVITED,
    ]);
  });
});

describe('unknown_senders → unknown_contacts (§6.3)', () => {
  it('keeps the rows, renames first_message_id and adds channel and call_id as null', async () => {
    expect(
      await svc(
        `select id, org_id, phone_e164, message_id, snippet, guessed_site_id, status::text,
                channel::text, call_id
         from unknown_contacts order by phone_e164`,
      ),
    ).toEqual([
      {
        id: CONTACT,
        org_id: ORG_A,
        phone_e164: '+15550194410',
        message_id: MESSAGE,
        snippet: 'this is Luis',
        guessed_site_id: SITE,
        status: 'pending',
        channel: null,
        call_id: null,
      },
      {
        id: CONTACT_B,
        org_id: ORG_B,
        phone_e164: '+15550194411',
        message_id: null,
        snippet: null,
        guessed_site_id: null,
        status: 'ignored',
        channel: null,
        call_id: null,
      },
    ]);
    const [types] = await svc<{ status: string; channel: string }>(
      `select format_type(a.atttypid, a.atttypmod) as status,
              (select format_type(atttypid, atttypmod) from pg_attribute
               where attrelid = 'unknown_contacts'::regclass and attname = 'channel') as channel
       from pg_attribute a where a.attrelid = 'unknown_contacts'::regclass and a.attname = 'status'`,
    );
    expect(types).toEqual({ status: 'contact_status', channel: 'field_channel' });
  });

  it('names its constraints, indexes and policies after the new table', async () => {
    const names = await svc<{ kind: string; name: string; def: string }>(`
      select 'constraint' as kind, conname as name, pg_get_constraintdef(oid) as def
      from pg_constraint where conrelid = 'unknown_contacts'::regclass and contype <> 'n'
      union all
      select 'index', c.relname, pg_get_indexdef(i.indexrelid)
      from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = 'unknown_contacts'::regclass
      union all
      select 'policy', policyname, cmd from pg_policies where tablename = 'unknown_contacts'
      order by 1, 2`);
    expect(names.map((n) => `${n.kind} ${n.name}`)).toEqual([
      'constraint unknown_contacts_call_id_fkey',
      'constraint unknown_contacts_guessed_site_id_fkey',
      'constraint unknown_contacts_message_id_fkey',
      'constraint unknown_contacts_org_id_fkey',
      'constraint unknown_contacts_pkey',
      'index unknown_contacts_org_id_status_idx',
      'index unknown_contacts_pkey',
      'policy unknown_contacts_select',
      'policy unknown_contacts_update',
    ]);
    expect(names.find((n) => n.name === 'unknown_contacts_call_id_fkey')!.def).toBe(
      'FOREIGN KEY (call_id) REFERENCES calls(id)',
    );
    expect(names.find((n) => n.name === 'unknown_contacts_message_id_fkey')!.def).toBe(
      'FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL',
    );
  });

  it('stays in the realtime publication, with the new columns', async () => {
    const [pub] = await svc<{ cols: string[] }>(
      `select attnames as cols from pg_publication_tables
       where pubname = 'supabase_realtime' and tablename = 'unknown_contacts'`,
    );
    expect(pub!.cols).toEqual(expect.arrayContaining(['message_id', 'channel', 'call_id']));
    const old = await svc(
      `select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'unknown_senders'`,
    );
    expect(old).toEqual([]);
  });

  it('applies the policies: admin and ops of the org read it, pm and other orgs do not', async () => {
    const seen = async (userId: string) => {
      const res = await probeAs(db, user(userId), `select id from unknown_contacts order by id`);
      return res.ok ? res.rows.map((r) => r.id) : res.code;
    };
    expect(await seen(ADMIN)).toEqual([CONTACT]);
    expect(await seen(OPS)).toEqual([CONTACT]);
    expect(await seen(PM)).toEqual([]);
    expect(await seen(OPS_B)).toEqual([CONTACT_B]);
  });

  it('lets the office set only the status (ignore); the rest is the service’s', async () => {
    const write = (set: string) =>
      probeAs(db, user(OPS), `update unknown_contacts set ${set} where id = $1`, [CONTACT]);
    expect(await write(`status = 'ignored'`)).toMatchObject({ ok: true, affectedRows: 1 });
    for (const set of [
      `phone_e164 = '+15550000000'`,
      `org_id = '${ORG_B}'`,
      `snippet = 'x'`,
      `message_id = null`,
      `channel = 'sms'`,
      `guessed_site_id = null`,
    ]) {
      const res = await write(set);
      expect(res.ok ? 'allowed' : res.code, set).toBe('42501');
    }
    const other = await probeAs(
      db,
      user(OPS),
      `update unknown_contacts set status = 'ignored' where id = $1`,
      [CONTACT_B],
    );
    expect(other).toMatchObject({ ok: true, affectedRows: 0 });
    const insert = await probeAs(
      db,
      user(OPS),
      `insert into unknown_contacts (org_id, phone_e164, channel) values ($1, '+15550000001', 'sms')`,
      [ORG_A],
    );
    expect(insert.ok ? 'allowed' : insert.code).toBe('42501');
  });

  it('takes a text or a call from the service, keyed to its message or call', async () => {
    const [call] = await svc<{ id: string }>(
      `insert into calls (org_id, direction, from_e164) values ($1, 'inbound', '+15550194412') returning id`,
      [ORG_A],
    );
    const rows = await svc<{ channel: string; call_id: string | null }>(
      `insert into unknown_contacts (org_id, phone_e164, channel, call_id) values
         ($1, '+15550194412', 'voice', $2), ($1, '+15550194413', 'sms', null)
       returning channel::text, call_id`,
      [ORG_A, call!.id],
    );
    expect(rows).toEqual([
      { channel: 'voice', call_id: call!.id },
      { channel: 'sms', call_id: null },
    ]);
    await svc(`delete from unknown_contacts where phone_e164 in ('+15550194412', '+15550194413')`);
    await svc(`delete from calls where id = $1`, [call!.id]);
  });
});

describe('dependent objects', () => {
  it('leaves no function, view, policy, trigger or object name on the old names', async () => {
    const found = await svc<{ what: string }>(
      `
      select 'function ' || p.oid::regprocedure::text as what
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosrc ~ $1
      union all
      select 'view ' || viewname from pg_views where schemaname = 'public' and definition ~ $1
      union all
      select 'policy ' || tablename || '.' || policyname from pg_policies
      where policyname ~ $1 or coalesce(qual, '') ~ $1 or coalesce(with_check, '') ~ $1
      union all
      select 'trigger ' || tgname from pg_trigger where not tgisinternal and tgname ~ $1
      union all
      select 'relation ' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname ~ $1
      union all
      select 'constraint ' || conname from pg_constraint where conname ~ $1
      union all
      select 'type ' || typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and typname ~ $1
      union all
      select 'column ' || attrelid::regclass::text || '.' || attname from pg_attribute
      where attname ~ $1 and attnum > 0 and not attisdropped`,
      [OLD_NAMES.source],
    );
    expect(found).toEqual([]);
  });

  it('every function in public still compiles against the renamed schema', async () => {
    const fns = await svc<{ fn: string; def: string }>(`
      select p.oid::regprocedure::text as fn, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
        and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`);
    expect(fns.length).toBeGreaterThan(40);
    const failed: string[] = [];
    for (const { fn, def } of fns) {
      await db.exec('begin');
      try {
        await db.exec(def);
      } catch (err) {
        failed.push(`${fn}: ${(err as Error).message}`);
      } finally {
        await db.exec('rollback');
      }
    }
    expect(failed).toEqual([]);
  });

  it('routes the legacy and the new unknown-contact notification kind to admin and ops', async () => {
    expect(
      await svc(
        `select notification_audience('unknown_contact')::text as new,
                notification_audience('unknown_sender')::text as legacy`,
      ),
    ).toEqual([{ new: '{admin,ops}', legacy: '{admin,ops}' }]);
    const seen = async (userId: string) => {
      const res = await probeAs(db, user(userId), `select kind from notifications`);
      return res.ok ? res.rows.map((r) => r.kind) : res.code;
    };
    expect(await seen(OPS)).toEqual(['unknown_sender']);
    expect(await seen(PM)).toEqual([]);
  });
});

describe('billing columns (expand/contract)', () => {
  const ids = async (id: string) =>
    (
      await svc<Record<string, string | null>>(
        `select billing_provider, billing_customer_id, billing_subscription_id,
                stripe_customer_id, stripe_subscription_id from orgs where id = $1`,
        [id],
      )
    )[0];

  it('backfills billing_* from stripe_*, with the stripe provider', async () => {
    expect(await ids(ORG_A)).toEqual({
      billing_provider: 'stripe',
      billing_customer_id: 'cus_A',
      billing_subscription_id: 'sub_A',
      stripe_customer_id: 'cus_A',
      stripe_subscription_id: 'sub_A',
    });
    expect(await ids(ORG_B)).toEqual({
      billing_provider: 'stripe',
      billing_customer_id: null,
      billing_subscription_id: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
    });
  });

  it('mirrors a new writer (billing_*) into stripe_* and an old writer (stripe_*) into billing_*', async () => {
    // stripe-webhook and api-billing of this commit.
    await svc(
      `update orgs set billing_customer_id = 'cus_B', billing_subscription_id = 'sub_B' where id = $1`,
      [ORG_B],
    );
    expect(await ids(ORG_B)).toMatchObject({
      stripe_customer_id: 'cus_B',
      stripe_subscription_id: 'sub_B',
    });
    // The functions deployed before the cut-over write stripe_* only.
    await svc(`update orgs set stripe_subscription_id = 'sub_B2' where id = $1`, [ORG_B]);
    expect(await ids(ORG_B)).toMatchObject({
      billing_customer_id: 'cus_B',
      billing_subscription_id: 'sub_B2',
      stripe_subscription_id: 'sub_B2',
    });
    await svc(`update orgs set stripe_customer_id = null where id = $1`, [ORG_B]);
    expect(await ids(ORG_B)).toMatchObject({ billing_customer_id: null, stripe_customer_id: null });
    // Both in one statement, different values: billing_* wins.
    await svc(
      `update orgs set billing_customer_id = 'cus_new', stripe_customer_id = 'cus_old' where id = $1`,
      [ORG_B],
    );
    expect(await ids(ORG_B)).toMatchObject({
      billing_customer_id: 'cus_new',
      stripe_customer_id: 'cus_new',
    });
    // Other columns leave them alone.
    await svc(`update orgs set name = 'Org B2', billing_status = 'past_due' where id = $1`, [
      ORG_B,
    ]);
    expect(await ids(ORG_B)).toMatchObject({
      billing_customer_id: 'cus_new',
      billing_subscription_id: 'sub_B2',
      stripe_customer_id: 'cus_new',
      stripe_subscription_id: 'sub_B2',
    });
  });

  it('fills the other generation on insert (create_org, the seed, an old writer)', async () => {
    const [a] = await svc<{ id: string }>(
      `insert into orgs (name, stripe_customer_id) values ('Old writer', 'cus_old') returning id`,
    );
    expect(await ids(a!.id)).toMatchObject({
      billing_customer_id: 'cus_old',
      stripe_customer_id: 'cus_old',
      billing_subscription_id: null,
    });
    const [b] = await svc<{ id: string }>(
      `insert into orgs (name, billing_subscription_id) values ('New writer', 'sub_new') returning id`,
    );
    expect(await ids(b!.id)).toMatchObject({
      billing_subscription_id: 'sub_new',
      stripe_subscription_id: 'sub_new',
      billing_customer_id: null,
    });
    await svc(`delete from orgs where id in ($1, $2)`, [a!.id, b!.id]);
  });

  it('keeps every billing column away from the office: admins write none of them', async () => {
    for (const set of [
      `billing_provider = 'iyzico'`,
      `billing_customer_id = 'cus_x'`,
      `billing_subscription_id = 'sub_x'`,
      `stripe_customer_id = 'cus_x'`,
    ]) {
      const res = await probeAs(db, user(ADMIN), `update orgs set ${set} where id = $1`, [ORG_A]);
      expect(res.ok ? 'allowed' : res.code, set).toBe('42501');
    }
    const read = await probeAs(
      db,
      user(ADMIN),
      `select billing_customer_id, billing_provider from orgs where id = $1`,
      [ORG_A],
    );
    expect(read).toMatchObject({
      ok: true,
      rows: [{ billing_customer_id: 'cus_A', billing_provider: 'stripe' }],
    });
  });

  it('lets the step 23 contract drop stripe_* only after the trigger and its function', async () => {
    // The trigger's UPDATE OF list makes both columns depend on it (docs/PLAN_WEEK1.md step 23).
    await db.exec('begin');
    try {
      await db.exec('savepoint plain_drop');
      await expect(db.exec('alter table orgs drop column stripe_customer_id')).rejects.toThrow(
        /other objects depend on it/,
      );
      await db.exec('rollback to savepoint plain_drop');
      await db.exec(`
        drop trigger orgs_billing_ids on orgs;
        drop function sync_org_billing_ids();
        alter table orgs drop column stripe_customer_id, drop column stripe_subscription_id;
      `);
      const left = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_proc where proname = 'sync_org_billing_ids'`,
      );
      expect(left.rows[0]!.n).toBe(0);
      const kept = await db.query<{ billing_customer_id: string }>(
        `select billing_customer_id from orgs where id = $1`,
        [ORG_A],
      );
      expect(kept.rows).toEqual([{ billing_customer_id: 'cus_A' }]);
    } finally {
      await db.exec('rollback');
    }
    expect(await ids(ORG_A)).toMatchObject({ stripe_customer_id: 'cus_A' });
  });
});
