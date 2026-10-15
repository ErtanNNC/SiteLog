/**
 * DataSource over the in-memory DemoStore. No network, deterministic "now" (DEMO_NOW).
 * Mutations persist for the session; `simulateIncomingReport()` is the only "realtime" event.
 */
import type { InvoiceStatus, MemberRole, ReporterStatus } from '@sitelog/shared/enums.ts';
import type { ReportRow } from '@sitelog/shared/db/types.ts';
import {
  officePhotoStoragePath,
  type OfficePhotoMime,
  type OfficePhotoUpload,
} from '@sitelog/shared/report/photos.ts';
import { seesNotification } from '@sitelog/shared/notifications.ts';
import type { StoredReportData } from '@sitelog/shared/schemas/report.ts';
import { DEMO_ORG_LOCALE, DEMO_SITELOG_NUMBER } from '@sitelog/shared/demo/kestrel.ts';
import { copy } from '@/copy/en';
import { randomUuid } from '@/lib/photos';
import { sleep } from '@/lib/utils';
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
  filterReports,
  orgSummary,
  paginate,
  payrollCsv,
  searchRows,
  type AssembleCtx,
} from '../assemble';
import {
  PDF_EXPORT_LIMIT,
  type AddGlossaryTermInput,
  type AddInvoiceInput,
  type CreateOfficeReportInput,
  type CreateSiteInput,
  type CreateSiteResult,
  type DataSource,
  type InviteReporterInput,
  type LinkUnknownSenderInput,
  type PdfLinkBatch,
  type PdfSelection,
  type RequestEvidencePackInput,
  type ResolveUnknownCompanyInput,
  type SaveReportPdfInput,
  type ReviewGlossaryTermInput,
  type SourceUser,
  type UpdateOrgInput,
  type UpdateReporterInput,
  type UpdateSitePatch,
  type UploadedPhoto,
} from '../source';
import type { ChangeEvent, OrgSettingsPatch, ReportFilters } from '../types';
import { demoOpsFor } from './ops';
import type { DemoStore } from './store';

export interface DemoSourceOptions {
  /** Simulated network latency so skeletons are visible in the browser (0 in tests). */
  latencyMs?: number;
  /** The demo user is a SiteLog operator so /ops can be seen (default true). */
  platformAdmin?: boolean;
}

export class DemoSource implements DataSource {
  readonly mode = 'demo' as const;
  readonly orgId: string;
  readonly user: SourceUser;
  private latency: number;
  private platformAdmin: boolean;
  /** PDFs rendered in this browser session (object URLs), by `${reportId}:${version}`. */
  private readonly pdfUrls = new Map<string, string>();
  /** Photos uploaded in this browser session (object URLs), by storage path. */
  private readonly photoUrls = new Map<string, string>();

  constructor(
    readonly store: DemoStore,
    user: SourceUser,
    opts: DemoSourceOptions = {},
  ) {
    this.user = user;
    this.orgId = store.data.org.id;
    this.latency = opts.latencyMs ?? 0;
    this.platformAdmin = opts.platformAdmin ?? true;
  }

  now(): Date {
    return this.store.now;
  }

  private ctx(): AssembleCtx {
    return { now: this.store.now, userId: this.user.id };
  }

  private async run<T>(fn: () => T): Promise<T> {
    if (this.latency > 0) await sleep(this.latency);
    return fn();
  }

  /** The seeded WhatsApp photos have no image in the demo; office uploads do. */
  private photoUrl(path: string | null): string | null {
    return path ? (this.photoUrls.get(path) ?? null) : null;
  }

  // ─── Reads ───
  getOrgs() {
    return this.run(() => [
      {
        ...orgSummary(this.store.rows(), this.ctx()),
        locale: DEMO_ORG_LOCALE,
        country: this.store.data.org.country,
        sitelogNumbers: [DEMO_SITELOG_NUMBER],
        demoOrg: this.store.data.org.is_demo,
      },
    ]);
  }
  getOverview() {
    return this.run(() => assembleOverview(this.store.rows(), this.ctx()));
  }
  getSites() {
    return this.run(() => assembleSiteCards(this.store.rows(), this.ctx()));
  }
  getSiteDetail(siteId: string, month: string) {
    return this.run(() => {
      const detail = assembleSiteDetail(this.store.rows(), this.ctx(), siteId, month);
      detail.photos = detail.photos?.map((p) => ({ ...p, url: this.photoUrl(p.storagePath) }));
      return detail;
    });
  }
  listReports(filters: ReportFilters) {
    return this.run(() => {
      const rows = this.store.rows();
      const { reports, total, incidentIds, weatherHours } = filterReports(rows, filters);
      return paginate(
        assembleReportItems(rows, reports, incidentIds),
        total,
        filters,
        weatherHours,
      );
    });
  }
  getReportDetail(reportId: string, version?: number | null) {
    return this.run(() => {
      const detail = assembleReportDetail(this.store.rows(), this.ctx(), reportId, version);
      detail.pdfUrl = this.pdfUrls.get(`${detail.report.id}:${detail.version}`) ?? null;
      detail.photos = detail.photos.map((p) => ({ ...p, url: this.photoUrl(p.storagePath) }));
      return detail;
    });
  }
  getHours(week: string, siteId: string | null = null) {
    return this.run(() => assembleHours(this.store.rows(), this.ctx(), week, siteId));
  }
  getWeather(month: string, siteId: string | null = null) {
    return this.run(() => assembleWeather(this.store.rows(), this.ctx(), month, siteId));
  }
  getTeam() {
    return this.run(() => assembleTeam(this.store.rows(), this.ctx()));
  }
  getGlossary() {
    return this.run(() => assembleGlossary(this.store.rows()));
  }
  getSettings() {
    return this.run(() => {
      const data = assembleSettings(this.store.rows());
      data.org.logoUrl = this.store.logoUrl;
      return data;
    });
  }
  getBilling() {
    return this.run(() => assembleBilling(this.store.rows(), this.ctx()));
  }
  /** The rows with the notifications RLS shows this user on Supabase (§13 audiences). */
  private rowsSeenByUser() {
    const rows = this.store.rows();
    return {
      ...rows,
      notifications: rows.notifications.filter((n) => seesNotification(n, this.user)),
    };
  }
  getNotifications() {
    return this.run(() => assembleNotifications(this.rowsSeenByUser(), this.ctx()));
  }
  getNavBadges() {
    return this.run(() => assembleNavBadges(this.rowsSeenByUser(), this.ctx()));
  }
  getSetupState() {
    return this.run(() => assembleSetupState(this.store.rows()));
  }
  search(q: string) {
    return this.run(() => searchRows(this.store.rows(), q));
  }
  /** Only PDFs rendered in this browser session have a URL; every other report is missing. */
  getPdfUrls(selection: PdfSelection) {
    return this.run((): PdfLinkBatch => {
      const rows = this.store.rows();
      let reports: ReportRow[];
      let total: number;
      if ('reportIds' in selection) {
        const ids = [...new Set(selection.reportIds)];
        total = ids.length;
        const byId = new Map(rows.reports.map((r) => [r.id, r]));
        reports = ids
          .slice(0, PDF_EXPORT_LIMIT)
          .map((id) => byId.get(id))
          .filter((r): r is ReportRow => !!r);
      } else {
        const res = filterReports(rows, {
          ...selection.filters,
          page: 1,
          pageSize: PDF_EXPORT_LIMIT,
        });
        total = res.total;
        reports = res.reports;
      }
      const files: PdfLinkBatch['files'] = [];
      const missing: PdfLinkBatch['missing'] = [];
      const dateOf = new Map(rows.siteDays.map((d) => [d.id, d.date]));
      for (const r of reports) {
        const url = this.pdfUrls.get(`${r.id}:${r.current_version}`);
        const link = {
          reportId: r.id,
          reportNo: r.report_no,
          date: dateOf.get(r.site_day_id) ?? '',
          version: r.current_version,
        };
        if (url) files.push({ ...link, url });
        else missing.push(link);
      }
      return { files, missing, total, capped: total > PDF_EXPORT_LIMIT };
    });
  }
  getBillingCheckoutUrl(): Promise<string> {
    return Promise.reject(new Error(copy.billing.checkoutDemo));
  }
  getBillingPortalUrl(): Promise<string> {
    return Promise.reject(new Error(copy.billing.portalDemo));
  }

  // ─── Mutations ───
  signOff(reportId: string) {
    return this.run(() => this.store.signOff(reportId, this.user.id));
  }
  undoSignOff(reportId: string) {
    return this.run(() => this.store.undoSignOff(reportId, this.user.id));
  }
  createReportVersion(
    reportId: string,
    data: StoredReportData,
    changeNote: string,
    photos: OfficePhotoUpload[] = [],
  ) {
    return this.run(() => ({
      version: this.store.createReportVersion(reportId, data, changeNote, this.user.id, photos),
    }));
  }
  /** Demo: the photo lives in memory as an object URL, so the report and its PDF show it. */
  uploadReportPhoto(siteId: string, photo: Blob, mime: OfficePhotoMime) {
    return this.run((): UploadedPhoto => {
      const path = officePhotoStoragePath(this.orgId, siteId, randomUuid(), mime);
      this.photoUrls.set(path, URL.createObjectURL(photo));
      this.store.recordPhotoUpload(path);
      return { path, mime };
    });
  }
  createOfficeReport(input: CreateOfficeReportInput) {
    return this.run(() => this.store.createOfficeReport({ ...input, userId: this.user.id }));
  }
  findDayReport(siteId: string, date: string) {
    return this.run(() => this.store.findDayReport(siteId, date));
  }
  saveReportPdf(input: SaveReportPdfInput) {
    return this.run(() => {
      this.store.attachVersionPdf(input.reportId, input.version, this.user.id);
      const key = `${input.reportId}:${input.version}`;
      const previous = this.pdfUrls.get(key);
      if (previous) URL.revokeObjectURL(previous);
      const url = URL.createObjectURL(input.pdf);
      this.pdfUrls.set(key, url);
      return url;
    });
  }
  markNoWork(siteDayId: string) {
    return this.run(() => this.store.markNoWork(siteDayId, this.user.id));
  }
  textDailyLink(siteId: string, requestId: string) {
    return this.run(() => {
      // api-text-daily-link's roles: everyone who sees the Overview (spec §19 Q69).
      if (!['admin', 'pm', 'ops'].includes(this.user.role)) throw new Error(copy.errors.notAllowed);
      return this.store.textDailyLink(siteId, requestId, this.user.id);
    });
  }
  resolveUnknownCompany(input: ResolveUnknownCompanyInput) {
    return this.run(() => this.store.resolveUnknownCompany(input, this.user.id));
  }
  reviewGlossaryTerm(input: ReviewGlossaryTermInput) {
    return this.run(() => this.store.reviewGlossaryTerm(input, this.user.id));
  }
  addGlossaryTerm(input: AddGlossaryTermInput) {
    return this.run(() => this.store.addGlossaryTerm(input, this.user.id));
  }
  saveSettings(patch: OrgSettingsPatch) {
    return this.run(() => this.store.saveSettings(patch, this.user.id));
  }
  saveSiteRecipients(siteId: string, emails: string[]) {
    return this.run(() => this.store.saveSiteRecipients(siteId, emails, this.user.id));
  }
  addInvoice(input: AddInvoiceInput) {
    return this.run(() => this.store.addInvoice(input, this.user.id));
  }
  setInvoiceStatus(invoiceId: string, status: InvoiceStatus) {
    return this.run(() => this.store.setInvoiceStatus(invoiceId, status, this.user.id));
  }
  inviteReporter(input: InviteReporterInput) {
    return this.run(() => {
      const id = this.store.inviteReporter(input, this.user.id);
      return { status: this.store.data.reporters.find((r) => r.id === id)!.status };
    });
  }
  linkUnknownSender(input: LinkUnknownSenderInput) {
    return this.run(() => this.store.linkUnknownSender(input, this.user.id));
  }
  ignoreUnknownSender(unknownSenderId: string) {
    return this.run(() => this.store.ignoreUnknownSender(unknownSenderId, this.user.id));
  }
  setReporterStatus(reporterId: string, status: ReporterStatus) {
    return this.run(() => this.store.setReporterStatus(reporterId, status, this.user.id));
  }
  resendInvite(reporterId: string) {
    return this.run(() => this.store.resendInvite(reporterId, this.user.id));
  }
  updateReporter(input: UpdateReporterInput) {
    return this.run(() => this.store.updateReporter(input, this.user.id));
  }
  addOfficeUser(input: { email: string; role: MemberRole; name?: string }) {
    return this.run(() => this.store.addOfficeUser(input, this.user.id));
  }
  changeMemberRole(userId: string, role: MemberRole) {
    return this.run(() => this.store.changeMemberRole(userId, role, this.user.id));
  }
  removeMember(userId: string) {
    return this.run(() => this.store.removeMember(userId, this.user.id));
  }
  updateOrg(input: UpdateOrgInput) {
    return this.run(() => this.store.updateOrg(input, this.user.id));
  }
  /** The in-memory insert and invite are one step, so nothing can fail after the site exists. */
  createSite(input: CreateSiteInput) {
    return this.run((): CreateSiteResult => ({
      siteId: this.store.createSite(input, this.user.id),
      inviteError: null,
      recipientsError: null,
    }));
  }
  updateSite(siteId: string, patch: UpdateSitePatch) {
    return this.run(() => this.store.updateSite(siteId, patch, this.user.id));
  }
  /** Demo: the logo lives in memory as an object URL so the PDF preview works. */
  setOrgLogo(file: File | null, _orgId?: string) {
    return this.run(() =>
      this.store.setLogo(
        file
          ? { url: URL.createObjectURL(file), ext: file.type === 'image/svg+xml' ? 'svg' : 'png' }
          : null,
        this.user.id,
      ),
    );
  }
  pauseSite(siteId: string) {
    return this.run(() => this.store.setSiteStatus(siteId, 'paused', this.user.id));
  }
  resumeSite(siteId: string) {
    return this.run(() => this.store.setSiteStatus(siteId, 'active', this.user.id));
  }
  requestEvidencePack(input: RequestEvidencePackInput) {
    return this.run(() => ({ packId: this.store.requestEvidencePack(input, this.user.id) }));
  }
  payrollCsvUrl(week: string, siteId: string | null = null) {
    return this.run(() => {
      const csv = payrollCsv(
        this.store.rows(),
        week,
        siteId,
        this.store.data.settings.include_unconfirmed_in_payroll,
        this.store.data.settings.payroll_columns,
      );
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      return URL.createObjectURL(blob);
    });
  }
  markNotificationsRead(ids: string[]) {
    return this.run(() => this.store.markNotificationsRead(ids));
  }

  // ─── Platform ops (fixed demo sample, demo/ops.ts) ───
  isPlatformAdmin() {
    return this.run(() => this.platformAdmin);
  }
  getOps() {
    return this.run(() => this.ops().snapshot());
  }
  retryDeadJob(jobId: number) {
    return this.run(() => this.ops().retry(jobId, this.user.id));
  }
  discardDeadJob(jobId: number) {
    return this.run(() => this.ops().discard(jobId, this.user.id));
  }
  /** Mirrors the ops_* RPCs: refused unless the user is a platform admin. */
  private ops() {
    if (!this.platformAdmin) throw new Error(copy.errors.notFound);
    return demoOpsFor(this.store);
  }

  // ─── Realtime ───
  subscribe(onChange: (event: ChangeEvent) => void): () => void {
    return this.store.subscribe(onChange);
  }

  // ─── Demo phone ───
  getDemoPhone() {
    return this.run(() => this.store.demoPhone());
  }
  getDemoPhoneThread(reporterId: string) {
    return this.run(() => this.store.demoPhoneThread(reporterId));
  }
  getDemoPhoneEmails() {
    return this.run(() => [...this.store.consoleEmails].reverse());
  }
  sendDemoPhoneReply(reporterId: string, body: string) {
    return this.run(() => this.store.demoPhoneReply(reporterId, body));
  }
  subscribeDemoPhone(onChange: () => void): () => void {
    return this.store.subscribe(() => onChange());
  }

  simulateIncomingReport() {
    return this.run(() => ({ changed: this.store.simulateIncomingReport() }));
  }
}

/** Raw CSV text (used by tests and the download helper). */
export function demoPayrollCsv(
  store: DemoStore,
  week: string,
  siteId: string | null = null,
): string {
  return payrollCsv(
    store.rows(),
    week,
    siteId,
    store.data.settings.include_unconfirmed_in_payroll,
    store.data.settings.payroll_columns,
  );
}
