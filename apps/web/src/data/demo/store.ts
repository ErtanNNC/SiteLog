/**
 * In-memory demo store over the §18 Kestrel dataset. One clone per browser session; every
 * mutation updates rows in place (with audit + notifications) so the panel behaves like the
 * real thing until the page is reloaded.
 */
import { DEMO_NOW, DEMO_ORG_ID, DEMO_USERS, kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import type { DemoDataset, DemoUser } from '@sitelog/shared/demo/types.ts';
import { demoId, demoRand } from '@sitelog/shared/demo/ids.ts';
import type {
  AuditLogRow,
  CompanyRow,
  GlossaryTermRow,
  ManpowerEntryRow,
  MessageRow,
  NotificationRow,
  ReportRow,
  ReportVersionRow,
  SiteDayRow,
  SiteRow,
  WeatherEventRow,
  WorkItemRow,
} from '@sitelog/shared/db/types.ts';
import type { InvoiceStatus, MemberRole, ReporterStatus } from '@sitelog/shared/enums.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { emptyReportData } from '@sitelog/shared/schemas/report.ts';
import { formatReportNo } from '@sitelog/shared/report/numbering.ts';
import { deriveTotals } from '@sitelog/shared/report/hours.ts';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { fromZonedTime } from 'date-fns-tz';
import { copy } from '@/copy/en';
import { localId } from '@/lib/utils';
import type { RowSet } from '../assemble';
import type {
  AddGlossaryTermInput,
  AddInvoiceInput,
  CreateSiteInput,
  InviteReporterInput,
  LinkUnknownSenderInput,
  RequestEvidencePackInput,
  ResolveUnknownCompanyInput,
  ReviewGlossaryTermInput,
  UpdateSitePatch,
} from '../source';
import type { ChangeEvent, OrgSettingsPatch } from '../types';

/** Extra demo office user so `?as=ops` has someone to be (not part of the §18 seed). */
export const DEMO_OPS_USER: DemoUser = {
  id: demoId('user:ravi'),
  email: 'ravi@kestrelbuild.example',
  name: 'Ravi Patel',
  title: 'Site coordinator',
  role: 'ops',
};

export const DEMO_LOGIN_KEYS = ['admin', 'pm', 'ops', 'accounts'] as const;
export type DemoLoginKey = (typeof DEMO_LOGIN_KEYS)[number];

export function demoUserFor(key: DemoLoginKey | string | null | undefined): DemoUser {
  switch (key) {
    case 'pm':
      return DEMO_USERS[1]!;
    case 'accounts':
      return DEMO_USERS[2]!;
    case 'ops':
      return DEMO_OPS_USER;
    default:
      return DEMO_USERS[0]!;
  }
}

export class DemoStore {
  readonly data: DemoDataset;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(dataset: DemoDataset = kestrelDemo()) {
    this.data = structuredClone(dataset);
    if (!this.data.users.some((u) => u.id === DEMO_OPS_USER.id)) {
      this.data.users.push({ ...DEMO_OPS_USER });
      this.data.members.push({
        org_id: this.data.org.id,
        user_id: DEMO_OPS_USER.id,
        role: DEMO_OPS_USER.role,
        display_name: DEMO_OPS_USER.name,
        title: DEMO_OPS_USER.title,
        created_at: this.data.org.created_at,
      });
    }
  }

  get now(): Date {
    return new Date(this.data.now);
  }

  nowIso(): string {
    return this.data.now;
  }

  rows(): RowSet {
    const d = this.data;
    const emailByUser = new Map(d.users.map((u) => [u.id, u.email]));
    return {
      org: d.org,
      settings: d.settings,
      members: d.members.map((m) => ({ ...m, email: emailByUser.get(m.user_id) ?? null })),
      sites: d.sites,
      reporters: d.reporters,
      siteReporters: d.siteReporters,
      recipients: d.recipients,
      companies: d.companies,
      glossary: d.glossary,
      messages: d.messages,
      transcripts: d.transcripts,
      unknownSenders: d.unknownSenders,
      siteDays: d.siteDays,
      reports: d.reports,
      versions: d.versions,
      sources: d.sources,
      manpower: d.manpower,
      weatherEvents: d.weatherEvents,
      questions: d.questions,
      invoices: d.invoices,
      packs: d.packs,
      notifications: d.notifications,
      audit: d.audit,
      billing: {
        monthlyCents: d.billing.monthlyCents,
        activeSites: d.sites.filter((s) => s.status === 'active').length,
        pricePerSiteCents: 39_900,
        nextInvoiceDate: d.billing.nextInvoiceDate,
        paymentMethod: d.billing.paymentMethod,
        status: d.org.billing_status,
        trialEndsAt: d.org.trial_ends_at,
        invoices: d.billing.invoices,
      },
    };
  }

  subscribe(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.listeners.clear();
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private audit(row: Omit<AuditLogRow, 'id' | 'created_at'> & { created_at?: string }): void {
    const id = (this.data.audit.at(-1)?.id ?? 0) + 1;
    this.data.audit.push({ id, created_at: this.nowIso(), ...row });
  }

  private notify(n: Omit<NotificationRow, 'id' | 'org_id' | 'read_at' | 'created_at'>): void {
    this.data.notifications.unshift({
      id: localId('notif'),
      org_id: this.data.org.id,
      read_at: null,
      created_at: this.nowIso(),
      ...n,
    });
  }

  private report(reportId: string): ReportRow {
    const r = this.data.reports.find((x) => x.id === reportId);
    if (!r) throw new Error(copy.errors.notFound);
    return r;
  }

  private site(siteId: string): SiteRow {
    const s = this.data.sites.find((x) => x.id === siteId);
    if (!s) throw new Error(copy.errors.notFound);
    return s;
  }

  /** Mirror of denormalize_report_version() in the migrations. */
  private denormalize(report: ReportRow, version: number, data: DailyReportData): void {
    const d = this.data;
    d.manpower = d.manpower.filter((m) => !(m.report_id === report.id && m.version === version));
    d.workItems = d.workItems.filter((w) => !(w.report_id === report.id && w.version === version));
    d.weatherEvents = d.weatherEvents.filter(
      (w) => !(w.report_id === report.id && w.version === version),
    );
    data.manpower.forEach((m, i) => {
      const row: ManpowerEntryRow = {
        id: demoId(`mp:${report.id}:${version}:${i}`),
        report_id: report.id,
        version,
        company_id: m.companyId,
        company_name_heard: m.companyNameHeard,
        company_name: m.companyName,
        trade: m.trade ?? null,
        area: m.area ?? null,
        workers: m.workers ?? 0,
        hours: m.totalHours ?? 0,
        hours_basis: m.hoursBasis,
        source: (m.source[0] ?? null) as ManpowerEntryRow['source'],
        confidence: m.confidence,
      };
      d.manpower.push(row);
    });
    data.workPerformed.forEach((w, i) => {
      const row: WorkItemRow = {
        id: demoId(`wi:${report.id}:${version}:${i}`),
        report_id: report.id,
        version,
        area: w.area,
        activity: w.activity,
        status: w.status,
        percent: w.percentComplete ?? null,
        quantity: w.quantity ? `${w.quantity.value} ${w.quantity.unit}` : null,
        source: (w.source[0] ?? null) as WorkItemRow['source'],
      };
      d.workItems.push(row);
    });
    const date = data.reportDate;
    data.weather.periods.forEach((p, i) => {
      const audio = p.source.find((s) => s.type === 'audio') ?? null;
      const row: WeatherEventRow = {
        id: demoId(`wx:${report.id}:${version}:${i}`),
        report_id: report.id,
        version,
        site_id: report.site_id,
        date,
        start_local: p.start ?? null,
        end_local: p.end ?? null,
        condition: p.condition,
        impact: p.impact ?? null,
        lost_hours: p.lostHours,
        full_day: !!p.fullDay,
        audio_source: (audio ?? null) as WeatherEventRow['audio_source'],
        photo_count: data.photos.length,
        observed: (data.weather.observed ?? null) as WeatherEventRow['observed'],
        claim_ready: !!audio && data.photos.length > 0 && !!data.weather.observed,
      };
      d.weatherEvents.push(row);
    });
  }

  private pushVersion(
    report: ReportRow,
    data: DailyReportData,
    author: ReportVersionRow['author'],
    userId: string | null,
    changeNote: string | null,
  ): number {
    const next = report.current_version + 1;
    const site = this.site(report.site_id);
    this.data.versions.push({
      report_id: report.id,
      version: next,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary,
      pdf_path: `${this.data.org.id}/${site.id}/${report.report_no}_v${next}.pdf`,
      author,
      author_user_id: userId,
      author_message_id: null,
      change_note: changeNote,
      created_at: this.nowIso(),
    });
    this.denormalize(report, next, data);
    const wasSigned = report.status === 'signed_off';
    const signer = report.signed_off_by;
    report.current_version = next;
    report.status = 'filed';
    report.signed_off_by = null;
    report.signed_off_at = null;
    report.updated_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.version_created',
      entity: 'report',
      entity_id: report.id,
      diff: { version: next, change_note: changeNote },
    });
    if (wasSigned) {
      this.audit({
        org_id: this.data.org.id,
        actor_type: 'user',
        actor_id: userId,
        action: 'report.signoff_reverted',
        entity: 'report',
        entity_id: report.id,
        diff: { version: next },
      });
      this.notify({
        user_id: signer,
        kind: 'report_edited',
        title: `${report.report_no} was edited after sign-off`,
        body: changeNote,
        target_path: `/reports/${report.id}`,
      });
    }
    return next;
  }

  // ─── Mutations ───

  signOff(reportId: string, userId: string): void {
    const r = this.report(reportId);
    if (r.status !== 'filed')
      throw new Error(`Only filed reports can be signed off (status ${r.status})`);
    r.status = 'signed_off';
    r.signed_off_by = userId;
    r.signed_off_at = this.nowIso();
    r.updated_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.signed_off',
      entity: 'report',
      entity_id: r.id,
      diff: { version: r.current_version },
    });
    this.emit({ table: 'reports', id: r.id });
  }

  undoSignOff(reportId: string, userId: string): void {
    const r = this.report(reportId);
    if (r.status !== 'signed_off') throw new Error('Report is not signed off');
    r.status = 'filed';
    r.signed_off_by = null;
    r.signed_off_at = null;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.signoff_undone',
      entity: 'report',
      entity_id: r.id,
      diff: null,
    });
    this.emit({ table: 'reports', id: r.id });
  }

  createReportVersion(
    reportId: string,
    data: DailyReportData,
    changeNote: string,
    userId: string,
  ): number {
    const r = this.report(reportId);
    if (!changeNote.trim()) throw new Error(copy.report.edit.changeNoteRequired);
    const next = this.pushVersion(
      r,
      structuredClone(data),
      'office_user',
      userId,
      changeNote.trim(),
    );
    this.emit({ table: 'reports', id: r.id });
    return next;
  }

  markNoWork(siteDayId: string, userId: string): void {
    const sd = this.data.siteDays.find((d) => d.id === siteDayId);
    if (!sd) throw new Error(copy.errors.notFound);
    if (sd.status === 'filed') throw new Error('A filed day cannot be marked no work');
    const from = sd.status;
    sd.status = 'no_work';
    sd.updated_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site_day.marked_no_work',
      entity: 'site_day',
      entity_id: sd.id,
      diff: { from },
    });
    this.emit({ table: 'site_days', id: sd.id });
  }

  resolveUnknownCompany(input: ResolveUnknownCompanyInput, userId: string): void {
    const r = this.report(input.reportId);
    const d = this.data;
    let company: CompanyRow | undefined;
    if (input.action === 'add') {
      company = d.companies.find((c) => c.name.toLowerCase() === input.name.toLowerCase());
      if (company) company.status = 'confirmed';
      else {
        company = {
          id: localId('company'),
          org_id: d.org.id,
          name: input.name,
          trade: null,
          aliases: [],
          is_self_perform: false,
          status: 'confirmed',
          created_at: this.nowIso(),
        };
        d.companies.push(company);
      }
    } else {
      company = d.companies.find((c) => c.id === input.companyId);
      if (!company) throw new Error('Company not found');
      if (company.name !== input.name && !company.aliases.includes(input.name))
        company.aliases.push(input.name);
    }
    const term = d.glossary.find(
      (t) => t.kind === 'company' && t.heard.toLowerCase() === input.name.toLowerCase(),
    );
    if (term) {
      term.status = 'confirmed';
      term.official = company.name;
      term.company_id = company.id;
    } else {
      d.glossary.push({
        id: localId('term'),
        org_id: d.org.id,
        scope_site_id: null,
        scope_reporter_id: null,
        heard: input.name,
        official: company.name,
        language: 'en',
        kind: 'company',
        company_id: company.id,
        status: 'confirmed',
        times_heard: 1,
        first_seen_at: this.nowIso(),
        last_seen_at: this.nowIso(),
      });
    }
    const cur = d.versions.find((v) => v.report_id === r.id && v.version === r.current_version)!;
    const data = structuredClone(cur.data as unknown as DailyReportData);
    const cid = company.id;
    const cname = company.name;
    data.manpower = data.manpower.map((m) =>
      m.companyId === null &&
      (m.companyName.toLowerCase() === input.name.toLowerCase() ||
        m.companyNameHeard.toLowerCase() === input.name.toLowerCase())
        ? {
            ...m,
            companyId: cid,
            companyName: cname,
            source: [...m.source, { type: 'office_edit' as const, userId, at: this.nowIso() }],
          }
        : m,
    );
    const note =
      input.action === 'add'
        ? `Added ${company.name} as subcontractor`
        : `"${input.name}" mapped to ${company.name}`;
    this.pushVersion(r, data, 'office_user', userId, note);
    r.review_reasons = r.review_reasons.filter((x) => x !== `unknown_company:${input.name}`);
    r.needs_review = r.review_reasons.length > 0;
    this.audit({
      org_id: d.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.unknown_company_resolved',
      entity: 'report',
      entity_id: r.id,
      diff: { name: input.name, action: input.action, company_id: company.id },
    });
    this.emit({ table: 'reports', id: r.id });
  }

  reviewGlossaryTerm(input: ReviewGlossaryTermInput, userId: string): void {
    const d = this.data;
    const t = d.glossary.find((x) => x.id === input.termId);
    if (!t || !t.org_id) throw new Error(copy.errors.notFound);
    const upsertCompany = (name: string): CompanyRow => {
      let c = d.companies.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!c) {
        c = {
          id: localId('company'),
          org_id: d.org.id,
          name,
          trade: null,
          aliases: [],
          is_self_perform: false,
          status: 'confirmed',
          created_at: this.nowIso(),
        };
        d.companies.push(c);
      } else c.status = 'confirmed';
      if (!c.aliases.includes(t.heard) && c.name !== t.heard) c.aliases.push(t.heard);
      return c;
    };
    switch (input.action) {
      case 'approve':
        t.status = 'confirmed';
        t.official = input.official ?? t.official;
        break;
      case 'change':
        if (!input.official?.trim()) throw new Error('Official term required');
        t.status = 'confirmed';
        t.official = input.official.trim();
        break;
      case 'reject':
        t.status = 'rejected';
        break;
      case 'add_company': {
        const c = upsertCompany(input.official ?? t.official ?? t.heard);
        t.status = 'confirmed';
        t.kind = 'company';
        t.official = c.name;
        t.company_id = c.id;
        break;
      }
      case 'map_company': {
        const c = d.companies.find((x) => x.id === input.companyId);
        if (!c) throw new Error('Company not found');
        if (!c.aliases.includes(t.heard)) c.aliases.push(t.heard);
        t.status = 'confirmed';
        t.kind = 'company';
        t.official = c.name;
        t.company_id = c.id;
        break;
      }
    }
    this.audit({
      org_id: d.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'glossary.reviewed',
      entity: 'glossary_term',
      entity_id: t.id,
      diff: {
        action: input.action,
        official: input.official ?? null,
        company_id: input.companyId ?? null,
      },
    });
    this.emit({ table: 'all' });
  }

  addGlossaryTerm(input: AddGlossaryTermInput, userId: string): void {
    const row: GlossaryTermRow = {
      id: localId('term'),
      org_id: this.data.org.id,
      scope_site_id: input.scopeSiteId ?? null,
      scope_reporter_id: null,
      heard: input.heard.trim(),
      official: input.official.trim(),
      language: input.language ?? 'en',
      kind: input.kind,
      company_id: null,
      status: 'confirmed',
      times_heard: 0,
      first_seen_at: this.nowIso(),
      last_seen_at: null,
    };
    this.data.glossary.push(row);
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'glossary.added',
      entity: 'glossary_term',
      entity_id: row.id,
      diff: { heard: row.heard, official: row.official },
    });
    this.emit({ table: 'all' });
  }

  saveSettings(patch: OrgSettingsPatch, userId: string): void {
    Object.assign(this.data.settings, patch, { updated_at: this.nowIso() });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'settings.updated',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: patch as AuditLogRow['diff'],
    });
    this.emit({ table: 'all' });
  }

  saveSiteRecipients(siteId: string, emails: string[], userId: string): void {
    this.site(siteId);
    this.data.recipients = this.data.recipients.filter((r) => r.site_id !== siteId);
    for (const email of emails) this.data.recipients.push({ site_id: siteId, email });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site.recipients_updated',
      entity: 'site',
      entity_id: siteId,
      diff: { emails },
    });
    this.emit({ table: 'all' });
  }

  addInvoice(input: AddInvoiceInput, userId: string): void {
    const total = input.totalHours ?? input.lines.reduce((a, l) => a + l.hours, 0);
    this.data.invoices.push({
      id: localId('invoice'),
      org_id: this.data.org.id,
      company_id: input.companyId,
      invoice_no: input.invoiceNo,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      lines: input.lines,
      total_hours: total,
      file_path: input.file ? `${this.data.org.id}/invoices/${input.file.name}` : null,
      status: 'open',
      queried_at: null,
      resolved_at: null,
      created_at: this.nowIso(),
    });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'invoice.added',
      entity: 'company',
      entity_id: input.companyId,
      diff: { invoice_no: input.invoiceNo, total },
    });
    this.emit({ table: 'all' });
  }

  setInvoiceStatus(invoiceId: string, status: InvoiceStatus, userId: string): void {
    const inv = this.data.invoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error(copy.errors.notFound);
    inv.status = status;
    if (status === 'queried') inv.queried_at = this.nowIso();
    if (status === 'resolved') inv.resolved_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: `invoice.${status}`,
      entity: 'company',
      entity_id: inv.company_id,
      diff: { invoice_no: inv.invoice_no },
    });
    this.emit({ table: 'all' });
  }

  inviteReporter(input: InviteReporterInput, userId: string): string {
    const id = localId('reporter');
    this.data.reporters.push({
      id,
      org_id: this.data.org.id,
      name: input.name.trim(),
      phone_e164: input.phone,
      role: input.role,
      languages: input.languages,
      status: 'invited',
      invited_at: this.nowIso(),
      verified_at: null,
      last_invite_error: null,
      created_at: this.nowIso(),
    });
    for (const siteId of input.siteIds) {
      const hasPrimary = this.data.siteReporters.some(
        (sr) => sr.site_id === siteId && sr.is_primary,
      );
      this.data.siteReporters.push({
        site_id: siteId,
        reporter_id: id,
        is_primary: input.role === 'site_manager' && !hasPrimary,
      });
    }
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'reporter.invited',
      entity: 'reporter',
      entity_id: id,
      diff: { sites: input.siteIds },
    });
    this.emit({ table: 'all' });
    return id;
  }

  linkUnknownSender(input: LinkUnknownSenderInput, userId: string): void {
    const u = this.data.unknownSenders.find((x) => x.id === input.unknownSenderId);
    if (!u) throw new Error(copy.errors.notFound);
    const id = this.inviteReporter(
      {
        name: input.name,
        phone: u.phone_e164,
        role: input.role ?? 'backup',
        siteIds: [input.siteId],
        languages: ['en'],
      },
      userId,
    );
    const r = this.data.reporters.find((x) => x.id === id)!;
    r.status = 'verified';
    r.verified_at = this.nowIso();
    u.status = 'linked';
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'unknown_sender.linked',
      entity: 'reporter',
      entity_id: id,
      diff: { site_id: input.siteId },
    });
    this.emit({ table: 'unknown_senders', id: u.id });
  }

  setReporterStatus(reporterId: string, status: ReporterStatus, userId: string): void {
    const r = this.data.reporters.find((x) => x.id === reporterId);
    if (!r) throw new Error(copy.errors.notFound);
    r.status = status;
    if (status === 'invited') {
      r.invited_at = this.nowIso();
      r.verified_at = null;
    }
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: status === 'disabled' ? 'reporter.disabled' : 'reporter.enabled',
      entity: 'reporter',
      entity_id: reporterId,
      diff: { status },
    });
    this.emit({ table: 'all' });
  }

  resendInvite(reporterId: string, userId: string): void {
    const r = this.data.reporters.find((x) => x.id === reporterId);
    if (!r) throw new Error(copy.errors.notFound);
    r.invited_at = this.nowIso();
    r.last_invite_error = null;
    if (r.status === 'disabled') r.status = 'invited';
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'reporter.invite_resent',
      entity: 'reporter',
      entity_id: reporterId,
      diff: null,
    });
    this.emit({ table: 'all' });
  }

  ignoreUnknownSender(id: string, userId: string): void {
    const u = this.data.unknownSenders.find((x) => x.id === id);
    if (!u) throw new Error(copy.errors.notFound);
    u.status = 'ignored';
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'unknown_sender.ignored',
      entity: 'unknown_sender',
      entity_id: id,
      diff: null,
    });
    this.emit({ table: 'unknown_senders', id });
  }

  addOfficeUser(input: { email: string; role: MemberRole; name?: string }, userId: string): void {
    const id = localId('user');
    this.data.users.push({
      id,
      email: input.email,
      name: input.name ?? input.email,
      title: null as unknown as string,
      role: input.role,
    });
    this.data.members.push({
      org_id: this.data.org.id,
      user_id: id,
      role: input.role,
      display_name: input.name ?? input.email,
      title: null,
      created_at: this.nowIso(),
    });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'member.invited',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: { email: input.email, role: input.role },
    });
    this.emit({ table: 'all' });
  }

  changeMemberRole(targetUserId: string, role: MemberRole, userId: string): void {
    const m = this.data.members.find((x) => x.user_id === targetUserId);
    if (!m) throw new Error(copy.errors.notFound);
    if (
      m.role === 'admin' &&
      role !== 'admin' &&
      this.data.members.filter((x) => x.role === 'admin').length <= 1
    )
      throw new Error(copy.team.addUser.lastAdmin);
    m.role = role;
    const u = this.data.users.find((x) => x.id === targetUserId);
    if (u) u.role = role;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'member.role_changed',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: { user_id: targetUserId, role },
    });
    this.emit({ table: 'all' });
  }

  removeMember(targetUserId: string, userId: string): void {
    const m = this.data.members.find((x) => x.user_id === targetUserId);
    if (!m) throw new Error(copy.errors.notFound);
    if (m.role === 'admin' && this.data.members.filter((x) => x.role === 'admin').length <= 1)
      throw new Error(copy.team.addUser.lastAdmin);
    this.data.members = this.data.members.filter((x) => x.user_id !== targetUserId);
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'member.removed',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: { user_id: targetUserId },
    });
    this.emit({ table: 'all' });
  }

  createSite(input: CreateSiteInput, userId: string): string {
    const id = localId('site');
    const today = formatDateInTz(this.now, input.timezone);
    this.data.sites.push({
      id,
      org_id: this.data.org.id,
      name: input.name.trim(),
      project_code: input.projectCode.trim(),
      address: input.address ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      timezone: input.timezone,
      deadline: input.deadline ?? null,
      working_hours: input.workingHours ?? null,
      status: 'active',
      active_since: today,
      paused_at: null,
      report_seq: 0,
      created_at: this.nowIso(),
    });
    for (const email of input.recipients ?? []) this.data.recipients.push({ site_id: id, email });
    if (input.reporter) this.inviteReporter({ ...input.reporter, siteIds: [id] }, userId);
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site.created',
      entity: 'site',
      entity_id: id,
      diff: { name: input.name },
    });
    this.emit({ table: 'all' });
    return id;
  }

  updateSite(siteId: string, patch: UpdateSitePatch, userId: string): void {
    const s = this.site(siteId);
    if (patch.name !== undefined) s.name = patch.name;
    if (patch.projectCode !== undefined) s.project_code = patch.projectCode;
    if (patch.address !== undefined) s.address = patch.address ?? null;
    if (patch.lat !== undefined) s.lat = patch.lat ?? null;
    if (patch.lng !== undefined) s.lng = patch.lng ?? null;
    if (patch.timezone !== undefined) s.timezone = patch.timezone;
    if (patch.deadline !== undefined) s.deadline = patch.deadline ?? null;
    if (patch.workingHours !== undefined) s.working_hours = patch.workingHours ?? null;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site.updated',
      entity: 'site',
      entity_id: siteId,
      diff: patch as AuditLogRow['diff'],
    });
    this.emit({ table: 'all' });
  }

  setSiteStatus(siteId: string, status: 'active' | 'paused', userId: string): void {
    const s = this.site(siteId);
    s.status = status;
    s.paused_at = status === 'paused' ? this.nowIso() : null;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: status === 'paused' ? 'site.paused' : 'site.resumed',
      entity: 'site',
      entity_id: siteId,
      diff: null,
    });
    this.emit({ table: 'all' });
  }

  requestEvidencePack(input: RequestEvidencePackInput, userId: string): string {
    const id = localId('pack');
    const site = input.siteId ? this.site(input.siteId) : null;
    this.data.packs.unshift({
      id,
      org_id: this.data.org.id,
      site_id: input.siteId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      status: 'queued',
      pdf_path: null,
      sections: input.sections,
      error: null,
      created_by: userId,
      created_at: this.nowIso(),
      ready_at: null,
    });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'evidence_pack.requested',
      entity: 'evidence_pack',
      entity_id: id,
      diff: { site_id: input.siteId, period: [input.periodStart, input.periodEnd] },
    });
    this.emit({ table: 'evidence_packs', id });
    const t = setTimeout(() => {
      const p = this.data.packs.find((x) => x.id === id);
      if (!p) return;
      p.status = 'ready';
      p.ready_at = this.nowIso();
      p.pdf_path = `${this.data.org.id}/${input.siteId ?? 'all'}/eot_${input.periodStart}_${input.periodEnd}.pdf`;
      this.notify({
        user_id: userId,
        kind: 'pack_ready',
        title: `EOT evidence pack ready — ${site?.name ?? copy.hours.allSites}`,
        body: null,
        target_path: '/weather',
      });
      this.emit({ table: 'evidence_packs', id });
    }, 1500);
    this.timers.push(t);
    return id;
  }

  markNotificationsRead(ids: string[]): void {
    const set = new Set(ids);
    for (const n of this.data.notifications)
      if (set.has(n.id) && !n.read_at) n.read_at = this.nowIso();
    this.emit({ table: 'notifications' });
  }

  /** Demo realtime: Priya's late report for Elm St. arrives. Deterministic, only when triggered. */
  simulateIncomingReport(): boolean {
    const d = this.data;
    const site = d.sites.find((s) => s.project_code === 'ES-0377');
    if (!site) return false;
    const today = formatDateInTz(this.now, site.timezone);
    const sd = d.siteDays.find((x) => x.site_id === site.id && x.date === today);
    if (!sd || sd.status === 'filed') return false;
    const reporter = d.reporters.find((r) => r.name === 'Priya Raman');
    const convo = d.conversations.find((c) => c.reporter_id === reporter?.id);
    const self = d.companies.find((c) => c.is_self_perform)!;
    const receivedAt = fromZonedTime(`${today}T19:04:00`, site.timezone).toISOString();
    const audioId = localId('msg');
    const reportId = localId('report');
    site.report_seq += 1;
    const reportNo = formatReportNo(site.project_code, site.report_seq);
    const data: DailyReportData = {
      ...emptyReportData(today),
      languageDetected: ['en'],
      summary:
        'Framing continued at Units 1–4 with 6 on site (48 h). Roof trusses set on Unit 2; backfill at the north trench completed. Dry all day. No incidents reported.',
      workingHours: { start: '07:00', end: '15:30' },
      weather: {
        observed: {
          precipIn: 0,
          tempMinF: 55,
          tempMaxF: 67,
          windMph: 8,
          gustMph: 14,
          provider: 'Open-Meteo',
        },
        conditionsText: 'Overcast, dry',
        periods: [],
      },
      manpower: [
        {
          companyId: self.id,
          companyNameHeard: 'our crew',
          companyName: self.name,
          trade: 'General labor',
          area: 'Units 1–4',
          workers: 6,
          hoursPerWorker: 8,
          totalHours: 48,
          hoursBasis: 'stated',
          confidence: 0.93,
          source: [{ type: 'audio', messageId: audioId, start: 6, end: 15 }],
        },
      ],
      workPerformed: [
        {
          area: 'Units 1–4',
          activity: 'Framing',
          status: 'in_progress',
          percentComplete: 70,
          source: [{ type: 'audio', messageId: audioId, start: 15, end: 26 }],
        },
        {
          area: 'Site',
          activity: 'Excavation and backfill',
          status: 'complete',
          source: [{ type: 'audio', messageId: audioId, start: 26, end: 34 }],
        },
      ],
      safety: {
        incidents: [],
        noIncidentsStated: true,
        visitors: [],
        source: [{ type: 'audio', messageId: audioId, start: 34, end: 41 }],
      },
      photos: [],
    };
    if (convo) {
      const msg: MessageRow = {
        id: audioId,
        conversation_id: convo.id,
        direction: 'in',
        wa_message_id: `wamid.demo.sim.${audioId.slice(-6)}`,
        type: 'audio',
        body: null,
        payload: {
          peaks: Array.from(
            { length: 64 },
            (_, i) => Math.round((0.15 + 0.85 * demoRand('peak:sim', i)) * 100) / 100,
          ),
        },
        media_id: null,
        media_mime: 'audio/ogg; codecs=opus',
        storage_path: null,
        duration_s: 58,
        template_name: null,
        status: 'received',
        error: null,
        created_at: receivedAt,
      };
      d.messages.push(msg);
      d.transcripts.push({
        id: localId('transcript'),
        message_id: audioId,
        language: 'en',
        text: 'Hey, sorry this is late. Elm Street, Friday. Six of us framing on one through four, full day. Trusses went up on unit two, and we finished the backfill on the north trench. Dry all day, no incidents.',
        segments: [
          { start: 0, end: 6, text: 'Hey, sorry this is late. Elm Street, Friday.' },
          { start: 6, end: 15, text: 'Six of us framing on one through four, full day.' },
          { start: 15, end: 26, text: 'Trusses went up on unit two,' },
          { start: 26, end: 34, text: 'and we finished the backfill on the north trench.' },
          { start: 34, end: 41, text: 'Dry all day, no incidents.' },
        ],
        model: 'whisper-1',
        created_at: receivedAt,
      });
      d.sources.push({
        id: localId('src'),
        report_id: reportId,
        message_id: audioId,
        kind: 'audio',
        caption: null,
        taken_at: receivedAt,
      });
    }
    const report: ReportRow = {
      id: reportId,
      org_id: d.org.id,
      site_id: site.id,
      site_day_id: sd.id,
      report_no: reportNo,
      status: 'filed',
      current_version: 0,
      reporter_id: reporter?.id ?? null,
      received_at: receivedAt,
      confirmed_at: receivedAt,
      filed_at: receivedAt,
      signed_off_by: null,
      signed_off_at: null,
      needs_review: false,
      review_reasons: [],
      is_late: true,
      kind: 'daily',
      created_at: receivedAt,
      updated_at: receivedAt,
    };
    d.reports.push(report);
    d.versions.push({
      report_id: reportId,
      version: 1,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary,
      pdf_path: `${d.org.id}/${site.id}/${reportNo}_v1.pdf`,
      author: 'agent',
      author_user_id: null,
      author_message_id: null,
      change_note: null,
      created_at: receivedAt,
    });
    report.current_version = 1;
    this.denormalize(report, 1, data);
    const totals = deriveTotals(data);
    sd.status = 'filed';
    sd.is_late = true;
    sd.report_id = reportId;
    sd.updated_at = receivedAt;
    this.audit({
      org_id: d.org.id,
      actor_type: 'agent',
      actor_id: null,
      action: 'report.filed',
      entity: 'report',
      entity_id: reportId,
      diff: { version: 1, late: true },
      created_at: receivedAt,
    });
    this.notify({
      user_id: null,
      kind: 'report_filed',
      title: `${site.name} — late report in`,
      body: `${reportNo} · ${totals.crewOnSite} on site · ${totals.totalHours} h`,
      target_path: `/reports/${reportId}`,
    });
    const missingNotif = d.notifications.find(
      (n) => n.kind === 'missing_report' && !n.read_at && n.title.startsWith(site.name),
    );
    if (missingNotif) missingNotif.read_at = this.nowIso();
    this.emit({ table: 'site_days', id: sd.id });
    this.emit({ table: 'reports', id: reportId });
    return true;
  }
}

export { DEMO_NOW, DEMO_ORG_ID, DEMO_USERS };
export type { SiteDayRow };

let instance: DemoStore | null = null;
/** One store per browser session (mutations persist until reload). */
export function getDemoStore(): DemoStore {
  if (!instance) instance = new DemoStore();
  return instance;
}
export function resetDemoStore(): void {
  instance?.dispose();
  instance = null;
}
