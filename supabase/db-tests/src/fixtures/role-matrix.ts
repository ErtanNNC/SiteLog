import {
  ORG,
  OPERATOR,
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
 * Today's known, deferred defects are listed in KNOWN_DEFECTS with the step that fixes them: the
 * test expects today's (wrong) result for those cells, so a fix fails the test until its entry is
 * removed. Any other cell that differs from the expectation fails it too, as does a table missing
 * from this list (each new table, e.g. the six of step 9, needs its row here).
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
  /** Not org-scoped (service tables): the other-org probes repeat the own-org ones. */
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
  orgs: {
    why: '§2.2 "Settings … billing: admin"; every member reads its org (§2.2 silent: the shell shows the name). Orgs are created by create_org() (README deviation).',
    allow: { select: ALL, insert: NONE, update: ADMIN, delete: NONE },
    where: (o) => `id = '${o.org}'`,
    insert: () => `insert into orgs (name) values ('Matrix new org')`,
    set: 'name = name',
  },
  org_members: {
    why: '§2.2 "Invite office users: admin"; members read their team (§2.2 silent). Updates and deletes target the ops member; the admin\'s own row is the last-admin case (PROBES).',
    allow: { select: ALL, insert: ADMIN, update: ADMIN, delete: ADMIN },
    where: (o) => `org_id = '${o.org}'`,
    writeWhere: (o) => `org_id = '${o.org}' and user_id = '${o.users.ops}'`,
    insert: (o) =>
      `insert into org_members (org_id, user_id, role) values ('${o.org}', '${SPARE_USER}', 'ops')`,
    set: 'role = role',
  },
  org_settings: {
    why: '§2.2 "Settings: admin"; every member reads deadlines and working days (§2.2 silent).',
    allow: { select: ALL, insert: ADMIN, update: ADMIN, delete: NONE },
    where: (o) => `org_id = '${o.org}'`,
    // The row exists (orgs trigger): a unique violation means the policy let the insert through.
    insert: (o) => `insert into org_settings (org_id) values ('${o.org}')`,
    set: 'default_deadline = default_deadline',
  },
  sites: {
    why: '§2.2 "View overview, sites, reports: admin, pm, ops"; "Add / pause sites: admin".',
    allow: { select: OFFICE, insert: ADMIN, update: ADMIN, delete: NONE },
    where: (o) => `org_id = '${o.org}'`,
    insert: (o) =>
      `insert into sites (org_id, name, project_code, timezone) values ('${o.org}', 'New', 'NEW-1', 'UTC')`,
    set: 'name = name',
  },
  reporters: {
    why: '§2.2 "Manage reporters, phone numbers & channel preferences: admin, ops"; pm reads who reported.',
    allow: { select: OFFICE, insert: ADMIN_OPS, update: ADMIN_OPS, delete: ADMIN_OPS },
    where: (o) => `org_id = '${o.org}'`,
    insert: (o) =>
      `insert into reporters (org_id, name, phone_e164) values ('${o.org}', 'New', '+15550009999')`,
    set: 'name = name',
  },
  site_reporters: {
    why: '§2.2 "Manage reporters: admin, ops".',
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
  unknown_senders: {
    why: '§2.2 "Manage reporters, phone numbers": admin, ops (Unknown contacts on Team); created by the service.',
    allow: { select: ADMIN_OPS, insert: NONE, update: ADMIN_OPS, delete: NONE },
    where: (o) => `id = '${o.unknownSender}'`,
    insert: (o) =>
      `insert into unknown_senders (org_id, phone_e164) values ('${o.org}', '+15550007777')`,
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
      `insert into reports (org_id, site_id, site_day_id, report_no) values ('${o.org}', '${o.site}', '${o.siteDay2}', 'NEW-0001')`,
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
    why: '§2.2 "Weather log, build EOT pack": admin, pm, ops; the worker fills the pack.',
    allow: { select: OFFICE, insert: OFFICE, update: NONE, delete: NONE },
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
    why: '§13 "Report missing … ops + admin" (the fixture row is a missing_report); marked read through mark_notifications_read().',
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
    why: 'EOT evidence packs, written by build_evidence_pack (§2.2 "Weather log, build EOT pack": admin, pm, ops).',
    select: OFFICE,
  },
  logos: {
    why: 'The letterhead of the PDFs the office renders (§2.2 "Edit a report") and Settings (admin); not hours or invoices (GAP D22).',
    select: OFFICE,
  },
  invoices: { why: '§2.2 "Record sub invoices / send invoice query": every role.', select: ALL },
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

const NOTIFICATIONS_REF =
  'docs/AUDIT_BACKLOG.md "notifications and audit_log ignore the spec\'s role restrictions"';

/** Accounts reads every bucket today ("members read org files"); §2.2 gives it invoices only. */
const STORAGE_DEFECTS: KnownDefect[] = (
  ['audio', 'photos', 'pdfs', 'exports', 'logos'] as const
).map((bucket): KnownDefect => ({
  table: storageCell(bucket),
  op: 'select',
  role: 'accounts',
  scope: 'own',
  today: true,
  fixedBy: 'W1-05 step 9 (D22)',
  ref: 'GAP D22; 20261011000006_platform.sql "members read org files" (is_member)',
}));

export const KNOWN_DEFECTS: KnownDefect[] = [
  ...STORAGE_DEFECTS,
  {
    table: 'sites',
    op: 'select',
    role: 'accounts',
    scope: 'own',
    today: true,
    fixedBy: 'W1-05 step 9 (D22)',
    ref: 'GAP D22; 20261011000004_rls.sql sites_select (is_member)',
  },
  {
    table: 'audit_log',
    op: 'select',
    role: 'accounts',
    scope: 'own',
    today: true,
    fixedBy: 'W1-05 step 9 (D21, D22)',
    ref: NOTIFICATIONS_REF,
  },
  {
    table: 'notifications',
    op: 'select',
    role: 'accounts',
    scope: 'own',
    today: true,
    fixedBy: 'W1-05 step 9 (D21, D22)',
    ref: NOTIFICATIONS_REF,
  },
  {
    table: 'notifications',
    op: 'select',
    role: 'pm',
    scope: 'own',
    today: true,
    fixedBy: 'W1-05 step 9 (D21)',
    ref: NOTIFICATIONS_REF,
  },
];

/**
 * Scenarios the CRUD matrix cannot express: cross-org links inside one row, forged values, column
 * lockdown, the last admin, §13 notification audiences, and the shared-phone leak. `expect` is the
 * spec's answer (allowed / visible); `defect` records today's different answer and the step that
 * fixes it.
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
const D21 = 'W1-05 step 9 (D21)';
const LAST_ADMIN_REF =
  'docs/AUDIT_BACKLOG.md "org_members update and delete policies allow an org with zero admins"';
/** A no-last-admin guard may be a policy (42501, or no row) or a trigger that raises (P0001). */
const GUARD_REFUSAL = ['42501', 'P0001'] as const;

/**
 * §13 audiences of the org-wide panel notifications in the fixture, for the roles §13 names on
 * either side (a role left out is not asserted). Today every member reads every org-wide row
 * (`notifications_select`: is_member, user_id null), so each `false` is a known defect, and each
 * `true` stops a fix that hides too much (accounts must keep invoice gaps, pm needs review).
 */
const NOTIFICATION_AUDIENCES: {
  kind: string;
  id: (o: OrgIds) => string;
  why: string;
  sees: Partial<Record<Role, boolean>>;
}[] = [
  {
    kind: 'invoice_gap',
    id: (o) => o.notifications.invoiceGap,
    why: '§13 "Invoice gap: ops, accounts"',
    sees: { ops: true, accounts: true, pm: false },
  },
  {
    kind: 'needs_review',
    id: (o) => o.notifications.needsReview,
    why: '§13 "Needs review / call mismatch / no photo: ops, pm"',
    sees: { ops: true, pm: true, accounts: false },
  },
  {
    kind: 'unknown_sender',
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
    (Object.entries(n.sees) as [Role, boolean][]).map(([role, sees]): Probe => ({
      name: `notifications: ${role} ${sees ? 'sees' : 'does not see'} an org-wide ${n.kind} (${n.why})`,
      org: 'A',
      role,
      kind: 'select',
      sql: `select 1 from notifications where id = '${n.id(A)}'`,
      expect: sees,
      ...(sees
        ? {}
        : {
            defect: {
              today: true,
              fixedBy: role === 'accounts' ? 'W1-05 step 9 (D21, D22)' : D21,
              ref: NOTIFICATIONS_REF,
            },
          }),
    })),
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
  ...(['admin', 'ops'] as const).map((role): Probe => ({
    name: `site_reporters: ${role} links another org's reporter to an own site`,
    org: 'A',
    role,
    kind: 'write',
    sql: `insert into site_reporters (site_id, reporter_id) values ('${A.site}', '${B.reporter2}')`,
    expect: false,
    defect: {
      today: true,
      fixedBy: D21,
      ref: 'docs/AUDIT_BACKLOG.md "site_reporters write policy does not check the reporter\'s org"',
    },
  })),
  {
    name: "evidence_packs: pm files a pack for another org's site",
    org: 'A',
    role: 'pm',
    kind: 'write',
    sql: `insert into evidence_packs (org_id, site_id, period_start, period_end, created_by) values ('${A.org}', '${B.site}', '2026-10-01', '2026-10-09', auth.uid())`,
    expect: false,
    defect: {
      today: true,
      fixedBy: D21,
      ref: 'docs/AUDIT_BACKLOG.md "evidence_packs insert policy lets a user forge a \'ready\' pack"',
    },
  },
  {
    name: "evidence_packs: ops forges a ready pack pointing at another org's PDF",
    org: 'A',
    role: 'ops',
    kind: 'write',
    sql: `insert into evidence_packs (org_id, site_id, period_start, period_end, status, pdf_path, created_by) values ('${A.org}', '${A.site}', '2026-10-01', '2026-10-09', 'ready', '${B.org}/${B.site}/eot.pdf', auth.uid())`,
    expect: false,
    defect: {
      today: true,
      fixedBy: D21,
      ref: 'docs/AUDIT_BACKLOG.md "evidence_packs insert policy lets a user forge a \'ready\' pack"',
    },
  },
  {
    name: 'org_members: the only admin demotes themselves',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update org_members set role = 'ops' where org_id = '${A.org}' and user_id = auth.uid()`,
    expect: false,
    defect: { today: true, fixedBy: D21, ref: LAST_ADMIN_REF },
    refusal: GUARD_REFUSAL,
  },
  {
    // Refused today by org_members_admin_delete (user_id <> auth.uid()); D21 must keep it so.
    name: 'org_members: the only admin removes themselves',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `delete from org_members where org_id = '${A.org}' and user_id = auth.uid()`,
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
  {
    name: 'orgs: an admin writes the billing columns',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update orgs set billing_status = 'active', stripe_customer_id = 'cus_B' where id = '${A.org}'`,
    expect: false,
    defect: {
      today: true,
      fixedBy: 'W1-05 step 9 (orgs column lockdown)',
      ref: 'GAP W1-05 "Column lockdown on orgs"; docs/AUDIT_BACKLOG.md "Org admins can overwrite the Stripe-mirrored billing columns"',
    },
  },
  {
    name: 'orgs: an admin edits the company profile',
    org: 'A',
    role: 'admin',
    kind: 'write',
    sql: `update orgs set name = 'Org A renamed', address = 'Main St 1' where id = '${A.org}'`,
    expect: true,
  },
  ...notificationProbes,
  ...(['messages', 'transcripts'] as const).flatMap((table): Probe[] => {
    const id = table === 'messages' ? SHARED.message : SHARED.transcript;
    const ref =
      'docs/AUDIT_BACKLOG.md "Messages, transcripts and conversation context of a phone shared by two orgs leak"';
    return [
      {
        name: `${table}: org A (owner of the conversation) reads org B's voice note`,
        org: 'A',
        role: 'pm',
        kind: 'select',
        sql: `select 1 from ${table} where id = '${id}'`,
        expect: false,
        defect: { today: true, fixedBy: D21, ref },
      },
      {
        name: `${table}: org B reads its own voice note in org A's conversation`,
        org: 'B',
        role: 'admin',
        kind: 'select',
        sql: `select 1 from ${table} where id = '${id}'`,
        expect: true,
        defect: { today: false, fixedBy: D21, ref },
      },
    ];
  }),
];
