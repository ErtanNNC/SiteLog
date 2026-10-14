import {
  ORG,
  OPERATOR,
  ROLES,
  SHARED,
  SPARE_USER,
  V1_DATA,
  type Bucket,
  type OrgIds,
  type OrgKey,
  type Role,
} from './two-orgs.ts';

/**
 * The §2.2 role matrix as data: for every table in `public`, which office roles may select,
 * insert, update and delete their own organisation's rows; which may read each storage bucket;
 * and which may run the two role-checked report RPCs of §2.2 (edit, sign off). Every other
 * organisation's rows, objects and reports are closed to every role. role-matrix.test.ts
 * measures each cell on PGlite against the two-org fixture (two-orgs.ts); anon.test.ts reuses the
 * statements.
 *
 * Known, deferred defects are listed in KNOWN_DEFECTS with the step that fixes them: the test
 * expects today's (wrong) result for those cells, so a fix fails the test until its entry is
 * removed. W1-05 step 9 (20261014000001_queue_rls_fixes.sql) fixed every one it listed, so the
 * list is empty. Any other cell that differs from the expectation fails the test too, as does a
 * table or view missing from this list (each new one needs its row here).
 */

export const OPS = ['select', 'insert', 'update', 'delete'] as const;
export type Op = (typeof OPS)[number];
/** A cell's verb: a table verb, or `execute` for an RPC. */
export type CellOp = Op | 'execute';

const ALL: readonly Role[] = ['admin', 'pm', 'ops', 'accounts'];
const OFFICE: readonly Role[] = ['admin', 'pm', 'ops'];
const ADMIN: readonly Role[] = ['admin'];
const ADMIN_OPS: readonly Role[] = ['admin', 'ops'];
const NONE: readonly Role[] = [];

export interface TableCase {
  /** Where the expectation comes from (§2.2 row, §13, or why §2.2 is silent). */
  why: string;
  allow: Record<Op, readonly Role[]>;
  /** SQL predicate selecting the fixture rows of org `o`. */
  where: (o: OrgIds) => string;
  /**
   * The rows the update and delete probes touch, when not all of `where` (default `where`): a
   * write that also hit a row a guard protects (the last admin) would test the guard, not §2.2.
   */
  writeWhere?: (o: OrgIds) => string;
  /** An insert of a new, valid row of org `o`. */
  insert: (o: OrgIds) => string;
  /** A no-op assignment for the update probe (`set …`). */
  set: string;
  /**
   * Not org-scoped (service tables, the country packs): the other-org probes repeat the own-org
   * ones and expect the same answer, since there is no other org's row.
   */
  orgless?: true;
}

const readOnly = (select: readonly Role[]): TableCase['allow'] => ({
  select,
  insert: NONE,
  update: NONE,
  delete: NONE,
});
const serviceOnly = readOnly(NONE);

export const TABLES: Record<string, TableCase> = {
  countries: {
    why: 'Country packs (spec §4.6, §6.5; GAP D47): every signed-in user reads them, an org member or not (the setup wizard runs before the user has an org); no client writes them: packs change by migration, sender ids and voice numbers through the service-only set_country_endpoints().',
    allow: readOnly(ALL),
    where: () => `code = 'US'`,
    insert: () =>
      `insert into countries (code, default_locale, field_locales, units, paper, currency, default_timezone, message_channels, sms_sender_type, two_way_sms, sms_links_allowed) values ('ZY', 'en-US', '{en-US}', 'metric', 'a4', 'EUR', 'UTC', '{sms}', 'long_code', true, true)`,
    set: 'code = code',
    orgless: true,
  },
  orgs: {
    why: '§2.2 "Settings … billing: admin"; every member reads its org (§2.2 silent: the shell shows the name). Orgs are created by create_org() (README deviation).',
    allow: { select: ALL, insert: NONE, update: ADMIN, delete: NONE },
    where: (o) => `id = '${o.org}'`,
    insert: () => `insert into orgs (name) values ('Matrix new org')`,
    set: 'name = name',
  },
  org_members: {
    why: '§2.2 "Invite office users: admin"; members read their team (§2.2 silent). Updates and deletes target the ops member; the admin\'s own row is the last-admin case, and the key (org_id, user_id) is not the client\'s (20261014000001, PROBES).',
    allow: { select: ALL, insert: ADMIN, update: ADMIN, delete: ADMIN },
    where: (o) => `org_id = '${o.org}'`,
    writeWhere: (o) => `org_id = '${o.org}' and user_id = '${o.users.ops}'`,
    insert: (o) =>
      `insert into org_members (org_id, user_id, role) values ('${o.org}', '${SPARE_USER}', 'ops')`,
    set: 'role = role',
  },
  org_settings: {
    why: '§2.2 "Settings: admin"; every member reads deadlines and working days (§2.2 silent). The row comes from the orgs trigger, so no client inserts one; admins update the settings columns, never org_id or past_due_grace_days (20261014000001, PROBES).',
    allow: { select: ALL, insert: NONE, update: ADMIN, delete: NONE },
    where: (o) => `org_id = '${o.org}'`,
    // The row exists (orgs trigger): a unique violation would mean an insert got through.
    insert: (o) => `insert into org_settings (org_id) values ('${o.org}')`,
    set: 'default_deadline = default_deadline',
  },
  sites: {
    why: '§2.2 "View overview, sites, reports: admin, pm, ops"; "Add / pause sites: admin". Accounts reads the site names Crew hours needs from the site_options view (GAP D22). Admins update the columns the panel saves, never org_id or report_seq (20261014000001, PROBES).',
    allow: { select: OFFICE, insert: ADMIN, update: ADMIN, delete: NONE },
    where: (o) => `org_id = '${o.org}'`,
    insert: (o) =>
      `insert into sites (org_id, name, project_code, timezone) values ('${o.org}', 'New', 'NEW-1', 'UTC')`,
    set: 'name = name',
  },
  reporters: {
    why: '§2.2 "Manage reporters, phone numbers & channel preferences: admin, ops"; pm reads who reported. Created by api-invite-reporter / api-link-unknown-sender and never deleted by a client (the consent records cascade, §17); admin and ops change status (disable, re-invite) directly and the rest through update_reporter() (20261013000007; column and status probes in PROBES).',
    allow: { select: OFFICE, insert: NONE, update: ADMIN_OPS, delete: NONE },
    where: (o) => `org_id = '${o.org}'`,
    insert: (o) =>
      `insert into reporters (org_id, name, phone_e164) values ('${o.org}', 'New', '+15550009999')`,
    set: 'status = status',
  },
  site_reporters: {
    why: '§2.2 "Manage reporters: admin, ops"; reporter and site of one org (PROBES).',
    allow: { select: OFFICE, insert: ADMIN_OPS, update: ADMIN_OPS, delete: ADMIN_OPS },
    where: (o) => `site_id = '${o.site}'`,
    insert: (o) =>
      `insert into site_reporters (site_id, reporter_id) values ('${o.site}', '${o.reporter2}')`,
    set: 'is_primary = is_primary',
  },
  site_recipients: {
    why: '§2.2 "Settings (… recipients): admin".',
    allow: { select: OFFICE, insert: ADMIN, update: ADMIN, delete: ADMIN },
    where: (o) => `site_id = '${o.site}'`,
    insert: (o) =>
      `insert into site_recipients (site_id, email) values ('${o.site}', 'new@matrix.test')`,
    set: 'email = email',
  },
  companies: {
    why: '§2.2 "View crew hours" and "Record sub invoices" include accounts (hours by company); companies are managed with the glossary (admin, pm, ops).',
    allow: { select: ALL, insert: OFFICE, update: OFFICE, delete: OFFICE },
    where: (o) => `id = '${o.company}'`,
    insert: (o) => `insert into companies (org_id, name) values ('${o.org}', 'New Co')`,
    set: 'name = name',
  },
  conversations: {
    why: 'WhatsApp (legacy, step 22): read-only source panel for admin, pm, ops.',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.conversation}'`,
    insert: (o) =>
      `insert into conversations (org_id, phone_e164) values ('${o.org}', '+15550008888')`,
    set: 'state = state',
  },
  messages: {
    why: 'Report sources (§2.2 "View reports": admin, pm, ops); written by the service only.',
    allow: readOnly(OFFICE),
    where: (o) => `conversation_id = '${o.conversation}'`,
    insert: (o) =>
      `insert into messages (conversation_id, direction, type) values ('${o.conversation}', 'in', 'text')`,
    set: 'body = body',
  },
  transcripts: {
    why: 'Report sources (§2.2 "View reports": admin, pm, ops); written by the service only.',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.transcript}'`,
    insert: (o) =>
      `insert into transcripts (message_id, text, segments) values ('${o.message2}', 't', '[]')`,
    set: 'text = text',
  },
  unknown_contacts: {
    why: '§2.2 "Manage reporters, phone numbers": admin, ops (Unknown contacts on Team); created by the service, and the office only links (api-link-unknown-sender) or ignores it: status is its one client-writable column (20261014000003, PROBES).',
    allow: { select: ADMIN_OPS, insert: NONE, update: ADMIN_OPS, delete: NONE },
    where: (o) => `id = '${o.unknownSender}'`,
    insert: (o) =>
      `insert into unknown_contacts (org_id, phone_e164) values ('${o.org}', '+15550007777')`,
    set: 'status = status',
  },
  site_days: {
    why: '§2.2 "View overview": admin, pm, ops; changed by the service and RPCs (mark_no_work).',
    allow: readOnly(OFFICE),
    where: (o) => `site_id = '${o.site}'`,
    insert: (o) =>
      `insert into site_days (site_id, date, deadline_at) values ('${o.site}', '2026-10-20', now())`,
    set: 'status = status',
  },
  reports: {
    why: '§2.2 "View reports": admin, pm, ops; edits and sign-off only through RPCs (§6.5).',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.report}'`,
    insert: (o) =>
      `insert into reports (org_id, site_id, site_day_id, report_no, language) values ('${o.org}', '${o.site}', '${o.siteDay2}', 'NEW-0001', 'en')`,
    set: 'needs_review = needs_review',
  },
  report_versions: {
    why: '§2.2 "View reports": admin, pm, ops; versions only through create_report_version() (§6.5).',
    allow: readOnly(OFFICE),
    where: (o) => `report_id = '${o.report}'`,
    insert: (o) =>
      `insert into report_versions (report_id, version, data, author) values ('${o.report}', 99, '{}', 'office_user')`,
    set: 'summary = summary',
  },
  report_sources: {
    why: '§2.2 "View reports": admin, pm, ops.',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.reportSource}'`,
    insert: (o) =>
      `insert into report_sources (report_id, message_id, kind) values ('${o.report}', '${o.message2}', 'text')`,
    set: 'kind = kind',
  },
  manpower_entries: {
    why: '§2.2 "View crew hours, export payroll CSV": every role, accounts included.',
    allow: readOnly(ALL),
    where: (o) => `id = '${o.manpower}'`,
    insert: (o) =>
      `insert into manpower_entries (report_id, version, workers, hours) values ('${o.report}', 1, 1, 8)`,
    set: 'workers = workers',
  },
  work_items: {
    why: '§2.2 "View reports": admin, pm, ops.',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.workItem}'`,
    insert: (o) =>
      `insert into work_items (report_id, version, activity) values ('${o.report}', 1, 'x')`,
    set: 'activity = activity',
  },
  weather_events: {
    why: '§2.2 "Weather log, build EOT pack": admin, pm, ops.',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.weather}'`,
    insert: (o) =>
      `insert into weather_events (report_id, version, site_id, date) values ('${o.report}', 1, '${o.site}', '2026-10-09')`,
    set: 'condition = condition',
  },
  questions: {
    why: '§2.2 "View reports": admin, pm, ops.',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.question}'`,
    insert: (o) =>
      `insert into questions (report_id, field, prompt) values ('${o.report}', 'hours', 'q')`,
    set: 'prompt = prompt',
  },
  consents: {
    why: '§2.2 "Manage reporters, phone numbers & channel preferences": admin, ops read the consent records (Team, "Call now" needs consent); field-api and office RPCs write them (§6.5).',
    allow: readOnly(ADMIN_OPS),
    where: (o) => `id = '${o.consent}'`,
    insert: (o) =>
      `insert into consents (reporter_id, type, method, text_version) values ('${o.reporter}', 'auto_call', 'office_attested', 'v1')`,
    set: 'method = method',
  },
  field_links: {
    why: 'Field access (§6.5): link code hashes, read and written by field-api with the service role only; no client policy, no grant.',
    allow: serviceOnly,
    where: (o) => `id = '${o.fieldLink}'`,
    insert: (o) =>
      `insert into field_links (code_hash, reporter_id, kind) values ('matrix-new-link', '${o.reporter}', 'personal')`,
    set: 'revoked_at = revoked_at',
  },
  field_devices: {
    why: 'Field access (§6.5): device cookie hashes, field-api only (revocation for admin, ops comes as an RPC); no client policy, no grant.',
    allow: serviceOnly,
    where: (o) => `id = '${o.fieldDevice}'`,
    insert: (o) =>
      `insert into field_devices (reporter_id, device_token_hash) values ('${o.reporter}', 'matrix-new-device')`,
    set: 'revoked_at = revoked_at',
  },
  uploads: {
    why: 'Report sources: voice notes and photos (§2.2 "View reports": admin, pm, ops); written by field-api and the office-photo RPCs.',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.upload}'`,
    insert: (o) =>
      `insert into uploads (report_id, site_id, kind, storage_path, uploaded_by) values ('${o.report}', '${o.site}', 'photo', '${o.org}/${o.site}/office/new.jpg', auth.uid())`,
    set: 'caption = caption',
  },
  calls: {
    why: 'Report sources: calls and their recordings (§2.2 "View reports": admin, pm, ops); written by the voice agent and worker (week 2).',
    allow: readOnly(OFFICE),
    where: (o) => `id = '${o.call}'`,
    insert: (o) =>
      `insert into calls (org_id, reporter_id, site_id, direction) values ('${o.org}', '${o.reporter}', '${o.site}', 'outbound')`,
    set: 'outcome = outcome',
  },
  rate_limits: {
    why: 'field-api throttling (§6.5): service role only; no client policy, no grant.',
    allow: serviceOnly,
    where: () => `key like 'matrix:%'`,
    insert: () => `insert into rate_limits (key, window_start) values ('matrix:new', now())`,
    set: 'count = count',
    orgless: true,
  },
  glossary_terms: {
    why: '§2.2 "Manage glossary": admin, pm, ops.',
    allow: { select: OFFICE, insert: OFFICE, update: OFFICE, delete: OFFICE },
    where: (o) => `id = '${o.term}'`,
    insert: (o) => `insert into glossary_terms (org_id, heard) values ('${o.org}', 'new term')`,
    set: 'official = official',
  },
  sub_invoices: {
    why: '§2.2 "Record sub invoices / send invoice query": every role.',
    allow: { select: ALL, insert: ALL, update: ALL, delete: ALL },
    where: (o) => `id = '${o.invoice}'`,
    insert: (o) =>
      `insert into sub_invoices (org_id, company_id) values ('${o.org}', '${o.company}')`,
    set: 'invoice_no = invoice_no',
  },
  evidence_packs: {
    why: '§2.2 "Weather log, build EOT pack": admin, pm, ops read the packs; they request one through api-evidence-pack (service role: site check, audit, build job) and the worker fills it, so no client writes a row (docs/AUDIT_BACKLOG.md forged pack; 20261014000001).',
    allow: { select: OFFICE, insert: NONE, update: NONE, delete: NONE },
    where: (o) => `id = '${o.pack}'`,
    insert: (o) =>
      `insert into evidence_packs (org_id, site_id, period_start, period_end, created_by) values ('${o.org}', '${o.site}', '2026-10-01', '2026-10-09', auth.uid())`,
    set: 'status = status',
  },
  jobs: {
    why: 'Queue: service role only (§6.5).',
    allow: serviceOnly,
    where: (o) => `payload ->> 'org' = '${o.org}'`,
    insert: (o) => `insert into jobs (type, payload) values ('render_pdf', '{"org":"${o.org}"}')`,
    set: 'status = status',
  },
  audit_log: {
    why: '§2.2 gives accounts hours and invoices only (GAP D22): admin, pm, ops read the trail (report timeline); rows are written by RPCs and the service.',
    allow: readOnly(OFFICE),
    where: (o) => `org_id = '${o.org}'`,
    insert: (o) => `insert into audit_log (org_id, action) values ('${o.org}', 'forged')`,
    set: 'action = action',
  },
  notifications: {
    why: '§13 "Report missing … ops + admin" (the fixture row is a missing_report; notification_audience(), 20261014000001); marked read through mark_notifications_read().',
    allow: readOnly(ADMIN_OPS),
    where: (o) => `id = '${o.notification}'`,
    insert: (o) =>
      `insert into notifications (org_id, kind, title) values ('${o.org}', 'billing', 'forged')`,
    set: 'read_at = read_at',
  },
  report_costs: {
    why: 'SiteLog-internal cost (README "/ops, cost"): service role and ops RPCs only.',
    allow: serviceOnly,
    where: (o) => `org_id = '${o.org}'`,
    insert: (o) =>
      `insert into report_costs (report_id, org_id, kind, filed_at, cost_cents) values ('${o.report}', '${o.org}', 'daily', now(), 1)`,
    set: 'cost_cents = cost_cents',
  },
  scheduler_state: {
    why: 'Scheduler bookkeeping: service role only.',
    allow: serviceOnly,
    where: () => `key like 'matrix:%'`,
    insert: () => `insert into scheduler_state (key) values ('matrix:new')`,
    set: 'value = value',
    orgless: true,
  },
  stripe_events: {
    why: 'Stripe webhook idempotency: service role only.',
    allow: serviceOnly,
    where: () => `id like 'evt_matrix_%'`,
    insert: () => `insert into stripe_events (id, type) values ('evt_matrix_new', 't')`,
    set: 'type = type',
    orgless: true,
  },
  platform_admins: {
    why: 'SiteLog operators: service role only (revoked from anon and authenticated).',
    allow: serviceOnly,
    where: () => `user_id = '${OPERATOR}'`,
    insert: () => `insert into platform_admins (user_id) values (auth.uid())`,
    set: 'note = note',
    orgless: true,
  },
};

/** Owner-privileged views (README "Aggregate views"): select only. */
export const VIEWS: Record<
  string,
  { why: string; select: readonly Role[]; where: (o: OrgIds) => string }
> = {
  current_manpower: {
    why: '§2.2 "View crew hours": every role.',
    select: ALL,
    where: (o) => `report_id = '${o.report}'`,
  },
  current_weather: {
    why: '§2.2 "Weather log": admin, pm, ops.',
    select: OFFICE,
    where: (o) => `report_id = '${o.report}'`,
  },
  report_archive: {
    why: '§2.2 "View reports": admin, pm, ops.',
    select: OFFICE,
    where: (o) => `id = '${o.report}'`,
  },
  site_options: {
    why: '§2.2 "View crew hours": every role reads the site names and the site filter of Crew hours (and the org switcher counts active sites); the rest of a site is admin, pm, ops (GAP D22; 20261014000001).',
    select: ALL,
    where: (o) => `id = '${o.site}'`,
  },
};

/**
 * Private buckets (§6.5; 20261011000006_platform.sql): which roles read their org's objects in
 * each (object paths start with the org id). Writes are covered by office-photos.test.ts and the
 * PDF tests; select is where accounts reaches too far today (GAP D22).
 */
export const STORAGE: Record<Bucket, { why: string; select: readonly Role[] }> = {
  audio: {
    why: 'Voice notes are report sources (§2.2 "View reports": admin, pm, ops).',
    select: OFFICE,
  },
  photos: { why: 'Report photos (§2.2 "View reports").', select: OFFICE },
  pdfs: { why: 'Report PDFs (§2.2 "View reports"; office edits render them).', select: OFFICE },
  exports: {
    why: 'EOT evidence packs, written by build_evidence_pack (§2.2 "Weather log, build EOT pack": admin, pm, ops). Payroll exports are not stored: api-export-payroll streams the CSV to every role.',
    select: OFFICE,
  },
  logos: {
    why: 'The letterhead of the PDFs the office renders (§2.2 "Edit a report") and Settings (admin); not hours or invoices (GAP D22).',
    select: OFFICE,
  },
  invoices: { why: '§2.2 "Record sub invoices / send invoice query": every role.', select: ALL },
  calls: {
    why: 'Call recordings are report sources (§2.2 "View reports": admin, pm, ops; 20261013000007).',
    select: OFFICE,
  },
};

/** The cell name of a bucket's objects. */
export const storageCell = (bucket: Bucket) => `storage.objects/${bucket}`;

/**
 * The §2.2 rows that exist only as RPC role checks (§6.5: sign-off and office edits only through
 * RPCs). 42501 is denied; the fixture report is filed, so an allowed call succeeds.
 */
export const RPCS: Record<
  string,
  { why: string; allow: readonly Role[]; call: (o: OrgIds) => string }
> = {
  sign_off_report: {
    why: '§2.2 "Sign off a report": admin, pm.',
    allow: ['admin', 'pm'],
    call: (o) => `select sign_off_report('${o.report}') as v`,
  },
  create_report_version: {
    why: '§2.2 "Edit a report (creates new version)": admin, pm, ops.',
    allow: OFFICE,
    call: (o) =>
      `select create_report_version('${o.report}', '${V1_DATA}'::jsonb, 'matrix edit') as v`,
  },
};

export type Scope = 'own' | 'other';

/** A cell whose result today differs from the expectation, and the step that fixes it. */
export interface KnownDefect {
  /** A table or view, `storage.objects/<bucket>` (storageCell) or an RPC name. */
  table: string;
  op: CellOp;
  role: Role;
  scope: Scope;
  /** Today's result: allowed (true) or denied (false). */
  today: boolean;
  fixedBy: string;
  ref: string;
}

export const KNOWN_DEFECTS: KnownDefect[] = [];

/**
 * Scenarios the CRUD matrix cannot express: cross-org links inside one row, forged values, column
 * lockdown, the last admin, §13 notification audiences, and the shared-phone leak. `expect` is the
 * spec's answer (allowed / visible); `defect` would record a different answer today and the step
 * that fixes it (none since W1-05 step 9).
 */
export interface Probe {
  name: string;
  org: OrgKey;
  role: Role;
  /** `select` probes count rows (visible = at least one); `write` probes count affected rows. */
  kind: 'select' | 'write';
  sql: string;
  expect: boolean;
  defect?: { today: boolean; fixedBy: string; ref: string };
  /**
   * SQLSTATEs that mean "refused" (default 42501), e.g. P0001 when a fix may be a guard trigger
   * that raises; any other error fails the probe.
   */
  refusal?: readonly string[];
}

const A = ORG.A;
const B = ORG.B;
/** The last-admin guard is a trigger that raises (P0001); a policy would refuse with 42501. */
const GUARD_REFUSAL = ['42501', 'P0001'] as const;

/**
 * §13 audiences of the org-wide panel notifications in the fixture (notification_audience(),
 * 20261014000001), for the roles §13 names on either side, and admin, who holds every §2.2
 * capability and so sees every kind. Each `false` keeps a role out (accounts sees invoice gaps
 * only), each `true` stops a fix that hides too much (accounts keeps invoice gaps, pm needs
 * review).
 */
const NOTIFICATION_AUDIENCES: {
  kind: string;
  id: (o: OrgIds) => string;
  why: string;
  sees: Partial<Record<Role, boolean>>;
}[] = [
  {
    kind: 'missing_report',
    id: (o) => o.notification,
    why: '§13 "Report missing: ops + admin"',
    sees: { admin: true, ops: true, pm: false, accounts: false },
  },
  {
    kind: 'invoice_gap',
    id: (o) => o.notifications.invoiceGap,
    why: '§13 "Invoice gap: ops, accounts"',
    sees: { admin: true, ops: true, accounts: true, pm: false },
  },
  {
    kind: 'needs_review',
    id: (o) => o.notifications.needsReview,
    why: '§13 "Needs review / call mismatch / no photo: ops, pm"',
    sees: { admin: true, ops: true, pm: true, accounts: false },
  },
  {
    kind: 'unknown_contact',
    id: (o) => o.notifications.unknownSender,
    why: '§13 "Unknown contact: ops, admin"',
    sees: { admin: true, ops: true, pm: false, accounts: false },
  },
  {
    kind: 'billing',
    id: (o) => o.notifications.billing,
    why: '§13 "Billing: admin"',
    sees: { admin: true, pm: false, ops: false, accounts: false },
  },
];

const notificationProbes: Probe[] = [
  ...NOTIFICATION_AUDIENCES.flatMap((n) =>
    (Object.entries(n.sees) as [Role, boolean][]).flatMap(([role, sees]): Probe[] => [
      {
        name: `notifications: ${role} ${sees ? 'sees' : 'does not see'} an org-wide ${n.kind} (${n.why})`,
        org: 'A',
        role,
        kind: 'select',
        sql: `select 1 from notifications where id = '${n.id(A)}'`,
        expect: sees,
      },
      {
        name: `notifications: ${role} of another org does not see an org-wide ${n.kind}`,
        org: 'B',
        role,
        kind: 'select',
        sql: `select 1 from notifications where id = '${n.id(A)}'`,
        expect: false,
      },
    ]),
  ),
  // §13 "EOT pack ready: requester": a row addressed to one user is that user's only.
  ...(['pm', 'admin', 'ops', 'accounts'] as const).map((role): Probe => ({
    name: `notifications: ${role} ${role === 'pm' ? 'sees' : 'does not see'} a pack_ready addressed to the pm`,
    org: 'A',
    role,
    kind: 'select',
    sql: `select 1 from notifications where id = '${A.notifications.packReadyForPm}'`,
    expect: role === 'pm',
  })),
];

export const PROBES: Probe[] = [
  // site_reporters (docs/AUDIT_BACKLOG.md "site_reporters write policy does not check the
  // reporter's org"): the policy refuses a link to another org's reporter, and moving an own link
  // to one; the same-org insert is the matrix's insert cell.
  ...(['admin', 'ops'] as const).flatMap((role): Probe[] => [
    {
      name: `site_reporters: ${role} links another org's reporter to an own site`,
      org: 'A',
      role,
      kind: 'write',
      sql: `insert into site_reporters (site_id, reporter_id) values ('${A.site}', '${B.reporter2}')`,
      expect: false,
    },
    {
      name: `site_reporters: ${role} moves an own link to another org's reporter`,
      org: 'A',
      role,
      kind: 'write',
      sql: `update site_reporters set reporter_id = '${B.reporter2}' where site_id = '${A.site}' and reporter_id = '${A.reporter}'`,
      expect: false,
    },
  ]),
  // evidence_packs (docs/AUDIT_BACKLOG.md "evidence_packs insert policy lets a user forge a
  // 'ready' pack"): no client insert at all, so neither a pack for another org's site nor a forged
  // ready one pointing at another org's PDF.
  {
    name: "evidence_packs: pm files a pack for another org's site",
    org: 'A',
    role: 'pm',
    kind: 'write',
    sql: `insert into evidence_packs (org_id, site_id, period_start, period_end, created_by) values ('${A.org}', '${B.site}', '2026-10-01', '2026-10-09', auth.uid())`,
    expect: false,
  },
  {
    name: "evidence_packs: ops forges a ready pack pointing at another org's PDF",
    org: 'A',
    role: 'ops',
    kind: 'write',
    sql: `insert into evidence_packs (org_id, site_id, period_start, period_end, status, pdf_path, created_by) values ('${A.org}', '${A.site}', '2026-10-01', '2026-10-09', 'ready', '${B.org}/${B.site}/eot.pdf', auth.uid())`,
    expect: false,
  },
  // docs/AUDIT_BACKLOG.md "org_members update and delete policies allow an org with zero admins".
  {
    name: 'org_members: the only admin demotes themselves',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_members set role = 'ops' where org_id = '${A.org}' and user_id = auth.uid()`,
    expect: false,
    refusal: GUARD_REFUSAL,
  },
  {
    // Refused by org_members_admin_delete (user_id <> auth.uid()) and by the last-admin guard.
    name: 'org_members: the only admin removes themselves',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `delete from org_members where org_id = '${A.org}' and user_id = auth.uid()`,
    expect: false,
    refusal: GUARD_REFUSAL,
  },
  {
    name: 'org_members: the only admin demotes every member at once, themselves included',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_members set role = 'ops' where org_id = '${A.org}'`,
    expect: false,
    refusal: GUARD_REFUSAL,
  },
  {
    name: "org_members: an admin changes another member's role",
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_members set role = 'pm' where org_id = '${A.org}' and user_id = '${A.users.ops}'`,
    expect: true,
  },
  // A member row's key (20261014000001): rewriting user_id hands the seat to another account,
  // moving org_id moves the member to another org, neither as a removal and an addition.
  {
    name: "org_members: an admin hands a member's seat to another account (user_id)",
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_members set user_id = '${SPARE_USER}' where org_id = '${A.org}' and user_id = '${A.users.pm}'`,
    expect: false,
  },
  {
    // org_id = org_id: refused by the column privilege alone, not by the policy's org check
    // (an admin of both orgs passes that; src/rls-fixes.test.ts).
    name: "org_members: an admin moves a member's row (org_id)",
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_members set org_id = org_id where org_id = '${A.org}' and user_id = '${A.users.ops}'`,
    expect: false,
  },
  {
    name: "org_members: an admin saves a member's name and title",
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_members set display_name = 'Ops A', title = 'Coordinator', ui_locale = 'tr-TR' where org_id = '${A.org}' and user_id = '${A.users.ops}'`,
    expect: true,
  },
  // sites (20261014000001): the columns the panel saves; org_id and report_seq are not a client's.
  {
    // org_id = org_id: the column privilege alone (an admin of both orgs; src/rls-fixes.test.ts).
    name: 'sites: an admin moves a site (org_id)',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update sites set org_id = org_id where id = '${A.site}'`,
    expect: false,
  },
  {
    name: "sites: an admin resets the site's report numbering (report_seq)",
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update sites set report_seq = 0 where id = '${A.site}'`,
    expect: false,
  },
  {
    name: 'sites: an admin edits, pauses and resumes a site (updateSite, pauseSite, resumeSite)',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update sites set name = 'Site A2', project_code = 'A-101', address = '1 Main St', lat = 30.1, lng = -97.7, timezone = 'America/Denver', deadline = '18:00', working_hours = '07:00–16:00', status = 'paused', paused_at = now() where id = '${A.site}'`,
    expect: true,
  },
  // orgs column lockdown (20261013000007; the orgs half of docs/AUDIT_BACKLOG.md "Org admins can
  // overwrite the Stripe-mirrored billing columns and the grace period"): billing, is_demo,
  // country, currency and logo_path are service / RPC only; the profile columns stay the admin's.
  ...(
    [
      ['the billing columns', `billing_status = 'active', billing_customer_id = 'cus_B'`],
      ['the subscription id', `billing_subscription_id = 'sub_B'`],
      ['the billing provider', `billing_provider = 'iyzico'`],
      ['the legacy Stripe customer id', `stripe_customer_id = 'cus_B'`],
      ['the legacy Stripe subscription id', `stripe_subscription_id = 'sub_B'`],
      ['the trial end', `trial_ends_at = now() + interval '1 year'`],
      ['is_demo', 'is_demo = true'],
      ['the country', `country = 'TR'`],
      ['the currency', `currency = 'TRY'`],
      ['the logo path', `logo_path = '${B.org}/logo.png'`],
    ] as const
  ).map(([what, set]): Probe => ({
    name: `orgs: an admin writes ${what}`,
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update orgs set ${set} where id = '${A.org}'`,
    expect: false,
  })),
  {
    name: 'orgs: an admin edits the company profile',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update orgs set name = 'Org A renamed', address = 'Main St 1', license_no = 'GC-1', tax_no = '123', timezone = 'America/Denver', locale = 'tr-TR', units = 'metric' where id = '${A.org}'`,
    expect: true,
  },
  {
    name: 'orgs: a pm edits the company profile',
    org: 'A',
    role: 'pm',
    kind: 'write',
    sql: `update orgs set name = 'Org A renamed' where id = '${A.org}'`,
    expect: false,
  },
  {
    // The org_settings half of that finding (20261014000001): scheduler-tick reads the grace period.
    name: 'org_settings: an admin sets past_due_grace_days (outlasts the billing block)',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_settings set past_due_grace_days = 100000 where org_id = '${A.org}'`,
    expect: false,
  },
  {
    name: "org_settings: an admin moves the org's settings row (org_id)",
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_settings set org_id = org_id where org_id = '${A.org}'`,
    expect: false,
  },
  {
    name: 'org_settings: an admin saves the deadline and the ladder (the panel sends updated_at)',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_settings set default_deadline = '18:00', reminder1_offset_min = 20, updated_at = now() where org_id = '${A.org}'`,
    expect: true,
  },
  // reporters lockdown (20261013000007; docs/AUDIT_BACKLOG.md "reporters and unknown_senders
  // write policies allow forging verification state"): consent, opt-out and activation state is
  // SiteLog's; the office disables and re-invites.
  ...(
    [
      ['ops', 'clears an opt-out (opted_out_at)', `opted_out_at = null`, A.optedOut],
      ['ops', 'sets activated_at', `activated_at = now()`, A.reporter2],
      ['admin', 'sets verified_at', `verified_at = now()`, A.reporter2],
      ['ops', "changes a reporter's phone number", `phone_e164 = '+15550006666'`, A.reporter],
      ['ops', 'moves a reporter out of opted_out', `status = 'invited'`, A.optedOut],
      ['admin', 'disables a reporter who opted out', `status = 'disabled'`, A.optedOut],
      ['admin', 'opts a reporter out', `status = 'opted_out'`, A.reporter],
      ['ops', 'marks an invited reporter active (no consent)', `status = 'active'`, A.reporter2],
    ] as const
  ).map(([role, what, set, id]): Probe => ({
    name: `reporters: ${role} ${what}`,
    org: 'A',
    role,
    kind: 'write',
    sql: `update reporters set ${set} where id = '${id}'`,
    expect: false,
  })),
  ...(['admin', 'ops'] as const).map((role): Probe => ({
    name: `reporters: ${role} deletes a reporter with consent records`,
    org: 'A',
    role,
    kind: 'write',
    sql: `delete from reporters where id = '${A.optedOut}'`,
    expect: false,
  })),
  {
    name: 'reporters: ops disables a reporter',
    org: 'A',
    role: 'ops',
    kind: 'write',
    sql: `update reporters set status = 'disabled' where id = '${A.reporter}'`,
    expect: true,
  },
  {
    name: 'reporters: an admin re-invites a reporter',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update reporters set status = 'invited', invited_at = now() where id = '${A.reporter}'`,
    expect: true,
  },
  // unknown_contacts lockdown (20261014000003; the unknown_senders half of the same finding): the
  // number, its org, the snippet and the keys are the service's; the office ignores (status).
  ...(
    [
      ['ops', "rewrites an unknown contact's phone number", `phone_e164 = '+15550006666'`],
      ['admin', 'changes the guessed site', `guessed_site_id = null`],
      ['ops', 'sets the channel', `channel = 'sms'`],
      ['admin', 'rewrites the held message', `message_id = null`],
    ] as const
  ).map(([role, what, set]): Probe => ({
    name: `unknown_contacts: ${role} ${what}`,
    org: 'A',
    role,
    kind: 'write',
    sql: `update unknown_contacts set ${set} where id = '${A.unknownSender}'`,
    expect: false,
  })),
  {
    name: 'unknown_contacts: ops ignores an unknown contact (ignoreUnknownSender)',
    org: 'A',
    role: 'ops',
    kind: 'write',
    sql: `update unknown_contacts set status = 'ignored' where id = '${A.unknownSender}'`,
    expect: true,
  },
  // v1.2 transcripts (upload_id or call_id, no message): transcripts_select finds their org.
  ...(
    [
      ['uploadTranscript', 'an upload'],
      ['callTranscript', 'a call'],
    ] as const
  ).flatMap(([t, what]) =>
    ROLES.flatMap((role): Probe[] => [
      {
        name: `transcripts: ${role} ${role === 'accounts' ? 'does not see' : 'sees'} ${what} transcript of its org`,
        org: 'A',
        role,
        kind: 'select',
        sql: `select 1 from transcripts where id = '${A[t]}'`,
        expect: role !== 'accounts',
      },
      {
        name: `transcripts: ${role} does not see ${what} transcript of another org`,
        org: 'B',
        role,
        kind: 'select',
        sql: `select 1 from transcripts where id = '${A[t]}'`,
        expect: false,
      },
    ]),
  ),
  // SMS rows (D15): no conversation; messages_select finds their org through org_id.
  ...ROLES.flatMap((role): Probe[] => [
    {
      name: `messages: ${role} ${role === 'accounts' ? 'does not see' : 'sees'} an SMS row of its org`,
      org: 'A',
      role,
      kind: 'select',
      sql: `select 1 from messages where id = '${A.smsMessage}'`,
      expect: role !== 'accounts',
    },
    {
      name: `messages: ${role} does not see an SMS row of another org`,
      org: 'B',
      role,
      kind: 'select',
      sql: `select 1 from messages where id = '${A.smsMessage}'`,
      expect: false,
    },
  ]),
  ...notificationProbes,
  // The shared phone (docs/AUDIT_BACKLOG.md "Messages, transcripts and conversation context of a
  // phone shared by two orgs leak"): a message tagged with an org is that org's, also in another
  // org's conversation, and so is its transcript.
  ...(['messages', 'transcripts'] as const).flatMap((table): Probe[] => {
    const id = table === 'messages' ? SHARED.message : SHARED.transcript;
    return [
      {
        name: `${table}: org A (owner of the conversation) does not read org B's voice note`,
        org: 'A',
        role: 'pm',
        kind: 'select',
        sql: `select 1 from ${table} where id = '${id}'`,
        expect: false,
      },
      {
        name: `${table}: org B reads its own voice note in org A's conversation`,
        org: 'B',
        role: 'admin',
        kind: 'select',
        sql: `select 1 from ${table} where id = '${id}'`,
        expect: true,
      },
    ];
  }),
  // The conversation context (active report, candidate sites) can name another org's ids; the
  // panel never reads it, so no API role does (column privilege). The other columns stay.
  {
    name: 'conversations: pm reads the context of a conversation (another org may be in it)',
    org: 'A',
    role: 'pm',
    kind: 'select',
    sql: `select context from conversations where id = '${SHARED.conversation}'`,
    expect: false,
  },
  {
    name: 'conversations: pm reads the state of an own conversation',
    org: 'A',
    role: 'pm',
    kind: 'select',
    sql: `select id, state, last_inbound_at from conversations where id = '${A.conversation}'`,
    expect: true,
  },
  // site_options: every member reads its own org's site names, nobody another org's.
  ...ROLES.flatMap((role): Probe[] => [
    {
      name: `site_options: ${role} reads the names of its org's sites`,
      org: 'A',
      role,
      kind: 'select',
      sql: `select name, project_code, timezone, status from site_options where org_id = '${A.org}'`,
      expect: true,
    },
    {
      name: `site_options: ${role} does not read another org's sites`,
      org: 'B',
      role,
      kind: 'select',
      sql: `select 1 from site_options where org_id = '${A.org}'`,
      expect: false,
    },
  ]),
  ...(['admin', 'accounts'] as const).map((role): Probe => ({
    name: `site_options: ${role} cannot rename a site through the view`,
    org: 'A',
    role,
    kind: 'write',
    sql: `update site_options set name = 'Renamed' where id = '${A.site}'`,
    expect: false,
  })),
];
