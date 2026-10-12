/**
 * The one interface every page talks to. Two implementations:
 *  - demo/DemoSource.ts — in-memory over the §18 Kestrel dataset (no Supabase)
 *  - supabase/SupabaseSource.ts — supabase-js queries, RPCs, edge functions, realtime
 */
import type {
  InvoiceStatus,
  MemberRole,
  ReporterRole,
  ReporterStatus,
  TermKind,
} from '@sitelog/shared/enums.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import type {
  BillingData,
  ChangeEvent,
  GlossaryData,
  HoursMatrix,
  NavBadges,
  NotificationItem,
  OpsData,
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

/** Team → Edit reporter (§P10). The phone is not editable: disable and invite the new number. */
export interface UpdateReporterInput {
  reporterId: string;
  name: string;
  role: ReporterRole;
  siteIds: string[];
  languages: string[];
}

/** Upper bound of one PDF zip export (signed URLs are fetched and zipped in the browser). */
export const PDF_EXPORT_LIMIT = 200;

/** Which reports to export: explicit ids (selected rows) or every report matching the filters. */
export type PdfSelection = { reportIds: string[] } | { filters: ReportFilters };

export interface PdfLink {
  reportId: string;
  reportNo: string;
  /** Signed URL (10 min) of the current version's PDF. */
  url: string;
}

export interface PdfLinkBatch {
  files: PdfLink[];
  /** Report numbers in the selection without a rendered PDF yet. */
  missing: string[];
  /** Reports in the selection before the PDF_EXPORT_LIMIT cap. */
  total: number;
  /** True when `total` exceeded PDF_EXPORT_LIMIT and only the first ones were resolved. */
  capped: boolean;
}

export interface LinkUnknownSenderInput {
  unknownSenderId: string;
  siteId: string;
  name: string;
  /** Defaults to `backup` (F11). */
  role?: ReporterRole;
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

/** A daily report typed in the panel (no WhatsApp, no AI): filed at once as version 1. */
export interface CreateOfficeReportInput {
  siteId: string;
  /** YYYY-MM-DD in the site's time zone; today or earlier. */
  date: string;
  data: DailyReportData;
}

export interface CreateOfficeReportResult {
  reportId: string;
  reportNo: string;
  /** false: the site-day already had a live report, which is returned unchanged. */
  created: boolean;
}

/** A report PDF rendered in the browser (@sitelog/pdf) for one version. */
export interface SaveReportPdfInput {
  reportId: string;
  reportNo: string;
  siteId: string;
  version: number;
  pdf: Blob;
}

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
  /**
   * Signed URLs (10 min) of the current-version PDFs for a set of reports, capped at
   * PDF_EXPORT_LIMIT. Demo mode only has the PDFs rendered in this browser session.
   */
  getPdfUrls(selection: PdfSelection): Promise<PdfLinkBatch>;
  /** Stripe customer portal session URL (payment method, invoices); demo rejects. */
  /** Stripe Checkout session URL to start the subscription (14-day trial, §F2 step 4, §19 #4). */
  getBillingCheckoutUrl(): Promise<string>;
  getBillingPortalUrl(): Promise<string>;

  // ─── Mutations ───
  signOff(reportId: string): Promise<void>;
  undoSignOff(reportId: string): Promise<void>;
  createReportVersion(
    reportId: string,
    data: DailyReportData,
    changeNote: string,
  ): Promise<{ version: number }>;
  /** create_office_report: returns the existing report when the site-day already has one. */
  createOfficeReport(input: CreateOfficeReportInput): Promise<CreateOfficeReportResult>;
  /**
   * Stores a browser-rendered PDF as the version's PDF and returns a URL to open it. Supabase:
   * pdfs/{org}/{site}/{report_no}_v{n}.pdf + attach_version_pdf; demo: an in-memory object URL.
   */
  saveReportPdf(input: SaveReportPdfInput): Promise<string>;
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
  /** Team row menu: Disable (→ `disabled`) or re-enable (→ `invited`). */
  setReporterStatus(reporterId: string, status: ReporterStatus): Promise<void>;
  /** Team row menu: one re-send of `sitelog_welcome` (F3 edge case). */
  resendInvite(reporterId: string): Promise<void>;
  /** Team row menu → Edit: name, role, sites, languages in one audited change. */
  updateReporter(input: UpdateReporterInput): Promise<void>;
  addOfficeUser(input: { email: string; role: MemberRole; name?: string }): Promise<void>;
  changeMemberRole(userId: string, role: MemberRole): Promise<void>;
  removeMember(userId: string): Promise<void>;
  createOrg(input: CreateOrgInput): Promise<{ orgId: string }>;
  createSite(input: CreateSiteInput): Promise<{ siteId: string }>;
  updateSite(siteId: string, patch: UpdateSitePatch): Promise<void>;
  /**
   * Upload (PNG/SVG ≤ 2 MB, validated by the caller) or clear (`null`) the company logo used on
   * PDFs. `orgId` defaults to the source's org (the setup wizard passes a freshly created one).
   */
  setOrgLogo(file: File | null, orgId?: string): Promise<void>;
  pauseSite(siteId: string): Promise<void>;
  resumeSite(siteId: string): Promise<void>;
  requestEvidencePack(input: RequestEvidencePackInput): Promise<{ packId: string }>;
  /** Object URL of the payroll CSV for a week (caller revokes it). */
  payrollCsvUrl(week: string, siteId?: string | null): Promise<string>;
  markNotificationsRead(ids: string[]): Promise<void>;

  // ─── Platform ops (/ops, §15): SiteLog operators only, never an org role ───
  /** True when the signed-in user is in `platform_admins`; false (not an error) otherwise. */
  isPlatformAdmin(): Promise<boolean>;
  /** Queue health, dead jobs and cost outliers across every org (RPCs refuse non-operators). */
  getOps(): Promise<OpsData>;
  /** Dead job → queued, attempts reset, due now (audited). */
  retryDeadJob(jobId: number): Promise<void>;
  /** Dead job → discarded, kept for forensics (audited). */
  discardDeadJob(jobId: number): Promise<void>;

  // ─── Realtime ───
  subscribe(onChange: (event: ChangeEvent) => void): () => void;

  /** Demo only: a late report arrives for the missing site. */
  simulateIncomingReport?(): Promise<{ changed: boolean }>;
}
