/**
 * §18.2 — Demir Yapı A.Ş., the fictional Turkish demo org, generated deterministically for the seed
 * (demo/seed-sql.ts). Everything §18.2 gives is here, verbatim: the org profile (Europe/Istanbul,
 * deadline 17:30, tr-TR, metric, TRY), the two sites with codes, the two reporters with their
 * language and preference, the four companies with trades and the four glossary seeds ("TBM / tool
 * box" as its two phrases).
 *
 * What §18.2 does not give is left out rather than invented:
 * - No reports: §18.2 has no crew counts, hours, dates or voice notes for a report (its sample
 *   report text is a sentence, not a report), so the org starts with its sites awaiting.
 * - No addresses or coordinates for the sites (null), no aliases for the companies.
 *
 * Seed values that a row needs and §18.2 does not give: the reporters' phone numbers (fictional
 * +90 532 000 … numbers that only the console SMS driver ever "texts", since the org is a demo
 * org, §4.5), and the org's set-up dates (Mon Oct 5, 2026, the week of the demo).
 *
 * The office user is the owner's answer to spec §19 question 18 (2026-10-14, GAP D46), not §18.2:
 * a separate fictional TR admin, Elif Aydın, a member of this org only. Her panel language is left
 * unset (`ui_locale` null), so the org's tr-TR decides it, as Lena's en-US does for Kestrel.
 */
import type {
  AuditLogRow,
  CompanyRow,
  ConsentRow,
  FieldLinkRow,
  GlossaryTermRow,
  MessageRow,
  OrgMemberRow,
  OrgSettingsRow,
  ReporterRow,
  SiteRow,
} from '../db/types.ts';
import { V12_ROW_DEFAULTS } from '../db/defaults.ts';
import type { ContactPref } from '../enums.ts';
import { firstName } from '../format.ts';
import { PAYROLL_COLUMNS } from '../report/payroll.ts';
import { renderSms } from '../copy/sms.ts';
import { demoCalendar } from './calendar.ts';
import { demoId } from './ids.ts';
import {
  DEMO_LINK_BASE,
  demoConsents,
  demoLink,
  demoSms,
  memberAudit,
  numberAudit,
} from './rows.ts';
import type { DemoOrgRows, DemoUser } from './types.ts';

export const DEMIR_TZ = 'Europe/Istanbul';
export const DEMIR_ORG_ID = demoId('org:demir');
export const DEMIR_ORG_NAME = 'Demir Yapı A.Ş.';
/**
 * The org's office user (spec §19 question 18, decided 2026-10-14: a separate fictional TR admin;
 * GAP D46). Like Kestrel's DEMO_USERS: a fixed id, the seed's password, a member of this org only.
 */
export const DEMIR_USERS: DemoUser[] = [
  {
    id: demoId('user:elif'),
    email: 'elif@demiryapi.example',
    name: 'Elif Aydın',
    title: 'Operasyon',
    role: 'admin',
  },
];

/** Consent wording the Turkish reporters agreed to (§6.3 consents.text_version). */
export const DEMIR_CONSENT_TEXT_VERSION = 'demo-tr-1';

const ORG = DEMIR_ORG_ID;
/** §18.2: deadline 17:30. */
const DEADLINE = '17:30';
/** The canonical day the org was set up (Mon Oct 5, 2026). */
const SETUP_DAY = '2026-10-05';

interface SiteDef {
  key: string;
  name: string;
  code: string;
  reporter: { key: string; name: string; phone: string; contactPref: ContactPref };
}

/** §18.2 sites and reporters (both TR: locale tr-TR, language tr). */
const SITES: SiteDef[] = [
  {
    key: 'kartal',
    name: 'Kartal Konutları — B Blok',
    code: 'KK-1203',
    reporter: { key: 'emre', name: 'Emre Yıldız', phone: '+905320001203', contactPref: 'call' },
  },
  {
    key: 'atasehir',
    name: 'Ataşehir Ofis Binası',
    code: 'AO-0512',
    reporter: { key: 'selin', name: 'Selin Kaya', phone: '+905320000512', contactPref: 'link' },
  },
];

/** §18.2 companies (trade in brackets); the own crew is the self-perform company. */
const COMPANIES: Array<{ key: string; name: string; trade: string; self?: boolean }> = [
  { key: 'usta-beton', name: 'Usta Beton', trade: 'Beton' },
  { key: 'volt-elektrik', name: 'Volt Elektrik', trade: 'Elektrik' },
  { key: 'akis-mekanik', name: 'Akış Mekanik', trade: 'Mekanik' },
  { key: 'oz-ekip', name: 'Demir Yapı öz ekip', trade: 'Genel işçilik', self: true },
];

/**
 * §18.2 glossary seeds, verbatim: heard → official. §18.2's "TBM / tool box" names two phrases a
 * reporter says, not one: terms match the heard phrase exactly (glossary learning, transcription
 * key terms), so it is two rows with the same official term.
 */
export const DEMIR_GLOSSARY: ReadonlyArray<readonly [heard: string, official: string]> = [
  ['döküm', 'Beton dökümü'],
  ['kalıp söktük', 'Kalıp sökümü yapıldı'],
  ['demirci ekibi', 'Donatı ekibi'],
  ['TBM', 'İş güvenliği bilgilendirmesi'],
  ['tool box', 'İş güvenliği bilgilendirmesi'],
];

export interface DemirOptions {
  /** As kestrel.ts: the live demo date; the org's set-up moves with the calendar. */
  date?: string;
  linkBase?: string;
}

export function buildDemirDemo(opts: DemirOptions = {}): DemoOrgRows {
  const cal = demoCalendar(opts.date);
  const linkBase = opts.linkBase ?? DEMO_LINK_BASE;
  // The set-up day as it lands before today (already mapped: atDate, not at, which maps again).
  const setupDay = cal.pastDay(SETUP_DAY);
  const setup = (time: string) => cal.atDate(setupDay, time, DEMIR_TZ);
  // §18.2: no Turkish voice number yet (VOICE_NUMBER_TR empty), so texts carry no "or call".
  const hasVoiceNumber = false;

  const siteId = (k: string) => demoId(`demir:site:${k}`);
  const reporterId = (k: string) => demoId(`demir:reporter:${k}`);

  const sites: SiteRow[] = SITES.map((s) => ({
    id: siteId(s.key),
    org_id: ORG,
    name: s.name,
    project_code: s.code,
    address: null,
    lat: null,
    lng: null,
    timezone: DEMIR_TZ,
    deadline: null,
    // The column default (§18.2 gives no working hours).
    working_hours: '07:00–15:30',
    status: 'active',
    active_since: setupDay,
    paused_at: null,
    report_seq: 0,
    created_at: setup('09:00'),
  }));

  const reporters: ReporterRow[] = SITES.map((s) => ({
    id: reporterId(s.reporter.key),
    org_id: ORG,
    name: s.reporter.name,
    phone_e164: s.reporter.phone,
    role: 'site_manager',
    languages: ['tr'],
    status: 'active',
    invited_at: setup('09:05'),
    verified_at: null,
    last_invite_error: null,
    created_at: setup('09:05'),
    locale: 'tr-TR',
    contact_pref: s.reporter.contactPref,
    activated_at: setup('09:40'),
    opted_out_at: null,
    // null = the country pack's order (§4.5); a preference comes with week 2.
    message_channel: null,
  }));

  const siteReporters = SITES.map((s) => ({
    site_id: siteId(s.key),
    reporter_id: reporterId(s.reporter.key),
    is_primary: true,
  }));

  const companies: CompanyRow[] = COMPANIES.map((c) => ({
    id: demoId(`demir:company:${c.key}`),
    org_id: ORG,
    name: c.name,
    trade: c.trade,
    aliases: [],
    is_self_perform: !!c.self,
    status: 'confirmed',
    created_at: setup('09:00'),
  }));

  const glossary: GlossaryTermRow[] = DEMIR_GLOSSARY.map(([heard, official]) => ({
    id: demoId(`demir:term:${heard}`),
    org_id: ORG,
    scope_site_id: null,
    scope_reporter_id: null,
    heard,
    official,
    language: 'tr',
    kind: 'term',
    company_id: null,
    status: 'confirmed',
    times_heard: 0,
    first_seen_at: setup('09:00'),
    last_seen_at: null,
  }));

  // The admin joins when the org is set up (her panel language: the org's, ui_locale null).
  const members: OrgMemberRow[] = DEMIR_USERS.map((u) => ({
    org_id: ORG,
    user_id: u.id,
    role: u.role,
    display_name: u.name,
    title: u.title,
    created_at: setup('09:00'),
    ...V12_ROW_DEFAULTS.org_members,
  }));

  const messages: MessageRow[] = [];
  const consents: ConsentRow[] = [];
  const fieldLinks: FieldLinkRow[] = [];
  // The membership's `member.added` row, as for Kestrel's office users (rows.ts `memberAudit`).
  const audit: AuditLogRow[] = memberAudit(members);
  for (const [i, r] of reporters.entries()) {
    const site = sites[i]!;
    const personal = demoLink({
      key: `personal:${r.id}`,
      reporterId: r.id,
      kind: 'personal',
      siteId: null,
      reportDate: null,
      createdAt: r.invited_at!,
      linkBase,
    });
    fieldLinks.push(personal.row);
    // §9.2 `welcome` in Turkish, from the SITELOG sender (one-way: no reply prompt).
    const welcome = demoSms({
      key: `welcome:${r.id}`,
      orgId: ORG,
      reporter: r,
      copyKey: 'welcome',
      body: renderSms(
        'welcome',
        'tr',
        {
          first: firstName(r.name),
          company: DEMIR_ORG_NAME,
          site: site.name,
          deadline: DEADLINE,
          link: personal.url,
        },
        { hasVoiceNumber },
      ),
      at: r.invited_at!,
    });
    messages.push(welcome);
    const given = demoConsents({
      reporter: r,
      givenAt: r.activated_at!,
      textVersion: DEMIR_CONSENT_TEXT_VERSION,
    });
    consents.push(...given);
    audit.push(
      {
        id: 0,
        org_id: ORG,
        actor_type: 'system',
        actor_id: null,
        action: 'field_link.created',
        entity: 'reporter',
        entity_id: r.id,
        diff: { kind: 'personal', site_id: null, report_date: null },
        created_at: r.invited_at!,
      },
      {
        id: 0,
        org_id: ORG,
        actor_type: 'system',
        actor_id: null,
        action: 'sms.sent',
        entity: 'message',
        entity_id: welcome.id,
        diff: { copy_key: 'welcome', provider: 'console' },
        created_at: r.invited_at!,
      },
      {
        id: 0,
        org_id: ORG,
        actor_type: 'reporter',
        actor_id: r.id,
        action: 'consent.given',
        entity: 'reporter',
        entity_id: r.id,
        diff: {
          types: given.map((x) => x.type),
          method: 'web_checkbox',
          text_version: DEMIR_CONSENT_TEXT_VERSION,
          contact_pref: r.contact_pref,
        },
        created_at: r.activated_at!,
      },
    );
  }

  const settings: OrgSettingsRow = {
    // The column defaults (20261011000002 and later), with §18.2's deadline and A4 paper for a
    // Turkish org (GAP D32).
    org_id: ORG,
    default_deadline: `${DEADLINE}:00`,
    working_days: [1, 2, 3, 4, 5],
    default_shift_hours: 8,
    heads_up_enabled: true,
    heads_up_offset_min: -35,
    reminder1_enabled: true,
    reminder1_offset_min: 15,
    reminder2_enabled: true,
    reminder2_offset_min: 60,
    missing_enabled: true,
    missing_offset_min: 90,
    required_fields: ['manpower', 'hours', 'weather', 'work_performed', 'safety', 'photo'],
    filing_mode: 'confirm',
    signoff_required: true,
    email_pdf_on_file: true,
    max_questions_per_report: 3,
    payroll_csv_format: 'generic',
    pdf_paper: 'a4',
    pdf_footer_enabled: true,
    pdf_max_photos: 4,
    letterhead_lines: [],
    no_work_pdf: false,
    include_unconfirmed_in_payroll: true,
    past_due_grace_days: 14,
    payroll_columns: [...PAYROLL_COLUMNS],
    updated_at: setup('09:00'),
    ...V12_ROW_DEFAULTS.org_settings,
  };

  return {
    org: {
      id: ORG,
      name: DEMIR_ORG_NAME,
      address: null,
      license_no: null,
      logo_path: null,
      timezone: DEMIR_TZ,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      // The column default; TR billing is open (spec §19 questions 8 and 9).
      billing_status: 'trialing',
      trial_ends_at: null,
      created_at: setup('09:00'),
      ...V12_ROW_DEFAULTS.orgs,
      // §18.2: Turkey, tr-TR, metric, TRY; a demo org (console SMS driver, Demo phone).
      country: 'TR',
      locale: 'tr-TR',
      units: 'metric',
      currency: 'TRY',
      is_demo: true,
    },
    settings,
    users: DEMIR_USERS,
    members,
    sites,
    reporters,
    siteReporters,
    recipients: [],
    companies,
    glossary,
    conversations: [],
    messages,
    transcripts: [],
    unknownContacts: [],
    siteDays: [],
    reports: [],
    versions: [],
    uploads: [],
    sources: [],
    manpower: [],
    workItems: [],
    weatherEvents: [],
    questions: [],
    consents,
    fieldLinks,
    calls: [],
    invoices: [],
    packs: [],
    notifications: [],
    audit: numberAudit(audit, 2),
  };
}
