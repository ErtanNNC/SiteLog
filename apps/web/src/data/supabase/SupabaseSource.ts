/**
 * DataSource over Supabase: RLS-scoped table/view queries with the user's JWT, security-definer
 * RPCs for state changes, edge functions for WhatsApp/CSV/packs/billing, Realtime for live rows,
 * signed storage URLs (10 min). Rows are fetched per page scope and assembled by ../assemble.ts.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Database } from '@sitelog/shared/db/types.ts';
import { fromZonedTime } from 'date-fns-tz';
import type {
  AuditLogRow,
  CallRow,
  CompanyRow,
  EvidencePackRow,
  GlossaryTermRow,
  MessageRow,
  NotificationRow,
  OrgMemberRow,
  OrgRow,
  OrgSettingsRow,
  ReportArchiveRow,
  ReportRow,
  ReportSourceRow,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRecipientRow,
  SiteOptionRow,
  SiteReporterRow,
  SiteRow,
  SubInvoiceRow,
  TranscriptRow,
  UnknownContactRow,
  UploadRow,
  CurrentManpowerRow,
  CurrentWeatherRow,
  OpsCostOutlierRow,
  OpsUnknownContactRow,
  OpsDeadJobRow,
  OpsQueueStatRow,
} from '@sitelog/shared/db/types.ts';
import type { InvoiceStatus, MemberRole, ReporterStatus } from '@sitelog/shared/enums.ts';
import type { StoredReportData } from '@sitelog/shared/schemas/report.ts';
import { addDays, formatDateInTz, isoWeekOf, isoWeekRange } from '@sitelog/shared/format.ts';
import { logoStoragePath, pdfStoragePath } from '@sitelog/shared/report/numbering.ts';
import { invoiceUploadPath } from '@sitelog/shared/invoices.ts';
import {
  officePhotoStoragePath,
  type OfficePhotoMime,
  type OfficePhotoUpload,
} from '@sitelog/shared/report/photos.ts';
import {
  isVoiceSourceKind,
  mediaOf,
  sourceMediaId,
  transcriptMediaId,
} from '@sitelog/shared/report/media.ts';
import { copy } from '@/copy/en';
import { translate } from '@/i18n/useCopy';
import { functionsUrl } from '@/lib/env';
import { rasterizeSvgLogo } from '@/lib/logo';
import { randomUuid } from '@/lib/photos';
import type { Db } from '@/lib/supabase';
import { CodedError, errorMessage, uniq, uniqBy } from '@/lib/utils';
import {
  assembleBilling,
  assembleGlossary,
  assembleHours,
  assembleNavBadges,
  assembleNotifications,
  assembleOverview,
  assembleReportDetail,
  assembleReportItems,
  assembleSettings,
  assembleSetupState,
  assembleSiteCards,
  assembleSiteDetail,
  assembleTeam,
  assembleWeather,
  monthDays,
  paginate,
  PAGE_SIZE,
  type AssembleCtx,
  type RowSet,
} from '../assemble';
import {
  PDF_EXPORT_LIMIT,
  type AddGlossaryTermInput,
  type AddInvoiceInput,
  type CreateOfficeReportInput,
  type CreateOfficeReportResult,
  type CreateSiteInput,
  type CreateSiteResult,
  type DataSource,
  type InviteReporterInput,
  type LinkUnknownSenderInput,
  type PdfLink,
  type PdfLinkBatch,
  type PdfSelection,
  type RequestEvidencePackInput,
  type ResolveUnknownCompanyInput,
  type ReviewGlossaryTermInput,
  type SaveReportPdfInput,
  type SourceUser,
  type UpdateOrgInput,
  type UpdateReporterInput,
  type UpdateSitePatch,
  type UploadedPhoto,
} from '../source';
import type {
  BillingData,
  ChangeEvent,
  DemoPhoneData,
  DemoPhoneEmail,
  DemoPhoneMessage,
  OpsData,
  OrgSettingsPatch,
  OrgSummary,
  OrglessContacts,
  ReportFilters,
  SearchResult,
  TextDailyLinkResult,
} from '../types';

const SIGNED_URL_TTL = 600; // 10 minutes (§15)
/** Ids per `.in()` filter so PostgREST URLs stay well under proxy limits. */
const IN_CHUNK = 100;
/** Rows per request when reading a whole filtered set, under PostgREST's max_rows (1000). */
const ARCHIVE_ROWS_PER_REQUEST = 500;

/**
 * A site as the accounts role reads it (the `site_options` view: §2.2 gives accounts hours and
 * invoices, so not the `sites` table): the rest of the row is what a site without it would have.
 */
function siteFromOption(o: SiteOptionRow): SiteRow {
  return {
    ...o,
    address: null,
    lat: null,
    lng: null,
    deadline: null,
    working_hours: null,
    active_since: null,
    paused_at: null,
    report_seq: 0,
    created_at: '',
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every row of a filtered read, a page at a time: PostgREST cuts a response at max_rows without
 * an error, so one unpaged select would silently drop rows. `page` must order by a unique column.
 */
async function allPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += ARCHIVE_ROWS_PER_REQUEST) {
    const rows = unwrap(await page(from, from + ARCHIVE_ROWS_PER_REQUEST - 1));
    out.push(...rows);
    if (rows.length < ARCHIVE_ROWS_PER_REQUEST) return out;
  }
}

/** Runs an `.in()` query per IN_CHUNK ids (deduplicated) and concatenates the rows. */
async function inChunks<T>(
  ids: readonly string[],
  query: (part: string[]) => PromiseLike<T[]>,
  size = IN_CHUNK,
): Promise<T[]> {
  if (!ids.length) return [];
  return (await Promise.all(chunks(uniq(ids), size).map((part) => query(part)))).flat();
}

/**
 * Ids per `or=(upload_id.in.(…),message_id.in.(…))` filter: the list appears twice in the URL,
 * so half an IN_CHUNK keeps the request as short as one `.in()` list.
 */
const MEDIA_OR_CHUNK = IN_CHUNK / 2;

/** `upload_id` or `message_id` in `ids`: a source's or a transcript's media id (report/media.ts). */
function mediaIdFilter(ids: readonly string[]): string {
  const list = ids.join(',');
  return `upload_id.in.(${list}),message_id.in.(${list})`;
}

/** Site detail Photos tab: the newest photos of the site, one page under PostgREST max_rows. */
const SITE_PHOTO_LIMIT = 500;

/** api-billing `invoices` rows (supabase/functions/api-billing/logic.ts InvoiceSummary). */
interface StripeInvoiceSummary {
  id: string;
  date: string;
  amount_cents: number;
  status: string | null;
  hosted_invoice_url: string | null;
  sites: number;
}

/** api-billing `status` (BillingSummary) — only the fields the Billing page shows. */
interface StripeBillingStatus {
  nextInvoiceAt: string | null;
  paymentMethod: { brand: string; last4: string } | null;
}

function toBillingInvoice(inv: StripeInvoiceSummary, tz: string): BillingData['invoices'][number] {
  return {
    id: inv.id,
    date: formatDateInTz(new Date(inv.date), tz),
    sites: inv.sites,
    amountCents: inv.amount_cents,
    status: inv.status === 'paid' ? 'paid' : inv.status === 'uncollectible' ? 'past_due' : 'open',
    url: inv.hosted_invoice_url ?? '',
  };
}

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? ([] as unknown as T)) as T;
}

function unwrapOne<T>(res: { data: T | null; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw new Error(res.error.message);
  if (res.data === null || res.data === undefined) throw new Error(copy.errors.notFound);
  return res.data as NonNullable<T>;
}

function emptyRows(org: OrgRow, settings: OrgSettingsRow): RowSet {
  return {
    org,
    settings,
    members: [],
    sites: [],
    reporters: [],
    siteReporters: [],
    recipients: [],
    companies: [],
    glossary: [],
    messages: [],
    transcripts: [],
    unknownContacts: [],
    siteDays: [],
    reports: [],
    versions: [],
    sources: [],
    manpower: [],
    weatherEvents: [],
    questions: [],
    invoices: [],
    packs: [],
    notifications: [],
    audit: [],
  };
}

interface Core {
  org: OrgRow;
  settings: OrgSettingsRow;
  members: OrgMemberRow[];
  sites: SiteRow[];
  reporters: ReporterRow[];
  siteReporters: SiteReporterRow[];
  recipients: SiteRecipientRow[];
  companies: CompanyRow[];
}

export class SupabaseSource implements DataSource {
  readonly mode = 'supabase' as const;

  constructor(
    private readonly sb: Db,
    readonly orgId: string,
    readonly user: SourceUser,
    private readonly accessToken: () => Promise<string | null>,
  ) {}

  now(): Date {
    return new Date();
  }

  private ctx(): AssembleCtx {
    return { now: this.now(), userId: this.user.id };
  }

  private siteIds(core: Core): string[] {
    return core.sites.map((s) => s.id);
  }

  /**
   * Rows most pages need; cheap for ≤ 50 sites. Some tables are hidden by RLS for `accounts`,
   * which reads the site names of Crew hours from `site_options` instead of `sites`.
   */
  private async core(): Promise<Core> {
    const sb = this.sb;
    const accounts = this.user.role === 'accounts';
    const [org, settings, members, siteRows, companies] = await Promise.all([
      sb.from('orgs').select('*').eq('id', this.orgId).single(),
      sb.from('org_settings').select('*').eq('org_id', this.orgId).single(),
      sb.from('org_members').select('*').eq('org_id', this.orgId),
      accounts
        ? sb
            .from('site_options')
            .select('*')
            .eq('org_id', this.orgId)
            .order('name')
            .then((r) => unwrap(r).map(siteFromOption))
        : sb.from('sites').select('*').eq('org_id', this.orgId).order('name').then(unwrap),
      sb.from('companies').select('*').eq('org_id', this.orgId).order('name'),
    ]);
    const ids = siteRows.map((s) => s.id);
    const [reporters, siteReporters, recipients] = accounts
      ? [[], [], []]
      : await Promise.all([
          sb.from('reporters').select('*').eq('org_id', this.orgId).then(unwrap),
          ids.length ? sb.from('site_reporters').select('*').in('site_id', ids).then(unwrap) : [],
          ids.length ? sb.from('site_recipients').select('*').in('site_id', ids).then(unwrap) : [],
        ]);
    return {
      org: unwrapOne<OrgRow>(org),
      settings: unwrapOne<OrgSettingsRow>(settings),
      members: unwrap(members),
      sites: siteRows,
      reporters,
      siteReporters,
      recipients,
      companies: unwrap(companies),
    };
  }

  private rowsFrom(core: Core): RowSet {
    return { ...emptyRows(core.org, core.settings), ...core };
  }

  private async siteDays(siteIds: string[], from: string, to: string): Promise<SiteDayRow[]> {
    if (!siteIds.length) return [];
    return unwrap(
      await this.sb
        .from('site_days')
        .select('*')
        .in('site_id', siteIds)
        .gte('date', from)
        .lte('date', to),
    );
  }

  private async reportsForSiteDays(siteDayIds: string[]): Promise<ReportRow[]> {
    return inChunks(siteDayIds, (part) =>
      this.sb.from('reports').select('*').in('site_day_id', part).then(unwrap),
    );
  }

  private async currentVersions(reports: ReportRow[]): Promise<ReportVersionRow[]> {
    if (!reports.length) return [];
    const rows = unwrap(
      await this.sb
        .from('report_versions')
        .select('*')
        .in(
          'report_id',
          reports.map((r) => r.id),
        ),
    );
    const cur = new Map(reports.map((r) => [r.id, r.current_version]));
    return rows.filter((v) => cur.get(v.report_id) === v.version);
  }

  private async manpowerBetween(
    from: string,
    to: string,
    siteId?: string | null,
  ): Promise<CurrentManpowerRow[]> {
    return allPages((start, end) => {
      let q = this.sb
        .from('current_manpower')
        .select('*')
        .eq('org_id', this.orgId)
        .gte('date', from)
        .lte('date', to);
      if (siteId) q = q.eq('site_id', siteId);
      return q.order('id', { ascending: true }).range(start, end);
    });
  }

  /** `delaysOnly`: just the periods that lost time (all the Weather page uses). */
  private async weatherBetween(
    from: string,
    to: string,
    siteId?: string | null,
    delaysOnly = false,
  ): Promise<CurrentWeatherRow[]> {
    return allPages((start, end) => {
      let q = this.sb
        .from('current_weather')
        .select('*')
        .eq('org_id', this.orgId)
        .gte('date', from)
        .lte('date', to);
      if (siteId) q = q.eq('site_id', siteId);
      if (delaysOnly) q = q.or('lost_hours.gt.0,full_day.eq.true');
      return q.order('id', { ascending: true }).range(start, end);
    });
  }

  private async signedUrl(bucket: string, path: string | null | undefined): Promise<string | null> {
    if (!path) return null;
    const { data } = await this.sb.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL);
    return data?.signedUrl ?? null;
  }

  /** Signed URLs for many objects in one request, by path; a path that fails is left out. */
  private async signedUrls(bucket: string, paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!paths.length) return out;
    const { data } = await this.sb.storage
      .from(bucket)
      .createSignedUrls(uniq(paths), SIGNED_URL_TTL);
    for (const d of data ?? []) if (d.path && d.signedUrl && !d.error) out.set(d.path, d.signedUrl);
    return out;
  }

  private async callFunction<T = unknown>(
    name: string,
    body?: unknown,
    init: { method?: 'GET' | 'POST'; query?: Record<string, string> } = {},
  ): Promise<T> {
    const token = await this.accessToken();
    if (!token) throw new Error(copy.errors.notAllowed);
    const url = new URL(functionsUrl(name));
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      method: init.method ?? 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      let code: string | null = null;
      try {
        const body = JSON.parse(text) as { error?: unknown; details?: unknown };
        if (typeof body.error === 'string' && body.error) message = body.error;
        // HttpError's `details.code` (api-text-daily-link's 409 no_reporter / no_active_reporter).
        const details = body.details as { code?: unknown } | null | undefined;
        if (details && typeof details.code === 'string' && details.code) code = details.code;
      } catch {
        /* plain-text error */
      }
      message ||= `${name} failed (${res.status})`;
      throw code ? new CodedError(code, message) : new Error(message);
    }
    const ct = res.headers.get('content-type') ?? '';
    return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
  }

  // ─── Reads ───

  async getOrgs(): Promise<OrgSummary[]> {
    return fetchOrgs(this.sb, this.user.id);
  }

  async getOverview() {
    const core = await this.core();
    const now = this.now();
    const dates = uniq(core.sites.map((s) => formatDateInTz(now, s.timezone))).sort();
    // A new org has no sites yet: the window is the org's own today.
    if (!dates.length) dates.push(formatDateInTz(now, core.org.timezone));
    const from = addDays(dates[0]!, -1);
    const to = addDays(dates.at(-1)!, 1);
    const siteDays = await this.siteDays(this.siteIds(core), from, to);
    const reports = await this.reportsForSiteDays(siteDays.map((d) => d.id));
    const today = formatDateInTz(now, core.org.timezone);
    const { start, sunday } = isoWeekRange(isoWeekOf(today));
    // Today's texts to reporters: the reminders (Elm St.'s "2 reminders sent") and the ones that
    // did not arrive (F17 `undeliverable_sms`), from the day before the earliest site day (W1-16).
    const since = fromZonedTime(`${addDays(dates[0]!, -1)}T00:00:00`, core.org.timezone);
    const [versions, unknownContacts, glossary, invoices, manpower, messages, notifications] =
      await Promise.all([
        this.currentVersions(reports),
        this.sb
          .from('unknown_contacts')
          .select('*')
          .eq('org_id', this.orgId)
          .eq('status', 'pending')
          .then(unwrap),
        this.sb
          .from('glossary_terms')
          .select('*')
          .eq('org_id', this.orgId)
          .eq('status', 'needs_review')
          .then(unwrap),
        this.sb
          .from('sub_invoices')
          .select('*')
          .eq('org_id', this.orgId)
          .lte('period_start', sunday)
          .gte('period_end', start)
          .then(unwrap),
        this.manpowerBetween(addDays(start, -7), addDays(sunday, 7)),
        this.sb
          .from('messages')
          .select('*')
          .eq('org_id', this.orgId)
          .eq('direction', 'out')
          .gte('created_at', since.toISOString())
          .order('created_at', { ascending: true })
          .limit(1000)
          .then(unwrap),
        // Today's missing notices (spec §19 Q55), for "Office alerted at …" (RLS: admin and ops).
        this.sb
          .from('notifications')
          .select('*')
          .eq('org_id', this.orgId)
          .eq('kind', 'missing_report')
          .gte('created_at', since.toISOString())
          .then(unwrap),
      ]);
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays,
      reports,
      versions,
      unknownContacts,
      glossary,
      invoices,
      manpower,
      messages,
      notifications: notifications as NotificationRow[],
    };
    return assembleOverview(rows, this.ctx());
  }

  async getSites() {
    const core = await this.core();
    const now = this.now();
    const today = formatDateInTz(now, core.org.timezone);
    const from =
      addDays(today, -28) < `${today.slice(0, 7)}-01`
        ? addDays(today, -28)
        : `${today.slice(0, 7)}-01`;
    const siteDays = await this.siteDays(this.siteIds(core), from, addDays(today, 1));
    const reports = await this.reportsForSiteDays(
      siteDays.filter((d) => d.date >= addDays(today, -1)).map((d) => d.id),
    );
    const [versions, weatherEvents] = await Promise.all([
      this.currentVersions(reports),
      this.weatherBetween(`${today.slice(0, 7)}-01`, today),
    ]);
    const rows: RowSet = { ...this.rowsFrom(core), siteDays, reports, versions, weatherEvents };
    return assembleSiteCards(rows, this.ctx());
  }

  async getSiteDetail(siteId: string, month: string) {
    const core = await this.core();
    const site = core.sites.find((s) => s.id === siteId);
    if (!site) throw new Error(copy.errors.notFound);
    const today = formatDateInTz(this.now(), site.timezone);
    const days = monthDays(month);
    const from = days[0]!;
    const to = days.at(-1)!;
    // Only the viewed month (calendar, month stats) and the latest report day are loaded, so an
    // older month never pulls every row since then. The latest is the newest day with a filed
    // report (site_days.report_id is set on filing) — by day, not by filed_at, because a typed
    // report can be back-filled for an earlier day. When the latest is today it also carries
    // "Crew today"; a day that is not filed has no crew to show.
    const [monthSiteDays, latestDays] = await Promise.all([
      this.siteDays([siteId], from, to),
      this.sb
        .from('site_days')
        .select('*')
        .eq('site_id', siteId)
        .not('report_id', 'is', null)
        .lte('date', today)
        .order('date', { ascending: false })
        .limit(1)
        .then(unwrap),
    ]);
    const latestDay = latestDays[0];
    const siteDays =
      latestDay && !monthSiteDays.some((d) => d.id === latestDay.id)
        ? [...monthSiteDays, latestDay]
        : monthSiteDays;
    const reports = await this.reportsForSiteDays(siteDays.map((d) => d.id));
    const dateOfDay = new Map(siteDays.map((d) => [d.id, d.date]));
    const todayReportIds = reports
      .filter((r) => r.status !== 'void' && dateOfDay.get(r.site_day_id) === today)
      .map((r) => r.id);
    const latestReportId = latestDay?.report_id ?? null;
    // The month's manpower / weather rows cover the calendar and month stats; the Latest card's
    // report needs its own when it falls outside the month.
    const latestOutside = latestDay && (latestDay.date < from || latestDay.date > to);
    const [manpower, latestManpower, weatherEvents, latestWeather, versions, questions, photos] =
      await Promise.all([
        this.manpowerBetween(from, to, siteId),
        latestOutside && latestReportId
          ? this.sb
              .from('current_manpower')
              .select('*')
              .eq('report_id', latestReportId)
              .then(unwrap)
          : Promise.resolve([] as CurrentManpowerRow[]),
        this.weatherBetween(from, to, siteId),
        latestOutside && latestReportId
          ? this.sb.from('current_weather').select('*').eq('report_id', latestReportId).then(unwrap)
          : Promise.resolve([] as CurrentWeatherRow[]),
        inChunks([...todayReportIds, ...(latestReportId ? [latestReportId] : [])], (part) =>
          this.sb.from('report_versions').select('*').in('report_id', part).then(unwrap),
        ),
        inChunks(todayReportIds, (part) =>
          this.sb.from('questions').select('*').in('report_id', part).then(unwrap),
        ),
        this.sitePhotos(siteId, reports, siteDays),
      ]);
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays: [...siteDays, ...photos.siteDays],
      reports: [...reports, ...photos.reports],
      versions,
      manpower: [...manpower, ...latestManpower],
      weatherEvents: [...weatherEvents, ...latestWeather],
      questions,
      sources: photos.sources,
      messages: photos.messages,
      uploads: photos.uploads,
      photoLists: photos.photoLists,
    };
    const detail = assembleSiteDetail(rows, this.ctx(), siteId, month);
    const urls = await this.signedUrls(
      'photos',
      (detail.photos ?? []).map((p) => p.storagePath).filter((p): p is string => !!p),
    );
    detail.photos = (detail.photos ?? []).map((p) => ({
      ...p,
      url: p.storagePath ? (urls.get(p.storagePath) ?? null) : null,
    }));
    return detail;
  }

  /**
   * The Photos tab shows the site's photos from every report, not only the viewed month's
   * (§11.4): the newest SITE_PHOTO_LIMIT photo sources, plus the reports and site days (for the
   * report number and date) and the files (uploads, else the WhatsApp messages: the storage
   * path) that are not loaded yet, and the current versions' data.photos (which of them each
   * report shows, with what caption).
   */
  private async sitePhotos(
    siteId: string,
    loadedReports: ReportRow[],
    loadedSiteDays: SiteDayRow[],
  ): Promise<{
    sources: ReportSourceRow[];
    reports: ReportRow[];
    siteDays: SiteDayRow[];
    messages: MessageRow[];
    uploads: UploadRow[];
    photoLists: NonNullable<RowSet['photoLists']>;
  }> {
    const sources: ReportSourceRow[] = unwrap(
      await this.sb
        .from('report_sources')
        .select('*, reports!inner(site_id)')
        .eq('kind', 'photo')
        .eq('reports.site_id', siteId)
        .order('taken_at', { ascending: false, nullsFirst: false })
        .limit(SITE_PHOTO_LIMIT),
    ).map(({ reports: _site, ...s }) => s);
    if (!sources.length)
      return { sources, reports: [], siteDays: [], messages: [], uploads: [], photoLists: [] };
    const haveReport = new Set(loadedReports.map((r) => r.id));
    const [reports, { messages, uploads }] = await Promise.all([
      inChunks(
        sources.map((s) => s.report_id).filter((id) => !haveReport.has(id)),
        (part) => this.sb.from('reports').select('*').in('id', part).then(unwrap),
      ),
      this.sourceFiles(sources),
    ]);
    const haveDay = new Set(loadedSiteDays.map((d) => d.id));
    const current = new Map(
      [...loadedReports, ...reports].map((r) => [r.id, r.current_version] as const),
    );
    const [siteDays, lists] = await Promise.all([
      inChunks(
        reports.map((r) => r.site_day_id).filter((id) => !haveDay.has(id)),
        (part) => this.sb.from('site_days').select('*').in('id', part).then(unwrap),
      ),
      // Only the photos of each version (and the data version they are in), not the whole report.
      inChunks(uniq(sources.map((s) => s.report_id)), (part) =>
        this.sb
          .from('report_versions')
          .select('report_id, version, photos:data->photos, schemaVersion:data->schemaVersion')
          .in('report_id', part)
          .then(unwrap),
      ),
    ]);
    const photoLists = (lists as unknown as NonNullable<RowSet['photoLists']>).filter(
      (v) => current.get(v.report_id) === v.version,
    );
    return { sources, reports, siteDays, messages, uploads, photoLists };
  }

  /**
   * The files of report sources (report/media.ts): the uploads of their media ids (upload_id,
   * else message_id: one UUID for media the migration backfilled) and the messages of the sources
   * that have one (WhatsApp media without an upload, and the WhatsApp thread's ids).
   */
  private async sourceFiles(
    sources: ReadonlyArray<Pick<ReportSourceRow, 'upload_id' | 'message_id'>>,
  ): Promise<{ messages: MessageRow[]; uploads: UploadRow[] }> {
    const [uploads, messages] = await Promise.all([
      inChunks(
        sources.flatMap((s) => {
          const id = sourceMediaId(s);
          return id ? [id] : [];
        }),
        (part) => this.sb.from('uploads').select('*').in('id', part).then(unwrap),
      ),
      inChunks(
        sources.flatMap((s) => (s.message_id ? [s.message_id] : [])),
        (part) => this.sb.from('messages').select('*').in('id', part).then(unwrap),
      ),
    ]);
    return { messages: messages as MessageRow[], uploads: uploads as UploadRow[] };
  }

  /** The report_sources rows (selected columns) of these media ids: by upload_id or message_id. */
  private sourcesOfMedia<T>(ids: readonly string[], columns: string): Promise<T[]> {
    return inChunks(
      ids,
      (part) =>
        this.sb
          .from('report_sources')
          .select(columns)
          .or(mediaIdFilter(part))
          .then((r) => unwrap(r) as unknown as T[]),
      MEDIA_OR_CHUNK,
    );
  }

  /**
   * The archive's text search (§P6 "report text + transcripts") as a PostgREST `or` filter over
   * report_archive: report number, site name, project code and the current version's summary (a
   * substring, as in the demo), or a transcript of the report matching it (full text). `null`
   * without a query; `''` when the query has nothing left to search for.
   */
  private async archiveTextFilter(query: string | null | undefined): Promise<string | null> {
    const text = query?.trim();
    if (!text) return null;
    // `,` `(` `)` structure an `or` filter, `"` `\` quote in it, `%` `*` are ilike wildcards.
    const safe = text
      .replace(/[,()"\\%*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!safe) return '';
    const tr = unwrap(
      await this.sb
        .from('transcripts')
        .select('message_id, upload_id')
        .textSearch('text', safe, { type: 'websearch', config: 'english' })
        .limit(IN_CHUNK),
    );
    // A transcript's voice note: its upload, else its WhatsApp message (report/media.ts).
    const srcs = await this.sourcesOfMedia<{ report_id: string }>(
      tr.flatMap((t) => {
        const id = transcriptMediaId(t);
        return id ? [id] : [];
      }),
      'report_id',
    );
    // At most IN_CHUNK ids, so the request URL stays well under proxy limits.
    const ids = uniq(srcs.map((x) => x.report_id)).slice(0, IN_CHUNK);
    const like = `ilike.%${safe}%`;
    return [
      `report_no.${like}`,
      `site_name.${like}`,
      `project_code.${like}`,
      `summary.${like}`,
      ...(ids.length ? [`id.in.(${ids.join(',')})`] : []),
    ].join(',');
  }

  /**
   * The Reports archive (§P6) for a set of filters, before ordering and paging: report_archive
   * rows (filed / signed-off reports with their current version's date, lost hours, incident flag
   * and summary), so every filter runs server-side without id lists in the URL.
   */
  private archive(
    columns: string,
    filters: ReportFilters,
    text: string | null,
    opts: { count?: 'exact'; head?: boolean } = {},
  ) {
    let q = this.sb.from('report_archive').select(columns, opts).eq('org_id', this.orgId);
    if (filters.siteId) q = q.eq('site_id', filters.siteId);
    if (filters.from) q = q.gte('date', filters.from);
    if (filters.to) q = q.lte('date', filters.to);
    switch (filters.status) {
      case 'needs_review':
        q = q.eq('status', 'filed').eq('needs_review', true);
        break;
      case 'filed':
        q = q.eq('status', 'filed').eq('needs_review', false).neq('kind', 'weather_day');
        break;
      case 'signed_off':
        q = q.eq('status', 'signed_off');
        break;
      case 'weather_day':
        q = q.eq('kind', 'weather_day');
        break;
      default:
        break;
    }
    if (filters.edited) q = q.gt('current_version', 1);
    if (filters.late) q = q.eq('is_late', true);
    if (filters.hasWeatherDelay) q = q.or('lost_hours.gt.0,kind.eq.weather_day');
    if (filters.incident) q = q.eq('has_incident', true);
    // P6 Channel: Link = the web recorder or SMS (field_channel web, sms), Call = voice.
    if (filters.channel === 'link') q = q.in('channel', ['web', 'sms']);
    else if (filters.channel === 'call') q = q.eq('channel', 'voice');
    if (text === '') q = q.in('id', []);
    else if (text) q = q.or(text);
    return q;
  }

  /** Archive order: newest report date first, then by site (as the demo sorts). */
  private archiveOrdered(q: ReturnType<SupabaseSource['archive']>) {
    return q
      .order('date', { ascending: false })
      .order('site_name', { ascending: true })
      .order('received_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true });
  }

  /** Lost weather hours over every report matching the filters, not just the page shown. */
  private async archiveWeatherHours(filters: ReportFilters, text: string | null): Promise<number> {
    let total = 0;
    for (let from = 0; ; from += ARCHIVE_ROWS_PER_REQUEST) {
      const rows = unwrap(
        await this.archive('id, lost_hours', filters, text)
          .gt('lost_hours', 0)
          .order('id', { ascending: true })
          .range(from, from + ARCHIVE_ROWS_PER_REQUEST - 1),
      ) as unknown as Array<Pick<ReportArchiveRow, 'id' | 'lost_hours'>>;
      total += rows.reduce((a, r) => a + Number(r.lost_hours), 0);
      if (rows.length < ARCHIVE_ROWS_PER_REQUEST) break;
    }
    return Math.round(total * 100) / 100;
  }

  /**
   * The versions an archive page needs, without their data: the current one (its PDF and its
   * photo list, for the "No photo" flag) and version 1 (who wrote it: a typed report stays the
   * office's after an edit, it does not become the site manager's). assembleReportItems reads
   * only these columns; the photo lists go to RowSet.photoLists.
   */
  private async archiveVersions(
    reports: ReportRow[],
  ): Promise<{ versions: ReportVersionRow[]; photoLists: NonNullable<RowSet['photoLists']> }> {
    const cur = new Map(reports.map((r) => [r.id, r.current_version]));
    const rows = (await inChunks(
      reports.map((r) => r.id),
      (part) =>
        this.sb
          .from('report_versions')
          .select('report_id, version, author, pdf_path, photos:data->photos')
          .in('report_id', part)
          .then(unwrap),
    )) as unknown as Array<
      Pick<ReportVersionRow, 'report_id' | 'version' | 'author' | 'pdf_path'> & { photos: unknown }
    >;
    const kept = rows.filter((v) => v.version === 1 || cur.get(v.report_id) === v.version);
    return {
      versions: kept.map(({ photos: _photos, ...v }) => v as ReportVersionRow),
      photoLists: kept
        .filter((v) => cur.get(v.report_id) === v.version)
        .map((v) => ({ report_id: v.report_id, version: v.version, photos: v.photos })),
    };
  }

  async listReports(filters: ReportFilters) {
    const sb = this.sb;
    const pageSize = filters.pageSize ?? PAGE_SIZE;
    const page = Math.max(1, filters.page ?? 1);
    const [core, text] = await Promise.all([this.core(), this.archiveTextFilter(filters.q)]);
    const [res, weatherHours] = await Promise.all([
      this.archiveOrdered(this.archive('*', filters, text, { count: 'exact' })).range(
        (page - 1) * pageSize,
        page * pageSize - 1,
      ),
      this.archiveWeatherHours(filters, text),
    ]);
    if (res.error) {
      // A page past the last one (a stale or typed URL): PostgREST answers 416. Return it empty
      // with the real total, like a page just past the end, so the archive goes back to page 1.
      if (res.error.code !== 'PGRST103' || page === 1) throw new Error(res.error.message);
      const head = await this.archive('id', filters, text, { count: 'exact', head: true });
      if (head.error) throw new Error(head.error.message);
      return paginate([], head.count ?? 0, filters, weatherHours);
    }
    const raw = (res.data ?? []) as unknown as ReportArchiveRow[];
    const reports: ReportRow[] = raw.map(
      ({
        date: _date,
        site_name: _site,
        project_code: _code,
        lost_hours: _lost,
        has_incident: _incident,
        summary: _summary,
        ...r
      }) => r,
    );
    const siteDays = raw.map(
      (r) => ({ id: r.site_day_id, date: r.date, site_id: r.site_id }) as SiteDayRow,
    );
    const incidentIds = new Set(raw.filter((r) => r.has_incident).map((r) => r.id));
    const ids = reports.map((r) => r.id);
    const [manpower, weatherEvents, archived] = ids.length
      ? await Promise.all([
          sb.from('current_manpower').select('*').in('report_id', ids).then(unwrap),
          sb.from('current_weather').select('*').in('report_id', ids).then(unwrap),
          this.archiveVersions(reports),
        ])
      : [[], [], { versions: [], photoLists: [] }];
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays,
      reports,
      versions: archived.versions,
      photoLists: archived.photoLists,
      manpower,
      weatherEvents,
    };
    const items = assembleReportItems(rows, reports, incidentIds);
    return paginate(items, res.count ?? items.length, filters, weatherHours);
  }

  async getReportDetail(reportId: string, version?: number | null) {
    const core = await this.core();
    const sb = this.sb;
    const report = unwrapOne<ReportRow>(
      await sb.from('reports').select('*').eq('id', reportId).single(),
    );
    const site = core.sites.find((s) => s.id === report.site_id);
    if (!site) throw new Error(copy.errors.notFound);
    const [siteDay, versions, sources, questions, audit, weatherEvents] = await Promise.all([
      sb
        .from('site_days')
        .select('*')
        .eq('id', report.site_day_id)
        .single()
        .then((r) => unwrapOne<SiteDayRow>(r)),
      sb
        .from('report_versions')
        .select('*')
        .eq('report_id', reportId)
        .order('version')
        .then(unwrap),
      sb.from('report_sources').select('*').eq('report_id', reportId).then(unwrap),
      sb.from('questions').select('*').eq('report_id', reportId).then(unwrap),
      sb
        .from('audit_log')
        .select('*')
        .eq('org_id', this.orgId)
        .or(`entity_id.eq.${reportId},entity_id.eq.${report.site_day_id}`)
        .order('created_at')
        .then(unwrap),
      sb.from('current_weather').select('*').eq('report_id', reportId).then(unwrap),
    ]);
    // The sources' files: uploads first, WhatsApp messages as the fallback (report/media.ts).
    const { messages: srcMessages, uploads } = await this.sourceFiles(sources);
    const uploadById = new Map(uploads.map((u) => [u.id, u]));
    const msgById = new Map(srcMessages.map((m) => [m.id, m]));
    // Every voice note of the report (W1-17: each clip plays), and its WhatsApp thread if any.
    const voiceFiles = uniqBy(
      sources
        .filter((s) => isVoiceSourceKind(s.kind))
        .flatMap((s) => {
          const f = mediaOf(s, uploadById, msgById);
          return f ? [f] : [];
        }),
      (f) => f.id,
    );
    const convoId = voiceFiles.find((f) => f.conversationId)?.conversationId ?? null;
    const dayStart = fromZonedTime(`${siteDay.date}T00:00:00`, site.timezone).toISOString();
    const dayEnd = fromZonedTime(
      `${addDays(siteDay.date, 1)}T00:00:00`,
      site.timezone,
    ).toISOString();
    const reporterId = report.reporter_id;
    const callIds = uniq(sources.flatMap((s) => (s.call_id ? [s.call_id] : [])));
    const [convoMessages, siteReports, calls, texts, linkAudit] = await Promise.all([
      convoId
        ? sb
            .from('messages')
            .select('*')
            .eq('conversation_id', convoId)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd)
            .order('created_at')
            .then(unwrap)
        : Promise.resolve([] as MessageRow[]),
      sb
        .from('reports')
        .select('id, site_day_id, status, site_id, site_days!reports_site_day_id_fkey(date)')
        .eq('site_id', site.id)
        .in('status', ['filed', 'signed_off'])
        .then(unwrap),
      // The report's calls, and the reporter's other calls that day (a missed reminder call).
      sb
        .from('calls')
        .select('*')
        .or(
          [
            `report_id.eq.${reportId}`,
            ...(callIds.length ? [`id.in.(${callIds.join(',')})`] : []),
            ...(reporterId
              ? [
                  `and(reporter_id.eq.${reporterId},created_at.gte.${dayStart},created_at.lt.${dayEnd})`,
                ]
              : []),
          ].join(','),
        )
        .then(unwrap),
      // The reporter's texts that day (any message channel; SMS since W1-08).
      reporterId
        ? sb
            .from('messages')
            .select('*')
            .eq('reporter_id', reporterId)
            .not('channel', 'is', null)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd)
            .order('created_at')
            .then(unwrap)
        : Promise.resolve([] as MessageRow[]),
      // The reporter's link openings that day (field-api audits them on the link, not the report).
      reporterId
        ? sb
            .from('audit_log')
            .select('*')
            .eq('org_id', this.orgId)
            .eq('actor_id', reporterId)
            .eq('action', 'link.opened')
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd)
            .then(unwrap)
        : Promise.resolve([] as AuditLogRow[]),
    ]);
    // Transcripts of every clip: voice notes by upload (or WhatsApp message), calls by call.
    const answered = (calls as CallRow[]).filter((c) => c.status === 'completed');
    const transcripts = await inChunks(
      [...voiceFiles.map((f) => `v:${f.id}`), ...answered.map((c) => `c:${c.id}`)],
      (part) => {
        const voice = part.filter((x) => x.startsWith('v:')).map((x) => x.slice(2));
        const call = part.filter((x) => x.startsWith('c:')).map((x) => x.slice(2));
        const or = [
          ...(voice.length ? [mediaIdFilter(voice)] : []),
          ...(call.length ? [`call_id.in.(${call.join(',')})`] : []),
        ].join(',');
        return sb.from('transcripts').select('*').or(or).then(unwrap);
      },
      MEDIA_OR_CHUNK,
    );
    const messages = uniqBy(
      [...srcMessages, ...convoMessages, ...(texts as MessageRow[])],
      (m) => m.id,
    );
    const otherReports = (
      siteReports as unknown as Array<{
        id: string;
        site_day_id: string;
        site_id: string;
        status: ReportRow['status'];
        site_days: { date: string } | null;
      }>
    )
      .filter((r) => r.id !== reportId)
      .map(
        (r) =>
          ({
            ...report,
            id: r.id,
            site_day_id: r.site_day_id,
            status: r.status,
            report_no: '',
          }) as ReportRow,
      );
    const otherSiteDays = (
      siteReports as unknown as Array<{ site_day_id: string; site_days: { date: string } | null }>
    )
      .filter((r) => r.site_days && r.site_day_id !== siteDay.id)
      .map((r) => ({ id: r.site_day_id, date: r.site_days!.date, site_id: site.id }) as SiteDayRow);
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays: [siteDay, ...otherSiteDays],
      reports: [report, ...otherReports],
      versions,
      sources: sources as ReportSourceRow[],
      messages,
      uploads,
      transcripts,
      calls: calls as CallRow[],
      questions,
      audit: uniqBy([...(audit as AuditLogRow[]), ...(linkAudit as AuditLogRow[])], (a) => a.id),
      weatherEvents,
    };
    const detail = assembleReportDetail(rows, this.ctx(), reportId, version);
    const viewed = versions.find((v) => v.version === detail.version);
    // Signed URLs (10 min) for every clip: voice notes in `audio`, call recordings in `calls`.
    const [audioUrls, callUrls, pdfUrl, photoUrls] = await Promise.all([
      this.signedUrls(
        'audio',
        detail.clips.flatMap((c) => (c.bucket === 'audio' && c.storagePath ? [c.storagePath] : [])),
      ),
      this.signedUrls(
        'calls',
        detail.clips.flatMap((c) => (c.bucket === 'calls' && c.storagePath ? [c.storagePath] : [])),
      ),
      this.signedUrl('pdfs', viewed?.pdf_path),
      Promise.all(detail.photos.map((p) => this.signedUrl('photos', p.storagePath))),
    ]);
    detail.clips = detail.clips.map((c) => ({
      ...c,
      url: c.storagePath
        ? ((c.bucket === 'calls' ? callUrls : audioUrls).get(c.storagePath) ?? null)
        : null,
    }));
    if (detail.audio)
      detail.audio.url = detail.audio.storagePath
        ? (audioUrls.get(detail.audio.storagePath) ?? null)
        : null;
    detail.pdfUrl = pdfUrl;
    detail.photos = detail.photos.map((p, i) => ({ ...p, url: photoUrls[i] ?? null }));
    return detail;
  }

  async getHours(week: string, siteId: string | null = null) {
    const core = await this.core();
    const { start, end } = isoWeekRange(week);
    const [manpower, invoices] = await Promise.all([
      this.manpowerBetween(start, end, siteId),
      this.sb
        .from('sub_invoices')
        .select('*')
        .eq('org_id', this.orgId)
        .lte('period_start', end)
        .gte('period_end', start)
        .then(unwrap),
    ]);
    // Reports, their audio and transcripts are admin/pm/ops only (RLS): an accounts user gets
    // the hours and report numbers from current_manpower alone. Id lists go in IN_CHUNK parts.
    const reportIds = this.user.role === 'accounts' ? [] : manpower.map((m) => m.report_id);
    const [reports, sources] = await Promise.all([
      inChunks(reportIds, (part) =>
        this.sb.from('reports').select('*').in('id', part).then(unwrap),
      ),
      // Voice notes: WhatsApp `audio` or v1.2 `voice_note` (report/media.ts).
      inChunks(reportIds, (part) =>
        this.sb
          .from('report_sources')
          .select('*')
          .in('kind', ['audio', 'voice_note'])
          .in('report_id', part)
          .then(unwrap),
      ),
    ]);
    // The calls and answered questions the crew lines cite (W3-06: call and answer evidence).
    const cited = (key: 'callId' | 'questionId', type: 'call' | 'answer') =>
      this.user.role === 'accounts'
        ? []
        : [
            ...new Set(
              manpower.flatMap((m) => {
                const src = m.source as Record<string, unknown> | null;
                const id = src && src.type === type ? src[key] : null;
                return typeof id === 'string' ? [id] : [];
              }),
            ),
          ];
    const [transcripts, callTranscripts, questions] = await Promise.all([
      inChunks(
        sources.flatMap((s) => {
          const id = sourceMediaId(s);
          return id ? [id] : [];
        }),
        (part) => this.sb.from('transcripts').select('*').or(mediaIdFilter(part)).then(unwrap),
        MEDIA_OR_CHUNK,
      ),
      inChunks(cited('callId', 'call'), (part) =>
        this.sb.from('transcripts').select('*').in('call_id', part).then(unwrap),
      ),
      inChunks(cited('questionId', 'answer'), (part) =>
        this.sb.from('questions').select('*').in('id', part).then(unwrap),
      ),
    ]);
    const rows: RowSet = {
      ...this.rowsFrom(core),
      manpower,
      invoices,
      reports,
      sources,
      transcripts: [...transcripts, ...callTranscripts],
      questions,
    };
    return assembleHours(rows, this.ctx(), week, siteId);
  }

  async getWeather(month: string, site: string | null = null) {
    const core = await this.core();
    const days = monthDays(month);
    // As assembleWeather: a site that is not the org's shows every site.
    const siteId = site && core.sites.some((s) => s.id === site) ? site : null;
    const [weatherEvents, packs] = await Promise.all([
      this.weatherBetween(days[0]!, days.at(-1)!, siteId, true),
      this.sb
        .from('evidence_packs')
        .select('*')
        .eq('org_id', this.orgId)
        .order('created_at', { ascending: false })
        .limit(50)
        .then(unwrap),
    ]);
    // The reports tell a site manager's report (a photo was asked for) from a typed one.
    const reports = await inChunks(
      weatherEvents.map((w) => w.report_id),
      (part) => this.sb.from('reports').select('*').in('id', part).then(unwrap),
    );
    const rows: RowSet = {
      ...this.rowsFrom(core),
      weatherEvents,
      packs: packs as EvidencePackRow[],
      reports,
    };
    const log = assembleWeather(rows, this.ctx(), month, siteId);
    log.packs = await Promise.all(
      log.packs.map(async (p) => ({
        ...p,
        url: p.status === 'ready' ? await this.signedUrl('exports', p.pdfPath) : null,
      })),
    );
    return log;
  }

  async getTeam() {
    const core = await this.core();
    const today = formatDateInTz(this.now(), core.org.timezone);
    const [siteDays, unknownContacts] = await Promise.all([
      this.siteDays(this.siteIds(core), addDays(today, -30), today),
      this.sb
        .from('unknown_contacts')
        .select('*')
        .eq('org_id', this.orgId)
        .eq('status', 'pending')
        .then(unwrap),
    ]);
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays,
      unknownContacts: unknownContacts as UnknownContactRow[],
    };
    return assembleTeam(rows, this.ctx());
  }

  async getGlossary() {
    const core = await this.core();
    const glossary = unwrap(
      await this.sb
        .from('glossary_terms')
        .select('*')
        .or(`org_id.eq.${this.orgId},org_id.is.null`)
        .order('times_heard', { ascending: false }),
    );
    return assembleGlossary({ ...this.rowsFrom(core), glossary: glossary as GlossaryTermRow[] });
  }

  async getSettings() {
    const data = assembleSettings(this.rowsFrom(await this.core()));
    data.org.logoUrl = await this.signedUrl('logos', data.org.logoPath);
    return data;
  }

  /**
   * Plan and sites from the database; invoices and the payment method from Stripe through
   * api-billing (admin only). Stripe being unreachable or unconfigured leaves those empty.
   */
  async getBilling() {
    const core = await this.core();
    const data = assembleBilling(this.rowsFrom(core), this.ctx());
    const call = <T>(action: 'status' | 'invoices') =>
      this.callFunction<T>('api-billing', { orgId: this.orgId, action }).catch(() => null);
    const [status, invoices] = await Promise.all([
      call<StripeBillingStatus>('status'),
      call<{ invoices?: StripeInvoiceSummary[] }>('invoices'),
    ]);
    if (status && typeof status === 'object') {
      if (status.paymentMethod) data.plan.paymentMethod = status.paymentMethod;
      if (status.nextInvoiceAt)
        data.plan.nextInvoiceDate = formatDateInTz(
          new Date(status.nextInvoiceAt),
          core.org.timezone,
        );
    }
    if (invoices && Array.isArray(invoices.invoices)) {
      data.invoices = invoices.invoices
        .filter((i) => i.status !== 'draft' && i.status !== 'void')
        .map((i) => toBillingInvoice(i, core.org.timezone));
    }
    return data;
  }

  async getBillingCheckoutUrl() {
    const res = await this.callFunction<{ url?: string | null }>('api-billing', {
      orgId: this.orgId,
      action: 'checkout',
    });
    if (!res?.url) throw new Error(copy.errors.generic);
    return res.url;
  }

  async getBillingPortalUrl() {
    const res = await this.callFunction<{ url?: string | null }>('api-billing', {
      orgId: this.orgId,
      action: 'portal',
    });
    if (!res?.url) throw new Error(copy.errors.generic);
    return res.url;
  }

  async getNotifications() {
    const core = await this.core();
    const notifications = unwrap(
      await this.sb
        .from('notifications')
        .select('*')
        .eq('org_id', this.orgId)
        .order('created_at', { ascending: false })
        .limit(50),
    );
    return assembleNotifications(
      { ...this.rowsFrom(core), notifications: notifications as NotificationRow[] },
      this.ctx(),
    );
  }

  async getNavBadges() {
    const sb = this.sb;
    const count = async (
      q: PromiseLike<{ count: number | null; error: { message: string } | null }>,
    ) => {
      const r = await q;
      return r.error ? 0 : (r.count ?? 0);
    };
    const [reportsToReview, unknownSenders, termsToReview, unread] = await Promise.all([
      count(
        sb
          .from('reports')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', this.orgId)
          .eq('status', 'filed')
          .eq('needs_review', true),
      ),
      count(
        sb
          .from('unknown_contacts')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', this.orgId)
          .eq('status', 'pending'),
      ),
      count(
        sb
          .from('glossary_terms')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', this.orgId)
          .eq('status', 'needs_review'),
      ),
      count(
        sb
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', this.orgId)
          .is('read_at', null),
      ),
    ]);
    const rows = emptyRows({} as OrgRow, {} as OrgSettingsRow);
    void assembleNavBadges(rows, this.ctx());
    return { reportsToReview, unknownSenders, termsToReview, unreadNotifications: unread };
  }

  async getSetupState() {
    const core = await this.core();
    return assembleSetupState(this.rowsFrom(core));
  }

  async search(q: string): Promise<SearchResult[]> {
    const needle = q.trim();
    if (needle.length < 2) return [];
    const like = `%${needle.replace(/[%_]/g, ' ')}%`;
    const sb = this.sb;
    const [sites, reports, companies, reporters, terms, transcripts] = await Promise.all([
      sb
        .from('sites')
        .select('id, name, project_code')
        .eq('org_id', this.orgId)
        .or(`name.ilike.${like},project_code.ilike.${like}`)
        .limit(5)
        .then(unwrap),
      sb
        .from('reports')
        .select('id, report_no, site_id')
        .eq('org_id', this.orgId)
        .ilike('report_no', like)
        .limit(5)
        .then(unwrap),
      sb
        .from('companies')
        .select('id, name, trade')
        .eq('org_id', this.orgId)
        .ilike('name', like)
        .limit(5)
        .then(unwrap),
      this.user.role === 'accounts'
        ? Promise.resolve([] as Array<Pick<ReporterRow, 'id' | 'name' | 'phone_e164'>>)
        : sb
            .from('reporters')
            .select('id, name, phone_e164')
            .eq('org_id', this.orgId)
            .or(`name.ilike.${like},phone_e164.ilike.${like}`)
            .limit(5)
            .then(unwrap),
      sb
        .from('glossary_terms')
        .select('id, heard, official, kind')
        .or(`org_id.eq.${this.orgId},org_id.is.null`)
        .or(`heard.ilike.${like},official.ilike.${like}`)
        .limit(5)
        .then(unwrap),
      this.user.role === 'accounts'
        ? Promise.resolve(
            [] as Array<Pick<TranscriptRow, 'id' | 'message_id' | 'upload_id' | 'text'>>,
          )
        : sb
            .from('transcripts')
            .select('id, message_id, upload_id, text')
            .textSearch('text', needle.replace(/[,()]/g, ' '), {
              type: 'websearch',
              config: 'english',
            })
            .limit(5)
            .then(unwrap),
    ]);
    const siteName = new Map((await this.core()).sites.map((s) => [s.id, s.name]));
    const out: SearchResult[] = [];
    for (const r of reports)
      out.push({
        kind: 'report',
        id: r.id,
        title: r.report_no,
        subtitle: siteName.get(r.site_id) ?? null,
        href: `/reports/${r.id}`,
      });
    for (const s of sites)
      out.push({
        kind: 'site',
        id: s.id,
        title: s.name,
        subtitle: s.project_code,
        href: `/sites/${s.id}`,
      });
    for (const c of companies)
      out.push({ kind: 'company', id: c.id, title: c.name, subtitle: c.trade, href: '/hours' });
    if (transcripts.length) {
      const srcs = await this.sourcesOfMedia<
        Pick<ReportSourceRow, 'report_id' | 'message_id' | 'upload_id'>
      >(
        transcripts.flatMap((t) => {
          const id = transcriptMediaId(t);
          return id ? [id] : [];
        }),
        'report_id, message_id, upload_id',
      );
      for (const t of transcripts) {
        const id = transcriptMediaId(t);
        const src = srcs.find((s) => id !== null && sourceMediaId(s) === id);
        const i = t.text.toLowerCase().indexOf(needle.toLowerCase());
        const snippet =
          i >= 0
            ? `…${t.text.slice(Math.max(0, i - 30), i + needle.length + 40).trim()}…`
            : t.text.slice(0, 80);
        out.push({
          kind: 'transcript',
          id: t.id,
          title: copy.shell.search.groups.transcript,
          subtitle: snippet,
          href: src ? `/reports/${src.report_id}` : '/reports',
        });
      }
    }
    for (const r of reporters)
      out.push({
        kind: 'reporter',
        id: r.id,
        title: r.name,
        subtitle: r.phone_e164,
        href: '/team',
      });
    for (const t of terms)
      out.push({
        kind: 'term',
        id: t.id,
        title: `“${t.heard}” → ${t.official ?? '?'}`,
        subtitle: t.kind,
        href: '/glossary',
      });
    return out.slice(0, 12);
  }

  /** Current-version PDFs of explicit reports or of every report matching archive filters. */
  async getPdfUrls(selection: PdfSelection): Promise<PdfLinkBatch> {
    type Picked = Pick<ReportRow, 'id' | 'report_no' | 'current_version'> & { date: string };
    let reports: Picked[];
    let total: number;
    if ('reportIds' in selection) {
      const ids = uniq(selection.reportIds);
      total = ids.length;
      const wanted = ids.slice(0, PDF_EXPORT_LIMIT);
      const found = (
        await Promise.all(
          chunks(wanted, IN_CHUNK).map((part) =>
            this.sb
              .from('reports')
              .select('id, report_no, current_version, site_day_id')
              .in('id', part)
              .then(unwrap),
          ),
        )
      ).flat();
      // The report date names the file (§12, D33).
      const days = (
        await Promise.all(
          chunks(uniq(found.map((r) => r.site_day_id)), IN_CHUNK).map((part) =>
            this.sb.from('site_days').select('id, date').in('id', part).then(unwrap),
          ),
        )
      ).flat();
      const dateOf = new Map(days.map((d) => [d.id, d.date]));
      const byId = new Map(
        found.map((r) => [
          r.id,
          {
            id: r.id,
            report_no: r.report_no,
            current_version: r.current_version,
            date: dateOf.get(r.site_day_id) ?? '',
          },
        ]),
      );
      reports = wanted.map((id) => byId.get(id)).filter((r): r is Picked => !!r);
    } else {
      const text = await this.archiveTextFilter(selection.filters.q);
      const res = await this.archiveOrdered(
        this.archive('id, report_no, current_version, date', selection.filters, text, {
          count: 'exact',
        }),
      ).range(0, PDF_EXPORT_LIMIT - 1);
      if (res.error) throw new Error(res.error.message);
      reports = (res.data ?? []) as unknown as Picked[];
      total = res.count ?? reports.length;
    }

    const versions = (
      await Promise.all(
        chunks(
          reports.map((r) => r.id),
          IN_CHUNK,
        ).map((part) =>
          this.sb
            .from('report_versions')
            .select('report_id, version, pdf_path')
            .in('report_id', part)
            .then(unwrap),
        ),
      )
    ).flat();
    const pdfPath = new Map(versions.map((v) => [`${v.report_id}:${v.version}`, v.pdf_path]));
    const pathOf = (r: Picked) => pdfPath.get(`${r.id}:${r.current_version}`) ?? null;
    const paths = uniq(reports.map(pathOf).filter((p): p is string => !!p));
    const urlByPath = new Map<string, string>();
    if (paths.length) {
      const signed = await this.sb.storage.from('pdfs').createSignedUrls(paths, SIGNED_URL_TTL);
      if (signed.error) throw new Error(signed.error.message);
      for (const d of signed.data ?? [])
        if (d.path && d.signedUrl && !d.error) urlByPath.set(d.path, d.signedUrl);
    }

    const files: PdfLink[] = [];
    const missing: PdfLinkBatch['missing'] = [];
    for (const r of reports) {
      const path = pathOf(r);
      const url = path ? urlByPath.get(path) : undefined;
      const link = {
        reportId: r.id,
        reportNo: r.report_no,
        date: r.date,
        version: r.current_version,
      };
      if (url) files.push({ ...link, url });
      else missing.push(link);
    }
    return { files, missing, total, capped: total > PDF_EXPORT_LIMIT };
  }

  // ─── Mutations (RPCs are security definer and check roles themselves) ───

  private async rpc<K extends keyof Database['public']['Functions']>(
    fn: K,
    args: Database['public']['Functions'][K]['Args'],
  ) {
    const { data, error } = await this.sb.rpc(fn, args as never);
    if (error) throw new Error(error.message);
    return data;
  }

  async signOff(reportId: string) {
    await this.rpc('sign_off_report', { p_report_id: reportId });
  }
  async undoSignOff(reportId: string) {
    await this.rpc('undo_sign_off', { p_report_id: reportId });
  }
  async createReportVersion(
    reportId: string,
    data: StoredReportData,
    changeNote: string,
    photos: OfficePhotoUpload[] = [],
    baseVersion?: number,
  ) {
    let res: { version?: number } | null;
    try {
      res = (await this.rpc(
        'create_report_version',
        baseVersion === undefined
          ? {
              p_report_id: reportId,
              p_data: data as never,
              p_change_note: changeNote,
              ...(photos.length ? { p_photos: photos as never } : {}),
            }
          : {
              p_report_id: reportId,
              p_data: data as never,
              p_change_note: changeNote,
              p_photos: photos as never,
              p_base_version: baseVersion,
            },
      )) as { version?: number } | null;
    } catch (err) {
      // §19 Q106: a newer version (the reporter's change, photos added) is never overwritten.
      if (errorMessage(err) === 'version_changed')
        throw new CodedError('version_changed', translate('report.editMode.versionChanged'));
      throw err;
    }
    return { version: res?.version ?? 0 };
  }
  async createOfficeReport(input: CreateOfficeReportInput): Promise<CreateOfficeReportResult> {
    const photos = input.photos ?? [];
    const res = (await this.rpc('create_office_report', {
      p_site_id: input.siteId,
      p_date: input.date,
      p_data: input.data as never,
      ...(photos.length ? { p_photos: photos as never } : {}),
    })) as Partial<CreateOfficeReportResult> | null;
    if (!res?.reportId || !res.reportNo) throw new Error(copy.errors.generic);
    return { reportId: res.reportId, reportNo: res.reportNo, created: res.created === true };
  }
  async findDayReport(siteId: string, date: string) {
    const days = unwrap(
      await this.sb.from('site_days').select('id').eq('site_id', siteId).eq('date', date).limit(1),
    );
    const day = days[0];
    if (!day) return null;
    const reports = unwrap(
      await this.sb
        .from('reports')
        .select('id, report_no')
        .eq('site_day_id', day.id)
        .neq('status', 'void')
        .order('created_at', { ascending: true })
        .limit(1),
    );
    const r = reports[0];
    return r ? { reportId: r.id, reportNo: r.report_no } : null;
  }
  /** Random object names, so no upsert: the storage policy allows inserts only. */
  async uploadReportPhoto(
    siteId: string,
    photo: Blob,
    mime: OfficePhotoMime,
  ): Promise<UploadedPhoto> {
    const path = officePhotoStoragePath(this.orgId, siteId, randomUuid(), mime);
    const { error } = await this.sb.storage.from('photos').upload(path, photo, {
      contentType: mime,
      upsert: false,
      cacheControl: '3600',
    });
    if (error) throw new Error(error.message);
    return { path, mime };
  }
  async saveReportPdf(input: SaveReportPdfInput) {
    const path = pdfStoragePath(this.orgId, input.siteId, input.reportNo, input.version);
    const { error } = await this.sb.storage.from('pdfs').upload(path, input.pdf, {
      contentType: 'application/pdf',
      upsert: true,
      cacheControl: '60',
    });
    if (error) throw error;
    await this.rpc('attach_version_pdf', {
      p_report_id: input.reportId,
      p_version: input.version,
      p_path: path,
    });
    return (await this.signedUrl('pdfs', path)) ?? URL.createObjectURL(input.pdf);
  }
  async markNoWork(siteDayId: string) {
    await this.rpc('mark_no_work', { p_site_day_id: siteDayId });
  }
  async textDailyLink(siteId: string, requestId: string): Promise<TextDailyLinkResult> {
    const res = await this.callFunction<TextDailyLinkResult>('api-text-daily-link', {
      siteId,
      requestId,
    });
    return res.sent
      ? { sent: true, channel: res.channel }
      : { sent: false, reason: res.reason, detail: res.detail ?? null };
  }
  async resolveUnknownCompany(input: ResolveUnknownCompanyInput) {
    await this.rpc('resolve_unknown_company', {
      p_report_id: input.reportId,
      p_name: input.name,
      p_action: input.action,
      p_company_id: input.companyId ?? null,
    });
  }
  async reviewGlossaryTerm(input: ReviewGlossaryTermInput) {
    await this.rpc('review_glossary_term', {
      p_term_id: input.termId,
      p_action: input.action,
      p_official: input.official ?? null,
      p_company_id: input.companyId ?? null,
    });
  }
  async addGlossaryTerm(input: AddGlossaryTermInput) {
    const { error } = await this.sb.from('glossary_terms').insert({
      org_id: this.orgId,
      heard: input.heard.trim(),
      official: input.official.trim(),
      kind: input.kind,
      language: input.language ?? 'en',
      scope_site_id: input.scopeSiteId ?? null,
      status: 'confirmed',
    });
    if (error) throw new Error(error.message);
  }
  async saveSettings(patch: OrgSettingsPatch) {
    const { error } = await this.sb
      .from('org_settings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('org_id', this.orgId);
    if (error) throw new Error(error.message);
  }
  async saveSiteRecipients(siteId: string, emails: string[]) {
    const del = await this.sb.from('site_recipients').delete().eq('site_id', siteId);
    if (del.error) throw new Error(del.error.message);
    if (emails.length) {
      const ins = await this.sb
        .from('site_recipients')
        .insert(emails.map((email) => ({ site_id: siteId, email })));
      if (ins.error) throw new Error(ins.error.message);
    }
  }
  async addInvoice(input: AddInvoiceInput) {
    let file_path: string | null = null;
    if (input.file) {
      // Safe characters only, the org's folder first (audit :878; packages/shared/src/invoices.ts).
      file_path = invoiceUploadPath(this.orgId, input.file.name, randomUuid());
      const up = await this.sb.storage.from('invoices').upload(file_path, input.file);
      if (up.error) throw new Error(up.error.message);
    }
    const total = input.totalHours ?? input.lines.reduce((a, l) => a + l.hours, 0);
    const { error } = await this.sb.from('sub_invoices').insert({
      org_id: this.orgId,
      company_id: input.companyId,
      invoice_no: input.invoiceNo,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      lines: input.lines,
      total_hours: total,
      file_path,
      status: 'open',
    });
    if (error) throw new Error(error.message);
  }
  async setInvoiceStatus(invoiceId: string, status: InvoiceStatus) {
    const patch: Partial<SubInvoiceRow> = { status };
    if (status === 'queried') patch.queried_at = new Date().toISOString();
    if (status === 'resolved') patch.resolved_at = new Date().toISOString();
    const { error } = await this.sb.from('sub_invoices').update(patch).eq('id', invoiceId);
    if (error) throw new Error(error.message);
  }
  async inviteReporter(input: InviteReporterInput) {
    const result = await this.callFunction<{ reporter?: { status?: ReporterStatus } }>(
      'api-invite-reporter',
      {
        orgId: this.orgId,
        name: input.name,
        phone: input.phone,
        role: input.role,
        siteIds: input.siteIds,
        languages: input.languages,
      },
    );
    return { status: result?.reporter?.status ?? ('invited' as const) };
  }
  async linkUnknownSender(input: LinkUnknownSenderInput) {
    // D38 (W1-16): api-link-unknown-contact links callers and texters too, with F3 consent
    // pending; api-link-unknown-sender stays deployed until the demo, then is deleted.
    await this.callFunction('api-link-unknown-contact', {
      unknownContactId: input.unknownSenderId,
      siteId: input.siteId,
      name: input.name,
      role: input.role ?? 'backup',
    });
  }
  async setReporterStatus(reporterId: string, status: ReporterStatus) {
    const patch: Partial<ReporterRow> = { status };
    if (status === 'invited') patch.invited_at = new Date().toISOString();
    const { error } = await this.sb.from('reporters').update(patch).eq('id', reporterId);
    if (error) throw new Error(error.message);
  }
  async resendInvite(reporterId: string) {
    // api-invite-reporter re-sends `sitelog_welcome` for an existing reporter (one re-send, F3).
    await this.callFunction('api-invite-reporter', { action: 'resend', reporterId });
  }
  async updateReporter(input: UpdateReporterInput) {
    // One audited transaction (20261012000001_web_gaps.sql); the phone number is never touched.
    await this.rpc('update_reporter', {
      p_reporter_id: input.reporterId,
      p_name: input.name,
      p_role: input.role,
      p_site_ids: input.siteIds,
      p_languages: input.languages,
    });
  }
  async ignoreUnknownSender(unknownSenderId: string) {
    // unknown_contacts: the panel may update only status (20261014000003).
    const { error } = await this.sb
      .from('unknown_contacts')
      .update({ status: 'ignored' })
      .eq('id', unknownSenderId);
    if (error) throw new Error(error.message);
  }
  async addOfficeUser(input: { email: string; role: MemberRole; name?: string }) {
    // Supabase invite (magic link) is sent by the api-billing-adjacent admin function in production;
    // the org_members row is created on first sign-in (§F20). Until then we store the pending role.
    await this.callFunction('api-invite-office-user', {
      orgId: this.orgId,
      email: input.email,
      role: input.role,
    });
  }
  async changeMemberRole(userId: string, role: MemberRole) {
    const { error } = await this.sb
      .from('org_members')
      .update({ role })
      .eq('org_id', this.orgId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
  }
  async removeMember(userId: string) {
    const { error } = await this.sb
      .from('org_members')
      .delete()
      .eq('org_id', this.orgId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
  }
  async updateOrg(input: UpdateOrgInput) {
    await this.rpc('update_org', {
      p_org_id: this.orgId,
      p_name: input.name,
      p_timezone: input.timezone,
      p_address: input.address ?? null,
      p_license_no: input.licenseNo ?? null,
    });
  }
  async createSite(input: CreateSiteInput): Promise<CreateSiteResult> {
    const { data, error } = await this.sb
      .from('sites')
      .insert({
        org_id: this.orgId,
        name: input.name.trim(),
        project_code: input.projectCode.trim(),
        address: input.address ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        timezone: input.timezone,
        deadline: input.deadline ?? null,
        working_hours: input.workingHours ?? null,
        status: 'active',
        active_since: formatDateInTz(new Date(), input.timezone),
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(error?.message ?? copy.errors.generic);
    // The site exists from here on: report a failed follow-up instead of throwing, or a retry
    // would hit unique(org_id, project_code) or create a second site.
    const result: CreateSiteResult = { siteId: data.id, inviteError: null, recipientsError: null };
    if (input.recipients?.length) {
      try {
        await this.saveSiteRecipients(data.id, input.recipients);
      } catch (err) {
        result.recipientsError = errorMessage(err, copy.errors.generic);
      }
    }
    if (input.reporter) {
      try {
        await this.inviteReporter({ ...input.reporter, siteIds: [data.id] });
      } catch (err) {
        result.inviteError = errorMessage(err, copy.errors.generic);
      }
    }
    // A running subscription bills one unit per active site (as after pause / resume).
    await this.callFunction('api-billing', { action: 'sync', orgId: this.orgId }).catch(
      () => undefined,
    );
    return result;
  }
  async updateSite(siteId: string, patch: UpdateSitePatch) {
    const row: Partial<SiteRow> = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.projectCode !== undefined) row.project_code = patch.projectCode;
    if (patch.address !== undefined) row.address = patch.address ?? null;
    if (patch.lat !== undefined) row.lat = patch.lat ?? null;
    if (patch.lng !== undefined) row.lng = patch.lng ?? null;
    if (patch.timezone !== undefined) row.timezone = patch.timezone;
    if (patch.deadline !== undefined) row.deadline = patch.deadline ?? null;
    if (patch.workingHours !== undefined) row.working_hours = patch.workingHours ?? null;
    const { error } = await this.sb.from('sites').update(row).eq('id', siteId);
    if (error) throw new Error(error.message);
  }
  async setOrgLogo(file: File | null, orgId?: string) {
    await uploadOrgLogo(this.sb, orgId ?? this.orgId, file);
  }
  async pauseSite(siteId: string) {
    const { error } = await this.sb
      .from('sites')
      .update({ status: 'paused', paused_at: new Date().toISOString() })
      .eq('id', siteId);
    if (error) throw new Error(error.message);
    await this.callFunction('api-billing', { action: 'sync', orgId: this.orgId }).catch(
      () => undefined,
    );
  }
  async resumeSite(siteId: string) {
    const { error } = await this.sb
      .from('sites')
      .update({ status: 'active', paused_at: null })
      .eq('id', siteId);
    if (error) throw new Error(error.message);
    await this.callFunction('api-billing', { action: 'sync', orgId: this.orgId }).catch(
      () => undefined,
    );
  }
  async requestEvidencePack(input: RequestEvidencePackInput) {
    const res = await this.callFunction<{ pack?: { id: string }; packId?: string; id?: string }>(
      'api-evidence-pack',
      {
        orgId: this.orgId,
        siteId: input.siteId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        sections: input.sections,
      },
    );
    return { packId: res.pack?.id ?? res.packId ?? res.id ?? '' };
  }
  async payrollCsvUrl(week: string, siteId: string | null = null) {
    const csv = await this.callFunction<string>('api-export-payroll', undefined, {
      method: 'GET',
      query: { week, org: this.orgId, site: siteId ?? 'all' },
    });
    return URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  }
  async markNotificationsRead(ids: string[]) {
    if (!ids.length) return;
    await this.rpc('mark_notifications_read', { p_ids: ids });
  }

  // ─── Platform ops (20261012000003_ops.sql; every RPC checks is_platform_admin()) ───

  async isPlatformAdmin() {
    const { data, error } = await this.sb.rpc('is_platform_admin');
    return !error && data === true;
  }
  async getOps(): Promise<OpsData> {
    const [queue, dead, outliers] = await Promise.all([
      this.rpc('ops_queue_stats', {}),
      this.rpc('ops_dead_jobs', { p_limit: 100 }),
      this.rpc('ops_cost_outliers', { p_days: 30 }),
    ]);
    return toOpsData(
      (queue ?? []) as OpsQueueStatRow[],
      (dead ?? []) as OpsDeadJobRow[],
      (outliers ?? []) as OpsCostOutlierRow[],
    );
  }
  async retryDeadJob(jobId: number) {
    await this.rpc('ops_retry_job', { p_job_id: jobId });
  }
  async discardDeadJob(jobId: number) {
    await this.rpc('ops_discard_job', { p_job_id: jobId });
  }
  async getOrglessContacts(): Promise<OrglessContacts> {
    const [contacts, orgs] = await Promise.all([
      this.rpc('ops_unknown_contacts', { p_limit: 200 }),
      this.rpc('ops_real_orgs', {}),
    ]);
    return {
      contacts: ((contacts ?? []) as OpsUnknownContactRow[]).map((c) => ({
        id: c.id,
        phone: c.phone_e164,
        channel: c.channel,
        snippet: c.snippet,
        createdAt: c.created_at,
      })),
      orgs: (orgs ?? []) as OrglessContacts['orgs'],
    };
  }
  async assignUnknownContact(contactId: string, orgId: string) {
    await this.rpc('ops_assign_unknown_contact', { p_id: contactId, p_org_id: orgId });
  }
  async ignoreOrglessContact(contactId: string) {
    await this.rpc('ops_ignore_unknown_contact', { p_id: contactId });
  }

  // ─── Realtime ───

  // ─── Demo phone (/dev/phone, §11.1) ───

  async getDemoPhone(): Promise<DemoPhoneData> {
    const org = unwrapOne(
      await this.sb.from('orgs').select('is_demo, country').eq('id', this.orgId).maybeSingle(),
    ) as { is_demo: boolean; country: string };
    const country = unwrapOne(
      await this.sb
        .from('countries')
        .select('code, two_way_sms, message_channels')
        .eq('code', org.country)
        .maybeSingle(),
    ) as { code: string; two_way_sms: boolean; message_channels: string[] };
    const reporters = unwrap(
      await this.sb
        .from('reporters')
        .select('id, name, phone_e164, status')
        .eq('org_id', this.orgId)
        .order('name'),
    ) as Array<{ id: string; name: string; phone_e164: string; status: string }>;
    // Per reporter, one request: the thread's newest text (its last line) and the exact count of
    // its texts, so neither a long thread nor a busy org reads low (no capped org-wide page).
    const threads = await Promise.all(
      reporters.map(async (r) => {
        const res = await this.sb
          .from('messages')
          .select('body, created_at', { count: 'exact' })
          .eq('org_id', this.orgId)
          .eq('reporter_id', r.id)
          .in('channel', ['sms', 'push', 'whatsapp'])
          .order('created_at', { ascending: false })
          .limit(1);
        const rows = unwrap(res) as Array<{ body: string | null; created_at: string }>;
        return { count: res.count ?? rows.length, last: rows[0] ?? null };
      }),
    );
    return {
      orgIsDemo: org.is_demo,
      pack: {
        code: country.code,
        twoWaySms: country.two_way_sms,
        whatsapp: country.message_channels.includes('whatsapp'),
      },
      reporters: reporters
        .map((r, i) => {
          const { count, last } = threads[i]!;
          return {
            id: r.id,
            name: r.name,
            phone: r.phone_e164,
            status: r.status,
            count,
            lastAt: last?.created_at ?? null,
            lastBody: last?.body ?? null,
          };
        })
        .sort(
          (a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.name.localeCompare(b.name),
        ),
    };
  }

  async getDemoPhoneThread(reporterId: string): Promise<DemoPhoneMessage[]> {
    // The newest 500, oldest first on the page: a long thread drops its oldest texts, never the
    // welcome that just arrived.
    const rows = unwrap(
      await this.sb
        .from('messages')
        .select('id, direction, body, status, copy_key, provider, channel, created_at')
        .eq('org_id', this.orgId)
        .eq('reporter_id', reporterId)
        // W2-14: pushes to the installed app share the thread, labelled by channel; W2-15 the
        // WhatsApp messages (Twilio's; v1.0 Meta rows have no channel and stay out).
        .in('channel', ['sms', 'push', 'whatsapp'])
        .order('created_at', { ascending: false })
        .limit(500),
    ) as Array<{
      id: string;
      direction: 'in' | 'out';
      body: string | null;
      status: string;
      copy_key: string | null;
      provider: string | null;
      channel: 'sms' | 'push' | 'whatsapp';
      created_at: string;
    }>;
    return rows.reverse().map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body ?? '',
      status: m.status,
      copyKey: m.copy_key,
      provider: m.provider,
      channel: m.channel,
      at: m.created_at,
    }));
  }

  async getDemoPhoneEmails(): Promise<DemoPhoneEmail[]> {
    const rows = unwrap(
      await this.sb
        .from('console_emails')
        .select('id, kind, recipients, subject, body_text, attachments, created_at')
        .eq('org_id', this.orgId)
        .order('created_at', { ascending: false })
        .limit(100),
    ) as Array<{
      id: string;
      kind: string;
      recipients: string[];
      subject: string;
      body_text: string;
      attachments: Array<{ filename: string; bytes: number }>;
      created_at: string;
    }>;
    return rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      recipients: e.recipients,
      subject: e.subject,
      body: e.body_text,
      attachments: e.attachments,
      at: e.created_at,
    }));
  }

  async sendDemoPhoneReply(
    reporterId: string,
    body: string,
    channel: 'sms' | 'whatsapp' = 'sms',
  ): Promise<void> {
    // The same handler as an inbound SMS or WhatsApp message; the function checks admin, demo
    // org, and a two-way pack (texts) or a pack that lists WhatsApp (W2-16).
    await this.callFunction('sms-webhook/demo-reply', {
      reporterId,
      body,
      ...(channel === 'whatsapp' ? { channel } : {}),
    });
  }

  subscribeDemoPhone(onChange: () => void): () => void {
    const filter = `org_id=eq.${this.orgId}`;
    const channel: RealtimeChannel = this.sb
      .channel(`demo-phone:${this.orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter }, () =>
        onChange(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'console_emails', filter },
        () => onChange(),
      )
      .subscribe();
    return () => {
      void this.sb.removeChannel(channel);
    };
  }

  subscribe(onChange: (event: ChangeEvent) => void): () => void {
    const channel: RealtimeChannel = this.sb
      .channel(`org:${this.orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reports', filter: `org_id=eq.${this.orgId}` },
        (p) => onChange({ table: 'reports', id: idOf(p.new) ?? idOf(p.old) }),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'site_days' }, (p) =>
        onChange({ table: 'site_days', id: idOf(p.new) ?? idOf(p.old) }),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `org_id=eq.${this.orgId}` },
        (p) => onChange({ table: 'notifications', id: idOf(p.new) }),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'unknown_contacts',
          filter: `org_id=eq.${this.orgId}`,
        },
        (p) => onChange({ table: 'unknown_contacts', id: idOf(p.new) }),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'evidence_packs',
          filter: `org_id=eq.${this.orgId}`,
        },
        (p) => onChange({ table: 'evidence_packs', id: idOf(p.new) }),
      )
      .subscribe();
    return () => {
      void this.sb.removeChannel(channel);
    };
  }
}

/**
 * Company logo (§F2, §F18): upsert `logos/{orgId}/logo.{png|svg}`, then record the path with
 * set_org_logo() (admin only, audited); `null` clears it. The other extension's object is removed
 * best-effort so switching PNG ↔ SVG leaves one file. Used by the source and by the setup wizard
 * right after create_org (no DataSource yet).
 */
export async function uploadOrgLogo(sb: Db, orgId: string, file: File | null): Promise<void> {
  const bucket = sb.storage.from('logos');
  const all = [logoStoragePath(orgId, 'png'), logoStoragePath(orgId, 'svg')];
  if (!file) {
    const { error } = await sb.rpc('set_org_logo', { p_org_id: orgId, p_logo_path: null });
    if (error) throw new Error(error.message);
    await bucket.remove(all).catch(() => undefined);
    return;
  }
  const isSvg = file.type === 'image/svg+xml';
  const path = logoStoragePath(orgId, isSvg ? 'svg' : 'png');
  const up = await bucket.upload(path, file, {
    upsert: true,
    contentType: file.type,
    cacheControl: '60',
  });
  if (up.error) throw new Error(up.error.message);
  // An SVG keeps a PNG rendition next to it for the PDF renderer (see rasterizeSvgLogo).
  const png = isSvg ? await rasterizeSvgLogo(file) : null;
  if (png) {
    await bucket
      .upload(logoStoragePath(orgId, 'png'), png, {
        upsert: true,
        contentType: 'image/png',
        cacheControl: '60',
      })
      .catch(() => undefined);
  }
  const { error } = await sb.rpc('set_org_logo', { p_org_id: orgId, p_logo_path: path });
  if (error) throw new Error(error.message);
  const keep = new Set([path, ...(png ? [logoStoragePath(orgId, 'png')] : [])]);
  await bucket.remove(all.filter((p) => !keep.has(p))).catch(() => undefined);
}

/** ops_* RPC rows → the /ops view model (payload / detail jsonb narrowed to primitives). */
function toOpsData(
  queue: OpsQueueStatRow[],
  dead: OpsDeadJobRow[],
  outliers: OpsCostOutlierRow[],
): OpsData {
  const record = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const num = (v: unknown): number | null =>
    typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(+v) ? +v : null;
  return {
    queue: queue.map((q) => ({
      type: q.type,
      queued: q.queued,
      running: q.running,
      dead: q.dead,
      oldestDueSeconds: q.oldest_due_s,
    })),
    deadJobs: dead.map((j) => ({
      id: Number(j.id),
      type: j.type,
      attempts: j.attempts,
      lastError: j.last_error,
      createdAt: j.created_at,
      finishedAt: j.finished_at,
      payload: Object.fromEntries(
        Object.entries(record(j.payload)).filter((e): e is [string, string | number | boolean] =>
          ['string', 'number', 'boolean'].includes(typeof e[1]),
        ),
      ),
    })),
    costOutliers: outliers.map((o) => {
      const detail = record(o.detail);
      return {
        reportId: o.report_id,
        reportNo: o.report_no,
        orgId: o.org_id,
        orgName: o.org_name,
        siteId: o.site_id,
        siteName: o.site_name,
        filedAt: o.filed_at,
        costCents: o.cost_cents,
        medianCents: num(o.median_cents),
        sample: o.sample,
        aiUsd: num(detail.aiUsd),
        waTemplates: num(detail.waTemplates),
      };
    }),
  };
}

/**
 * Org memberships of a user (used by the AuthProvider before any org is selected). Each carries
 * the org's `locale` (§6.3): with no language chosen, it decides the panel's language (§11.2), so
 * a tr-TR org (Demir Yapı A.Ş., §18.2) opens the panel in Turkish before the shell mounts.
 */
export async function fetchOrgs(sb: Db, userId: string): Promise<OrgSummary[]> {
  const members = unwrap(
    await sb
      .from('org_members')
      .select('org_id, role, orgs(id, name, timezone, locale, country, is_demo)')
      .eq('user_id', userId),
  ) as unknown as Array<{
    org_id: string;
    role: MemberRole;
    orgs: Pick<OrgRow, 'id' | 'name' | 'timezone' | 'locale' | 'country' | 'is_demo'> | null;
  }>;
  // site_options: an accounts user cannot read `sites`, and every member counts active sites.
  const sites = unwrap(await sb.from('site_options').select('org_id, status'));
  return members
    .filter((m) => m.orgs)
    .map((m) => ({
      id: m.org_id,
      name: m.orgs!.name,
      timezone: m.orgs!.timezone,
      role: m.role,
      activeSites: sites.filter((s) => s.org_id === m.org_id && s.status === 'active').length,
      locale: m.orgs!.locale,
      country: m.orgs!.country,
      demoOrg: m.orgs!.is_demo,
    }));
}

function idOf(row: unknown): string | null {
  return row &&
    typeof row === 'object' &&
    'id' in row &&
    typeof (row as { id: unknown }).id === 'string'
    ? (row as { id: string }).id
    : null;
}
