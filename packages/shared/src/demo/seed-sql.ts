/**
 * The demo seed as SQL (GAP D8): `pnpm seed:demo` writes it to supabase/seed.sql (run by
 * `supabase db reset`), and `pnpm seed:demo -- --apply` runs it against a database (scripts/src/
 * seed-demo.ts). One script for both, so the PGlite and stack tests of the file test the apply.
 *
 * What it does, in one transaction:
 * 1. Refuses to write anything when a demo org's id already belongs to an org that is not a demo
 *    org (`is_demo = false`), and the generator refuses a dataset org that is not one.
 * 2. Adds the demo office users to auth.users (by id). seed.sql (local stacks) gives them the
 *    password "sitelog-demo" and leaves an existing one as it is; an apply (`officePasswordHash`,
 *    from DEMO_OFFICE_PASSWORD) sets its password on the demo users instead, so a hosted project
 *    never has the committed one. The apply's script carries only the bcrypt hash, never the
 *    password: a server logs a failing statement's text (`log_min_error_statement`), and the whole
 *    script when `log_statement` is `ddl` or more (the script disables a trigger).
 * 3. For each demo org (§18.1 Kestrel Build Group, §18.2 Demir Yapı A.Ş.): upserts the org row by
 *    its deterministic id, deletes the org's rows (reports, texts, links, calls, …: everything
 *    that hangs off the org, its sites, reporters and reports, and the jobs that name them:
 *    `PRUNE`), then inserts the generated rows with their deterministic ids, audit rows
 *    included. Seeded members are upserted; other members of a demo org (someone who joined it
 *    later) are kept.
 *
 * So applying it twice gives the same rows, applying it after a demo resets the demo orgs, and
 * rows of other orgs are never deleted or updated: every delete is scoped to a demo org's id
 * (after the check in 1), everything else is an insert, and an insert that collides with another
 * org's row fails the whole transaction instead of overwriting it.
 */
import { buildDemirDemo } from './demir.ts';
import { buildKestrelDemo, kestrelDemo } from './kestrel.ts';
import { ident, insertRows, lit } from './sql.ts';
import type { DemoDataset, DemoOrgRows, DemoUser } from './types.ts';

/** The demo office users' password in seed.sql (local stacks only; an apply needs its own). */
export const LOCAL_DEMO_PASSWORD = 'sitelog-demo';

export interface DemoSeedOptions {
  /** `YYYY-MM-DD`: the live demo for that date (D36); omitted: §18.1's Fri Oct 9. */
  date?: string;
  /** With `date`: the real time it is built at (see KestrelOptions.clock). */
  clock?: string;
  /** FIELD_APP_URL for the links in the seeded texts. */
  linkBase?: string;
  /**
   * For an apply: the bcrypt hash of the demo office users' password (DEMO_OFFICE_PASSWORD), set on
   * the demo users even when they exist. The database computes it from the password as a bind
   * parameter (`OFFICE_PASSWORD_HASH_SQL`, scripts/src/seed-demo.ts), so the password itself is
   * never in the script's text. Omitted (seed.sql): "sitelog-demo", existing users left alone.
   */
  officePasswordHash?: string;
  /**
   * Built-in glossary terms (org_id null, shared by every org): seed.sql writes them; an apply
   * leaves them out, since it writes nothing outside the demo orgs.
   */
  globalRows?: boolean;
}

/** The demo orgs, Kestrel first. */
export function demoOrgs(
  opts: Pick<DemoSeedOptions, 'date' | 'clock' | 'linkBase'> = {},
): [DemoDataset, DemoOrgRows] {
  const kestrel =
    opts.date === undefined && opts.linkBase === undefined
      ? kestrelDemo()
      : buildKestrelDemo({ date: opts.date, clock: opts.clock, linkBase: opts.linkBase });
  return [kestrel, buildDemirDemo({ date: opts.date, linkBase: opts.linkBase })];
}

/**
 * The bcrypt hash of a password, computed by the database (pgcrypto, as GoTrue stores it) with the
 * password as bind parameter $1: an apply runs it before the script and passes the hash on.
 */
export const OFFICE_PASSWORD_HASH_SQL = "select crypt($1, gen_salt('bf')) as hash";

/** A bcrypt hash as `crypt(…, gen_salt('bf'))` returns it ($2a$, cost, 22-character salt, hash). */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const banner = (title: string) => `-- ${title} ${'-'.repeat(Math.max(4, 96 - title.length))}`;

function usersSql(users: DemoUser[], officePasswordHash: string | undefined): string {
  if (users.length === 0) return '-- auth.users: no rows\n';
  if (officePasswordHash !== undefined && !BCRYPT_HASH.test(officePasswordHash))
    throw new Error('seed:demo: officePasswordHash must be a bcrypt hash, never the password');
  const password =
    officePasswordHash === undefined
      ? `crypt(${lit(LOCAL_DEMO_PASSWORD)}, gen_salt('bf'))`
      : lit(officePasswordHash);
  // An apply sets its password on the demo users (these ids only) even when they exist.
  const conflict =
    officePasswordHash === undefined
      ? 'on conflict (id) do nothing'
      : 'on conflict (id) do update set encrypted_password = excluded.encrypted_password';
  return `insert into auth.users (id, instance_id, email, aud, role, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change, email_change_token_new)
values
${users
  .map(
    (u) =>
      `  (${lit(u.id)}, '00000000-0000-0000-0000-000000000000', ${lit(u.email)}, 'authenticated', 'authenticated', ${password}, now(), '{"provider":"email","providers":["email"]}'::jsonb, ${lit({ name: u.name })}, now(), now(), '', '', '', '')`,
  )
  .join(',\n')}
${conflict};

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'auth' and tablename = 'identities') then
${users
  .map(
    (u) =>
      `    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), ${lit(u.id)}, ${lit(u.id)}, ${lit({ sub: u.id, email: u.email })}, 'email', now(), now(), now()) on conflict do nothing;`,
  )
  .join('\n')}
  end if;
end $$;
`;
}

/** The org row: inserted, or brought back to the generated values (a demo org only). */
function orgSql(d: DemoOrgRows): string {
  const cols = Object.keys(d.org).filter((c) => c !== 'id');
  return `${insertRows('orgs', [d.org]).replace(
    /;\n$/,
    `\non conflict (id) do update set\n  ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(',\n  ')}\nwhere orgs.is_demo;\n`,
  )}`;
}

/** The rows of one demo org, as SQL subqueries the prune is scoped by. */
export interface PruneScope {
  /** The org id literal. */
  o: string;
  /** Its sites, reporters, reports, calls, conversations, messages and uploads (ids). */
  S: string;
  R: string;
  P: string;
  C: string;
  V: string;
  M: string;
  U: string;
}

function pruneScope(orgId: string): PruneScope {
  const o = lit(orgId);
  const S = `(select id from sites where org_id = ${o})`;
  const R = `(select id from reporters where org_id = ${o})`;
  const P = `(select id from reports where org_id = ${o})`;
  const C = `(select id from calls where org_id = ${o} or reporter_id in ${R} or site_id in ${S})`;
  const V = `(select id from conversations where org_id = ${o} or reporter_id in ${R})`;
  const M = `(select id from messages where org_id = ${o} or reporter_id in ${R} or conversation_id in ${V})`;
  const U = `(select id from uploads where site_id in ${S} or reporter_id in ${R})`;
  return { o, S, R, P, C, V, M, U };
}

/** A job whose payload names one of the org's rows (schemas/jobs.ts keys), whatever its status. */
function jobsWhere(k: PruneScope): string {
  const ids = (key: string, sub: string) =>
    `payload->>'${key}' in (select x.id::text from ${sub} x)`;
  return `(${[
    `payload->>'orgId' = ${k.o}::text`,
    ids('siteId', k.S),
    ids('reporterId', k.R),
    ids('reportId', k.P),
    ids('callId', k.C),
    ids('conversationId', k.V),
    ids('messageId', k.M),
    ids('uploadId', k.U),
    ids('siteDayId', `(select id from site_days where site_id in ${k.S})`),
    ids('packId', `(select id from evidence_packs where org_id = ${k.o} or site_id in ${k.S})`),
    ids('invoiceId', `(select id from sub_invoices where org_id = ${k.o})`),
    ids('unknownContactId', `(select id from unknown_contacts where org_id = ${k.o})`),
  ].join(' or ')})`;
}

/**
 * What the prune deletes for a demo org, table → where clause, in order (children first): every
 * row of the org except the org itself and its members, scoped by the org id, its sites,
 * reporters and reports. Jobs first, finished ones too: a job still queued or running from an
 * earlier rehearsal would run against rows the reset replaced, and since W1-10 (GAP D16) a dedupe
 * key is never used twice, so a finished job of the last rehearsal would keep the next one's
 * PDF, filing or welcome from being enqueued (the reset brings back the same ids and versions).
 * seed-apply.test.ts checks
 * the tables against the catalog and the SQL `pruneSql()` writes from this list.
 */
export const PRUNE: ReadonlyArray<readonly [table: string, where: (k: PruneScope) => string]> = [
  ['jobs', jobsWhere],
  ['report_costs', (k) => `org_id = ${k.o} or report_id in ${k.P}`],
  ['questions', (k) => `report_id in ${k.P}`],
  ['report_sources', (k) => `report_id in ${k.P}`],
  ['manpower_entries', (k) => `report_id in ${k.P}`],
  ['work_items', (k) => `report_id in ${k.P}`],
  ['weather_events', (k) => `report_id in ${k.P} or site_id in ${k.S}`],
  ['report_versions', (k) => `report_id in ${k.P}`],
  ['evidence_packs', (k) => `org_id = ${k.o} or site_id in ${k.S}`],
  ['unknown_contacts', (k) => `org_id = ${k.o} or call_id in ${k.C} or message_id in ${k.M}`],
  ['transcripts', (k) => `upload_id in ${k.U} or call_id in ${k.C} or message_id in ${k.M}`],
  ['uploads', (k) => `site_id in ${k.S} or reporter_id in ${k.R} or report_id in ${k.P}`],
  [
    'calls',
    (k) => `org_id = ${k.o} or reporter_id in ${k.R} or site_id in ${k.S} or report_id in ${k.P}`,
  ],
  ['reports', (k) => `org_id = ${k.o} or site_id in ${k.S}`],
  ['messages', (k) => `org_id = ${k.o} or reporter_id in ${k.R} or conversation_id in ${k.V}`],
  ['conversations', (k) => `org_id = ${k.o} or reporter_id in ${k.R}`],
  ['site_days', (k) => `site_id in ${k.S}`],
  ['notifications', (k) => `org_id = ${k.o}`],
  ['console_emails', (k) => `org_id = ${k.o}`],
  ['sub_invoices', (k) => `org_id = ${k.o}`],
  [
    'glossary_terms',
    (k) => `org_id = ${k.o} or scope_site_id in ${k.S} or scope_reporter_id in ${k.R}`,
  ],
  ['consents', (k) => `reporter_id in ${k.R}`],
  ['field_links', (k) => `reporter_id in ${k.R}`],
  ['field_devices', (k) => `reporter_id in ${k.R}`],
  ['site_reporters', (k) => `site_id in ${k.S} or reporter_id in ${k.R}`],
  ['site_recipients', (k) => `site_id in ${k.S}`],
  ['reporters', (k) => `org_id = ${k.o}`],
  ['sites', (k) => `org_id = ${k.o}`],
  ['companies', (k) => `org_id = ${k.o}`],
  ['org_settings', (k) => `org_id = ${k.o}`],
  ['audit_log', (k) => `org_id = ${k.o}`],
];

/** The tables the prune empties for a demo org (src/seed-apply.test.ts checks it against the catalog). */
export const PRUNED_TABLES: readonly string[] = PRUNE.map(([table]) => table);

/** The prune of one demo org: one `delete … where …;` line per `PRUNE` entry. */
export function pruneSql(orgId: string): string {
  const k = pruneScope(orgId);
  return PRUNE.map(([table, where]) => `delete from ${ident(table)} where ${where(k)};\n`).join('');
}

function orgRowsSql(d: DemoOrgRows, globalRows: boolean): string {
  const parts: string[] = [];
  const members = insertRows('org_members', d.members, {
    onConflict: `on conflict (org_id, user_id) do update set role = excluded.role, display_name = excluded.display_name, title = excluded.title, created_at = excluded.created_at, ui_locale = excluded.ui_locale
where (org_members.role, org_members.display_name, org_members.title, org_members.created_at, org_members.ui_locale)
  is distinct from (excluded.role, excluded.display_name, excluded.title, excluded.created_at, excluded.ui_locale)`,
  });
  parts.push(members);
  parts.push(insertRows('org_settings', [d.settings]));
  parts.push(insertRows('sites', d.sites));
  parts.push(insertRows('reporters', d.reporters));
  parts.push(insertRows('site_reporters', d.siteReporters));
  parts.push(insertRows('site_recipients', d.recipients));
  parts.push(insertRows('companies', d.companies));
  parts.push(
    insertRows(
      'glossary_terms',
      d.glossary.filter((g) => g.org_id !== null),
    ),
  );
  const global = d.glossary.filter((g) => g.org_id === null);
  if (globalRows && global.length)
    parts.push(insertRows('glossary_terms', global, { onConflict: 'on conflict (id) do nothing' }));
  parts.push(insertRows('consents', d.consents));
  parts.push(insertRows('field_links', d.fieldLinks));
  parts.push(insertRows('conversations', d.conversations));
  parts.push(insertRows('messages', d.messages));
  parts.push(
    insertRows(
      'site_days',
      d.siteDays.map((s) => ({ ...s, report_id: null })),
    ),
  );
  parts.push(insertRows('reports', d.reports));
  const linked = d.siteDays.filter((s) => s.report_id);
  if (linked.length) {
    // The site-day ↔ report link closes the loop of two foreign keys. The seed writes the row's
    // updated_at itself, so the trigger that stamps now() is off for this one update (inside the
    // transaction: no other session sees it off).
    parts.push(`alter table site_days disable trigger site_days_updated_at;
update site_days sd set report_id = v.report_id::uuid
from (values
${linked.map((s) => `  (${lit(s.id)}, ${lit(s.report_id)})`).join(',\n')}
) as v(id, report_id)
where sd.id = v.id::uuid;
alter table site_days enable trigger site_days_updated_at;
`);
  }
  parts.push(insertRows('uploads', d.uploads, { json: ['peaks'] }));
  parts.push(insertRows('calls', d.calls, { json: ['peaks', 'dialog_log', 'metrics'] }));
  parts.push(insertRows('transcripts', d.transcripts));
  parts.push(insertRows('unknown_contacts', d.unknownContacts));
  parts.push(insertRows('report_versions', d.versions, { chunk: 25 }));
  parts.push(insertRows('report_sources', d.sources));
  parts.push(insertRows('questions', d.questions, { json: ['options'] }));
  parts.push(insertRows('manpower_entries', d.manpower));
  parts.push(insertRows('work_items', d.workItems));
  parts.push(insertRows('weather_events', d.weatherEvents, { omit: ['claim_ready'] }));
  parts.push(insertRows('sub_invoices', d.invoices));
  parts.push(insertRows('evidence_packs', d.packs));
  parts.push(insertRows('notifications', d.notifications));
  parts.push(insertRows('audit_log', d.audit));
  return parts.join('\n');
}

export function buildSeedSql(opts: DemoSeedOptions = {}): string {
  const orgs = demoOrgs(opts);
  for (const d of orgs)
    if (!d.org.is_demo) throw new Error(`seed:demo: ${d.org.name} is not a demo org (is_demo)`);
  const users = orgs.flatMap((d) => d.users);
  const ids = orgs.map((d) => lit(d.org.id)).join(', ');
  const parts: string[] = [];
  parts.push(`-- SiteLog demo seed (§18), the demo orgs: ${orgs.map((d) => d.org.name).join(' · ')}
-- Generated by \`pnpm seed:demo\` (packages/shared/src/demo/seed-sql.ts); do not edit by hand.
-- ${opts.date ? `Live demo for ${opts.date} as of ${orgs[0].now} (D36).` : '§18.1 as written: Fri Oct 9, 2026.'}
-- Idempotent: it replaces the rows of the demo orgs (is_demo) and refuses to touch any other org.
-- Demo office users sign in with magic links (or ${opts.officePasswordHash === undefined ? `password "${LOCAL_DEMO_PASSWORD}"` : 'the password given to the apply'} when password auth is enabled).
begin;

${banner('Refuse a non-demo org with a demo id')}
do $$
declare v_org record;
begin
  select id, name into v_org from orgs where id in (${ids}) and not is_demo limit 1;
  if found then
    raise exception 'seed:demo: org % (%) exists and is not a demo org (is_demo = false); nothing was written', v_org.id, v_org.name
      using errcode = 'P0001';
  end if;
end $$;
`);
  parts.push(banner('Office users'));
  parts.push(usersSql(users, opts.officePasswordHash));
  for (const d of orgs) {
    parts.push(banner(`${d.org.name} (${d.org.id})`));
    parts.push(orgSql(d));
    parts.push(pruneSql(d.org.id));
    parts.push(orgRowsSql(d, opts.globalRows ?? true));
  }
  parts.push('commit;\n');
  return parts.join('\n');
}
