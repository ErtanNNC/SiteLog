import type { PGlite } from '@electric-sql/pglite';

/**
 * Two organisations with one row in every org-scoped table each, and one office user per role
 * (§2.2) in each, for the role matrix and the anon test. Ids are fixed so the expectations can
 * name rows without subqueries (a subquery would run under the caller's RLS too). Each org also
 * has one panel notification per §13 audience (and one addressed to its pm), and one storage
 * object in each bucket (so the database must be booted with `{ storage: true }`).
 *
 * Also one "shared phone" case from docs/AUDIT_BACKLOG.md (messages, transcripts and conversation
 * context of a phone shared by two orgs): org A owns the conversation, and a voice note in it is
 * org B's (tagged `messages.org_id = B`, a source of B's report).
 */

export type OrgKey = 'A' | 'B';
export const ROLES = ['admin', 'pm', 'ops', 'accounts'] as const;
export type Role = (typeof ROLES)[number];

const hex = (n: number) => n.toString(16).padStart(12, '0');

function orgIds(prefix: 'aaaaaaaa' | 'bbbbbbbb') {
  const id = (n: number) => `${prefix}-0000-4000-8000-${hex(n)}`;
  const user = (n: number) => `${prefix}-1111-4000-8000-${hex(n)}`;
  return {
    org: id(1),
    company: id(2),
    site: id(3),
    reporter: id(4),
    /** Not linked to any site: the site_reporters insert target. */
    reporter2: id(5),
    conversation: id(6),
    message: id(7),
    /** Has no transcript and is no report source: the insert target for both. */
    message2: id(8),
    transcript: id(9),
    unknownSender: id(10),
    siteDay: id(11),
    /** Has no report: the reports insert target. */
    siteDay2: id(12),
    report: id(13),
    reportSource: id(14),
    manpower: id(15),
    workItem: id(16),
    weather: id(17),
    question: id(18),
    term: id(19),
    invoice: id(20),
    pack: id(21),
    /** missing_report, org-wide (§13: ops + admin). */
    notification: id(22),
    /** Org-wide panel notifications of the other §13 audiences, and one addressed to the pm. */
    notifications: {
      invoiceGap: id(23),
      needsReview: id(24),
      unknownSender: id(25),
      billing: id(26),
      packReadyForPm: id(27),
    },
    // v1.2 tables (W1-05 step 9).
    consent: id(28),
    fieldLink: id(29),
    fieldDevice: id(30),
    upload: id(31),
    call: id(32),
    /** An SMS row (D15): no conversation; org, reporter and phone set. */
    smsMessage: id(33),
    /** A reporter who texted STOP (status opted_out, opted_out_at), with its revoked SMS consent. */
    optedOut: id(34),
    optedOutConsent: id(35),
    /** v1.2 transcripts: of the web recorder upload, and of the call. */
    uploadTranscript: id(36),
    callTranscript: id(37),
    /** An email the console provider stored (W1-08, 20261014000007), for the Demo phone. */
    consoleEmail: id(38),
    /** F4's test recording (W2-13, 20261016000070). */
    testClip: id(39),
    /** A fix of the report's draft (W2-10, 20261016000100). */
    correction: id(40),
    /** A web push subscription (W2-14, 20261016000180). */
    pushSubscription: id(41),
    users: { admin: user(1), pm: user(2), ops: user(3), accounts: user(4) } as Record<Role, string>,
  };
}

export const ORG = { A: orgIds('aaaaaaaa'), B: orgIds('bbbbbbbb') } as const;
export type OrgIds = (typeof ORG)[OrgKey];

/**
 * The private buckets of 20261011000006_platform.sql and `calls` (20261013000007, call
 * recordings); each org has one object in each.
 */
export const BUCKETS = [
  'audio',
  'photos',
  'pdfs',
  'exports',
  'logos',
  'invoices',
  'calls',
] as const;
export type Bucket = (typeof BUCKETS)[number];
/** The object of org `o` in a bucket (paths start with the org id, §6.5). */
export const objectName = (o: OrgIds, bucket: Bucket) => `${o.org}/${o.site}/matrix-${bucket}.bin`;

/** The data of each fixture report's version 1 (also the body of the matrix's office edit). */
export const V1_DATA = '{"schemaVersion":1,"reportDate":"2026-10-09"}';

/** Signed-in user with no membership anywhere (the org_members insert target). */
export const SPARE_USER = 'cccccccc-1111-4000-8000-000000000001';
/** A SiteLog operator (platform_admins), member of no org. */
export const OPERATOR = 'cccccccc-1111-4000-8000-000000000002';

/** The shared-phone case: A's conversation, B's voice note and its transcript. */
export const SHARED = {
  conversation: 'dddddddd-0000-4000-8000-000000000001',
  message: 'dddddddd-0000-4000-8000-000000000002',
  transcript: 'dddddddd-0000-4000-8000-000000000003',
  reportSource: 'dddddddd-0000-4000-8000-000000000004',
} as const;

export const other = (k: OrgKey): OrgKey => (k === 'A' ? 'B' : 'A');

/**
 * The names a schema from before W1-05 step 11 (20261014000003_renames_billing.sql) uses: tests of
 * an earlier migration seed the fixture on a database as deployed before it (`until`).
 */
interface SchemaNames {
  unknownContacts: 'unknown_contacts' | 'unknown_senders';
  activeStatus: 'active' | 'verified';
  customerId: 'billing_customer_id' | 'stripe_customer_id';
}

function orgSql(k: OrgKey, n: number, names: SchemaNames): string {
  const o = ORG[k];
  const u = o.users;
  const phone = (base: number) => `+1555000${base}${n}`;
  return `
    insert into auth.users (id, email) values
      ('${u.admin}', 'admin-${k}@matrix.test'), ('${u.pm}', 'pm-${k}@matrix.test'),
      ('${u.ops}', 'ops-${k}@matrix.test'), ('${u.accounts}', 'accounts-${k}@matrix.test');
    insert into orgs (id, name, ${names.customerId}, billing_status) values
      ('${o.org}', 'Org ${k}', 'cus_${k}', 'active');
    insert into org_members (org_id, user_id, role) values
      ('${o.org}', '${u.admin}', 'admin'), ('${o.org}', '${u.pm}', 'pm'),
      ('${o.org}', '${u.ops}', 'ops'), ('${o.org}', '${u.accounts}', 'accounts');
    insert into companies (id, org_id, name, trade) values ('${o.company}', '${o.org}', 'Apex ${k}', 'Concrete');
    insert into sites (id, org_id, name, project_code, timezone) values
      ('${o.site}', '${o.org}', 'Site ${k}', '${k}-100', 'America/Chicago');
    insert into reporters (id, org_id, name, phone_e164, status) values
      ('${o.reporter}', '${o.org}', 'Reporter ${k}', '${phone(10)}', '${names.activeStatus}'),
      ('${o.reporter2}', '${o.org}', 'Backup ${k}', '${phone(11)}', 'invited');
    insert into reporters (id, org_id, name, phone_e164, status, opted_out_at) values
      ('${o.optedOut}', '${o.org}', 'Opted out ${k}', '${phone(12)}', 'opted_out', now());
    insert into site_reporters (site_id, reporter_id) values ('${o.site}', '${o.reporter}');
    insert into site_recipients (site_id, email) values ('${o.site}', 'office-${k}@matrix.test');
    insert into conversations (id, org_id, reporter_id, phone_e164, state) values
      ('${o.conversation}', '${o.org}', '${o.reporter}', '${phone(10)}', 'idle');
    insert into messages (id, conversation_id, direction, type, storage_path) values
      ('${o.message}', '${o.conversation}', 'in', 'audio', '${o.org}/${o.site}/m.ogg'),
      ('${o.message2}', '${o.conversation}', 'in', 'text', null);
    insert into transcripts (id, message_id, text, segments) values
      ('${o.transcript}', '${o.message}', 'six from Apex', '[]');
    insert into ${names.unknownContacts} (id, org_id, phone_e164, snippet) values
      ('${o.unknownSender}', '${o.org}', '${phone(20)}', 'hello');
    insert into site_days (id, site_id, date, status, deadline_at) values
      ('${o.siteDay}', '${o.site}', '2026-10-09', 'filed', '2026-10-09T22:30:00Z'),
      ('${o.siteDay2}', '${o.site}', '2026-10-10', 'pending', '2026-10-10T22:30:00Z');
    insert into reports (id, org_id, site_id, site_day_id, report_no, status, reporter_id, filed_at, language) values
      ('${o.report}', '${o.org}', '${o.site}', '${o.siteDay}', '${k}-100-0001', 'filed', '${o.reporter}', now(), 'en');
    update site_days set report_id = '${o.report}' where id = '${o.siteDay}';
    insert into report_versions (report_id, version, data, summary, author) values
      ('${o.report}', 1, '${V1_DATA}', 'Matrix ${k}', 'agent');
    insert into report_sources (id, report_id, message_id, kind) values
      ('${o.reportSource}', '${o.report}', '${o.message}', 'audio');
    insert into manpower_entries (id, report_id, version, company_id, company_name, workers, hours) values
      ('${o.manpower}', '${o.report}', 1, '${o.company}', 'Apex ${k}', 6, 48);
    insert into work_items (id, report_id, version, activity) values ('${o.workItem}', '${o.report}', 1, 'Slab pour');
    insert into weather_events (id, report_id, version, site_id, date, lost_hours) values
      ('${o.weather}', '${o.report}', 1, '${o.site}', '2026-10-09', 2);
    insert into questions (id, report_id, field, prompt) values ('${o.question}', '${o.report}', 'hours', 'How many hours?');
    insert into consents (id, reporter_id, type, method, text_version, revoked_at) values
      ('${o.consent}', '${o.reporter}', 'sms', 'web_checkbox', 'v1', null),
      ('${o.optedOutConsent}', '${o.optedOut}', 'sms', 'web_checkbox', 'v1', now());
    insert into field_links (id, code_hash, reporter_id, kind) values
      ('${o.fieldLink}', 'matrix-link-${k}', '${o.reporter}', 'personal');
    insert into field_devices (id, reporter_id, device_token_hash, verified_at) values
      ('${o.fieldDevice}', '${o.reporter}', 'matrix-device-${k}', now());
    insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path, mime) values
      ('${o.upload}', '${o.report}', '${o.reporter}', '${o.site}', 'audio', '${o.org}/${o.site}/2026-10-09/u.webm', 'audio/webm');
    insert into calls (id, org_id, reporter_id, site_id, report_id, direction, status) values
      ('${o.call}', '${o.org}', '${o.reporter}', '${o.site}', '${o.report}', 'inbound', 'completed');
    insert into transcripts (id, upload_id, call_id, text, segments) values
      ('${o.uploadTranscript}', '${o.upload}', null, 'six from Apex, recorder', '[]'),
      ('${o.callTranscript}', null, '${o.call}', 'six from Apex, call', '[]');
    insert into messages (id, org_id, reporter_id, phone_e164, direction, provider, copy_key, body, status) values
      ('${o.smsMessage}', '${o.org}', '${o.reporter}', '${phone(10)}', 'out', 'console', 'daily_link', 'Today''s link', 'delivered');
    insert into rate_limits (key, window_start, count) values ('matrix:${k}', '2026-10-09T17:00:00Z', 1);
    insert into glossary_terms (id, org_id, heard, official) values ('${o.term}', '${o.org}', 'mud', 'Joint compound');
    insert into sub_invoices (id, org_id, company_id, invoice_no) values ('${o.invoice}', '${o.org}', '${o.company}', 'INV-${k}');
    insert into evidence_packs (id, org_id, site_id, period_start, period_end, created_by) values
      ('${o.pack}', '${o.org}', '${o.site}', '2026-10-01', '2026-10-09', '${u.pm}');
    insert into jobs (type, payload) values ('render_pdf', '{"org":"${o.org}"}');
    insert into audit_log (org_id, actor_type, action) values ('${o.org}', 'system', 'matrix.fixture');
    insert into notifications (id, org_id, user_id, kind, title) values
      ('${o.notification}', '${o.org}', null, 'missing_report', 'Site ${k}: no report'),
      ('${o.notifications.invoiceGap}', '${o.org}', null, 'invoice_gap', 'Apex ${k}: 8 h gap'),
      ('${o.notifications.needsReview}', '${o.org}', null, 'needs_review', '${k}-100-0001 needs review'),
      ('${o.notifications.unknownSender}', '${o.org}', null, 'unknown_contact', 'Unknown number'),
      ('${o.notifications.billing}', '${o.org}', null, 'billing', 'Payment failed'),
      ('${o.notifications.packReadyForPm}', '${o.org}', '${u.pm}', 'pack_ready', 'EOT pack ready');
    insert into storage.objects (bucket_id, name) values
      ${BUCKETS.map((b) => `('${b}', '${objectName(o, b)}')`).join(',\n      ')};
    insert into report_costs (report_id, org_id, kind, filed_at, cost_cents) values
      ('${o.report}', '${o.org}', 'daily', now(), 12);
    insert into scheduler_state (key) values ('matrix:${k}');
    insert into stripe_events (id, type) values ('evt_matrix_${k}', 'invoice.paid');
  `;
}

/** Inserts both orgs (as the migration owner, so RLS does not apply). */
export async function seedTwoOrgs(db: PGlite): Promise<void> {
  await db.exec('reset role;');
  const storage = await db.query<{ t: string | null }>(
    `select to_regclass('storage.objects')::text as t`,
  );
  if (!storage.rows[0]?.t) throw new Error('seedTwoOrgs needs bootDatabase({ storage: true })');
  const renamed = await db.query<{ v: boolean }>(
    `select to_regclass('public.unknown_contacts') is not null as v`,
  );
  const names: SchemaNames = renamed.rows[0]!.v
    ? {
        unknownContacts: 'unknown_contacts',
        activeStatus: 'active',
        customerId: 'billing_customer_id',
      }
    : {
        unknownContacts: 'unknown_senders',
        activeStatus: 'verified',
        customerId: 'stripe_customer_id',
      };
  await db.exec(orgSql('A', 1, names));
  await db.exec(orgSql('B', 2, names));
  const consoleEmails = await db.query<{ v: boolean }>(
    `select to_regclass('public.console_emails') is not null as v`,
  );
  if (consoleEmails.rows[0]!.v) {
    for (const o of [ORG.A, ORG.B])
      await db.exec(`
        insert into console_emails (id, org_id, kind, recipients, subject, body_text) values
          ('${o.consoleEmail}', '${o.org}', 'report_filed', '{pm@matrix.test}', 'Daily report', 'Filed.');
      `);
    // W1-08's phone-level opt-outs (no org), from the same migration.
    await db.exec(`
      insert into sms_opt_outs (phone_e164, country, method) values
        ('+15550991000', 'US', 'sms_keyword'), ('+15550992000', 'US', 'provider_opt_out');
    `);
  }
  const testClips = await db.query<{ v: boolean }>(
    `select to_regclass('public.test_clips') is not null as v`,
  );
  if (testClips.rows[0]!.v) {
    for (const o of [ORG.A, ORG.B])
      await db.exec(`
        insert into test_clips (id, org_id, reporter_id, storage_path, mime) values
          ('${o.testClip}', '${o.org}', '${o.reporter}', 'test/${o.org}/${o.testClip}.webm', 'audio/webm');
      `);
  }
  const pushSubs = await db.query<{ v: boolean }>(
    `select to_regclass('public.push_subscriptions') is not null as v`,
  );
  if (pushSubs.rows[0]!.v) {
    for (const o of [ORG.A, ORG.B])
      await db.exec(`
        insert into push_subscriptions (id, org_id, reporter_id, endpoint, p256dh, auth) values
          ('${o.pushSubscription}', '${o.org}', '${o.reporter}', 'https://fcm.googleapis.com/fcm/send/${o.pushSubscription}', 'k', 'a');
      `);
  }
  const corrections = await db.query<{ v: boolean }>(
    `select to_regclass('public.draft_corrections') is not null as v`,
  );
  if (corrections.rows[0]!.v) {
    for (const o of [ORG.A, ORG.B])
      await db.exec(`
        insert into draft_corrections (id, org_id, report_id, reporter_id, via, text) values
          ('${o.correction}', '${o.org}', '${o.report}', '${o.reporter}', 'text', 'Apex had 7');
      `);
  }
  // W3-03: the voice agent's kept tool answers, on each org's call.
  const toolRequests = await db.query<{ v: boolean }>(
    `select to_regclass('public.voice_tool_requests') is not null as v`,
  );
  if (toolRequests.rows[0]!.v) {
    for (const o of [ORG.A, ORG.B])
      await db.exec(`
        insert into voice_tool_requests (call_id, request_key, tool, status, response) values
          ('${o.call}', 'matrix-1', 'end_call', 200, '{"ok": true}');
      `);
  }
  // W3-04: a LiveKit event voice-events stored, on each org's call.
  const livekitEvents = await db.query<{ v: boolean }>(
    `select to_regclass('public.livekit_events') is not null as v`,
  );
  if (livekitEvents.rows[0]!.v) {
    for (const o of [ORG.A, ORG.B])
      await db.exec(`
        insert into livekit_events (id, event, room, call_id, event_at) values
          ('EV_matrix_${o.call}', 'room_started', 'call-${o.call}', '${o.call}', now());
      `);
  }
  await db.exec(`
    insert into auth.users (id, email) values ('${SPARE_USER}', 'spare@matrix.test'), ('${OPERATOR}', 'operator@matrix.test');
    insert into platform_admins (user_id, note) values ('${OPERATOR}', 'matrix');
    insert into conversations (id, org_id, phone_e164, state) values
      ('${SHARED.conversation}', '${ORG.A.org}', '+15550003333', 'idle');
    insert into messages (id, conversation_id, org_id, direction, type) values
      ('${SHARED.message}', '${SHARED.conversation}', '${ORG.B.org}', 'in', 'audio');
    insert into transcripts (id, message_id, text, segments) values
      ('${SHARED.transcript}', '${SHARED.message}', 'B site, five from Delta', '[]');
    insert into report_sources (id, report_id, message_id, kind) values
      ('${SHARED.reportSource}', '${ORG.B.report}', '${SHARED.message}', 'audio');
  `);
}
