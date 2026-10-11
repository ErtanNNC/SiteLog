/**
 * The one interface every page talks to. Two implementations:
 *  - demo/DemoSource.ts — in-memory over the §18 Kestrel dataset (no Supabase)
 *  - supabase/SupabaseSource.ts — supabase-js queries, RPCs, edge functions, realtime
 */
import type { InvoiceStatus, MemberRole, ReporterRole, TermKind } from '@sitelog/shared/enums.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import type {
  BillingData,
  ChangeEvent,
  GlossaryData,
  HoursMatrix,
  NavBadges,
  NotificationItem,
  OrgSettingsPatch,
  OrgSummary,
  OverviewData,
  ReportDetail,
  ReportFilters,
  ReportList,
  SearchResult,
  SettingsData,
  SetupState,
  SiteCard,
  SiteDetail,
  TeamData,
  WeatherLog,
} from './types';

export interface SourceUser {
  id: string;
  email: string | null;
  name: string;
  role: MemberRole;
}

export interface ResolveUnknownCompanyInput {
  reportId: string;
  name: string;
  action: 'add' | 'map';
  companyId?: string | null;
}

export interface ReviewGlossaryTermInput {
  termId: string;
  action: 'approve' | 'change' | 'reject' | 'add_company' | 'map_company';
  official?: string | null;
  companyId?: string | null;
}

export interface AddGlossaryTermInput {
  heard: string;
  official: string;
  kind: TermKind;
  language?: string;
  scopeSiteId?: string | null;
}

export interface AddInvoiceInput {
  companyId: string;
  invoiceNo: string;
  periodStart: string;
  periodEnd: string;
  /** Per-day hours; the total is derived when `totalHours` is omitted. */
  lines: Array<{ date: string; hours: number }>;
  totalHours?: number | null;
  file?: File | null;
}

export interface InviteReporterInput {
  name: string;
  phone: string;
  role: ReporterRole;
  siteIds: string[];
  languages: string[];
}

export interface LinkUnknownSenderInput {
  unknownSenderId: string;
  siteId: string;
  name: string;
}

export interface CreateOrgInput {
  name: string;
  timezone: string;
  address?: string | null;
  licenseNo?: string | null;
}

export interface CreateSiteInput {
  name: string;
  projectCode: string;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  timezone: string;
  deadline?: string | null;
  workingHours?: string | null;
  recipients?: string[];
  reporter?: InviteReporterInput | null;
}

export type UpdateSitePatch = Partial<
  Pick<
    CreateSiteInput,
    'name' | 'projectCode' | 'address' | 'lat' | 'lng' | 'timezone' | 'deadline' | 'workingHours'
  >
>;

export interface RequestEvidencePackInput {
  siteId: string | null;
  periodStart: string;
  periodEnd: string;
  sections: string[];
}

export interface DataSource {
  readonly mode: 'demo' | 'supabase';
  readonly orgId: string;
  readonly user: SourceUser;
  /** "Now" — the demo is frozen at Fri Oct 9 2026 19:05 Chicago; Supabase uses the clock. */
  now(): Date;

  // ─── Reads ───
  getOrgs(): Promise<OrgSummary[]>;
  getOverview(): Promise<OverviewData>;
  getSites(): Promise<SiteCard[]>;
  getSiteDetail(siteId: string, month: string): Promise<SiteDetail>;
  listReports(filters: ReportFilters): Promise<ReportList>;
  getReportDetail(reportId: string, version?: number | null): Promise<ReportDetail>;
  getHours(week: string, siteId?: string | null): Promise<HoursMatrix>;
  getWeather(month: string, siteId?: string | null): Promise<WeatherLog>;
  getTeam(): Promise<TeamData>;
  getGlossary(): Promise<GlossaryData>;
  getSettings(): Promise<SettingsData>;
  getBilling(): Promise<BillingData>;
  getNotifications(): Promise<NotificationItem[]>;
  getNavBadges(): Promise<NavBadges>;
  getSetupState(): Promise<SetupState>;
  search(q: string): Promise<SearchResult[]>;
  /** Signed URLs (10 min) for today's filed PDFs; demo returns []. */
  getTodaysPdfUrls(): Promise<Array<{ reportNo: string; url: string }>>;

  // ─── Mutations ───
  signOff(reportId: string): Promise<void>;
  undoSignOff(reportId: string): Promise<void>;
  createReportVersion(
    reportId: string,
    data: DailyReportData,
    changeNote: string,
  ): Promise<{ version: number }>;
  markNoWork(siteDayId: string): Promise<void>;
  resolveUnknownCompany(input: ResolveUnknownCompanyInput): Promise<void>;
  reviewGlossaryTerm(input: ReviewGlossaryTermInput): Promise<void>;
  addGlossaryTerm(input: AddGlossaryTermInput): Promise<void>;
  saveSettings(patch: OrgSettingsPatch): Promise<void>;
  saveSiteRecipients(siteId: string, emails: string[]): Promise<void>;
  addInvoice(input: AddInvoiceInput): Promise<void>;
  setInvoiceStatus(invoiceId: string, status: InvoiceStatus): Promise<void>;
  inviteReporter(input: InviteReporterInput): Promise<void>;
  linkUnknownSender(input: LinkUnknownSenderInput): Promise<void>;
  ignoreUnknownSender(unknownSenderId: string): Promise<void>;
  addOfficeUser(input: { email: string; role: MemberRole; name?: string }): Promise<void>;
  changeMemberRole(userId: string, role: MemberRole): Promise<void>;
  removeMember(userId: string): Promise<void>;
  createOrg(input: CreateOrgInput): Promise<{ orgId: string }>;
  createSite(input: CreateSiteInput): Promise<{ siteId: string }>;
  updateSite(siteId: string, patch: UpdateSitePatch): Promise<void>;
  pauseSite(siteId: string): Promise<void>;
  resumeSite(siteId: string): Promise<void>;
  requestEvidencePack(input: RequestEvidencePackInput): Promise<{ packId: string }>;
  /** Object URL of the payroll CSV for a week (caller revokes it). */
  payrollCsvUrl(week: string, siteId?: string | null): Promise<string>;
  markNotificationsRead(ids: string[]): Promise<void>;

  // ─── Realtime ───
  subscribe(onChange: (event: ChangeEvent) => void): () => void;

  /** Demo only: a late report arrives for the missing site. */
  simulateIncomingReport?(): Promise<{ changed: boolean }>;
}
