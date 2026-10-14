/**
 * Pure assemblers: DB-shaped rows → page view models. Used by the DemoSource (whole dataset in
 * memory) and the SupabaseSource (rows fetched per page scope), so the aggregation logic — and
 * its tests against the §18 numbers — is shared. No I/O, no React.
 */
import type {
  AuditLogRow,
  CompanyRow,
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
} from '@sitelog/shared/db/types.ts';
import {
  isActiveReporterStatus,
  isReporterAuthor,
  type InvoiceStatus,
} from '@sitelog/shared/enums.ts';
import { reportChip, siteDayChip } from '@sitelog/shared/status.ts';
import type { ChipVariant } from '@sitelog/shared/status.ts';
import type {
  DailyReportData,
  ManpowerEntry,
  ObservedWeather,
  ObservedWeatherV1,
  Photo,
  PhotoV1,
  Source,
  StoredReportData,
} from '@sitelog/shared/schemas/report.ts';
import { deriveTotals } from '@sitelog/shared/report/hours.ts';
import type { ReportTotals } from '@sitelog/shared/report/hours.ts';
import { normalizePayrollColumns, type PayrollColumn } from '@sitelog/shared/report/payroll.ts';
import { versionPhotos } from '@sitelog/shared/report/photos.ts';
import {
  isVoiceSourceKind,
  mediaOf,
  sourceMediaId,
  transcriptMediaId,
  voiceMediaIdOf,
  type MediaRef,
} from '@sitelog/shared/report/media.ts';
import {
  readReportData,
  upgradeObservedV1,
  upgradePhotosV1,
} from '@sitelog/shared/report/upgrade.ts';
import { isWorkingDay } from '@sitelog/shared/schedule/day.ts';
import {
  addDays,
  daysBetween,
  firstName,
  formatAudioTimestamp,
  formatDateInTz,
  formatHours,
  formatMonthDay,
  formatPhone,
  formatTimeInTz,
  isoWeekOf,
  isoWeekRange,
  parseIsoDate,
} from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import { formatGap, formatHoursNum } from '@/lib/format';
import { groupBy, isRecord, sum, uniq } from '@/lib/utils';
import type {
  ActivityEntry,
  AttentionItem,
  BillingData,
  CalendarCell,
  Chip,
  CompanyOption,
  CrewRow,
  DelayEntry,
  GlossaryData,
  GlossaryTerm,
  HeatmapCell,
  HoursMatrix,
  HoursRow,
  InvoiceDetail,
  InvoiceEvidence,
  MessageItem,
  NavBadges,
  NotificationItem,
  OfficeUser,
  OverviewData,
  OverviewSiteRow,
  PackItem,
  QuestionItem,
  ReportDetail,
  ReportFilters,
  ReportFlag,
  ReportList,
  ReportListItem,
  ReporterSummary,
  SearchResult,
  SettingsData,
  SetupState,
  SiteCard,
  SiteDetail,
  SitePhoto,
  SiteInfo,
  SiteOption,
  StreakCell,
  StreakStatus,
  TeamData,
  TeamReporter,
  TranscriptExcerpt,
  TranscriptSegment,
  WeatherLog,
} from './types';

// ───────────────────────────── Row set ─────────────────────────────

export interface MemberInfo extends OrgMemberRow {
  email?: string | null;
}

/** Weather rows may come from `weather_events` (demo) or the `current_weather` view. */
export type WeatherLike = WeatherEventRow & { report_no?: string };

/** Manpower rows may come from `manpower_entries` (demo) or the `current_manpower` view. */
export type ManpowerLike = ManpowerEntryRow & {
  date?: string;
  site_id?: string;
  report_no?: string;
  report_status?: string;
};

export interface RowSet {
  org: OrgRow;
  settings: OrgSettingsRow;
  members: MemberInfo[];
  sites: SiteRow[];
  reporters: ReporterRow[];
  siteReporters: SiteReporterRow[];
  recipients: SiteRecipientRow[];
  companies: CompanyRow[];
  glossary: GlossaryTermRow[];
  messages: MessageRow[];
  /**
   * Files of report sources (D14): office photos since 20261014000002 and the media the
   * migration backfilled with their message ids. Readers take a source's file from here first and
   * from `messages` otherwise (mediaIndex). Optional: rows from before W1-06 have none.
   */
  uploads?: UploadRow[];
  transcripts: TranscriptRow[];
  unknownContacts: UnknownContactRow[];
  siteDays: SiteDayRow[];
  reports: ReportRow[];
  versions: ReportVersionRow[];
  sources: ReportSourceRow[];
  manpower: ManpowerLike[];
  weatherEvents: WeatherLike[];
  questions: QuestionRow[];
  invoices: SubInvoiceRow[];
  packs: EvidencePackRow[];
  notifications: NotificationRow[];
  audit: AuditLogRow[];
  billing?: Omit<BillingData['plan'], 'hasSubscription'> & { invoices: BillingData['invoices'] };
  /**
   * `data.photos` of report versions whose full row is not in `versions` (the Supabase Photos
   * tab loads only this column for the site's older reports).
   */
  photoLists?: Array<{
    report_id: string;
    version: number;
    photos: unknown;
    /** `data.schemaVersion` of that version (its photos are v1 entries unless it is 2). */
    schemaVersion?: unknown;
  }>;
}

export interface AssembleCtx {
  now: Date;
  userId: string;
}

export const PRICE_PER_SITE_CENTS = 39_900;
export const PAGE_SIZE = 50;

// ───────────────────────────── Helpers ─────────────────────────────

const FILED_STATUSES = new Set(['filed', 'signed_off']);

export function shortSiteName(name: string): string {
  // "Riverside Lofts — Block B" → "Riverside B"; "Pier 9 Warehouse Retrofit" → "Pier 9"
  const [main, suffix] = name.split(/\s+[—–-]\s+/);
  const words = (main ?? name).split(/\s+/);
  const base = words.length > 2 ? words.slice(0, 2).join(' ') : (main ?? name);
  if (suffix) {
    const last = suffix.split(/\s+/).pop();
    return `${words[0]} ${last}`.trim();
  }
  if (/^Pier \d+/.test(name)) return words.slice(0, 2).join(' ');
  return words.length >= 2 && /^(st\.?|street|ave\.?|rd\.?)$/i.test(words[1] ?? '')
    ? words.slice(0, 2).join(' ')
    : (words[0] ?? base);
}

export function hhmm(time: string | null | undefined, fallback = '17:30'): string {
  return (time ?? fallback).slice(0, 5);
}

export function addMinutesToHHMM(time: string, minutes: number): string {
  const [h, m] = hhmm(time).split(':').map(Number) as [number, number];
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function siteDeadline(site: SiteRow, settings: OrgSettingsRow): string {
  return hhmm(site.deadline ?? settings.default_deadline);
}

export function toSiteOption(s: SiteRow): SiteOption {
  return {
    id: s.id,
    name: s.name,
    shortName: shortSiteName(s.name),
    projectCode: s.project_code,
    timezone: s.timezone,
    status: s.status,
  };
}

export function toSiteInfo(s: SiteRow, settings: OrgSettingsRow): SiteInfo {
  return {
    ...toSiteOption(s),
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    deadline: siteDeadline(s, settings),
    workingHours: s.working_hours,
    activeSince: s.active_since,
    pausedAt: s.paused_at,
  };
}

export function toCompanyOption(c: CompanyRow): CompanyOption {
  return {
    id: c.id,
    name: c.name,
    trade: c.trade,
    status: c.status,
    isSelfPerform: c.is_self_perform,
    aliases: c.aliases ?? [],
  };
}

export function toReporterSummary(r: ReporterRow, isPrimary: boolean): ReporterSummary {
  return {
    id: r.id,
    name: r.name,
    firstName: firstName(r.name),
    phone: r.phone_e164,
    role: r.role,
    languages: r.languages ?? [],
    status: r.status,
    isPrimary,
  };
}

/** A version's data as stored: v1 (WhatsApp era, and every writer until W1-12) or v2. */
export function storedVersionData(v: ReportVersionRow): StoredReportData {
  return v.data as unknown as StoredReportData;
}

/**
 * A version's data as every view reads it: §10.3 v2, a stored v1 upgraded on read (D20). Null
 * without the row, or for a row loaded without its `data` column (list queries select less).
 */
export function versionData(v: ReportVersionRow | undefined): DailyReportData | null {
  if (!v || !isRecord(v.data)) return null;
  return readReportData(storedVersionData(v));
}

/** A version's `data->photos` loaded on its own (RowSet.photoLists), in v2 terms like versionData. */
function photoListOf(
  p: { photos: unknown; schemaVersion?: unknown } | undefined,
): DailyReportData['photos'] | undefined {
  if (!p || !Array.isArray(p.photos)) return undefined;
  return p.schemaVersion === 2 ? (p.photos as Photo[]) : upgradePhotosV1(p.photos as PhotoV1[]);
}

export function memberName(rows: RowSet, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = rows.members.find((x) => x.user_id === userId);
  return m?.display_name ?? m?.email ?? null;
}

export function selfPerformIds(rows: RowSet): Set<string> {
  return new Set(rows.companies.filter((c) => c.is_self_perform).map((c) => c.id));
}

export function totalsOf(rows: RowSet, data: DailyReportData): ReportTotals {
  return deriveTotals(data, { selfPerformCompanyIds: selfPerformIds(rows) });
}

export function workdaysBetween(
  from: string,
  to: string,
  workingDays: readonly number[],
): string[] {
  const out: string[] = [];
  if (from > to) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(d, workingDays)) out.push(d);
  return out;
}

export function lastWorkdays(today: string, n: number, workingDays: readonly number[]): string[] {
  const out: string[] = [];
  let d = today;
  let guard = 0;
  while (out.length < n && guard++ < 60) {
    if (isWorkingDay(d, workingDays)) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

export function monthDays(yearMonth: string): string[] {
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${yearMonth}-${String(i + 1).padStart(2, '0')}`);
}

/** Index built once per assembly. */
export interface Index {
  siteById: Map<string, SiteRow>;
  reporterById: Map<string, ReporterRow>;
  companyById: Map<string, CompanyRow>;
  reportById: Map<string, ReportRow>;
  reportBySiteDay: Map<string, ReportRow>;
  siteDayById: Map<string, SiteDayRow>;
  siteDaysBySite: Map<string, SiteDayRow[]>;
  versionsByReport: Map<string, ReportVersionRow[]>;
  primaryReporterBySite: Map<string, ReporterRow>;
  reportDate: Map<string, string>;
}

export function buildIndex(rows: RowSet): Index {
  const siteById = new Map(rows.sites.map((s) => [s.id, s]));
  const reporterById = new Map(rows.reporters.map((r) => [r.id, r]));
  const companyById = new Map(rows.companies.map((c) => [c.id, c]));
  const reportById = new Map(rows.reports.map((r) => [r.id, r]));
  // The report a site-day shows: never a void one, and a filed / signed-off one over a draft.
  const reportBySiteDay = new Map<string, ReportRow>();
  for (const r of rows.reports) {
    if (r.status === 'void') continue;
    const have = reportBySiteDay.get(r.site_day_id);
    if (!have || (!FILED_STATUSES.has(have.status) && FILED_STATUSES.has(r.status)))
      reportBySiteDay.set(r.site_day_id, r);
  }
  const siteDayById = new Map(rows.siteDays.map((d) => [d.id, d]));
  const siteDaysBySite = groupBy(rows.siteDays, (d) => d.site_id);
  const versionsByReport = groupBy(rows.versions, (v) => v.report_id);
  for (const list of versionsByReport.values()) list.sort((a, b) => a.version - b.version);
  const primaryReporterBySite = new Map<string, ReporterRow>();
  for (const sr of rows.siteReporters) {
    if (!sr.is_primary) continue;
    const r = reporterById.get(sr.reporter_id);
    if (r) primaryReporterBySite.set(sr.site_id, r);
  }
  const reportDate = new Map<string, string>();
  for (const r of rows.reports) {
    const sd = siteDayById.get(r.site_day_id);
    if (sd) reportDate.set(r.id, sd.date);
  }
  return {
    siteById,
    reporterById,
    companyById,
    reportById,
    reportBySiteDay,
    siteDayById,
    siteDaysBySite,
    versionsByReport,
    primaryReporterBySite,
    reportDate,
  };
}

export function currentVersion(ix: Index, report: ReportRow): ReportVersionRow | undefined {
  return ix.versionsByReport.get(report.id)?.find((v) => v.version === report.current_version);
}

/** Uploads and messages by id: where a source's file is (report/media.ts mediaOf). */
export interface MediaIndex {
  uploads: ReadonlyMap<string, UploadRow>;
  messages: ReadonlyMap<string, MessageRow>;
}

export function mediaIndex(rows: Pick<RowSet, 'uploads' | 'messages'>): MediaIndex {
  return {
    uploads: new Map((rows.uploads ?? []).map((u) => [u.id, u])),
    messages: new Map(rows.messages.map((m) => [m.id, m])),
  };
}

/** A source's file: its upload, else its message. */
export function sourceMedia(source: ReportSourceRow, media: MediaIndex): MediaRef | undefined {
  return mediaOf(source, media.uploads, media.messages);
}

/** One photo a version shows, with its file (storage path, type). */
export interface ShownPhoto {
  source: ReportSourceRow;
  /** The source's media id (upload, else message): the id data.photos keys it by. */
  id: string;
  media: MediaRef | undefined;
  caption: string | null;
  takenAt: string | null;
}

/**
 * The photos a version shows (versionPhotos: its data.photos in order; every photo of the report
 * for data without the list). The file's caption (an upload's, or a WhatsApp message's body)
 * stands in for a missing caption only then: with a list, a caption cleared in an edit stays
 * cleared.
 */
export function shownPhotos(
  photos: unknown,
  sources: readonly ReportSourceRow[],
  media: MediaIndex,
): ShownPhoto[] {
  const listed = Array.isArray(photos);
  return versionPhotos(listed ? (photos as DailyReportData['photos']) : null, sources).flatMap(
    ({ source, caption, takenAt }) => {
      const id = sourceMediaId(source);
      if (!id) return [];
      const file = sourceMedia(source, media);
      return [
        {
          source,
          id,
          media: file,
          caption: listed ? caption : (caption ?? file?.text ?? null),
          takenAt: takenAt ?? file?.receivedAt ?? null,
        },
      ];
    },
  );
}

/** Typed in the panel (create_office_report): no reporter and version 1 by an office user. */
export function isOfficeEntry(ix: Index, report: ReportRow): boolean {
  if (report.reporter_id) return false;
  return ix.versionsByReport.get(report.id)?.find((v) => v.version === 1)?.author === 'office_user';
}

/** The report's site manager; older rows without one fall back to the site's primary reporter. */
function reporterOf(ix: Index, report: ReportRow): ReporterRow | undefined {
  if (report.reporter_id) return ix.reporterById.get(report.reporter_id);
  return isOfficeEntry(ix, report) ? undefined : ix.primaryReporterBySite.get(report.site_id);
}

export function reportForSiteDay(ix: Index, sd: SiteDayRow | undefined): ReportRow | null {
  if (!sd) return null;
  if (sd.report_id) {
    const linked = ix.reportById.get(sd.report_id);
    if (linked && linked.status !== 'void') return linked;
  }
  return ix.reportBySiteDay.get(sd.id) ?? null;
}

export function chipForSiteDay(sd: SiteDayRow | undefined | null, report: ReportRow | null): Chip {
  if (!sd) return { variant: 'pending', label: copy.chips.pending };
  return siteDayChip(
    sd.status,
    report ? { status: report.status, needsReview: report.needs_review } : null,
  );
}

export function chipForReport(report: ReportRow): Chip {
  return reportChip({ status: report.status, needsReview: report.needs_review });
}

export function streakStatusOf(sd: SiteDayRow | undefined, report: ReportRow | null): StreakStatus {
  if (!sd) return 'pending';
  switch (sd.status) {
    case 'filed':
      return sd.is_late || report?.is_late ? 'late' : 'on_time';
    case 'weather_day':
      return 'weather_day';
    case 'missing':
      return 'missing';
    default:
      return 'pending';
  }
}

/** Current-version manpower rows of filed/signed-off reports, with the date resolved. */
export function currentManpower(
  rows: RowSet,
  ix: Index,
): Array<ManpowerLike & { date: string; site_id: string; report_no: string }> {
  const out: Array<ManpowerLike & { date: string; site_id: string; report_no: string }> = [];
  for (const m of rows.manpower) {
    const r = ix.reportById.get(m.report_id);
    if (r) {
      if (r.current_version !== m.version || !FILED_STATUSES.has(r.status)) continue;
      const date = m.date ?? ix.reportDate.get(r.id);
      if (!date) continue;
      out.push({
        ...m,
        date,
        site_id: m.site_id ?? r.site_id,
        report_no: m.report_no ?? r.report_no,
      });
    } else if (m.date && m.site_id) {
      if (m.report_status && !FILED_STATUSES.has(m.report_status)) continue;
      out.push({ ...m, date: m.date, site_id: m.site_id, report_no: m.report_no ?? '' });
    }
  }
  return out;
}

/** Current-version weather events of filed/signed-off reports. */
export function currentWeather(rows: RowSet, ix: Index): WeatherLike[] {
  return rows.weatherEvents.filter((w) => {
    const r = ix.reportById.get(w.report_id);
    if (!r) return true; // from the current_weather view
    return r.current_version === w.version && FILED_STATUSES.has(r.status);
  });
}

function weatherImpactText(data: DailyReportData | null): string | null {
  if (!data) return null;
  const p =
    data.weather.periods.find((x) => x.lostHours > 0 || x.fullDay) ?? data.weather.periods[0];
  if (!p) return null;
  const range = p.start && p.end ? `${p.start}–${p.end}` : p.start ? `from ${p.start}` : '';
  const head = [p.condition, range].filter(Boolean).join(' ');
  return p.impact ? `${head} · ${p.impact}` : head;
}

/**
 * weather_events.observed (the version's weather.observed, copied as written) in v2 terms: a v1
 * copy (precipIn, tempMinF …) is upgraded, a v2 one (precip, tempMin …) passes; anything else is
 * null.
 */
export function observedWeatherOf(json: unknown): ObservedWeather | null {
  if (!isRecord(json)) return null;
  if (typeof json.precipIn === 'number')
    return upgradeObservedV1(json as unknown as ObservedWeatherV1);
  if (typeof json.precip === 'number') return json as unknown as ObservedWeather;
  return null;
}

export function segmentsOf(json: unknown): TranscriptSegment[] {
  if (!Array.isArray(json)) return [];
  return json.filter(isRecord).map((s) => ({
    start: Number(s.start ?? 0),
    end: Number(s.end ?? 0),
    text: String(s.text ?? ''),
  }));
}

function optionsOf(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.map((o) => (isRecord(o) ? String(o.title ?? o.id ?? '') : String(o))).filter(Boolean);
}

function answerText(json: unknown): string | null {
  if (json === null || json === undefined) return null;
  if (typeof json === 'string') return json;
  if (isRecord(json)) {
    const parts: string[] = [];
    if (typeof json.workers === 'number') parts.push(String(json.workers));
    if (json.fullDay === true) parts.push('full day');
    else if (typeof json.hours === 'number') parts.push(formatHours(json.hours));
    if (typeof json.text === 'string') parts.push(json.text);
    return parts.length ? parts.join(' · ') : JSON.stringify(json);
  }
  return String(json);
}

function invoiceLines(json: unknown): Array<{ date: string; hours: number }> {
  if (!Array.isArray(json)) return [];
  return json
    .filter(isRecord)
    .map((l) => ({ date: String(l.date ?? ''), hours: Number(l.hours ?? 0) }))
    .filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date));
}

export function reviewReasonText(reason: string, rows?: RowSet): string {
  const [kind, ...rest] = reason.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'unknown_company':
      return copy.states.reviewReasons.unknown_company(arg);
    case 'low_confidence':
      return copy.states.reviewReasons.low_confidence(arg);
    case 'unanswered':
      return copy.states.reviewReasons.unanswered(arg);
    case 'unconfirmed':
      return copy.states.reviewReasons.unconfirmed;
    default:
      void rows;
      return copy.states.reviewReasons.generic(reason);
  }
}

const UNKNOWN_COMPANY = 'unknown_company:';

/**
 * `unknown_company:<name>` for each crew company in `data` that has no company id and is not
 * already one of `reviewReasons`, e.g. a company typed in the panel before typed companies were
 * linked on save. The report page offers them the same Add / Map controls as the review reasons
 * (resolve_unknown_company takes any name), so Crew hours "Confirm" always lands on an action.
 */
export function unlinkedCompanyReasons(data: DailyReportData, reviewReasons: string[]): string[] {
  const seen = new Set(
    reviewReasons
      .filter((x) => x.startsWith(UNKNOWN_COMPANY))
      .map((x) => x.slice(UNKNOWN_COMPANY.length).trim().toLowerCase()),
  );
  const out: string[] = [];
  for (const m of data.manpower) {
    if (m.companyId !== null) continue;
    const name = m.companyName.trim() ? m.companyName : m.companyNameHeard;
    const keys = [m.companyName, m.companyNameHeard]
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    if (!keys.length || keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(`${UNKNOWN_COMPANY}${name}`);
  }
  return out;
}

/** Manpower rows that differ from the previous version (for "Edited v2 · was 6"). */
export function manpowerChanges(
  prev: DailyReportData | null,
  cur: DailyReportData,
): Map<number, { workers: number | null; totalHours: number | null }> {
  const changes = new Map<number, { workers: number | null; totalHours: number | null }>();
  if (!prev) return changes;
  cur.manpower.forEach((m, i) => {
    const key = (x: ManpowerEntry) => `${x.companyId ?? x.companyName.toLowerCase()}`;
    const before = prev.manpower.find((p) => key(p) === key(m)) ?? prev.manpower[i];
    if (!before) {
      changes.set(i, { workers: null, totalHours: null });
      return;
    }
    if (before.workers !== m.workers || before.totalHours !== m.totalHours) {
      changes.set(i, { workers: before.workers, totalHours: before.totalHours });
    }
  });
  return changes;
}

// ───────────────────────────── Overview ─────────────────────────────

export function assembleOverview(rows: RowSet, ctx: AssembleCtx): OverviewData {
  const ix = buildIndex(rows);
  const orgTz = rows.org.timezone;
  const today = formatDateInTz(ctx.now, orgTz);
  const active = rows.sites.filter((s) => s.status === 'active');
  const segments = { filed: 0, weather: 0, missing: 0, awaiting: 0, noWork: 0 };
  let crew = 0;
  let hours = 0;
  let weatherSites = 0;
  let lost = 0;
  const pdfReportIds: string[] = [];
  const sitesToday: OverviewSiteRow[] = [];
  const attention: AttentionItem[] = [];

  for (const site of active) {
    const siteToday = formatDateInTz(ctx.now, site.timezone);
    const sd = ix.siteDaysBySite.get(site.id)?.find((d) => d.date === siteToday);
    const report = reportForSiteDay(ix, sd);
    const data = report ? versionData(currentVersion(ix, report)) : null;
    const totals = data ? totalsOf(rows, data) : null;
    const reporter = ix.primaryReporterBySite.get(site.id) ?? null;
    const chip = chipForSiteDay(sd, report);
    const status = sd?.status ?? null;
    const isWeatherDay = status === 'weather_day';

    if (status === 'filed') segments.filed += 1;
    else if (status === 'weather_day') segments.weather += 1;
    else if (status === 'missing') segments.missing += 1;
    else if (status === 'no_work') segments.noWork += 1;
    else segments.awaiting += 1;

    const filedData =
      status === 'filed' && report && FILED_STATUSES.has(report.status) ? totals : null;
    if (filedData) {
      crew += filedData.crewOnSite;
      hours += filedData.totalHours;
      // With or without a stored PDF: the zip export renders and stores a missing one (typed
      // reports, an office edit or a failed upload, no worker yet).
      pdfReportIds.push(report!.id);
    }
    const lostHours = totals?.lostHours ?? 0;
    if (isWeatherDay || (totals?.weatherAffected ?? false)) {
      weatherSites += 1;
      lost += lostHours;
    }

    sitesToday.push({
      siteId: site.id,
      siteName: site.name,
      siteShort: shortSiteName(site.name),
      projectCode: site.project_code,
      timezone: site.timezone,
      managerName: reporter?.name ?? null,
      managerFirstName: reporter ? firstName(reporter.name) : null,
      managerPhone: reporter?.phone_e164 ?? null,
      siteDayId: sd?.id ?? null,
      siteDayStatus: status,
      chip,
      inAt: report?.received_at ?? null,
      crew: filedData ? filedData.crewOnSite : null,
      hours: filedData ? filedData.totalHours : null,
      weatherImpact: weatherImpactText(data),
      lostHours,
      weatherDay: isWeatherDay,
      // Only a filed report can be opened; a draft or a voided one has no page yet.
      reportId: report && FILED_STATUSES.has(report.status) ? report.id : null,
      reportNo: report?.report_no ?? null,
      isLate: !!(sd?.is_late || report?.is_late),
      needsReview: !!report?.needs_review && report.status === 'filed',
      reminderStage: sd?.reminder_stage ?? 0,
    });

    if (status === 'missing' && sd) {
      const first = reporter ? firstName(reporter.name) : copy.sites.reporter;
      const reminders = sd.reminder_stage >= 3 ? 2 : sd.reminder_stage >= 2 ? 1 : 0;
      attention.push({
        id: `missing:${sd.id}`,
        kind: 'missing',
        title: copy.overview.attention.missing.title(site.name),
        body: copy.overview.attention.missing.body(first, reminders),
        siteId: site.id,
        actions: [
          ...(reporter
            ? [
                {
                  kind: 'call' as const,
                  label: copy.overview.attention.missing.call(first),
                  tel: reporter.phone_e164,
                },
              ]
            : []),
          {
            kind: 'mark_no_work',
            label: copy.overview.attention.missing.markNoWork,
            siteDayId: sd.id,
            siteName: site.name,
            date: sd.date,
          },
        ],
      });
    }
    if (report && report.status === 'filed' && report.needs_review) {
      const reasons = report.review_reasons.map((r) => {
        const [kind, name] = r.split(':');
        if (kind === 'unknown_company' && data) {
          const entry = data.manpower.find(
            (m) =>
              m.companyName.toLowerCase() === (name ?? '').toLowerCase() ||
              m.companyNameHeard.toLowerCase() === (name ?? '').toLowerCase(),
          );
          return copy.overview.attention.needs_review.unknownCompany(
            name ?? '',
            entry?.workers ?? 0,
          );
        }
        return reviewReasonText(r);
      });
      attention.push({
        id: `review:${report.id}`,
        kind: 'needs_review',
        title: copy.overview.attention.needs_review.title(site.name),
        body: reasons.join(' · '),
        siteId: site.id,
        reportId: report.id,
        actions: [
          {
            kind: 'review_report',
            label: copy.overview.attention.needs_review.review,
            reportId: report.id,
          },
        ],
      });
    }
  }

  // Invoice gaps for invoices overlapping this week.
  const week = isoWeekOf(today);
  const gapItems: Array<AttentionItem & { gap: number }> = [];
  const cm = currentManpower(rows, ix);
  for (const inv of rows.invoices) {
    if (inv.status === 'resolved' || !inv.period_start || !inv.period_end) continue;
    const { start, sunday } = isoWeekRange(week);
    if (inv.period_end < start || inv.period_start > sunday) continue;
    const company = ix.companyById.get(inv.company_id);
    if (!company) continue;
    const reported = sum(
      cm
        .filter(
          (m) =>
            m.company_id === inv.company_id &&
            m.date >= inv.period_start! &&
            m.date <= inv.period_end!,
        )
        .map((m) => Number(m.hours)),
    );
    const invoiced = Number(inv.total_hours ?? 0);
    const gap = Math.round((invoiced - reported) * 100) / 100;
    if (Math.abs(gap) < 0.005) continue;
    gapItems.push({
      id: `gap:${inv.id}`,
      kind: 'invoice_gap',
      gap,
      title: copy.overview.attention.invoice_gap.title(company.name, formatGap(gap)),
      body: copy.overview.attention.invoice_gap.body(
        inv.invoice_no ?? '',
        formatHours(invoiced),
        formatHours(reported),
      ),
      actions: [
        { kind: 'compare_hours', label: copy.overview.attention.invoice_gap.compare, week },
      ],
    });
  }
  gapItems.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  attention.push(...gapItems.map(({ gap: _g, ...item }) => item));

  for (const u of rows.unknownContacts.filter((x) => x.status === 'pending')) {
    const snippet = (u.snippet ?? '').replace(/…$/, '');
    const short = snippet.length > 42 ? `${snippet.slice(0, 41).trimEnd()}…` : snippet;
    attention.push({
      id: `unknown:${u.id}`,
      kind: 'unknown_sender',
      title: copy.overview.attention.unknown_sender.title,
      body: copy.overview.attention.unknown_sender.body(formatPhone(u.phone_e164), short),
      actions: [{ kind: 'link_number', label: copy.overview.attention.unknown_sender.link }],
    });
  }

  const review = rows.glossary.filter((t) => t.status === 'needs_review');
  if (review.length) {
    attention.push({
      id: 'glossary:review',
      kind: 'glossary_review',
      title: copy.overview.attention.glossary_review.title(review.length),
      body: copy.overview.attention.glossary_review.body(review.map((t) => t.heard)),
      actions: [{ kind: 'review_terms', label: copy.overview.attention.glossary_review.review }],
    });
  }

  const order: Record<AttentionItem['kind'], number> = {
    missing: 0,
    needs_review: 1,
    invoice_gap: 2,
    unknown_sender: 3,
    glossary_review: 4,
  };
  attention.sort((a, b) => order[a.kind] - order[b.kind]);

  const rowOrder: Record<ChipVariant, number> = {
    missing: 0,
    awaiting: 1,
    pending: 1,
    needs_review: 2,
    weather_day: 3,
    filed: 4,
    signed_off: 5,
    no_work: 6,
  };
  sitesToday.sort(
    (a, b) =>
      rowOrder[a.chip.variant] - rowOrder[b.chip.variant] || a.siteName.localeCompare(b.siteName),
  );

  const deadlines = active.map((s) => siteDeadline(s, rows.settings)).sort();
  const earliest = deadlines[0] ?? hhmm(rows.settings.default_deadline);
  // The scheduler reminds a verified site manager linked to the site (§7.4); without one, or
  // with the first reminder turned off, the "Reminders go out at …" line would be false.
  const activeIds = new Set(active.map((s) => s.id));
  const hasReporter = rows.siteReporters.some(
    (sr) =>
      activeIds.has(sr.site_id) &&
      isActiveReporterStatus(ix.reporterById.get(sr.reporter_id)?.status ?? ''),
  );

  return {
    today,
    now: ctx.now.toISOString(),
    timezone: orgTz,
    siteCount: active.length,
    pausedCount: rows.sites.filter((s) => s.status === 'paused').length,
    hasReporter,
    remindersOn: hasReporter && rows.settings.reminder1_enabled,
    earliestDeadline: earliest,
    reminder1At: addMinutesToHHMM(earliest, rows.settings.reminder1_offset_min),
    kpis: {
      reportsIn: segments.filed,
      total: active.length,
      segments,
      crewOnSite: crew,
      laborHours: Math.round(hours * 100) / 100,
      weatherAffectedSites: weatherSites,
      weatherLostHours: Math.round(lost * 100) / 100,
    },
    sitesToday,
    needsAttention: attention,
    pdfReportIds,
  };
}

// ───────────────────────────── Sites ─────────────────────────────

export function assembleSiteCards(rows: RowSet, ctx: AssembleCtx): SiteCard[] {
  const ix = buildIndex(rows);
  const wx = currentWeather(rows, ix);
  const cards: SiteCard[] = [];
  for (const site of rows.sites) {
    if (site.status === 'archived') continue;
    const today = formatDateInTz(ctx.now, site.timezone);
    const month = today.slice(0, 7);
    const days = ix.siteDaysBySite.get(site.id) ?? [];
    const sd = days.find((d) => d.date === today);
    const report = reportForSiteDay(ix, sd);
    const data = report ? versionData(currentVersion(ix, report)) : null;
    const chip =
      site.status === 'paused'
        ? { variant: 'no_work' as const, label: copy.chips.paused }
        : chipForSiteDay(sd, report);
    const streakDays = lastWorkdays(today, 14, rows.settings.working_days);
    const streak: StreakCell[] = streakDays.map((date) => {
      const d = days.find((x) => x.date === date);
      return { date, status: streakStatusOf(d, reportForSiteDay(ix, d)) };
    });
    const reporter = ix.primaryReporterBySite.get(site.id) ?? null;
    const weatherDates = new Set<string>();
    for (const w of wx) {
      if (
        w.site_id === site.id &&
        w.date.startsWith(month) &&
        (Number(w.lost_hours) > 0 || w.full_day)
      )
        weatherDates.add(w.date);
    }
    for (const d of days)
      if (d.date.startsWith(month) && d.status === 'weather_day') weatherDates.add(d.date);
    const filedToday =
      sd?.status === 'filed' && report && FILED_STATUSES.has(report.status) && data;
    cards.push({
      siteId: site.id,
      name: site.name,
      shortName: shortSiteName(site.name),
      projectCode: site.project_code,
      status: site.status,
      timezone: site.timezone,
      chip,
      reportId: report && FILED_STATUSES.has(report.status) ? report.id : null,
      streak,
      onTime14: streak.filter((c) => c.status === 'on_time').length,
      reporterName: reporter?.name ?? null,
      reporterPhone: reporter?.phone_e164 ?? null,
      crewToday: filedToday ? totalsOf(rows, data).crewOnSite : null,
      weatherDaysMonth: weatherDates.size,
      needsAttention:
        site.status === 'active' && (chip.variant === 'missing' || chip.variant === 'needs_review'),
      activeSince: site.active_since,
      pausedAt: site.paused_at,
    });
  }
  cards.sort((a, b) =>
    a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1,
  );
  return cards;
}

// ───────────────────────────── Site detail ─────────────────────────────

function crewRowsFor(
  rows: RowSet,
  ix: Index,
  report: ReportRow,
  data: DailyReportData,
  prev: DailyReportData | null,
): CrewRow[] {
  const changes = manpowerChanges(prev, data);
  const qs = rows.questions.filter((q) => q.report_id === report.id);
  return data.manpower.map((m, i) => {
    const company = m.companyId ? ix.companyById.get(m.companyId) : undefined;
    const unconfirmed = !company || company.status === 'unconfirmed';
    const badges: CrewRow['badges'] = [];
    const change = changes.get(i);
    if (change) badges.push({ kind: 'edited', label: copy.chips.edited(report.current_version) });
    const q = qs.find((x) => {
      const t = isRecord(x.target) ? x.target : {};
      return (
        t.manpowerIndex === i ||
        (typeof t.companyName === 'string' && t.companyName === m.companyName) ||
        (typeof t.companyNameHeard === 'string' && t.companyNameHeard === m.companyNameHeard)
      );
    });
    if (q?.answered_at)
      badges.push({ kind: 'confirmed_by_reply', label: copy.chips.confirmedByReply });
    else if (q?.asked_at)
      badges.push({
        kind: 'asked',
        label: copy.chips.asked(
          formatTimeInTz(
            q.asked_at,
            ix.siteById.get(report.site_id)?.timezone ?? rows.org.timezone,
          ),
        ),
      });
    if (m.hoursBasis === 'answer' && !q)
      badges.push({ kind: 'confirmed_by_reply', label: copy.chips.confirmedByReply });
    if (unconfirmed) badges.push({ kind: 'unconfirmed', label: copy.chips.unconfirmed });
    return {
      companyId: m.companyId,
      companyName: m.companyName,
      trade: m.trade ?? company?.trade ?? null,
      area: m.area ?? null,
      workers: m.workers,
      hours: m.totalHours,
      hoursBasis: m.hoursBasis,
      unconfirmed,
      badges,
    };
  });
}

export function assembleSiteDetail(
  rows: RowSet,
  ctx: AssembleCtx,
  siteId: string,
  month: string,
): SiteDetail {
  const ix = buildIndex(rows);
  const site = ix.siteById.get(siteId);
  if (!site) throw new Error(copy.errors.notFound);
  const today = formatDateInTz(ctx.now, site.timezone);
  const days = ix.siteDaysBySite.get(siteId) ?? [];
  const cm = currentManpower(rows, ix).filter((m) => m.site_id === siteId);
  const wx = currentWeather(rows, ix).filter((w) => w.site_id === siteId);
  const crewByReport = groupBy(cm, (m) => m.report_id);
  const lostByReport = new Map<string, number>();
  for (const w of wx)
    lostByReport.set(w.report_id, (lostByReport.get(w.report_id) ?? 0) + Number(w.lost_hours));

  const cells: CalendarCell[] = monthDays(month).map((date) => {
    const sd = days.find((d) => d.date === date);
    const report = reportForSiteDay(ix, sd);
    const filed = report && FILED_STATUSES.has(report.status);
    const crewRows = filed ? (crewByReport.get(report.id) ?? []) : [];
    const lost = filed ? (lostByReport.get(report.id) ?? 0) : 0;
    return {
      date,
      isWorkday: isWorkingDay(date, rows.settings.working_days),
      isToday: date === today,
      isFuture: date > today,
      status: sd?.status ?? null,
      chip: sd ? chipForSiteDay(sd, report) : null,
      crew:
        filed && report.kind !== 'weather_day' ? sum(crewRows.map((m) => Number(m.workers))) : null,
      hours:
        filed && report.kind !== 'weather_day' ? sum(crewRows.map((m) => Number(m.hours))) : null,
      weatherAffected: sd?.status === 'weather_day' || lost > 0,
      lostHours: lost,
      reportId: filed ? report.id : null,
      isLate: !!(sd?.is_late || report?.is_late),
    };
  });

  const siteReports = rows.reports
    .filter((r) => r.site_id === siteId && FILED_STATUSES.has(r.status))
    .map((r) => ({ r, date: ix.reportDate.get(r.id) ?? '' }))
    .filter((x) => x.date && x.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const latestRow = siteReports[0];
  let latest: SiteDetail['latest'] = null;
  if (latestRow) {
    const v = currentVersion(ix, latestRow.r);
    const crewRows = crewByReport.get(latestRow.r.id) ?? [];
    const isWx = latestRow.r.kind === 'weather_day';
    latest = {
      date: latestRow.date,
      reportId: latestRow.r.id,
      reportNo: latestRow.r.report_no,
      summary: v?.summary ?? versionData(v)?.summary ?? '',
      crew: isWx ? null : sum(crewRows.map((m) => Number(m.workers))),
      hours: isWx ? null : sum(crewRows.map((m) => Number(m.hours))),
      weatherHours: lostByReport.get(latestRow.r.id) ?? 0,
      chip: chipForReport(latestRow.r),
    };
  }

  const monthReports = siteReports.filter((x) => x.date.startsWith(month));
  const monthStart = `${month}-01`;
  const monthEnd = monthDays(month).at(-1)!;
  const activeFrom =
    site.active_since && site.active_since > monthStart ? site.active_since : monthStart;
  // A report typed for a day before the site was added (back-filled) starts the count there, and
  // a day with a report counts even when it is not a working day, so it never reads "7 of 1".
  const firstReport = monthReports.at(-1)?.date;
  const from = firstReport && firstReport < activeFrom ? firstReport : activeFrom;
  const workdaysSoFar = new Set([
    ...workdaysBetween(from, monthEnd < today ? monthEnd : today, rows.settings.working_days),
    ...monthReports.map((x) => x.date),
  ]).size;
  const onTime = monthReports.filter((x) => !x.r.is_late && x.r.kind !== 'weather_day').length;
  const monthCrew = monthReports.map((x) =>
    sum((crewByReport.get(x.r.id) ?? []).map((m) => Number(m.workers))),
  );
  const dailyReports = monthReports.filter((x) => x.r.kind !== 'weather_day');
  const monthStats = {
    reports: monthReports.length,
    onTime,
    workdaysSoFar,
    weatherHours: sum(monthReports.map((x) => lostByReport.get(x.r.id) ?? 0)),
    laborHours: sum(
      monthReports.flatMap((x) => (crewByReport.get(x.r.id) ?? []).map((m) => Number(m.hours))),
    ),
    avgCrew: dailyReports.length ? Math.round(sum(monthCrew) / dailyReports.length) : null,
  };

  const todayRow = siteReports.find((x) => x.date === today);
  let crewToday: SiteDetail['crewToday'] = null;
  if (todayRow && todayRow.r.kind !== 'weather_day') {
    const versions = ix.versionsByReport.get(todayRow.r.id) ?? [];
    const cur = versionData(versions.find((v) => v.version === todayRow.r.current_version));
    const prev = versionData(versions.find((v) => v.version === todayRow.r.current_version - 1));
    if (cur) {
      const crewRows = crewRowsFor(rows, ix, todayRow.r, cur, prev);
      crewToday = {
        date: today,
        rows: crewRows,
        totalWorkers: sum(crewRows.map((c) => c.workers ?? 0)),
        totalHours: sum(crewRows.map((c) => c.hours ?? 0)),
      };
    }
  }

  const reporters = rows.siteReporters
    .filter((sr) => sr.site_id === siteId)
    .map((sr) => {
      const r = ix.reporterById.get(sr.reporter_id);
      return r ? toReporterSummary(r, sr.is_primary) : null;
    })
    .filter((x): x is ReporterSummary => !!x)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  // Each report's photos as its current version shows them (an edit may remove or re-caption).
  const media = mediaIndex(rows);
  const photoSources = groupBy(
    rows.sources.filter((s) => s.kind === 'photo'),
    (s) => s.report_id,
  );
  const photos: SitePhoto[] = rows.reports
    .filter((r) => r.site_id === siteId && photoSources.has(r.id))
    .flatMap((r) => {
      const v = currentVersion(ix, r);
      const list = v
        ? versionData(v)?.photos
        : photoListOf(
            rows.photoLists?.find((p) => p.report_id === r.id && p.version === r.current_version),
          );
      return shownPhotos(list, photoSources.get(r.id) ?? [], media).map((p) => ({
        messageId: p.id,
        reportId: r.id,
        reportNo: r.report_no,
        date: ix.reportDate.get(r.id) ?? '',
        caption: p.caption,
        takenAt: p.takenAt,
        storagePath: p.media?.storagePath ?? null,
        url: null,
      }));
    })
    // Newest day first; within a day by time taken (ties keep the version's order).
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const x = a.takenAt ?? '';
      const y = b.takenAt ?? '';
      return x < y ? -1 : x > y ? 1 : 0;
    });
  return {
    site: toSiteInfo(site, rows.settings),
    reporters,
    recipients: rows.recipients.filter((r) => r.site_id === siteId).map((r) => r.email),
    month,
    cells,
    latest,
    monthStats,
    crewToday,
    photoCount: photos.length,
    photos,
  };
}

// ───────────────────────────── Reports list ─────────────────────────────

export function reportFlags(report: ReportRow, lost: number, tz: string): ReportFlag[] {
  const flags: ReportFlag[] = [];
  if (report.kind === 'weather_day')
    flags.push({ kind: 'weather_day', label: copy.reports.flags.weatherDay });
  else if (lost > 0)
    flags.push({ kind: 'rain', label: copy.reports.flags.rain(formatHours(lost)) });
  if (report.current_version > 1)
    flags.push({ kind: 'version', label: copy.reports.flags.version(report.current_version) });
  if (report.review_reasons.some((r) => r.startsWith('unknown_company')))
    flags.push({ kind: 'unknown_sub', label: copy.reports.flags.unknownSub });
  if (report.is_late && report.received_at)
    flags.push({
      kind: 'late',
      label: copy.reports.flags.late(formatTimeInTz(report.received_at, tz)),
    });
  return flags;
}

export function assembleReportItems(
  rows: RowSet,
  reports: ReportRow[],
  incidentReportIds: Set<string> = new Set(),
): ReportListItem[] {
  const ix = buildIndex(rows);
  const cm = currentManpower(rows, ix);
  const wx = currentWeather(rows, ix);
  const crewByReport = groupBy(cm, (m) => m.report_id);
  const lostByReport = new Map<string, number>();
  for (const w of wx)
    lostByReport.set(w.report_id, (lostByReport.get(w.report_id) ?? 0) + Number(w.lost_hours));
  return reports.map((r) => {
    const site = ix.siteById.get(r.site_id);
    const tz = site?.timezone ?? rows.org.timezone;
    const reporter = reporterOf(ix, r);
    const crewRows = crewByReport.get(r.id) ?? [];
    const lost = lostByReport.get(r.id) ?? 0;
    const flags = reportFlags(r, lost, tz);
    if (incidentReportIds.has(r.id))
      flags.push({ kind: 'incident', label: copy.reports.flags.incident });
    const isWx = r.kind === 'weather_day';
    return {
      reportId: r.id,
      reportNo: r.report_no,
      date: ix.reportDate.get(r.id) ?? '',
      siteId: r.site_id,
      siteName: site?.name ?? '',
      siteShort: site ? shortSiteName(site.name) : '',
      timezone: tz,
      managerName: reporter?.name ?? null,
      crew: isWx ? null : sum(crewRows.map((m) => Number(m.workers))),
      hours: isWx ? null : sum(crewRows.map((m) => Number(m.hours))),
      version: r.current_version,
      flags,
      chip: chipForReport(r),
      status: r.status,
      needsReview: r.needs_review,
      isLate: r.is_late,
      kind: r.kind,
      pdfPath: currentVersion(ix, r)?.pdf_path ?? null,
    };
  });
}

/** In-memory filtering + pagination (demo). The Supabase source does this server-side. */
export function filterReports(
  rows: RowSet,
  filters: ReportFilters,
): { reports: ReportRow[]; total: number; incidentIds: Set<string>; weatherHours: number } {
  const ix = buildIndex(rows);
  const q = filters.q?.trim().toLowerCase() ?? '';
  const wx = currentWeather(rows, ix);
  const lostByReport = new Map<string, number>();
  for (const w of wx)
    lostByReport.set(w.report_id, (lostByReport.get(w.report_id) ?? 0) + Number(w.lost_hours));
  const incidentIds = new Set<string>();
  const transcriptByMedia = new Map(
    rows.transcripts.map((t) => [transcriptMediaId(t), t.text.toLowerCase()]),
  );
  const sourcesByReport = groupBy(rows.sources, (s) => s.report_id);

  let list = rows.reports.filter((r) => FILED_STATUSES.has(r.status));
  list = list.filter((r) => {
    const date = ix.reportDate.get(r.id) ?? '';
    const site = ix.siteById.get(r.site_id);
    if (filters.siteId && r.site_id !== filters.siteId) return false;
    if (filters.from && date < filters.from) return false;
    if (filters.to && date > filters.to) return false;
    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'needs_review' && !(r.status === 'filed' && r.needs_review))
        return false;
      if (
        filters.status === 'filed' &&
        !(r.status === 'filed' && !r.needs_review && r.kind !== 'weather_day')
      )
        return false;
      if (filters.status === 'signed_off' && r.status !== 'signed_off') return false;
      if (filters.status === 'weather_day' && r.kind !== 'weather_day') return false;
    }
    const lost = lostByReport.get(r.id) ?? 0;
    if (filters.hasWeatherDelay && !(lost > 0 || r.kind === 'weather_day')) return false;
    if (filters.edited && r.current_version <= 1) return false;
    if (filters.late && !r.is_late) return false;
    const data = versionData(currentVersion(ix, r));
    const hasIncident = (data?.safety.incidents.length ?? 0) > 0;
    if (hasIncident) incidentIds.add(r.id);
    if (filters.incident && !hasIncident) return false;
    if (q) {
      const hay = [r.report_no, site?.name ?? '', site?.project_code ?? '', data?.summary ?? '']
        .join(' ')
        .toLowerCase();
      const transcripts = (sourcesByReport.get(r.id) ?? [])
        .map((s) => transcriptByMedia.get(sourceMediaId(s)) ?? '')
        .join(' ');
      if (!hay.includes(q) && !transcripts.includes(q)) return false;
    }
    return true;
  });
  list.sort((a, b) => {
    const da = ix.reportDate.get(a.id) ?? '';
    const db = ix.reportDate.get(b.id) ?? '';
    if (da !== db) return da < db ? 1 : -1;
    return (ix.siteById.get(a.site_id)?.name ?? '').localeCompare(
      ix.siteById.get(b.site_id)?.name ?? '',
    );
  });
  const weatherHours = sum(list.map((r) => lostByReport.get(r.id) ?? 0));
  const total = list.length;
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  const page = Math.max(1, filters.page ?? 1);
  return {
    reports: list.slice((page - 1) * pageSize, page * pageSize),
    total,
    incidentIds,
    weatherHours,
  };
}

export function paginate(
  items: ReportListItem[],
  total: number,
  filters: ReportFilters,
  weatherHours: number,
): ReportList {
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  const page = Math.max(1, filters.page ?? 1);
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    weatherHours,
  };
}

// ───────────────────────────── Report detail ─────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  'report.created': 'Voice note received',
  'question.asked': 'Question asked',
  'question.answered': 'Question answered',
  'report.confirmed': 'Confirmed on WhatsApp',
  'report.filed': 'Filed',
  'report.version_created': 'New version',
  'report.pdf_rendered': 'PDF created',
  'report.signed_off': 'Signed off',
  'report.signoff_undone': 'Sign-off undone',
  'report.signoff_reverted': 'Sign-off reverted by edit',
  'report.needs_review': 'Flagged for review',
  'report.unknown_company_resolved': 'Unknown company resolved',
  'site_day.marked_no_work': 'Marked no work',
  'site_day.missing': 'Missing — office alerted',
};

function excerptsFor(data: DailyReportData, segments: TranscriptSegment[]): TranscriptExcerpt[] {
  if (!segments.length) return [];
  const out: TranscriptExcerpt[] = [];
  const seen = new Set<string>();
  const push = (
    src: Source[] | undefined,
    mapped: string,
    section: TranscriptExcerpt['section'],
  ) => {
    const a = src?.find((s) => s.type === 'voice_note');
    if (!a || a.type !== 'voice_note') return;
    const seg =
      segments.find((s) => a.start >= s.start - 0.01 && a.start < s.end) ??
      segments.find((s) => s.end > a.start);
    if (!seg) return;
    const key = `${seg.start}:${mapped}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ start: seg.start, end: seg.end, quote: seg.text, mapped, section });
  };
  for (const m of data.manpower) {
    const hrs =
      m.totalHours !== null
        ? ` × ${m.hoursPerWorker ?? '?'} h = ${formatHoursNum(m.totalHours)} h`
        : '';
    push(
      m.source,
      `${m.companyName} · ${m.workers ?? '?'} ${copy.common.workersUnit}${hrs}${m.area ? ` · ${m.area}` : ''}`,
      'manpower',
    );
  }
  for (const p of data.weather.periods) {
    const range = p.start && p.end ? ` ${p.start}–${p.end}` : '';
    push(
      p.source,
      `${p.condition}${range} · ${p.impact ?? ''} · ${formatHours(p.lostHours)} lost`.replace(
        ' ·  ·',
        ' ·',
      ),
      'weather',
    );
  }
  for (const w of data.workPerformed) {
    const qty = w.quantity ? ` · ${w.quantity.value} ${w.quantity.unit}` : '';
    const pct = w.percentComplete !== undefined ? ` · ${w.percentComplete}%` : '';
    push(
      w.source,
      `${w.area} · ${w.activity} · ${copy.report.workStatus[w.status]}${qty}${pct}`,
      'work',
    );
  }
  for (const d of data.deliveries)
    push(
      d.source,
      `${d.item}${d.quantity ? `, ${d.quantity}` : ''}${d.supplier ? ` (${d.supplier})` : ''}${d.time ? ` · ${d.time}` : ''}`,
      'delivery',
    );
  push(
    data.safety.source,
    data.safety.toolboxTalk
      ? copy.report.safety.toolboxTalk(data.safety.toolboxTalk) +
          (data.safety.noIncidentsStated ? ` · ${copy.report.safety.noIncidents}` : '')
      : data.safety.noIncidentsStated
        ? copy.report.safety.noIncidents
        : copy.report.safety.notStated,
    'safety',
  );
  for (const n of data.nextWorkday) push(n.source, n.item, 'next');
  for (const i of data.issues) push(i.source, i.description, 'other');
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, 8);
}

export function assembleReportDetail(
  rows: RowSet,
  ctx: AssembleCtx,
  reportId: string,
  selected?: number | null,
): ReportDetail {
  const ix = buildIndex(rows);
  const report = ix.reportById.get(reportId);
  if (!report) throw new Error(copy.errors.notFound);
  const site = ix.siteById.get(report.site_id);
  if (!site) throw new Error(copy.errors.notFound);
  const tz = site.timezone;
  const versions = ix.versionsByReport.get(report.id) ?? [];
  const version =
    selected && versions.some((v) => v.version === selected) ? selected : report.current_version;
  const vRow = versions.find((v) => v.version === version);
  const data = versionData(vRow);
  if (!vRow || !data) throw new Error(copy.errors.notFound);
  const previousData = versionData(versions.find((v) => v.version === version - 1));

  const sources = rows.sources.filter((s) => s.report_id === report.id);
  const media = mediaIndex(rows);
  // The voice note (WhatsApp `audio` or v1.2 `voice_note`), from its upload or its message.
  const audioSrc = sources.find((s) => isVoiceSourceKind(s.kind) && sourceMedia(s, media));
  const audioFile = audioSrc ? sourceMedia(audioSrc, media) : undefined;
  const transcriptRow = audioFile
    ? rows.transcripts.find((t) => transcriptMediaId(t) === audioFile.id)
    : undefined;
  const segments = transcriptRow ? segmentsOf(transcriptRow.segments) : [];
  // The viewed version's photos: an office edit may have removed some or changed a caption.
  const photos = shownPhotos(data.photos, sources, media).map((p) => ({
    messageId: p.id,
    storagePath: p.media?.storagePath ?? null,
    mime: p.media?.mime ?? null,
    url: null,
    caption: p.caption,
    takenAt: p.takenAt,
  }));

  const reporter = reporterOf(ix, report);
  const reporterName = reporter?.name ?? copy.sites.reporter;
  const actorName = (a: AuditLogRow): string => {
    if (a.actor_type === 'user') return memberName(rows, a.actor_id) ?? 'Office';
    if (a.actor_type === 'reporter')
      return (a.actor_id && ix.reporterById.get(a.actor_id)?.name) || reporterName;
    if (a.actor_type === 'agent') return 'SiteLog agent';
    return 'System';
  };
  const activity: ActivityEntry[] = rows.audit
    .filter(
      (a) =>
        a.entity_id === report.id ||
        (a.entity === 'site_day' && a.entity_id === report.site_day_id),
    )
    .map((a) => {
      const diff = isRecord(a.diff) ? a.diff : {};
      const detail =
        typeof diff.change_note === 'string'
          ? `v${String(diff.version ?? '')}: ${diff.change_note}`
          : typeof diff.answer === 'string'
            ? diff.answer
            : typeof diff.company === 'string'
              ? `${String(diff.field ?? '')} · ${diff.company}`
              : typeof diff.version === 'number'
                ? `v${diff.version}`
                : null;
      return {
        id: `audit:${a.id}`,
        at: a.created_at,
        actorType: (a.actor_type ?? 'system') as ActivityEntry['actorType'],
        actorName: actorName(a),
        label: ACTION_LABELS[a.action] ?? a.action,
        detail,
        messageId: null,
      };
    });
  const date = ix.reportDate.get(report.id) ?? data.reportDate;
  // The WhatsApp thread of the day, when the voice note came by WhatsApp.
  const convoId = audioFile?.conversationId ?? null;
  const convoMessages = rows.messages
    .filter(
      (m) =>
        convoId !== null &&
        m.conversation_id === convoId &&
        formatDateInTz(m.created_at, tz) === date,
    )
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const messages: MessageItem[] = convoMessages.map((m) => ({
    id: m.id,
    direction: m.direction,
    type: m.type,
    body: m.body,
    at: m.created_at,
  }));
  activity.sort((a, b) => (a.at < b.at ? -1 : 1));

  const questions: QuestionItem[] = rows.questions
    .filter((q) => q.report_id === report.id)
    .map((q) => {
      const t = isRecord(q.target) ? q.target : {};
      return {
        id: q.id,
        field: q.field,
        prompt: q.prompt,
        options: optionsOf(q.options),
        askedAt: q.asked_at,
        answeredAt: q.answered_at,
        answer: answerText(q.answer),
        companyName: typeof t.companyName === 'string' ? t.companyName : null,
        manpowerIndex: typeof t.manpowerIndex === 'number' ? t.manpowerIndex : null,
      };
    });

  const siteReports = rows.reports
    .filter((r) => r.site_id === site.id && FILED_STATUSES.has(r.status))
    .map((r) => ({ id: r.id, date: ix.reportDate.get(r.id) ?? '' }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const pos = siteReports.findIndex((r) => r.id === report.id);
  const lost = currentWeather(rows, ix)
    .filter((w) => w.report_id === report.id)
    .reduce((a, w) => a + Number(w.lost_hours), 0);

  return {
    report: {
      id: report.id,
      reportNo: report.report_no,
      date,
      status: report.status,
      currentVersion: report.current_version,
      needsReview: report.needs_review,
      reviewReasons: report.review_reasons,
      isLate: report.is_late,
      kind: report.kind,
      receivedAt: report.received_at,
      confirmedAt: report.confirmed_at,
      filedAt: report.filed_at,
      signedOffBy: report.signed_off_by,
      signedOffByName: memberName(rows, report.signed_off_by),
      signedOffAt: report.signed_off_at,
    },
    site: toSiteInfo(site, rows.settings),
    reporter: reporter ? toReporterSummary(reporter, true) : null,
    version,
    data,
    storedData: storedVersionData(vRow),
    previousData,
    versions: versions.map((v) => ({
      version: v.version,
      author: v.author,
      authorName:
        v.author === 'office_user'
          ? (memberName(rows, v.author_user_id) ?? 'Office')
          : isReporterAuthor(v.author)
            ? reporterName
            : 'SiteLog agent',
      changeNote: v.change_note,
      createdAt: v.created_at,
      isCurrent: v.version === report.current_version,
      pdfPath: v.pdf_path,
    })),
    totals: totalsOf(rows, data),
    audio: audioFile
      ? {
          messageId: audioFile.id,
          peaks: audioFile.peaks ?? [],
          durationS: Number(audioFile.durationS ?? 0),
          storagePath: audioFile.storagePath,
          url: null,
          receivedAt: audioFile.receivedAt,
          language: transcriptRow?.language ?? null,
        }
      : null,
    photos,
    transcript: transcriptRow
      ? { language: transcriptRow.language, text: transcriptRow.text, segments }
      : null,
    excerpts: excerptsFor(data, segments),
    activity,
    messages,
    questions,
    companies: rows.companies.map(toCompanyOption).sort((a, b) => a.name.localeCompare(b.name)),
    selfPerformCompanyIds: [...selfPerformIds(rows)],
    settings: {
      signoffRequired: rows.settings.signoff_required,
      filingMode: rows.settings.filing_mode,
      defaultShiftHours: Number(rows.settings.default_shift_hours),
    },
    pdfUrl: null,
    prevReportId: pos > 0 ? siteReports[pos - 1]!.id : null,
    nextReportId: pos >= 0 && pos < siteReports.length - 1 ? siteReports[pos + 1]!.id : null,
    delayLogHours: Math.round(lost * 100) / 100,
  };
}

// ───────────────────────────── Hours ─────────────────────────────

/** Code-point order (not locale order), the same in every browser. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function assembleHours(
  rows: RowSet,
  _ctx: AssembleCtx,
  week: string,
  siteId: string | null,
): HoursMatrix {
  const ix = buildIndex(rows);
  const { start, end } = isoWeekRange(week);
  const days = Array.from({ length: 5 }, (_, i) => addDays(start, i));
  // In report order, whatever order the rows came in (the database pages them by id), so a row's
  // sites, its reports per day and the invoice evidence list the same way in both data sources.
  const cm = currentManpower(rows, ix)
    .filter((m) => m.date >= start && m.date <= end && (!siteId || m.site_id === siteId))
    .sort((a, b) => compareText(a.report_no, b.report_no) || compareText(a.id, b.id));
  const self = selfPerformIds(rows);
  const subs = cm.filter((m) => !(m.company_id && self.has(m.company_id)));
  const keyOf = (m: ManpowerLike) =>
    m.company_id ?? `heard:${(m.company_name ?? m.company_name_heard ?? '').toLowerCase()}`;
  const grouped = groupBy(subs, keyOf);
  const hasInvoiceComparison = !siteId;

  const overlapsWeek = (i: SubInvoiceRow) =>
    !!i.period_start && !!i.period_end && i.period_start <= end && i.period_end >= start;
  const invoiceFor = (companyId: string | null): SubInvoiceRow | undefined => {
    if (!companyId || !hasInvoiceComparison) return undefined;
    return rows.invoices
      .filter((i) => i.company_id === companyId && overlapsWeek(i))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  };

  // A subcontractor that invoiced the week but has no hours in any report still gets a row: all
  // of its invoiced hours are a gap (the invoice_gaps RPC reports it too).
  const groups = [...grouped].map(([key, entries]) => ({
    key,
    companyId: entries[0]!.company_id,
    entries,
  }));
  if (hasInvoiceComparison) {
    const listed = new Set(groups.map((g) => g.companyId));
    for (const i of rows.invoices) {
      if (!i.company_id || self.has(i.company_id) || listed.has(i.company_id) || !overlapsWeek(i))
        continue;
      listed.add(i.company_id);
      groups.push({ key: i.company_id, companyId: i.company_id, entries: [] });
    }
  }

  const rowsOut: HoursRow[] = [];
  for (const { key, companyId, entries } of groups) {
    const first = entries[0];
    const company = companyId ? ix.companyById.get(companyId) : undefined;
    const dayHours = days.map((d) =>
      sum(entries.filter((m) => m.date === d).map((m) => Number(m.hours))),
    );
    const reported = sum(dayHours);
    const inv = invoiceFor(companyId);
    const invoiced = inv
      ? Number(inv.total_hours ?? sum(invoiceLines(inv.lines).map((l) => l.hours)))
      : null;
    const gap = invoiced === null ? null : Math.round((invoiced - reported) * 100) / 100;
    const unconfirmed = !company || company.status === 'unconfirmed';
    const status: HoursRow['status'] = unconfirmed
      ? 'unconfirmed'
      : gap === null
        ? 'awaiting'
        : Math.abs(gap) < 0.005
          ? 'match'
          : 'gap';
    rowsOut.push({
      key,
      companyId,
      companyName: company?.name ?? first?.company_name ?? first?.company_name_heard ?? '—',
      trade: company?.trade ?? first?.trade ?? null,
      siteNames: uniq(entries.map((m) => ix.siteById.get(m.site_id)?.name ?? ''))
        .filter(Boolean)
        .map(shortSiteName),
      days: dayHours,
      reported,
      invoiced,
      gap,
      status,
      unconfirmed,
      invoiceId: inv?.id ?? null,
      invoiceNo: inv?.invoice_no ?? null,
      invoiceStatus: (inv?.status as InvoiceStatus | undefined) ?? null,
      reportIdsByDay: days.map((d) =>
        uniq(entries.filter((m) => m.date === d).map((m) => m.report_id)),
      ),
    });
  }
  rowsOut.sort((a, b) => b.reported - a.reported || a.companyName.localeCompare(b.companyName));

  const totals = {
    days: days.map((_, i) => sum(rowsOut.map((r) => r.days[i] ?? 0))),
    reported: sum(rowsOut.map((r) => r.reported)),
    invoiced: sum(rowsOut.map((r) => r.invoiced ?? 0)),
    gap: sum(rowsOut.map((r) => r.gap ?? 0)),
  };
  const gapRows = rowsOut.filter((r) => r.status === 'gap');

  const transcriptByMedia = new Map(rows.transcripts.map((t) => [transcriptMediaId(t), t]));
  const audioByReport = new Map<string, ReportSourceRow>();
  for (const s of rows.sources) if (isVoiceSourceKind(s.kind)) audioByReport.set(s.report_id, s);

  const invoices: InvoiceDetail[] = rowsOut
    .filter((r) => r.invoiceId)
    .map((r) => {
      const inv = rows.invoices.find((i) => i.id === r.invoiceId)!;
      const lines = invoiceLines(inv.lines);
      const dayCmp = days.map((d, i) => {
        const invoicedDay = lines.find((l) => l.date === d)?.hours ?? 0;
        const reportedDay = r.days[i] ?? 0;
        return {
          date: d,
          invoiced: invoicedDay,
          reported: reportedDay,
          gap: Math.round((invoicedDay - reportedDay) * 100) / 100,
          reportIds: r.reportIdsByDay[i] ?? [],
        };
      });
      const evidence: InvoiceEvidence[] = [];
      for (const d of dayCmp) {
        if (Math.abs(d.gap) < 0.005) continue;
        for (const rid of d.reportIds) {
          // An accounts user cannot read reports (RLS): the current_manpower row carries the
          // report number and site, so the evidence still lists the day.
          const rep = ix.reportById.get(rid);
          const entries = subs.filter((m) => m.report_id === rid && keyOf(m) === r.key);
          const entry = entries[0];
          if (!rep && !entry) continue;
          // The manpower row's voice-note source: v1 audio (messageId) or v2 voice_note (uploadId).
          const src =
            entry &&
            isRecord(entry.source) &&
            (entry.source.type === 'audio' || entry.source.type === 'voice_note')
              ? entry.source
              : null;
          const audioStart = src && typeof src.start === 'number' ? src.start : null;
          const audio = audioByReport.get(rid);
          const transcript = audio ? transcriptByMedia.get(sourceMediaId(audio)) : undefined;
          const seg =
            transcript && audioStart !== null
              ? segmentsOf(transcript.segments).find(
                  (s) => audioStart >= s.start && audioStart < s.end,
                )
              : undefined;
          const quote =
            seg?.text ??
            `${r.companyName} · ${entries.map((m) => `${m.workers} × ${formatHoursNum(Number(m.hours) / Math.max(1, Number(m.workers)))} h`).join(', ')} = ${formatHoursNum(sum(entries.map((m) => Number(m.hours))))} h`;
          const siteId = rep?.site_id ?? entry?.site_id;
          evidence.push({
            date: d.date,
            reportId: rid,
            reportNo: rep?.report_no ?? entry?.report_no ?? '',
            siteName: (siteId && ix.siteById.get(siteId)?.name) || '',
            quote,
            audioStart,
            messageId:
              (audio && sourceMediaId(audio)) ??
              (src ? voiceMediaIdOf(src as unknown as Source) : null),
          });
        }
      }
      return {
        invoiceId: inv.id,
        invoiceNo: inv.invoice_no ?? '',
        companyId: inv.company_id,
        companyName: r.companyName,
        periodStart: inv.period_start ?? start,
        periodEnd: inv.period_end ?? end,
        status: inv.status as InvoiceStatus,
        filePath: inv.file_path,
        days: dayCmp,
        totals: { invoiced: r.invoiced ?? 0, reported: r.reported, gap: r.gap ?? 0 },
        evidence,
      };
    });

  const siteOptions = rows.sites.filter((s) => s.status !== 'archived').map(toSiteOption);
  return {
    week,
    weekStart: start,
    weekEnd: end,
    days,
    siteId,
    sites: siteOptions,
    companies: rows.companies.map(toCompanyOption),
    rows: rowsOut,
    totals,
    kpis: {
      subHours: totals.reported,
      // On site: in a report this week (not only on an invoice).
      companies: rowsOut.filter((r) => grouped.has(r.key)).length,
      gapHours: sum(gapRows.map((r) => Math.max(0, r.gap ?? 0))),
      gapSubs: gapRows.length,
    },
    invoices,
    hasInvoiceComparison,
  };
}

/**
 * Payroll CSV (§F15): date,site,project_code,company,trade,workers,hours,report_no,version —
 * columns in the org's order (org_settings.payroll_columns, normalised), like api-export-payroll.
 */
export function payrollCsv(
  rows: RowSet,
  week: string,
  siteId: string | null,
  includeUnconfirmed: boolean,
  order?: readonly string[] | null,
): string {
  const ix = buildIndex(rows);
  const { start, end } = isoWeekRange(week);
  const columns = normalizePayrollColumns(order);
  const cm = currentManpower(rows, ix).filter(
    (m) => m.date >= start && m.date <= end && (!siteId || m.site_id === siteId),
  );
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const m of cm.sort((a, b) =>
    a.date === b.date ? a.site_id.localeCompare(b.site_id) : a.date < b.date ? -1 : 1,
  )) {
    const company = m.company_id ? ix.companyById.get(m.company_id) : undefined;
    if (!includeUnconfirmed && (!company || company.status === 'unconfirmed')) continue;
    const site = ix.siteById.get(m.site_id);
    const cell: Record<PayrollColumn, string | number> = {
      date: m.date,
      site: esc(site?.name),
      project_code: esc(site?.project_code),
      company: esc(company?.name ?? m.company_name),
      trade: esc(company?.trade ?? m.trade),
      workers: m.workers,
      hours: Number(m.hours),
      report_no: esc(m.report_no),
      version: m.version,
    };
    lines.push(columns.map((c) => cell[c]).join(','));
  }
  return lines.join('\n') + '\n';
}

// ───────────────────────────── Weather ─────────────────────────────

/**
 * A pack the worker has not picked up after this long is shown as not started: only the worker
 * builds packs, and a deployment without it would otherwise show "Queued" for ever.
 */
export const PACK_START_GRACE_MS = 10 * 60 * 1000;

export function assembleWeather(
  rows: RowSet,
  ctx: AssembleCtx,
  month: string,
  site: string | null,
): WeatherLog {
  const ix = buildIndex(rows);
  // A site that is not the org's (a stale or typed link) shows every site, not an empty log.
  const siteId = site && ix.siteById.has(site) ? site : null;
  const today = formatDateInTz(ctx.now, rows.org.timezone);
  const monthEnd = monthDays(month).at(-1)!;
  const until = monthEnd < today ? monthEnd : today;
  const days = workdaysBetween(`${month}-01`, until, rows.settings.working_days);
  const wx = currentWeather(rows, ix).filter(
    (w) =>
      w.date.startsWith(month) &&
      w.date <= until &&
      (!siteId || w.site_id === siteId) &&
      (Number(w.lost_hours) > 0 || w.full_day),
  );

  const entries: DelayEntry[] = wx
    .map((w) => {
      const site = ix.siteById.get(w.site_id);
      const report = ix.reportById.get(w.report_id);
      // The voice note of the period: v1 `audio` (messageId) or v2 `voice_note` (uploadId).
      const audio = isRecord(w.audio_source) ? w.audio_source : null;
      const audioStart = audio && typeof audio.start === 'number' ? audio.start : null;
      const observed = observedWeatherOf(w.observed);
      return {
        id: w.id,
        reportId: w.report_id,
        reportNo: report?.report_no ?? w.report_no ?? '',
        siteId: w.site_id,
        siteName: site?.name ?? '',
        siteShort: site ? shortSiteName(site.name) : '',
        date: w.date,
        condition: w.condition ?? '',
        impact: w.impact,
        start: w.start_local ? hhmm(w.start_local) : null,
        end: w.end_local ? hhmm(w.end_local) : null,
        lostHours: Number(w.lost_hours),
        fullDay: w.full_day,
        observed,
        evidence: {
          audioStart,
          messageId: audio ? voiceMediaIdOf(audio as unknown as Source) : null,
          photos: w.photo_count,
          weatherData: !!observed,
          // Only a site manager's report asks for a photo; one typed in the panel has no reporter.
          photoRequested: w.photo_count === 0 && !!report?.reporter_id,
        },
        claimReady: w.claim_ready,
      };
    })
    .sort((a, b) =>
      a.date === b.date ? a.siteName.localeCompare(b.siteName) : a.date < b.date ? 1 : -1,
    );

  const cellMap = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.siteId}:${e.date}`;
    cellMap.set(k, (cellMap.get(k) ?? 0) + e.lostHours);
  }
  const cells: HeatmapCell[] = [...cellMap].map(([k, hours]) => {
    const [sid, date] = k.split(':') as [string, string];
    return { siteId: sid, date, hours: Math.round(hours * 100) / 100 };
  });
  // Every site for the site picker (the page narrows the heatmap), and the chosen one even when
  // it is archived (Site detail links here).
  const siteOptions = rows.sites
    .filter((s) => s.status !== 'archived' || s.id === siteId)
    .map(toSiteOption);
  const nowMs = ctx.now.getTime();
  const packs: PackItem[] = rows.packs
    .filter((p) => !siteId || p.site_id === siteId)
    .map((p) => ({
      id: p.id,
      siteId: p.site_id,
      siteName: p.site_id ? (ix.siteById.get(p.site_id)?.name ?? null) : null,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      status: p.status,
      sections: p.sections,
      createdAt: p.created_at,
      readyAt: p.ready_at,
      pdfPath: p.pdf_path,
      url: null,
      notStarted:
        p.status === 'queued' && nowMs - new Date(p.created_at).getTime() > PACK_START_GRACE_MS,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return {
    month,
    siteId,
    sites: siteOptions,
    days,
    cells,
    maxHours: Math.max(0, ...cells.map((c) => c.hours)),
    kpis: {
      siteDays: cellMap.size,
      hours: sum(entries.map((e) => e.lostHours)),
      claimReady: entries.filter((e) => e.claimReady).length,
      entries: entries.length,
    },
    entries,
    packs,
  };
}

// ───────────────────────────── Team ─────────────────────────────

export function assembleTeam(rows: RowSet, ctx: AssembleCtx): TeamData {
  const ix = buildIndex(rows);
  const today = formatDateInTz(ctx.now, rows.org.timezone);
  const from = addDays(today, -30);
  const reporters: TeamReporter[] = rows.reporters.map((r) => {
    const links = rows.siteReporters.filter((sr) => sr.reporter_id === r.id);
    const sites = links
      .map((l) => {
        const s = ix.siteById.get(l.site_id);
        return s
          ? { id: s.id, name: s.name, shortName: shortSiteName(s.name), isPrimary: l.is_primary }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    const primarySites = links.filter((l) => l.is_primary).map((l) => l.site_id);
    let expected = 0;
    let onTime = 0;
    let reports30 = 0;
    for (const sid of primarySites) {
      for (const d of ix.siteDaysBySite.get(sid) ?? []) {
        if (d.date < from || d.date > today || d.status === 'no_work' || d.status === 'pending')
          continue;
        expected += 1;
        if (d.status === 'filed' || d.status === 'weather_day') {
          reports30 += 1;
          if (!d.is_late) onTime += 1;
        }
      }
    }
    const chipStatus: TeamReporter['chipStatus'] =
      r.status === 'disabled'
        ? 'disabled'
        : isActiveReporterStatus(r.status)
          ? 'active'
          : r.last_invite_error
            ? 'not_on_whatsapp'
            : 'invite_sent';
    return {
      id: r.id,
      name: r.name,
      phone: r.phone_e164,
      role: r.role,
      languages: r.languages ?? [],
      status: r.status,
      chipStatus,
      sites,
      onTime30: expected ? Math.round((onTime / expected) * 100) : null,
      reports30,
      lastInviteError: r.last_invite_error,
    };
  });
  reporters.sort((a, b) => a.name.localeCompare(b.name));
  const unknownSenders = rows.unknownContacts
    .filter((u) => u.status === 'pending')
    .map((u) => ({
      id: u.id,
      phone: u.phone_e164,
      at: u.created_at,
      snippet: u.snippet,
      guessedSiteId: u.guessed_site_id,
      guessedSiteName: u.guessed_site_id
        ? (ix.siteById.get(u.guessed_site_id)?.name ?? null)
        : null,
      messageId: u.message_id,
    }));
  return {
    reporters,
    unknownSenders,
    officeUsers: officeUsers(rows),
    sites: rows.sites.filter((s) => s.status !== 'archived').map(toSiteOption),
  };
}

export function officeUsers(rows: RowSet): OfficeUser[] {
  const order: Record<string, number> = { admin: 0, pm: 1, ops: 2, accounts: 3 };
  return rows.members
    .map((m) => ({
      userId: m.user_id,
      name: m.display_name ?? m.email ?? 'User',
      email: m.email ?? null,
      title: m.title,
      role: m.role,
    }))
    .sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name));
}

// ───────────────────────────── Glossary ─────────────────────────────

export function assembleGlossary(rows: RowSet): GlossaryData {
  const ix = buildIndex(rows);
  const terms: GlossaryTerm[] = rows.glossary.map((t) => ({
    id: t.id,
    heard: t.heard,
    official: t.official,
    kind: t.kind,
    language: t.language,
    status: t.status,
    timesHeard: t.times_heard,
    scopeSiteId: t.scope_site_id,
    scopeSiteName: t.scope_site_id ? (ix.siteById.get(t.scope_site_id)?.name ?? null) : null,
    companyId: t.company_id,
    firstSeenAt: t.first_seen_at,
    lastSeenAt: t.last_seen_at,
    isBuiltIn: t.org_id === null || t.status === 'built_in',
  }));
  terms.sort((a, b) => b.timesHeard - a.timesHeard || a.heard.localeCompare(b.heard));
  return {
    reviewQueue: terms
      .filter((t) => t.status === 'needs_review')
      .sort((a, b) => ((a.lastSeenAt ?? '') < (b.lastSeenAt ?? '') ? 1 : -1)),
    terms: terms.filter((t) => t.status !== 'rejected'),
    companies: rows.companies.map(toCompanyOption),
    sites: rows.sites.map(toSiteOption),
  };
}

// ───────────────────────────── Settings / billing / setup ─────────────────────────────

export function assembleSettings(rows: RowSet): SettingsData {
  const { org_id: _o, updated_at: _u, ...settings } = rows.settings;
  return {
    org: {
      id: rows.org.id,
      name: rows.org.name,
      address: rows.org.address,
      licenseNo: rows.org.license_no,
      timezone: rows.org.timezone,
      logoPath: rows.org.logo_path,
      logoUrl: null,
    },
    settings,
    siteRecipients: rows.sites
      .filter((s) => s.status !== 'archived')
      .map((s) => ({
        siteId: s.id,
        siteName: s.name,
        emails: rows.recipients.filter((r) => r.site_id === s.id).map((r) => r.email),
      })),
  };
}

export function assembleBilling(rows: RowSet, ctx: AssembleCtx): BillingData {
  const active = rows.sites.filter((s) => s.status === 'active');
  const today = formatDateInTz(ctx.now, rows.org.timezone);
  const { y, m } = parseIsoDate(today);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const plan = rows.billing ?? {
    monthlyCents: active.length * PRICE_PER_SITE_CENTS,
    activeSites: active.length,
    pricePerSiteCents: PRICE_PER_SITE_CENTS,
    nextInvoiceDate: nextMonth,
    paymentMethod: null,
    status: rows.org.billing_status,
    trialEndsAt: rows.org.trial_ends_at,
    invoices: [],
  };
  return {
    plan: {
      monthlyCents: active.length * PRICE_PER_SITE_CENTS,
      activeSites: active.length,
      pricePerSiteCents: PRICE_PER_SITE_CENTS,
      nextInvoiceDate: plan.nextInvoiceDate,
      paymentMethod: plan.paymentMethod,
      status: rows.org.billing_status,
      trialEndsAt: rows.org.trial_ends_at,
      hasSubscription:
        rows.org.billing_subscription_id != null && rows.org.billing_status !== 'canceled',
    },
    sites: rows.sites
      .filter((s) => s.status !== 'archived')
      .map((s) => ({
        id: s.id,
        name: s.name,
        projectCode: s.project_code,
        activeSince: s.active_since,
        status: s.status,
        monthlyCents: s.status === 'active' ? PRICE_PER_SITE_CENTS : 0,
        pausedAt: s.paused_at,
      }))
      .sort((a, b) => ((a.activeSince ?? '') < (b.activeSince ?? '') ? -1 : 1)),
    invoices: plan.invoices,
  };
}

export function assembleSetupState(rows: RowSet): SetupState {
  return {
    hasOrg: true,
    orgId: rows.org.id,
    orgName: rows.org.name,
    timezone: rows.org.timezone,
    siteCount: rows.sites.filter((s) => s.status !== 'archived').length,
    reporterCount: rows.reporters.length,
    projectCodes: rows.sites.map((s) => s.project_code),
    steps: {
      company: true,
      site: rows.sites.length > 0,
      reports: rows.settings.updated_at > rows.org.created_at,
    },
  };
}

// ───────────────────────────── Notifications / badges / search ─────────────────────────────

export function assembleNotifications(rows: RowSet, ctx: AssembleCtx): NotificationItem[] {
  return rows.notifications
    .filter((n) => n.user_id === null || n.user_id === ctx.userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 50)
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      targetPath: n.target_path,
      readAt: n.read_at,
      createdAt: n.created_at,
    }));
}

export function assembleNavBadges(rows: RowSet, ctx: AssembleCtx): NavBadges {
  return {
    reportsToReview: rows.reports.filter((r) => r.status === 'filed' && r.needs_review).length,
    unknownSenders: rows.unknownContacts.filter((u) => u.status === 'pending').length,
    termsToReview: rows.glossary.filter((t) => t.status === 'needs_review').length,
    unreadNotifications: rows.notifications.filter(
      (n) => !n.read_at && (n.user_id === null || n.user_id === ctx.userId),
    ).length,
  };
}

export function searchRows(rows: RowSet, q: string, limit = 12): SearchResult[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const ix = buildIndex(rows);
  const out: SearchResult[] = [];
  const has = (s: string | null | undefined) => (s ?? '').toLowerCase().includes(needle);
  for (const s of rows.sites) {
    if (has(s.name) || has(s.project_code))
      out.push({
        kind: 'site',
        id: s.id,
        title: s.name,
        subtitle: s.project_code,
        href: `/sites/${s.id}`,
      });
  }
  for (const r of rows.reports) {
    const site = ix.siteById.get(r.site_id);
    const v = currentVersion(ix, r);
    if (has(r.report_no) || has(v?.summary)) {
      out.push({
        kind: 'report',
        id: r.id,
        title: r.report_no,
        subtitle: `${site?.name ?? ''} · ${formatMonthDay(ix.reportDate.get(r.id) ?? r.created_at.slice(0, 10))}`,
        href: `/reports/${r.id}`,
      });
    }
  }
  for (const c of rows.companies) {
    if (has(c.name) || c.aliases.some(has))
      out.push({ kind: 'company', id: c.id, title: c.name, subtitle: c.trade, href: `/hours` });
  }
  const sourceByMedia = new Map(rows.sources.map((s) => [sourceMediaId(s), s]));
  for (const t of rows.transcripts) {
    if (!has(t.text)) continue;
    const src = sourceByMedia.get(transcriptMediaId(t));
    const r = src ? ix.reportById.get(src.report_id) : undefined;
    const i = t.text.toLowerCase().indexOf(needle);
    const snippet = `…${t.text.slice(Math.max(0, i - 30), i + needle.length + 40).trim()}…`;
    out.push({
      kind: 'transcript',
      id: t.id,
      title: r ? r.report_no : copy.shell.search.groups.transcript,
      subtitle: snippet,
      href: r ? `/reports/${r.id}` : '/team',
    });
  }
  for (const r of rows.reporters) {
    if (has(r.name) || has(r.phone_e164) || has(formatPhone(r.phone_e164)))
      out.push({
        kind: 'reporter',
        id: r.id,
        title: r.name,
        subtitle: formatPhone(r.phone_e164),
        href: '/team',
      });
  }
  for (const t of rows.glossary) {
    if (has(t.heard) || has(t.official))
      out.push({
        kind: 'term',
        id: t.id,
        title: `“${t.heard}” → ${t.official ?? '?'}`,
        subtitle: t.kind,
        href: '/glossary',
      });
  }
  const order: Record<SearchResult['kind'], number> = {
    report: 0,
    site: 1,
    company: 2,
    transcript: 3,
    reporter: 4,
    term: 5,
  };
  return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, limit);
}

export function orgSummary(
  rows: RowSet,
  ctx: AssembleCtx,
): { id: string; name: string; timezone: string; activeSites: number; role: OrgMemberRow['role'] } {
  const m = rows.members.find((x) => x.user_id === ctx.userId);
  return {
    id: rows.org.id,
    name: rows.org.name,
    timezone: rows.org.timezone,
    activeSites: rows.sites.filter((s) => s.status === 'active').length,
    role: m?.role ?? 'ops',
  };
}

export function audioTimestamp(seconds: number): string {
  return formatAudioTimestamp(seconds);
}

export function reportDateOf(ix: Index, reportId: string): string | undefined {
  return ix.reportDate.get(reportId);
}

export function daysSince(date: string, today: string): number {
  return daysBetween(date, today);
}
