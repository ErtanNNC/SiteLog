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
import type { OfficePhotoMime, OfficePhotoUpload } from '@sitelog/shared/report/photos.ts';
import type { StoredReportData } from '@sitelog/shared/schemas/report.ts';
import type {
  BillingData,
  ChangeEvent,
  DemoPhoneData,
  DemoPhoneEmail,
  DemoPhoneMessage,
  GlossaryData,
  HoursMatrix,
  NavBadges,
  NotificationItem,
  OpsData,
  OrgSettingsPatch,
  OrgSummary,
  OrglessContacts,
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
  TextDailyLinkResult,
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
  /** The report's date (YYYY-MM-DD) and current version: the §12 file name (D33). */
  date: string;
  version: number;
  /** Signed URL (10 min) of the current version's PDF. */
  url: string;
}

export interface PdfLinkBatch {
  files: PdfLink[];
  /** Reports in the selection without a stored PDF yet (the export renders them in the browser). */
  missing: Array<Omit<PdfLink, 'url'>>;
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

/** Company details (name, time zone, address, licence number) of the current org. */
export interface UpdateOrgInput {
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

/**
 * The site exists once createSite resolves. Saving its recipients or inviting its manager runs
 * after the insert; a failure there is returned instead of thrown, so the caller never retries
 * (and duplicates) a site that was created.
 */
export interface CreateSiteResult {
  siteId: string;
  /** Message of a failed manager invite (the welcome text); null when it was queued or not asked. */
  inviteError: string | null;
  /** Message of a failed recipients save; null when saved or not asked. */
  recipientsError: string | null;
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
  /**
   * Report data v2 (W1-12): create_office_report stamps the date, the org's report language and
   * units (and keeps v1 data from a panel built before W1-12 as v1).
   */
  data: StoredReportData;
  /** Photos uploaded with uploadReportPhoto() for this site (at most OFFICE_PHOTO_MAX). */
  photos?: OfficePhotoUpload[];
}

/** An office photo in the `photos` bucket, not attached to a report yet. */
export interface UploadedPhoto {
  /** {org}/{site}/office/{uuid}.jpg (officePhotoStoragePath). */
  path: string;
  mime: OfficePhotoMime;
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
  /**
   * create_report_version. `data.photos` lists the report's photos the new version keeps (with
   * their captions, in order); `photos` are new uploads, each placed at its `position` among them
   * (none: after them). `data` has the shape of the version it edits (ReportDetail.storedData).
   */
  createReportVersion(
    reportId: string,
    data: StoredReportData,
    changeNote: string,
    photos?: OfficePhotoUpload[],
    /**
     * The version the edit was opened on (W2-11 review, spec §19 Q106): a newer one refuses the
     * edit with CodedError `version_changed` ("This report changed. Reload …").
     */
    baseVersion?: number,
  ): Promise<{ version: number }>;
  /**
   * create_office_report: returns the existing report when the site-day already has one (its
   * photos are then not attached).
   */
  createOfficeReport(input: CreateOfficeReportInput): Promise<CreateOfficeReportResult>;
  /**
   * The report (not void) a site's day already has, as create_office_report() finds it; New
   * report checks this before it uploads any photo.
   */
  findDayReport(
    siteId: string,
    date: string,
  ): Promise<{ reportId: string; reportNo: string } | null>;
  /**
   * Uploads a prepared photo for a report of this site, before the call that files it. Supabase:
   * photos/{org}/{site}/office/{uuid}.jpg (no overwrite); demo: an in-memory object URL.
   */
  uploadReportPhoto(siteId: string, photo: Blob, mime: OfficePhotoMime): Promise<UploadedPhoto>;
  /**
   * Stores a browser-rendered PDF as the version's PDF and returns a URL to open it. Supabase:
   * pdfs/{org}/{site}/{report_no}_v{n}.pdf + attach_version_pdf; demo: an in-memory object URL.
   */
  saveReportPdf(input: SaveReportPdfInput): Promise<string>;
  markNoWork(siteDayId: string): Promise<void>;
  /**
   * F17 "Text today's link" (W1-16): today's daily link to the site's reporter through the
   * Notifier (api-text-daily-link; the demo writes the console text). `requestId` makes one tap
   * one text, however often the request is retried.
   */
  textDailyLink(siteId: string, requestId: string): Promise<TextDailyLinkResult>;
  resolveUnknownCompany(input: ResolveUnknownCompanyInput): Promise<void>;
  reviewGlossaryTerm(input: ReviewGlossaryTermInput): Promise<void>;
  addGlossaryTerm(input: AddGlossaryTermInput): Promise<void>;
  saveSettings(patch: OrgSettingsPatch): Promise<void>;
  saveSiteRecipients(siteId: string, emails: string[]): Promise<void>;
  addInvoice(input: AddInvoiceInput): Promise<void>;
  setInvoiceStatus(invoiceId: string, status: InvoiceStatus): Promise<void>;
  /**
   * The reporter's status after the invite: `opted_out` when the number sent STOP before (no
   * welcome text reaches it), else `invited` (or `active` for one already set up).
   */
  inviteReporter(input: InviteReporterInput): Promise<{ status: ReporterStatus }>;
  linkUnknownSender(input: LinkUnknownSenderInput): Promise<void>;
  ignoreUnknownSender(unknownSenderId: string): Promise<void>;
  /** Team row menu: Disable (→ `disabled`) or re-enable (→ `invited`). */
  setReporterStatus(reporterId: string, status: ReporterStatus): Promise<void>;
  /** Team row menu: one re-send of the welcome text (F3 edge case). */
  resendInvite(reporterId: string): Promise<void>;
  /** Team row menu → Edit: name, role, sites, languages in one audited change. */
  updateReporter(input: UpdateReporterInput): Promise<void>;
  addOfficeUser(input: { email: string; role: MemberRole; name?: string }): Promise<void>;
  changeMemberRole(userId: string, role: MemberRole): Promise<void>;
  removeMember(userId: string): Promise<void>;
  /**
   * Admin: edit the current org's company details (update_org, audited). Orgs are created only by
   * the no-org setup wizard (create_org), never through a source, which always has an org.
   */
  updateOrg(input: UpdateOrgInput): Promise<void>;
  createSite(input: CreateSiteInput): Promise<CreateSiteResult>;
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

  // ─── Demo phone (/dev/phone, §11.1): admins; the console texts and emails ───
  /** The reporters and their newest text, the org's demo flag and its pack's two-way SMS. */
  getDemoPhone(): Promise<DemoPhoneData>;
  /** A reporter's thread, oldest first (SMS rows of the org). */
  getDemoPhoneThread(reporterId: string): Promise<DemoPhoneMessage[]>;
  /** What the console email provider would have sent for this org, newest first. */
  getDemoPhoneEmails(): Promise<DemoPhoneEmail[]>;
  /**
   * Types a text as the reporter (demo orgs on two-way packs only): the same handler as an inbound
   * SMS (sms-webhook `/demo-reply`), so STOP, START, HELP, CALL and TEXT act as on a phone.
   */
  sendDemoPhoneReply(reporterId: string, body: string): Promise<void>;
  /** Live updates of the Demo phone's texts and emails (its own channel, not the org-wide one). */
  subscribeDemoPhone(onChange: () => void): () => void;

  // ─── Platform ops (/ops, §15): SiteLog operators only, never an org role ───
  /** True when the signed-in user is in `platform_admins`; false (not an error) otherwise. */
  isPlatformAdmin(): Promise<boolean>;
  /** Queue health, dead jobs and cost outliers across every org (RPCs refuse non-operators). */
  getOps(): Promise<OpsData>;
  /** Dead job → queued, attempts reset, due now (audited). */
  retryDeadJob(jobId: number): Promise<void>;
  /** Dead job → discarded, kept for forensics (audited). */
  discardDeadJob(jobId: number): Promise<void>;
  /** Org-less unknown contacts and the real orgs (spec §19 Q44; ops_* RPCs refuse non-operators). */
  getOrglessContacts(): Promise<OrglessContacts>;
  /** Gives an org-less contact to a real org, which then links or ignores it (audited). */
  assignUnknownContact(contactId: string, orgId: string): Promise<void>;
  /** Ignores an org-less contact (audited). */
  ignoreOrglessContact(contactId: string): Promise<void>;

  // ─── Realtime ───
  subscribe(onChange: (event: ChangeEvent) => void): () => void;

  /** Demo only: a late report arrives for the missing site. */
  simulateIncomingReport?(): Promise<{ changed: boolean }>;
}
