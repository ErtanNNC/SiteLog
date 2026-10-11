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
  CompanyRow,
  EvidencePackRow,
  GlossaryTermRow,
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
  UnknownSenderRow,
  CurrentManpowerRow,
  CurrentWeatherRow,
} from '@sitelog/shared/db/types.ts';
import type { InvoiceStatus, MemberRole, ReporterStatus } from '@sitelog/shared/enums.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { addDays, formatDateInTz, isoWeekOf, isoWeekRange } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import { functionsUrl } from '@/lib/env';
import type { Db } from '@/lib/supabase';
import { uniq } from '@/lib/utils';
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
import type {
  AddGlossaryTermInput,
  AddInvoiceInput,
  CreateOrgInput,
  CreateSiteInput,
  DataSource,
  InviteReporterInput,
  LinkUnknownSenderInput,
  RequestEvidencePackInput,
  ResolveUnknownCompanyInput,
  ReviewGlossaryTermInput,
  SourceUser,
  UpdateSitePatch,
} from '../source';
import type {
  ChangeEvent,
  OrgSettingsPatch,
  OrgSummary,
  ReportFilters,
  SearchResult,
} from '../types';

const SIGNED_URL_TTL = 600; // 10 minutes (§15)

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
    unknownSenders: [],
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

  /** Rows most pages need; cheap for ≤ 50 sites. Some tables are hidden by RLS for `accounts`. */
  private async core(): Promise<Core> {
    const sb = this.sb;
    const [org, settings, members, sites, companies] = await Promise.all([
      sb.from('orgs').select('*').eq('id', this.orgId).single(),
      sb.from('org_settings').select('*').eq('org_id', this.orgId).single(),
      sb.from('org_members').select('*').eq('org_id', this.orgId),
      sb.from('sites').select('*').eq('org_id', this.orgId).order('name'),
      sb.from('companies').select('*').eq('org_id', this.orgId).order('name'),
    ]);
    const siteRows = unwrap(sites);
    const ids = siteRows.map((s) => s.id);
    const [reporters, siteReporters, recipients] =
      this.user.role === 'accounts'
        ? [[], [], []]
        : await Promise.all([
            sb.from('reporters').select('*').eq('org_id', this.orgId).then(unwrap),
            ids.length ? sb.from('site_reporters').select('*').in('site_id', ids).then(unwrap) : [],
            ids.length
              ? sb.from('site_recipients').select('*').in('site_id', ids).then(unwrap)
              : [],
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
    if (!siteDayIds.length) return [];
    return unwrap(await this.sb.from('reports').select('*').in('site_day_id', siteDayIds));
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
    let q = this.sb
      .from('current_manpower')
      .select('*')
      .eq('org_id', this.orgId)
      .gte('date', from)
      .lte('date', to);
    if (siteId) q = q.eq('site_id', siteId);
    return unwrap(await q);
  }

  private async weatherBetween(
    from: string,
    to: string,
    siteId?: string | null,
  ): Promise<CurrentWeatherRow[]> {
    let q = this.sb
      .from('current_weather')
      .select('*')
      .eq('org_id', this.orgId)
      .gte('date', from)
      .lte('date', to);
    if (siteId) q = q.eq('site_id', siteId);
    return unwrap(await q);
  }

  private async signedUrl(bucket: string, path: string | null | undefined): Promise<string | null> {
    if (!path) return null;
    const { data } = await this.sb.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL);
    return data?.signedUrl ?? null;
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
      throw new Error(text || `${name} failed (${res.status})`);
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
    const from = addDays(dates[0]!, -1);
    const to = addDays(dates.at(-1)!, 1);
    const siteDays = await this.siteDays(this.siteIds(core), from, to);
    const reports = await this.reportsForSiteDays(siteDays.map((d) => d.id));
    const today = formatDateInTz(now, core.org.timezone);
    const { start, sunday } = isoWeekRange(isoWeekOf(today));
    const [versions, unknownSenders, glossary, invoices, manpower] = await Promise.all([
      this.currentVersions(reports),
      this.sb
        .from('unknown_senders')
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
    ]);
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays,
      reports,
      versions,
      unknownSenders,
      glossary,
      invoices,
      manpower,
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
    const from = days[0]! < today ? days[0]! : today;
    const to = days.at(-1)! > today ? days.at(-1)! : today;
    const siteDays = await this.siteDays([siteId], from, to);
    const reports = await this.reportsForSiteDays(siteDays.map((d) => d.id));
    // Latest report may be outside the month: fetch the newest filed report for the site.
    const latest = unwrap(
      await this.sb
        .from('reports')
        .select('*')
        .eq('site_id', siteId)
        .in('status', ['filed', 'signed_off'])
        .order('filed_at', { ascending: false })
        .limit(1),
    );
    const allReports = [...reports, ...latest.filter((r) => !reports.some((x) => x.id === r.id))];
    const latestSiteDays =
      latest.length && !siteDays.some((d) => d.id === latest[0]!.site_day_id)
        ? unwrap(await this.sb.from('site_days').select('*').eq('id', latest[0]!.site_day_id))
        : [];
    const todayReport = allReports.find(
      (r) => siteDays.find((d) => d.id === r.site_day_id)?.date === today,
    );
    const [manpower, weatherEvents, versions, questions, photoSources] = await Promise.all([
      this.manpowerBetween(from, to, siteId),
      this.weatherBetween(from, to, siteId),
      this.sb
        .from('report_versions')
        .select('*')
        .in('report_id', uniq([todayReport?.id, latest[0]?.id].filter((x): x is string => !!x)))
        .then(unwrap),
      todayReport
        ? this.sb.from('questions').select('*').eq('report_id', todayReport.id).then(unwrap)
        : Promise.resolve([] as QuestionRow[]),
      this.sb
        .from('report_sources')
        .select('*')
        .eq('kind', 'photo')
        .in(
          'report_id',
          allReports.map((r) => r.id),
        )
        .then(unwrap),
    ]);
    const photoMessages = photoSources.length
      ? unwrap(
          await this.sb
            .from('messages')
            .select('*')
            .in(
              'id',
              photoSources.map((s) => s.message_id),
            ),
        )
      : [];
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays: [...siteDays, ...latestSiteDays],
      reports: allReports,
      versions,
      manpower,
      weatherEvents,
      questions,
      sources: photoSources as ReportSourceRow[],
      messages: photoMessages as MessageRow[],
    };
    const detail = assembleSiteDetail(rows, this.ctx(), siteId, month);
    const urls = await Promise.all(
      (detail.photos ?? []).map((p) => this.signedUrl('photos', p.storagePath)),
    );
    detail.photos = (detail.photos ?? []).map((p, i) => ({ ...p, url: urls[i] ?? null }));
    return detail;
  }

  async listReports(filters: ReportFilters) {
    const core = await this.core();
    const sb = this.sb;
    const pageSize = filters.pageSize ?? PAGE_SIZE;
    const page = Math.max(1, filters.page ?? 1);
    let q = sb
      .from('reports')
      .select('*, site_days!inner(id, date, site_id)', { count: 'exact' })
      .eq('org_id', this.orgId)
      .in('status', ['filed', 'signed_off']);
    if (filters.siteId) q = q.eq('site_id', filters.siteId);
    if (filters.from) q = q.gte('site_days.date', filters.from);
    if (filters.to) q = q.lte('site_days.date', filters.to);
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
    if (filters.hasWeatherDelay) {
      const wx = unwrap(
        await sb
          .from('current_weather')
          .select('report_id')
          .eq('org_id', this.orgId)
          .gt('lost_hours', 0)
          .limit(1000),
      );
      q = q.or(
        `id.in.(${uniq(wx.map((w) => w.report_id)).join(',') || '00000000-0000-0000-0000-000000000000'}),kind.eq.weather_day`,
      );
    }
    if (filters.incident) {
      const inc = unwrap(
        await sb
          .from('report_versions')
          .select('report_id')
          .neq('data->safety->incidents', '[]')
          .limit(1000),
      );
      q = q.in('id', uniq(inc.map((i) => i.report_id)));
    }
    const text = filters.q?.trim();
    if (text) {
      const safe = text.replace(/[,()]/g, ' ');
      const tr = unwrap(
        await sb
          .from('transcripts')
          .select('message_id')
          .textSearch('text', safe, { type: 'websearch', config: 'english' })
          .limit(200),
      );
      const srcs = tr.length
        ? unwrap(
            await sb
              .from('report_sources')
              .select('report_id')
              .in(
                'message_id',
                tr.map((t) => t.message_id),
              ),
          )
        : [];
      const ids = uniq(srcs.map((s) => s.report_id));
      q = q.or(`report_no.ilike.%${safe}%${ids.length ? `,id.in.(${ids.join(',')})` : ''}`);
    }
    q = q
      .order('received_at', { ascending: false, nullsFirst: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    const res = await q;
    if (res.error) throw new Error(res.error.message);
    const raw = (res.data ?? []) as unknown as Array<
      ReportRow & { site_days: { id: string; date: string; site_id: string } | null }
    >;
    const reports: ReportRow[] = raw.map(({ site_days: _sd, ...r }) => r);
    const siteDays = raw
      .filter((r) => r.site_days)
      .map(
        (r) =>
          ({
            id: r.site_days!.id,
            date: r.site_days!.date,
            site_id: r.site_days!.site_id,
          }) as SiteDayRow,
      );
    const ids = reports.map((r) => r.id);
    const [manpower, weatherEvents, versions] = ids.length
      ? await Promise.all([
          sb.from('current_manpower').select('*').in('report_id', ids).then(unwrap),
          sb.from('current_weather').select('*').in('report_id', ids).then(unwrap),
          this.currentVersions(reports),
        ])
      : [[], [], []];
    const incidentIds = new Set(
      versions
        .filter(
          (v) =>
            ((v.data as unknown as DailyReportData | null)?.safety?.incidents?.length ?? 0) > 0,
        )
        .map((v) => v.report_id),
    );
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays,
      reports,
      versions,
      manpower,
      weatherEvents,
    };
    const items = assembleReportItems(rows, reports, incidentIds);
    const weatherHours = weatherEvents.reduce((a, w) => a + Number(w.lost_hours), 0);
    return paginate(
      items,
      res.count ?? items.length,
      filters,
      Math.round(weatherHours * 100) / 100,
    );
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
    const messageIds = sources.map((s) => s.message_id);
    const srcMessages: MessageRow[] = messageIds.length
      ? unwrap(await sb.from('messages').select('*').in('id', messageIds))
      : [];
    const audioMsg = srcMessages.find((m) => m.type === 'audio');
    const dayStart = fromZonedTime(`${siteDay.date}T00:00:00`, site.timezone).toISOString();
    const dayEnd = fromZonedTime(
      `${addDays(siteDay.date, 1)}T00:00:00`,
      site.timezone,
    ).toISOString();
    const [convoMessages, transcripts, siteReports] = await Promise.all([
      audioMsg
        ? sb
            .from('messages')
            .select('*')
            .eq('conversation_id', audioMsg.conversation_id)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd)
            .order('created_at')
            .then(unwrap)
        : Promise.resolve([] as MessageRow[]),
      audioMsg
        ? sb.from('transcripts').select('*').eq('message_id', audioMsg.id).then(unwrap)
        : Promise.resolve([] as TranscriptRow[]),
      sb
        .from('reports')
        .select('id, site_day_id, status, site_id, site_days(date)')
        .eq('site_id', site.id)
        .in('status', ['filed', 'signed_off'])
        .then(unwrap),
    ]);
    const messages = [
      ...srcMessages,
      ...convoMessages.filter((m) => !srcMessages.some((s) => s.id === m.id)),
    ];
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
      transcripts,
      questions,
      audit: audit as AuditLogRow[],
      weatherEvents,
    };
    const detail = assembleReportDetail(rows, this.ctx(), reportId, version);
    const viewed = versions.find((v) => v.version === detail.version);
    const [audioUrl, pdfUrl, photoUrls] = await Promise.all([
      this.signedUrl('audio', detail.audio?.storagePath),
      this.signedUrl('pdfs', viewed?.pdf_path),
      Promise.all(detail.photos.map((p) => this.signedUrl('photos', p.storagePath))),
    ]);
    if (detail.audio) detail.audio.url = audioUrl;
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
    const reportIds = uniq(manpower.map((m) => m.report_id));
    const [reports, sources] = reportIds.length
      ? await Promise.all([
          this.sb.from('reports').select('*').in('id', reportIds).then(unwrap),
          this.user.role === 'accounts'
            ? Promise.resolve([] as ReportSourceRow[])
            : this.sb
                .from('report_sources')
                .select('*')
                .eq('kind', 'audio')
                .in('report_id', reportIds)
                .then(unwrap),
        ])
      : [[], []];
    const transcripts = sources.length
      ? unwrap(
          await this.sb
            .from('transcripts')
            .select('*')
            .in(
              'message_id',
              sources.map((s) => s.message_id),
            ),
        )
      : [];
    const rows: RowSet = {
      ...this.rowsFrom(core),
      manpower,
      invoices,
      reports,
      sources,
      transcripts,
    };
    return assembleHours(rows, this.ctx(), week, siteId);
  }

  async getWeather(month: string, siteId: string | null = null) {
    const core = await this.core();
    const days = monthDays(month);
    const [weatherEvents, packs] = await Promise.all([
      this.weatherBetween(days[0]!, days.at(-1)!, siteId),
      this.sb
        .from('evidence_packs')
        .select('*')
        .eq('org_id', this.orgId)
        .order('created_at', { ascending: false })
        .limit(50)
        .then(unwrap),
    ]);
    const reportIds = uniq(weatherEvents.map((w) => w.report_id));
    const reports = reportIds.length
      ? unwrap(await this.sb.from('reports').select('*').in('id', reportIds))
      : [];
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
    const [siteDays, unknownSenders] = await Promise.all([
      this.siteDays(this.siteIds(core), addDays(today, -30), today),
      this.sb
        .from('unknown_senders')
        .select('*')
        .eq('org_id', this.orgId)
        .eq('status', 'pending')
        .then(unwrap),
    ]);
    const rows: RowSet = {
      ...this.rowsFrom(core),
      siteDays,
      unknownSenders: unknownSenders as UnknownSenderRow[],
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
    return assembleSettings(this.rowsFrom(await this.core()));
  }

  async getBilling() {
    return assembleBilling(this.rowsFrom(await this.core()), this.ctx());
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
          .from('unknown_senders')
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
        ? Promise.resolve([] as Array<Pick<TranscriptRow, 'id' | 'message_id' | 'text'>>)
        : sb
            .from('transcripts')
            .select('id, message_id, text')
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
      const srcs = unwrap(
        await sb
          .from('report_sources')
          .select('report_id, message_id')
          .in(
            'message_id',
            transcripts.map((t) => t.message_id),
          ),
      );
      for (const t of transcripts) {
        const src = srcs.find((s) => s.message_id === t.message_id);
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

  async getTodaysPdfUrls() {
    const overview = await this.getOverview();
    if (!overview.pdfReportIds.length) return [];
    const reports = unwrap(
      await this.sb
        .from('reports')
        .select('id, report_no, current_version')
        .in('id', overview.pdfReportIds),
    );
    const versions = unwrap(
      await this.sb
        .from('report_versions')
        .select('report_id, version, pdf_path')
        .in('report_id', overview.pdfReportIds),
    );
    const out: Array<{ reportNo: string; url: string }> = [];
    for (const r of reports) {
      const v = versions.find((x) => x.report_id === r.id && x.version === r.current_version);
      const url = await this.signedUrl('pdfs', v?.pdf_path);
      if (url) out.push({ reportNo: r.report_no, url });
    }
    return out;
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
  async createReportVersion(reportId: string, data: DailyReportData, changeNote: string) {
    const res = (await this.rpc('create_report_version', {
      p_report_id: reportId,
      p_data: data as never,
      p_change_note: changeNote,
    })) as { version?: number } | null;
    return { version: res?.version ?? 0 };
  }
  async markNoWork(siteDayId: string) {
    await this.rpc('mark_no_work', { p_site_day_id: siteDayId });
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
      file_path = `${this.orgId}/${Date.now()}-${input.file.name}`;
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
    await this.callFunction('api-invite-reporter', {
      orgId: this.orgId,
      name: input.name,
      phone: input.phone,
      role: input.role,
      siteIds: input.siteIds,
      languages: input.languages,
    });
  }
  async linkUnknownSender(input: LinkUnknownSenderInput) {
    await this.callFunction('api-link-unknown-sender', {
      unknownSenderId: input.unknownSenderId,
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
  async ignoreUnknownSender(unknownSenderId: string) {
    const { error } = await this.sb
      .from('unknown_senders')
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
  async createOrg(input: CreateOrgInput) {
    const res = (await this.rpc('create_org', {
      p_name: input.name,
      p_timezone: input.timezone,
      p_address: input.address ?? null,
      p_license_no: input.licenseNo ?? null,
    })) as { id?: string } | null;
    if (!res?.id) throw new Error(copy.errors.generic);
    return { orgId: res.id };
  }
  async createSite(input: CreateSiteInput) {
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
    if (input.recipients?.length) await this.saveSiteRecipients(data.id, input.recipients);
    if (input.reporter) await this.inviteReporter({ ...input.reporter, siteIds: [data.id] });
    return { siteId: data.id };
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

  // ─── Realtime ───

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
          table: 'unknown_senders',
          filter: `org_id=eq.${this.orgId}`,
        },
        (p) => onChange({ table: 'unknown_senders', id: idOf(p.new) }),
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

/** Org memberships of a user (used by the AuthProvider before any org is selected). */
export async function fetchOrgs(sb: Db, userId: string): Promise<OrgSummary[]> {
  const members = unwrap(
    await sb
      .from('org_members')
      .select('org_id, role, orgs(id, name, timezone)')
      .eq('user_id', userId),
  ) as unknown as Array<{
    org_id: string;
    role: MemberRole;
    orgs: { id: string; name: string; timezone: string } | null;
  }>;
  const sites = unwrap(await sb.from('sites').select('org_id, status'));
  return members
    .filter((m) => m.orgs)
    .map((m) => ({
      id: m.org_id,
      name: m.orgs!.name,
      timezone: m.orgs!.timezone,
      role: m.role,
      activeSites: sites.filter((s) => s.org_id === m.org_id && s.status === 'active').length,
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
