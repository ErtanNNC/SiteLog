/**
 * View models for every panel page (§11). Pages build against these; the DataSource
 * implementations (demo in-memory, Supabase) assemble them from DB-shaped rows.
 */
import type {
  ContactPref,
  FieldChannel,
  InvoiceStatus,
  MemberRole,
  PackStatus,
  ReportStatus,
  ReporterRole,
  ReporterStatus,
  SiteDayStatus,
  SiteStatus,
  TermKind,
  TermStatus,
  VersionAuthor,
} from '@sitelog/shared/enums.ts';
import type { ChipVariant } from '@sitelog/shared/status.ts';
import type {
  DailyReportData,
  ObservedWeather,
  StoredReportData,
} from '@sitelog/shared/schemas/report.ts';
import type { ReportTotals } from '@sitelog/shared/report/hours.ts';
import type { OrgSettingsRow } from '@sitelog/shared/db/types.ts';
import type { OrgLocale } from '@sitelog/shared/locale.ts';

export interface Chip {
  variant: ChipVariant;
  label: string;
}

// ───────────────────────────── Shared bits ─────────────────────────────

export interface SiteOption {
  id: string;
  name: string;
  shortName: string;
  projectCode: string;
  timezone: string;
  status: SiteStatus;
}

export interface SiteInfo extends SiteOption {
  address: string | null;
  lat: number | null;
  lng: number | null;
  /** "17:30" (site override or org default). */
  deadline: string;
  workingHours: string | null;
  activeSince: string | null;
  pausedAt: string | null;
}

export interface ReporterSummary {
  id: string;
  name: string;
  firstName: string;
  phone: string;
  role: ReporterRole;
  languages: string[];
  status: ReporterStatus;
  isPrimary: boolean;
  /** §2.3 `contact_pref`: how they prefer to report, a text link or a call (P5, W1-18). */
  contactPref: ContactPref;
}

export interface CompanyOption {
  id: string;
  name: string;
  trade: string | null;
  status: 'confirmed' | 'unconfirmed';
  isSelfPerform: boolean;
  aliases: string[];
}

export interface OfficeUser {
  userId: string;
  name: string;
  email: string | null;
  title: string | null;
  role: MemberRole;
}

export interface OrgSummary {
  id: string;
  name: string;
  timezone: string;
  activeSites: number;
  role: MemberRole;
  /** `orgs.locale` (§6.3) when known: the panel's default language without a choice (§11.2). */
  locale?: OrgLocale;
  /** `orgs.country` (§6.3), its country pack's code (§4.6) when known: the wizard's locked country. */
  country?: string;
  /** The org's SiteLog number(s) for texts and calls, E.164 (§11.2 sidebar footer); none yet → []. */
  sitelogNumbers?: string[];
  /** `orgs.is_demo` (§6.3): a demo org, whose texts all go to the Demo phone (§4.5, §11.1). */
  demoOrg?: boolean;
}

// ───────────────────────────── P3 Overview ─────────────────────────────

export interface OverviewSegments {
  filed: number;
  weather: number;
  missing: number;
  awaiting: number;
  noWork: number;
}

export interface OverviewKpis {
  reportsIn: number;
  total: number;
  segments: OverviewSegments;
  crewOnSite: number;
  laborHours: number;
  weatherAffectedSites: number;
  weatherLostHours: number;
}

export interface OverviewSiteRow {
  siteId: string;
  siteName: string;
  siteShort: string;
  projectCode: string;
  timezone: string;
  managerName: string | null;
  managerFirstName: string | null;
  managerPhone: string | null;
  siteDayId: string | null;
  siteDayStatus: SiteDayStatus | null;
  chip: Chip;
  /** ISO instant the voice note was received (shown in the site tz). */
  inAt: string | null;
  crew: number | null;
  hours: number | null;
  weatherImpact: string | null;
  lostHours: number;
  weatherDay: boolean;
  reportId: string | null;
  reportNo: string | null;
  isLate: boolean;
  needsReview: boolean;
  reminderStage: number;
}

export type AttentionKind =
  'missing' | 'needs_review' | 'invoice_gap' | 'unknown_sender' | 'glossary_review';

export type AttentionAction =
  | { kind: 'call'; label: string; tel: string }
  | { kind: 'mark_no_work'; label: string; siteDayId: string; siteName: string; date: string }
  | { kind: 'review_report'; label: string; reportId: string }
  | { kind: 'compare_hours'; label: string; week: string }
  | { kind: 'link_number'; label: string }
  | { kind: 'review_terms'; label: string };

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  body: string;
  actions: AttentionAction[];
  siteId?: string;
  reportId?: string;
}

export interface OverviewData {
  /** Org-local date "YYYY-MM-DD". */
  today: string;
  now: string;
  timezone: string;
  /** Active sites (the ones that report today). */
  siteCount: number;
  /** Paused sites: an org whose sites are all paused is not an org with no sites. */
  pausedCount: number;
  /** Some active site has a verified site manager linked (who reports and gets reminders). */
  hasReporter: boolean;
  /** `hasReporter` and the first reminder is turned on in Settings → Reports. */
  remindersOn: boolean;
  /** Earliest site deadline today, "17:30". */
  earliestDeadline: string;
  /** First reminder time, "17:45". */
  reminder1At: string;
  kpis: OverviewKpis;
  sitesToday: OverviewSiteRow[];
  needsAttention: AttentionItem[];
  /** Report ids filed today (for "Today's PDFs"; one without a stored PDF is rendered first). */
  pdfReportIds: string[];
}

// ───────────────────────────── P4 Sites ─────────────────────────────

export type StreakStatus = 'on_time' | 'late' | 'weather_day' | 'missing' | 'pending';

export interface StreakCell {
  date: string;
  status: StreakStatus;
}

export interface SiteCard {
  siteId: string;
  name: string;
  shortName: string;
  projectCode: string;
  status: SiteStatus;
  timezone: string;
  chip: Chip;
  reportId: string | null;
  streak: StreakCell[];
  onTime14: number;
  reporterName: string | null;
  reporterPhone: string | null;
  /** The primary reporter's §2.3 `contact_pref` (P4 "preference icon", W1-18). */
  reporterContactPref: ContactPref | null;
  crewToday: number | null;
  weatherDaysMonth: number;
  needsAttention: boolean;
  activeSince: string | null;
  pausedAt: string | null;
}

// ───────────────────────────── P5 Site detail ─────────────────────────────

export interface CalendarCell {
  date: string;
  isWorkday: boolean;
  isToday: boolean;
  isFuture: boolean;
  status: SiteDayStatus | null;
  chip: Chip | null;
  crew: number | null;
  hours: number | null;
  weatherAffected: boolean;
  lostHours: number;
  reportId: string | null;
  isLate: boolean;
  /** P5 "channel dot per day" (W1-18): how the day's filed report came in; null: none, or v1.0. */
  channel: CalendarChannel | null;
}

/** A report's `field_channel` as the calendar shows it: web (and SMS) → link, voice → call. */
export type CalendarChannel = 'link' | 'call' | 'office';

/** P5 crew-by-company badges; the page words them (`siteDetail.badges`, W1-18). */
export type CrewBadge =
  | { kind: 'edited'; version: number }
  | { kind: 'asked'; time: string }
  | { kind: 'confirmed_by_answer' }
  | { kind: 'unconfirmed' };

export interface CrewRow {
  companyId: string | null;
  companyName: string;
  trade: string | null;
  area: string | null;
  workers: number | null;
  hours: number | null;
  hoursBasis: string | null;
  unconfirmed: boolean;
  badges: CrewBadge[];
}

export interface SiteDetail {
  site: SiteInfo;
  reporters: ReporterSummary[];
  recipients: string[];
  month: string;
  cells: CalendarCell[];
  latest: {
    date: string;
    reportId: string;
    reportNo: string;
    summary: string;
    crew: number | null;
    hours: number | null;
    weatherHours: number;
    chip: Chip;
  } | null;
  monthStats: {
    reports: number;
    onTime: number;
    workdaysSoFar: number;
    weatherHours: number;
    laborHours: number;
    avgCrew: number | null;
  };
  crewToday: { date: string; rows: CrewRow[]; totalWorkers: number; totalHours: number } | null;
  photoCount: number;
  /** Photos tab (P5): every photo attached to this site's reports, newest first. */
  photos?: SitePhoto[];
}

export interface SitePhoto {
  messageId: string;
  reportId: string;
  reportNo: string;
  date: string;
  caption: string | null;
  takenAt: string | null;
  storagePath: string | null;
  /** Signed URL (10 min) or null in demo mode. */
  url: string | null;
}

// ───────────────────────────── P6 Reports ─────────────────────────────

export type ReportStatusFilter = 'all' | 'filed' | 'needs_review' | 'signed_off' | 'weather_day';

export interface ReportFilters {
  siteId?: string | null;
  from?: string | null;
  to?: string | null;
  status?: ReportStatusFilter;
  hasWeatherDelay?: boolean;
  edited?: boolean;
  late?: boolean;
  incident?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

export type ReportFlagKind =
  'rain' | 'version' | 'unknown_sub' | 'late' | 'incident' | 'weather_day';

export interface ReportFlag {
  kind: ReportFlagKind;
  label: string;
}

export interface ReportListItem {
  reportId: string;
  reportNo: string;
  date: string;
  siteId: string;
  siteName: string;
  siteShort: string;
  timezone: string;
  managerName: string | null;
  crew: number | null;
  hours: number | null;
  version: number;
  flags: ReportFlag[];
  chip: Chip;
  status: ReportStatus;
  needsReview: boolean;
  isLate: boolean;
  kind: string;
  pdfPath: string | null;
}

export interface ReportList {
  items: ReportListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Sum of lost hours in the filtered set (for the footer "build pack" action). */
  weatherHours: number;
}

// ───────────────────────────── P7 Report review ─────────────────────────────

export interface ReportVersionSummary {
  version: number;
  author: VersionAuthor;
  authorName: string;
  changeNote: string | null;
  createdAt: string;
  isCurrent: boolean;
  pdfPath: string | null;
}

export interface AudioSourceInfo {
  /** The voice note's media id: its upload, else its WhatsApp message (one UUID once backfilled). */
  messageId: string;
  peaks: number[];
  durationS: number;
  storagePath: string | null;
  /** Signed URL (10 min) or null in demo mode. */
  url: string | null;
  receivedAt: string;
  language: string | null;
}

/** A photo the viewed version shows (its data.photos, in order): WhatsApp or office upload. */
export interface PhotoSourceInfo {
  /**
   * The photo's media id (the key of its data.photos entry: `messageId` in v1, `uploadId` in v2):
   * its upload, else its WhatsApp message (one UUID for media the migration backfilled).
   */
  messageId: string;
  storagePath: string | null;
  /** uploads.mime, else messages.media_mime (image/jpeg, image/png, image/webp…). */
  mime: string | null;
  url: string | null;
  caption: string | null;
  takenAt: string | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptExcerpt {
  start: number;
  end: number;
  quote: string;
  /** Official English facts mapped from the quote. */
  mapped: string;
  section: 'manpower' | 'weather' | 'work' | 'delivery' | 'safety' | 'next' | 'other';
}

export interface ActivityEntry {
  id: string;
  at: string;
  actorType: 'agent' | 'reporter' | 'user' | 'system';
  actorName: string;
  label: string;
  detail: string | null;
  messageId: string | null;
}

export interface QuestionItem {
  id: string;
  field: string;
  prompt: string;
  options: string[];
  askedAt: string | null;
  answeredAt: string | null;
  /** The answering message (a v1 report's reply source names it, not the question). */
  answeredMessageId: string | null;
  answer: string | null;
  companyName: string | null;
  manpowerIndex: number | null;
}

export interface MessageItem {
  id: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  at: string;
}

export interface ReportHeader {
  id: string;
  reportNo: string;
  date: string;
  status: ReportStatus;
  currentVersion: number;
  needsReview: boolean;
  reviewReasons: string[];
  isLate: boolean;
  kind: string;
  receivedAt: string | null;
  confirmedAt: string | null;
  filedAt: string | null;
  signedOffBy: string | null;
  signedOffByName: string | null;
  signedOffAt: string | null;
  /** `reports.channel` / `confirmed_via` (null: v1.0 WhatsApp, D13): the PDF's source record. */
  channel: FieldChannel | null;
  confirmedVia: FieldChannel | null;
}

export interface ReportDetail {
  report: ReportHeader;
  site: SiteInfo;
  reporter: ReporterSummary | null;
  /** The version being viewed (current unless `?v=` selects another). */
  version: number;
  /** The viewed version's data as every view reads it: §10.3 v2 (a stored v1 is upgraded, D20). */
  data: DailyReportData;
  /**
   * The same version as stored (v1 or v2). The office editor builds the new version from this, so
   * create_report_version receives the stored version's own shape (writers stay v1 until W1-12).
   */
  storedData: StoredReportData;
  /** Previous version's data (v2, like `data`) for the "EDITED V2 · was …" diff, if any. */
  previousData: DailyReportData | null;
  versions: ReportVersionSummary[];
  totals: ReportTotals;
  audio: AudioSourceInfo | null;
  photos: PhotoSourceInfo[];
  transcript: { language: string | null; text: string; segments: TranscriptSegment[] } | null;
  excerpts: TranscriptExcerpt[];
  activity: ActivityEntry[];
  messages: MessageItem[];
  questions: QuestionItem[];
  companies: CompanyOption[];
  selfPerformCompanyIds: string[];
  settings: { signoffRequired: boolean; filingMode: string; defaultShiftHours: number };
  pdfUrl: string | null;
  prevReportId: string | null;
  nextReportId: string | null;
  /** Delay-log hours for the chip "In delay log · 3.5 h". */
  delayLogHours: number;
}

// ───────────────────────────── P8 Crew hours ─────────────────────────────

export type HoursRowStatus = 'match' | 'gap' | 'awaiting' | 'unconfirmed';

export interface HoursRow {
  key: string;
  companyId: string | null;
  companyName: string;
  trade: string | null;
  siteNames: string[];
  /** Mon–Fri hours. */
  days: number[];
  reported: number;
  invoiced: number | null;
  gap: number | null;
  status: HoursRowStatus;
  unconfirmed: boolean;
  invoiceId: string | null;
  invoiceNo: string | null;
  invoiceStatus: InvoiceStatus | null;
  /** Report ids per weekday (for "Confirm" links and evidence). */
  reportIdsByDay: Array<string[]>;
}

export interface InvoiceDayComparison {
  date: string;
  invoiced: number;
  reported: number;
  gap: number;
  reportIds: string[];
}

export interface InvoiceEvidence {
  date: string;
  reportId: string;
  reportNo: string;
  siteName: string;
  quote: string;
  audioStart: number | null;
  messageId: string | null;
}

export interface InvoiceDetail {
  invoiceId: string;
  invoiceNo: string;
  companyId: string;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  status: InvoiceStatus;
  filePath: string | null;
  days: InvoiceDayComparison[];
  totals: { invoiced: number; reported: number; gap: number };
  evidence: InvoiceEvidence[];
}

export interface HoursMatrix {
  week: string;
  weekStart: string;
  weekEnd: string;
  days: string[];
  siteId: string | null;
  sites: SiteOption[];
  companies: CompanyOption[];
  rows: HoursRow[];
  totals: { days: number[]; reported: number; invoiced: number; gap: number };
  kpis: { subHours: number; companies: number; gapHours: number; gapSubs: number };
  invoices: InvoiceDetail[];
  /** False when a site filter is on (invoices are per company, not per site). */
  hasInvoiceComparison: boolean;
}

// ───────────────────────────── P9 Weather & delays ─────────────────────────────

export interface HeatmapCell {
  siteId: string;
  date: string;
  hours: number;
}

export interface DelayEvidence {
  audioStart: number | null;
  messageId: string | null;
  photos: number;
  weatherData: boolean;
  photoRequested: boolean;
}

export interface DelayEntry {
  id: string;
  reportId: string;
  reportNo: string;
  siteId: string;
  siteName: string;
  siteShort: string;
  date: string;
  condition: string;
  impact: string | null;
  start: string | null;
  end: string | null;
  lostHours: number;
  fullDay: boolean;
  /**
   * weather_events.observed, the SQL copy of the version's weather.observed, in §10.3 v2 terms:
   * a v1 version's copy (precipIn …) is upgraded on read (observedWeatherOf in assemble.ts).
   */
  observed: ObservedWeather | null;
  evidence: DelayEvidence;
  claimReady: boolean;
}

export interface PackItem {
  id: string;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  status: PackStatus;
  sections: string[];
  createdAt: string;
  readyAt: string | null;
  pdfPath: string | null;
  url: string | null;
  /** Still queued well after it was requested: nothing is building it. */
  notStarted: boolean;
}

export interface WeatherLog {
  month: string;
  siteId: string | null;
  sites: SiteOption[];
  days: string[];
  cells: HeatmapCell[];
  maxHours: number;
  kpis: { siteDays: number; hours: number; claimReady: number; entries: number };
  entries: DelayEntry[];
  packs: PackItem[];
}

// ───────────────────────────── P10 Team ─────────────────────────────

export type ReporterChipStatus =
  'active' | 'invite_sent' | 'not_on_whatsapp' | 'opted_out' | 'disabled';

export interface TeamReporter {
  id: string;
  name: string;
  phone: string;
  role: ReporterRole;
  languages: string[];
  status: ReporterStatus;
  chipStatus: ReporterChipStatus;
  sites: Array<{ id: string; name: string; shortName: string; isPrimary: boolean }>;
  onTime30: number | null;
  reports30: number;
  lastInviteError: string | null;
  /** §2.3: how the reporter prefers to report, a text link or a call. */
  contactPref: ContactPref;
}

export interface UnknownSenderItem {
  id: string;
  phone: string;
  at: string;
  snippet: string | null;
  guessedSiteId: string | null;
  guessedSiteName: string | null;
  messageId: string | null;
  /** null: a WhatsApp sender; `voice` or `sms`: a caller or texter (linked from W1-16 on). */
  channel: FieldChannel | null;
}

export interface TeamData {
  reporters: TeamReporter[];
  unknownSenders: UnknownSenderItem[];
  officeUsers: OfficeUser[];
  sites: SiteOption[];
}

// ───────────────────────────── P11 Glossary ─────────────────────────────

export interface GlossaryTerm {
  id: string;
  heard: string;
  official: string | null;
  kind: TermKind;
  language: string;
  status: TermStatus;
  timesHeard: number;
  scopeSiteId: string | null;
  scopeSiteName: string | null;
  companyId: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  isBuiltIn: boolean;
}

export interface GlossaryData {
  reviewQueue: GlossaryTerm[];
  terms: GlossaryTerm[];
  companies: CompanyOption[];
  sites: SiteOption[];
}

// ───────────────────────────── P12 Settings ─────────────────────────────

export type OrgSettings = Omit<OrgSettingsRow, 'org_id' | 'updated_at'>;
export type OrgSettingsPatch = Partial<OrgSettings>;

export interface SettingsData {
  org: {
    id: string;
    name: string;
    address: string | null;
    licenseNo: string | null;
    /** `orgs.tax_no`: the PDF letterhead's tax line (§12). */
    taxNo: string | null;
    timezone: string;
    logoPath: string | null;
    /** Signed URL (Supabase) or in-memory object URL (demo) of the logo, for previews. */
    logoUrl: string | null;
  };
  settings: OrgSettings;
  siteRecipients: Array<{ siteId: string; siteName: string; emails: string[] }>;
}

// ───────────────────────────── P13 Billing ─────────────────────────────

export interface BillingData {
  plan: {
    monthlyCents: number;
    activeSites: number;
    pricePerSiteCents: number;
    nextInvoiceDate: string;
    paymentMethod: { brand: string; last4: string } | null;
    status: string | null;
    trialEndsAt: string | null;
    /** A Stripe subscription exists (not canceled); without one, payment buttons open Checkout. */
    hasSubscription: boolean;
  };
  sites: Array<{
    id: string;
    name: string;
    projectCode: string;
    activeSince: string | null;
    status: SiteStatus;
    monthlyCents: number;
    pausedAt: string | null;
  }>;
  invoices: Array<{
    /** Stripe invoice id (Supabase mode). */
    id?: string;
    date: string;
    sites: number;
    amountCents: number;
    status: 'paid' | 'open' | 'past_due';
    /** Stripe hosted invoice page; empty / '#' → open the customer portal instead. */
    url: string;
  }>;
}

// ───────────────────────────── P2 Setup ─────────────────────────────

export interface SetupState {
  hasOrg: boolean;
  orgId: string | null;
  orgName: string | null;
  timezone: string;
  siteCount: number;
  reporterCount: number;
  steps: { company: boolean; site: boolean; reports: boolean };
  /** Existing project numbers (uniqueness check in the wizard). */
  projectCodes?: string[];
}

// ───────────────────────────── Shell ─────────────────────────────

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  targetPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export type SearchKind = 'report' | 'site' | 'company' | 'transcript' | 'reporter' | 'term';

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

export interface NavBadges {
  reportsToReview: number;
  unknownSenders: number;
  termsToReview: number;
  unreadNotifications: number;
}

/** Realtime change event — hooks invalidate the matching queries. */
// ───────────────────────────── Demo phone (/dev/phone, §11.1) ─────────────────────────────

/** A reporter of the Demo phone's list, with the newest text of their thread. */
export interface DemoPhoneReporter {
  id: string;
  name: string;
  /** E.164. */
  phone: string;
  status: string;
  /** Texts in the thread. */
  count: number;
  lastAt: string | null;
  lastBody: string | null;
}

export interface DemoPhoneData {
  /** `orgs.is_demo`: the Demo phone is for demo orgs (staging also shows real orgs' texts). */
  orgIsDemo: boolean;
  /** The org's country pack: replies can be typed only where SMS is two-way (spec §19 Q35). */
  pack: { code: string; twoWaySms: boolean };
  reporters: DemoPhoneReporter[];
}

/** One text of a thread: `out` from SiteLog to the reporter, `in` from the reporter. */
export interface DemoPhoneMessage {
  id: string;
  direction: 'in' | 'out';
  body: string;
  status: string;
  /** §9.2 copy key of a text SiteLog sent (`welcome`, `verify_code`, …). */
  copyKey: string | null;
  provider: string | null;
  at: string;
}

/** An email the console provider would have sent (`console_emails`). */
export interface DemoPhoneEmail {
  id: string;
  kind: string;
  recipients: string[];
  subject: string;
  body: string;
  attachments: Array<{ filename: string; bytes: number }>;
  at: string;
}

export interface ChangeEvent {
  table: 'site_days' | 'reports' | 'notifications' | 'unknown_contacts' | 'evidence_packs' | 'all';
  id?: string | null;
}

// ───────────────────────────── Ops (/ops, SiteLog staff only) ─────────────────────────────

/** Queue health per job type (§15 reliability). */
export interface OpsQueueRow {
  type: string;
  queued: number;
  running: number;
  dead: number;
  /** Seconds the oldest due job has waited to be claimed; null when none is waiting. */
  oldestDueSeconds: number | null;
}

/** A dead-lettered job. `payload` holds ids and enum-like fields only (no phones or texts). */
export interface OpsDeadJob {
  id: number;
  type: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  payload: Record<string, string | number | boolean>;
}

/** A filed report whose cost passed 3× the 30-day median (§15 cost guardrail). */
export interface OpsCostOutlier {
  reportId: string;
  reportNo: string;
  orgId: string;
  orgName: string;
  siteId: string;
  siteName: string;
  filedAt: string;
  costCents: number;
  medianCents: number | null;
  sample: number;
  aiUsd: number | null;
  waTemplates: number | null;
}

export interface OpsData {
  queue: OpsQueueRow[];
  deadJobs: OpsDeadJob[];
  costOutliers: OpsCostOutlier[];
}
