import type {
  AuditLogRow,
  CallRow,
  CompanyRow,
  ConsentRow,
  ConversationRow,
  EvidencePackRow,
  FieldLinkRow,
  GlossaryTermRow,
  ManpowerEntryRow,
  MessageRow,
  NotificationRow,
  OrgMemberRow,
  OrgRow,
  OrgSettingsRow,
  QuestionRow,
  ReportRow,
  ReportSourceRow,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRecipientRow,
  SiteReporterRow,
  SiteRow,
  SubInvoiceRow,
  TranscriptRow,
  UnknownContactRow,
  UploadRow,
  WeatherEventRow,
  WorkItemRow,
} from '../db/types.ts';
import type { MemberRole } from '../enums.ts';

export interface DemoUser {
  id: string;
  email: string;
  name: string;
  title: string;
  role: MemberRole;
}

export interface DemoInvoice {
  date: string;
  sites: number;
  amountCents: number;
  status: 'paid' | 'open' | 'past_due';
  url: string;
}

/**
 * The rows of one demo org (§18.1 Kestrel, §18.2 Demir Yapı): the seed generator writes them to SQL
 * (supabase/seed.sql and `pnpm seed:demo -- --apply`), the web panel's demo mode reads Kestrel's.
 */
export interface DemoOrgRows {
  org: OrgRow;
  settings: OrgSettingsRow;
  /** Office users (auth.users) of the org; none for Demir Yapı (spec §19 question 18). */
  users: DemoUser[];
  members: OrgMemberRow[];
  sites: SiteRow[];
  reporters: ReporterRow[];
  siteReporters: SiteReporterRow[];
  recipients: SiteRecipientRow[];
  companies: CompanyRow[];
  /** The org's terms, plus built-in global terms (org_id null) that only seed.sql writes. */
  glossary: GlossaryTermRow[];
  /** WhatsApp threads, one per reporter, kept only for the panel's /try simulator (D29); no messages. */
  conversations: ConversationRow[];
  /** SMS (§6.3 messages): org_id set, no conversation; copy_key names the §9.2 text. */
  messages: MessageRow[];
  transcripts: TranscriptRow[];
  unknownContacts: UnknownContactRow[];
  siteDays: SiteDayRow[];
  reports: ReportRow[];
  versions: ReportVersionRow[];
  /** Web recorder files: voice notes and photos of the reports (§6.3 uploads). */
  uploads: UploadRow[];
  sources: ReportSourceRow[];
  manpower: ManpowerEntryRow[];
  workItems: WorkItemRow[];
  weatherEvents: WeatherEventRow[];
  questions: QuestionRow[];
  /** §6.3 consents of the active reporters (F4 first open). */
  consents: ConsentRow[];
  /** §6.3 field_links: personal, daily and photos links, stored as code hashes. */
  fieldLinks: FieldLinkRow[];
  /** §6.3 calls: the §18.1 call states (seed rows; writing calls at runtime is week 2). */
  calls: CallRow[];
  invoices: SubInvoiceRow[];
  packs: EvidencePackRow[];
  notifications: NotificationRow[];
  /** Deterministic ids (seed-sql.ts `demoAuditId`), so an apply writes the same rows twice. */
  audit: AuditLogRow[];
}

/** Kestrel (§18.1) for the panel's demo mode: the org's rows, its "now" and billing. */
export interface DemoDataset extends DemoOrgRows {
  /**
   * "Now" for the demo, ISO instant: Fri Oct 9 2026 19:05 Chicago; 17:00 on a `--date` day, or the
   * clock when it was built earlier that day (KestrelOptions.clock).
   */
  now: string;
  billing: {
    monthlyCents: number;
    nextInvoiceDate: string;
    paymentMethod: { brand: string; last4: string };
    invoices: DemoInvoice[];
  };
}
