import type {
  AuditLogRow,
  CompanyRow,
  ConversationRow,
  EvidencePackRow,
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

/** Row-shaped demo data: the seed generator writes it to SQL, the web panel uses it in demo mode. */
export interface DemoDataset {
  /** "Now" for the demo, ISO instant (Fri Oct 9 2026 19:05 Chicago). */
  now: string;
  org: OrgRow;
  settings: OrgSettingsRow;
  users: DemoUser[];
  members: OrgMemberRow[];
  sites: SiteRow[];
  reporters: ReporterRow[];
  siteReporters: SiteReporterRow[];
  recipients: SiteRecipientRow[];
  companies: CompanyRow[];
  glossary: GlossaryTermRow[];
  conversations: ConversationRow[];
  messages: MessageRow[];
  transcripts: TranscriptRow[];
  unknownContacts: UnknownContactRow[];
  siteDays: SiteDayRow[];
  reports: ReportRow[];
  versions: ReportVersionRow[];
  /** Files of report sources (D14); none in the WhatsApp-era Kestrel data (W1-06 adds them). */
  uploads: UploadRow[];
  sources: ReportSourceRow[];
  manpower: ManpowerEntryRow[];
  workItems: WorkItemRow[];
  weatherEvents: WeatherEventRow[];
  questions: QuestionRow[];
  invoices: SubInvoiceRow[];
  packs: EvidencePackRow[];
  notifications: NotificationRow[];
  audit: AuditLogRow[];
  billing: {
    monthlyCents: number;
    nextInvoiceDate: string;
    paymentMethod: { brand: string; last4: string };
    invoices: DemoInvoice[];
  };
}
