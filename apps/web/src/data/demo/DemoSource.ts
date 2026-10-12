/**
 * DataSource over the in-memory DemoStore. No network, deterministic "now" (DEMO_NOW).
 * Mutations persist for the session; `simulateIncomingReport()` is the only "realtime" event.
 */
import type { InvoiceStatus, MemberRole, ReporterStatus } from '@sitelog/shared/enums.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { copy } from '@/copy/en';
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
  type CreateOrgInput,
  type CreateSiteInput,
  type DataSource,
  type InviteReporterInput,
  type LinkUnknownSenderInput,
  type PdfLinkBatch,
  type PdfSelection,
  type RequestEvidencePackInput,
  type ResolveUnknownCompanyInput,
  type ReviewGlossaryTermInput,
  type SourceUser,
  type UpdateReporterInput,
  type UpdateSitePatch,
} from '../source';
import type { ChangeEvent, OrgSettingsPatch, ReportFilters } from '../types';
import type { DemoStore } from './store';

export interface DemoSourceOptions {
  /** Simulated network latency so skeletons are visible in the browser (0 in tests). */
  latencyMs?: number;
}

export class DemoSource implements DataSource {
  readonly mode = 'demo' as const;
  readonly orgId: string;
  readonly user: SourceUser;
  private latency: number;

  constructor(
    readonly store: DemoStore,
    user: SourceUser,
    opts: DemoSourceOptions = {},
  ) {
    this.user = user;
    this.orgId = store.data.org.id;
    this.latency = opts.latencyMs ?? 0;
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

  // ─── Reads ───
  getOrgs() {
    return this.run(() => [orgSummary(this.store.rows(), this.ctx())]);
  }
  getOverview() {
    return this.run(() => assembleOverview(this.store.rows(), this.ctx()));
  }
  getSites() {
    return this.run(() => assembleSiteCards(this.store.rows(), this.ctx()));
  }
  getSiteDetail(siteId: string, month: string) {
    return this.run(() => assembleSiteDetail(this.store.rows(), this.ctx(), siteId, month));
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
    return this.run(() => assembleReportDetail(this.store.rows(), this.ctx(), reportId, version));
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
  getNotifications() {
    return this.run(() => assembleNotifications(this.store.rows(), this.ctx()));
  }
  getNavBadges() {
    return this.run(() => assembleNavBadges(this.store.rows(), this.ctx()));
  }
  getSetupState() {
    return this.run(() => assembleSetupState(this.store.rows()));
  }
  search(q: string) {
    return this.run(() => searchRows(this.store.rows(), q));
  }
  /** The demo has no rendered PDFs: every selected report is reported as missing. */
  getPdfUrls(selection: PdfSelection) {
    return this.run((): PdfLinkBatch => {
      const rows = this.store.rows();
      let reportNos: string[];
      let total: number;
      if ('reportIds' in selection) {
        const ids = [...new Set(selection.reportIds)];
        total = ids.length;
        reportNos = ids
          .slice(0, PDF_EXPORT_LIMIT)
          .map((id) => rows.reports.find((r) => r.id === id)?.report_no)
          .filter((no): no is string => !!no);
      } else {
        const res = filterReports(rows, {
          ...selection.filters,
          page: 1,
          pageSize: PDF_EXPORT_LIMIT,
        });
        total = res.total;
        reportNos = res.reports.map((r) => r.report_no);
      }
      return { files: [], missing: reportNos, total, capped: total > PDF_EXPORT_LIMIT };
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
  createReportVersion(reportId: string, data: DailyReportData, changeNote: string) {
    return this.run(() => ({
      version: this.store.createReportVersion(reportId, data, changeNote, this.user.id),
    }));
  }
  markNoWork(siteDayId: string) {
    return this.run(() => this.store.markNoWork(siteDayId, this.user.id));
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
      this.store.inviteReporter(input, this.user.id);
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
  createOrg(_input: CreateOrgInput) {
    // The demo has exactly one org; the wizard "creates" it by returning it.
    return this.run(() => ({ orgId: this.orgId }));
  }
  createSite(input: CreateSiteInput) {
    return this.run(() => ({ siteId: this.store.createSite(input, this.user.id) }));
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

  // ─── Realtime ───
  subscribe(onChange: (event: ChangeEvent) => void): () => void {
    return this.store.subscribe(onChange);
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
