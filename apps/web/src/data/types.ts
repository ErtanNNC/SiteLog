/**
 * View models for every panel page (§11). Pages build against these; the DataSource
 * implementations (demo in-memory, Supabase) assemble them from DB-shaped rows.
 */
import type {
  CallOutcome,
  ContactPref,
  FieldChannel,
  InvoiceStatus,
  MemberRole,
  MessageChannel,
  MsgStatus,
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
import type { CallProgress } from '@sitelog/shared/voice-outbound.ts';
import type { BillingAlert, BillingPrice, BillingProviderName } from '@sitelog/shared/billing.ts';
import type { OrgLocale, ReporterLocale, UnitSystem } from '@sitelog/shared/locale.ts';
import type { CountryPack } from '@sitelog/shared/countries.ts';
import type { CopyKey } from '@/i18n/keys';
import type { NoticeText } from './notices';

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
  /** F24: the member's panel language (`org_members.ui_locale`); null = the org's. */
  uiLocale?: OrgLocale | null;
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
  /** The org's TalkOlog number(s) for texts and calls, E.164 (§11.2 sidebar footer); none yet → []. */
  sitelogNumbers?: string[];
  /** `orgs.is_demo` (§6.3): a demo org, whose texts all go to the Demo phone (§4.5, §11.1). */
  demoOrg?: boolean;
  /**
   * F24 (W4-03): the member's own panel language (`org_members.ui_locale`); null or absent = the
   * org's. It wins over the org's locale, never over a choice made on this device (§11.2).
   */
  uiLocale?: OrgLocale | null;
  /** W4-10 (§19 Q234): the org's price per active site and month; null while TalkOlog set none. */
  price?: BillingPrice | null;
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

/**
 * A panel string by its `copy/en.ts` key (D9), for view models built outside React: the page
 * renders it with `t()`, so the panel's language applies (W1-16). Numbers that read differently per
 * language travel as values: `{ hours }` (184 h · 184 sa), `{ time, tz }` (an instant shown in that
 * time zone), `{ date }` (a `YYYY-MM-DD` day).
 */
export type CopyVarValue =
  string | number | { hours: number } | { time: string; tz: string } | { date: string };

export interface CopyRef {
  key: CopyKey;
  vars?: Record<string, CopyVarValue>;
}

/**
 * How a site reports (§11.3 `ChannelIcon`, F17 "channel icon: link or call"; W1-16): its report's
 * channel when one came in (`web` → link, `voice` → call, `office` → typed in the panel), else
 * the primary reporter's preference (`contact_pref`).
 */
export type OverviewChannel = 'link' | 'call' | 'office';

/** The weather cell: the report's first stoppage (or first period), as the reporter said it. */
export interface OverviewWeather {
  condition: string;
  start: string | null;
  end: string | null;
  impact: string | null;
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
  /** The channel of today's report, else the reporter's preference; null: nobody reports here. */
  channel: OverviewChannel | null;
  /** true: `channel` is how today's report came in; false: how the reporter prefers to report. */
  channelReported: boolean;
  /** ISO instant the voice note was received (shown in the site tz). */
  inAt: string | null;
  crew: number | null;
  hours: number | null;
  weather: OverviewWeather | null;
  lostHours: number;
  weatherDay: boolean;
  reportId: string | null;
  reportNo: string | null;
  isLate: boolean;
  needsReview: boolean;
  reminderStage: number;
  /** Reminder texts (`reminder_1`, `reminder_2`) sent to the reporter today (Web-Overview). */
  remindersSent: number;
}

/** F17 step 2, in priority order. */
export type AttentionKind =
  | 'missing'
  | 'needs_review'
  | 'invoice_gap'
  | 'unknown_contact'
  | 'glossary_review'
  | 'undeliverable';

export type AttentionAction =
  | { kind: 'call'; label: CopyRef; tel: string }
  | { kind: 'text_link'; label: CopyRef; siteId: string; first: string }
  | { kind: 'mark_no_work'; label: CopyRef; siteDayId: string; siteName: string; date: string }
  | { kind: 'review_report'; label: CopyRef; reportId: string }
  | { kind: 'compare_hours'; label: CopyRef; week: string }
  | { kind: 'link_number'; label: CopyRef }
  | { kind: 'open_team'; label: CopyRef }
  | { kind: 'review_terms'; label: CopyRef };

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: CopyRef;
  /** One or more lines, joined with " · ". */
  body: CopyRef[];
  actions: AttentionAction[];
  siteId?: string;
  reportId?: string;
}

/**
 * "Text today's link" when the site has no one to text: api-text-daily-link's 409 `details.code`
 * (nobody linked; nobody linked is active), thrown as a `CodedError` by both data sources.
 */
export const TEXT_LINK_ERROR_CODES = [
  'no_reporter',
  'no_active_reporter',
  // W4-03: Team's row menu names the reporter.
  'reporter_not_linked',
  'reporter_not_active',
] as const;
export type TextDailyLinkErrorCode = (typeof TEXT_LINK_ERROR_CODES)[number];

/** "Text today's link" (F17, W1-16): what the Notifier did. */
export type TextDailyLinkResult =
  | { sent: true; channel: string }
  | {
      sent: false;
      reason: 'no_consent' | 'opted_out' | 'no_channel';
      detail: string | null;
    };

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
  /** W4-04: the latest outbound call today to the site's primary reporter at this site. */
  callToday?: CallToday | null;
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

/**
 * How a report reached TalkOlog, as the panel shows it (§11.3 `ChannelIcon`, P6 Channel filter):
 * `link` = the web recorder from a text link (`field_channel` web), `call` = a phone call (voice).
 * Reports typed in the panel, sent by SMS or from the WhatsApp era have neither.
 */
export type ReportChannel = 'link' | 'call';

export interface ReportFilters {
  siteId?: string | null;
  from?: string | null;
  to?: string | null;
  status?: ReportStatusFilter;
  hasWeatherDelay?: boolean;
  edited?: boolean;
  late?: boolean;
  incident?: boolean;
  /** P6 Channel filter: Any (null) · Link · Call. */
  channel?: ReportChannel | null;
  q?: string;
  page?: number;
  pageSize?: number;
}

export type ReportFlagKind =
  'rain' | 'version' | 'unknown_sub' | 'late' | 'incident' | 'weather_day' | 'no_photo';

/**
 * One archive flag (P6). The page words it in the panel's language (`reports.flags.*`) from its
 * kind and values: `hours` lost (rain), `version` (v2), `time` received (late, site time).
 */
export interface ReportFlag {
  kind: ReportFlagKind;
  hours?: number;
  version?: number;
  time?: string;
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
  /** The archive's channel icon (W1-16's `ChannelIcon`); null: SMS or WhatsApp era. */
  channel: OverviewChannel | null;
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
  /** Channel of a reporter edit (§6.3 report_versions.via): web, voice, sms; null otherwise. */
  via?: FieldChannel | null;
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
  /** A call's speaker lane (§11.3 `TranscriptExcerpt`); absent on a voice note. */
  speaker?: 'reporter' | 'agent';
}

/**
 * One recording of a report (§11.3 `MediaPlayer`): a web-recorder voice note (its upload; a
 * WhatsApp-era report's voice note is its message, the same UUID once backfilled) or a call
 * recording. Every clip has its own player, waveform (`uploads.peaks` / `calls.peaks`),
 * transcript and excerpts; a source's seconds seek the clip it cites.
 */
export interface MediaClip {
  /** The upload (or WhatsApp message) id of a voice note; the call id of a call. */
  id: string;
  kind: 'voice_note' | 'call';
  /** Storage bucket of the file: voice notes in `audio`, call recordings in `calls`. */
  bucket: 'audio' | 'calls';
  peaks: number[];
  durationS: number;
  storagePath: string | null;
  /** Signed URL (10 min) or null (demo mode, or the file is gone). */
  url: string | null;
  /** When TalkOlog received it (a call: when it started). */
  receivedAt: string;
  /** The transcript's language codes, e.g. ['es', 'en']. */
  languages: string[];
  transcript: { language: string | null; text: string; segments: TranscriptSegment[] } | null;
  /** Excerpts for the values this clip is cited for (max 8, in time order). */
  excerpts: TranscriptExcerpt[];
  /**
   * A call's assistant lane (W3-05, `calls.peaks` `{reporter, agent}`): `peaks` is then the
   * reporter's lane. Null or absent: one lane (a voice note, or a v1 call row's single array).
   */
  agentPeaks?: number[] | null;
  /** A call's direction, transport and outcome (P7 provenance and Activity). */
  call?: CallClipInfo | null;
  /** A spoken answer's clip (W2-09, §19 Q93): the question it answers; never report material. */
  questionId?: string | null;
  /** The demo's synthetic recording (tones, no speech), so the page can say so. */
  synthetic?: boolean;
}

export interface CallClipInfo {
  direction: 'inbound' | 'outbound';
  /** `pstn` (the phone network) or `web` (Talk now in the browser). */
  transport: 'pstn' | 'web';
  outcome: CallOutcome | null;
}

export interface TranscriptExcerpt {
  start: number;
  end: number;
  quote: string;
  /** Official English facts mapped from the quote. */
  mapped: string;
  section: 'manpower' | 'weather' | 'work' | 'delivery' | 'safety' | 'next' | 'other';
  /** A call excerpt's speaker. */
  speaker?: 'reporter' | 'agent';
}

/**
 * What an Activity entry records (P7 "Activity"): field events from the audit log, the report's
 * uploads, questions, texts and calls, and the office's actions. The page words each kind in the
 * panel's language (`report.activity.events.*`); `other` shows the audit action as stored.
 */
export type ActivityKind =
  | 'link_opened'
  | 'clip_received'
  | 'photos_received'
  | 'report_started'
  | 'extracted'
  | 'question_asked'
  | 'question_answered'
  | 'question_timeout'
  | 'draft_shown'
  | 'draft_corrected'
  | 'confirmed'
  | 'filed'
  | 'version'
  | 'pdf_rendered'
  | 'pdf_emailed'
  | 'text_sent'
  | 'text_received'
  | 'call_in'
  | 'call_out'
  | 'call_missed'
  | 'whatsapp_in'
  | 'whatsapp_out'
  | 'signed_off'
  | 'signoff_undone'
  | 'signoff_reverted'
  | 'needs_review'
  | 'company_resolved'
  | 'no_work'
  | 'missing'
  | 'voided'
  | 'other';

export interface ActivityEntry {
  id: string;
  at: string;
  actorType: 'agent' | 'reporter' | 'user' | 'system';
  /** The reporter or office user; null for TalkOlog itself (worded by the page). */
  actorName: string | null;
  kind: ActivityKind;
  /**
   * Values the wording takes: `version`, `photos` (count), `seconds` (a clip's or call's length),
   * `channel` (`sms` | `whatsapp` | `web` | `voice` | `push`), `message` (an SMS copy key),
   * `status` (a message's delivery status), `type` (a WhatsApp message type), `action` (other).
   */
  params: Record<string, string | number>;
  /** Data shown as is: a change note, an answer, a question, a company. */
  detail: string | null;
  /**
   * What a source link reveals in the timeline: the question id of an answer, or the WhatsApp
   * message id of a v1 reply.
   */
  anchor: string | null;
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
  /**
   * How the report came in (§6.2 field_channel, `reports.channel`); null on WhatsApp-era reports
   * (D13). With `confirmedVia`, the PDF's source record and the P7 provenance line.
   */
  channel: FieldChannel | null;
  /** How the reporter confirmed it: web (the recorder), voice (on the call), sms. */
  confirmedVia: FieldChannel | null;
  /** The report's language (§9.6): the org's, what the source panel's language line maps to. */
  language: string;
  receivedAt: string | null;
  confirmedAt: string | null;
  filedAt: string | null;
  signedOffBy: string | null;
  signedOffByName: string | null;
  signedOffAt: string | null;
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
  /**
   * The first voice note (or WhatsApp voice note), kept for the browser PDF's evidence summary.
   * The page plays `clips`.
   */
  audio: AudioSourceInfo | null;
  /** Every recording of the report in time order: voice notes and call recordings. */
  clips: MediaClip[];
  /**
   * Spoken answers' clips (W2-09 *Other — say it*, `uploads.question_id`; §19 Q93): not report
   * material, so not in `clips`; P7 plays one from its answer (Activity, the answer's source link).
   */
  answerClips: MediaClip[];
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

/**
 * What a gap day's evidence cites (P8 "evidence links can be voice-note or call timestamps"): the
 * crew line's voice note (or the report's), a call second, an answered question, or only the
 * report (typed in the panel, or edited).
 */
export type InvoiceEvidenceKind = 'voice_note' | 'call' | 'answer' | 'report';

export interface InvoiceEvidence {
  date: string;
  reportId: string;
  reportNo: string;
  siteName: string;
  kind: InvoiceEvidenceKind;
  /**
   * The words behind the hours: the transcript segment at the cited second (a call: the
   * reporter's), or the answer. Null when there is none to read (a typed report; an accounts user,
   * who cannot read transcripts): the page shows `crew` instead.
   */
  quote: string | null;
  /** The crew lines of the company in that report: workers × hours each, and their total. */
  crew: { company: string; lines: Array<{ workers: number; hoursEach: number }>; total: number };
  /** The voice note (upload or WhatsApp message) or call the source cites; P7 plays it. */
  clipId: string | null;
  /** The cited second in that clip, if any. */
  at: number | null;
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
  /** The period's voice evidence (P9, W3-07): a voice note, else a call second; null for none. */
  clip: 'voice_note' | 'call' | null;
  /** The cited second in that clip. */
  audioStart: number | null;
  /** The voice note (upload or WhatsApp message) or call id; P7 opens it at `?clip=&at=`. */
  clipId: string | null;
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
  /**
   * The delay record's evidence (`weather_events.claim_ready`), on a report the site manager
   * confirmed or the office signed off (spec §19 Q134).
   */
  claimReady: boolean;
  /** Spec §19 Q134: filed without the site manager's confirmation and not signed off yet. */
  awaitingSignOff: boolean;
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
  /** The org's units (§10.11): observed values are shown in them. */
  units: UnitSystem;
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

/**
 * P10 statuses (W4-03, v1.2 data): `undeliverable` ("Can't text this number") is read from the
 * welcome's last attempts (W2-01's walk), not from the v1.0 `last_invite_error`.
 */
export type ReporterChipStatus =
  'active' | 'invite_sent' | 'opted_out' | 'undeliverable' | 'disabled';

/** One attempt of the latest welcome message (`messages`, W2-01): what Team reads its status from. */
export interface WelcomeAttempt {
  status: MsgStatus;
  channel: MessageChannel | null;
  provider_message_id: string | null;
  attempt: number;
  dedupe_key: string | null;
}

/** What Team shows beside a reporter row that RLS keeps from the panel (`team_reporter_states`). */
export interface TeamReporterState {
  reporterId: string;
  /** `sms_opt_outs.method` of the phone on the org's pack. */
  optOutMethod: 'sms_keyword' | 'provider_opt_out' | null;
  /** Verified devices not revoked. */
  devices: number;
  /** Consent types held (not revoked). */
  consents: string[];
  welcome: WelcomeAttempt[];
}

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
  /** §2.3: how the reporter prefers to report, a text link or a call. */
  contactPref: ContactPref;
  /** §19 Q21: the preferred message channel; null = the pack's order. */
  messageChannel: MessageChannel | null;
  /** The language TalkOlog uses with them (`reporters.locale`). */
  locale: ReporterLocale;
  /** Who stopped texts (§19 Q242): the person by STOP, or the provider; null when not opted out. */
  optOutBy: 'person' | 'provider' | null;
  /** Verified phones signed in (F16, §19 Q244). */
  devices: number;
  /** Consent types they hold (Edit says when a chosen channel has none, §19 Q243). */
  consents: string[];
  /** §19 Q243: the preferred channel has no consent yet, so messages go another way. */
  channelUnreachable: boolean;
  /** §19 Q241 (W4-12): the latest welcome was the automatic re-send. */
  autoResent: boolean;
  /** W4-04: their latest outbound call today (the office's Call now or the ladder's), from `calls`. */
  callToday: CallToday | null;
}

/**
 * W4-04 (F3, §19 Q230): a reporter's latest outbound call today, as Team and Site detail show its
 * progress (requested, ringing, answered, not reached, failed).
 */
export interface CallToday {
  id: string;
  progress: CallProgress;
  /** When it was requested (UTC). */
  at: string;
  /** The office's Call now (`daily_report`), not the ladder's call. */
  byOffice: boolean;
  /** Queued, ringing or in progress: Call now waits until it ends. */
  live: boolean;
}

/** Team's RPC refusals the panel words itself (`team.errors.*`, W4-03): CodedError codes. */
export const TEAM_RPC_CODES = [
  'attestation_required',
  'channel_not_offered',
  'locale_not_offered',
  'two_way_pack',
  'opted_out_by_person',
  'not_opted_out',
] as const;
export type TeamRpcCode = (typeof TEAM_RPC_CODES)[number];

/** The org's country pack as Team needs it (§4.6). */
export interface TeamPack {
  code: string;
  /** Languages TalkOlog uses with field users; the first is a new reporter's default. */
  fieldLocales: ReporterLocale[];
  /** The pack's order (§4.5). */
  messageChannels: MessageChannel[];
  /** What Edit offers: the pack's built channels other than push (as the recorder's Settings). */
  settingsChannels: MessageChannel[];
  twoWaySms: boolean;
  /** Where the reporter can call TalkOlog (§19 Q33: a call preference without one uses Talk now). */
  hasVoiceNumber: boolean;
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
  pack: TeamPack;
  /** The org's locale: an office user's "company's language" (F24). */
  orgLocale: OrgLocale;
  /** §19 Q51, Q132 (`placesCalls`): a demo org, or a pack with an outbound trunk here. */
  placesCalls: boolean;
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
  /** TalkOlog's global term (`org_id` null): read-only for the office. */
  isGlobal: boolean;
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
    /** W4-05: the org's country pack code (`orgs.country`). */
    country: string;
    /** A demo org: its texts and calls are `console` (the Demo phone). */
    isDemo: boolean;
    /** §19 Q233: the report language and units new report versions take. */
    locale: OrgLocale;
    units: UnitSystem;
  };
  /** W4-05: the org's country pack, read-only on Settings → Field channels (null: not loaded). */
  pack: CountryPack | null;
  settings: OrgSettings;
  siteRecipients: Array<{ siteId: string; siteName: string; emails: string[] }>;
}

// ───────────────────────────── P13 Billing ─────────────────────────────

export interface BillingData {
  plan: {
    /** `orgs.billing_provider` (§19 Q236): `manual` → no Checkout or portal, TalkOlog invoices. */
    provider: BillingProviderName;
    /** The org's price per active site and month (§19 Q234); null while TalkOlog has set none. */
    price: BillingPrice | null;
    activeSites: number;
    /** Price × active sites in minor units, computed here; null without a price. */
    monthlyMinor: number | null;
    nextInvoiceDate: string;
    paymentMethod: { brand: string; last4: string } | null;
    status: string | null;
    trialEndsAt: string | null;
    /** A Stripe subscription exists (not canceled); without one, payment buttons open Checkout. */
    hasSubscription: boolean;
    /** `org_settings.past_due_grace_days` (F23: 14). */
    graceDays: number;
  };
  /** The past-due / trial-ended state the banner shows (§19 Q235), or null. */
  alert: BillingAlert | null;
  sites: Array<{
    id: string;
    name: string;
    projectCode: string;
    activeSince: string | null;
    status: SiteStatus;
    /** The site's monthly price: the org's price while active, null when paused or unpriced. */
    monthlyMinor: number | null;
    pausedAt: string | null;
  }>;
  invoices: Array<{
    /** Stripe invoice id (Supabase mode). */
    id?: string;
    date: string;
    sites: number;
    amountMinor: number;
    /** ISO 4217, upper case. */
    currency: string;
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
  /** The stored English title and body: shown when `notice` is null. */
  title: string;
  body: string | null;
  /** The notice's wording in the reader's language (`notifications.data`, data/notices.ts). */
  notice: NoticeText | null;
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
  pack: {
    code: string;
    twoWaySms: boolean;
    /** W2-16: the pack lists WhatsApp: the Demo phone types WhatsApp replies too. */
    whatsapp: boolean;
  };
  reporters: DemoPhoneReporter[];
}

/** One text of a thread: `out` from TalkOlog to the reporter, `in` from the reporter. */
export interface DemoPhoneMessage {
  id: string;
  direction: 'in' | 'out';
  body: string;
  status: string;
  /** §9.2 copy key of a text TalkOlog sent (`welcome`, `verify_code`, …). */
  copyKey: string | null;
  provider: string | null;
  /**
   * W2-14: `sms` or `push` (a push to the installed field app has no phone); W2-15 `whatsapp`;
   * W3-17 `call`: a demo org's outbound call on the console telephony (§19 Q132), with `call`.
   */
  channel: 'sms' | 'push' | 'whatsapp' | 'call';
  at: string;
  /** W3-17: the call's state (`calls.status`, `outcome`, `purpose`, `attempt`). */
  call?: { status: string; outcome: string | null; purpose: string | null; attempt: number | null };
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

// ───────────────────────────── Ops (/ops, TalkOlog staff only) ─────────────────────────────

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

/**
 * /ops (spec §19 Q44, W1-16): unknown contacts no org may see (an SMS on a shared sender with no
 * history, or with history in several orgs), and the real orgs support can give one to.
 */
export interface OrglessContacts {
  contacts: Array<{
    id: string;
    phone: string;
    channel: FieldChannel | null;
    snippet: string | null;
    createdAt: string;
  }>;
  orgs: Array<{ id: string; name: string; country: string }>;
}

/**
 * W3-17 (M8, spec §16.2): per org and ISO week, the site-days TalkOlog called a reporter about (an
 * outbound ladder call or callback) and those filed by the reporter's yes on such a call.
 */
export interface OpsOutboundCalls {
  orgId: string;
  orgName: string;
  isDemo: boolean;
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  callDays: number;
  filedByCall: number;
}

/** /ops (W4-10, `ops_org_billing()`): an org's billing for TalkOlog staff. */
export interface OpsOrgBilling {
  orgId: string;
  orgName: string;
  country: string;
  isDemo: boolean;
  provider: BillingProviderName;
  status: string | null;
  trialEndsAt: string | null;
  hasSubscription: boolean;
  price: BillingPrice | null;
  activeSites: number;
}

export interface OpsData {
  queue: OpsQueueRow[];
  deadJobs: OpsDeadJob[];
  costOutliers: OpsCostOutlier[];
  /** W3-17: the M8 measure (`ops_outbound_call_share`). */
  outboundCalls: OpsOutboundCalls[];
}
