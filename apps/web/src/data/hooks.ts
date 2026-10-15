/**
 * TanStack Query hooks over the DataSource. Query keys are org-scoped (lib/query.ts);
 * mutations invalidate the org and toast (sonner). Pages never call the source directly.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { InvoiceStatus, MemberRole, ReporterStatus } from '@sitelog/shared/enums.ts';
import type { StoredReportData } from '@sitelog/shared/schemas/report.ts';
import type { OfficePhotoUpload } from '@sitelog/shared/report/photos.ts';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { copy } from '@/copy/en';
import { translate } from '@/i18n/useCopy';
import { pdfFileNames, saveBlob, zipFromUrls } from '@/lib/pdfZip';
import { qk } from '@/lib/query';
import { pendingTab } from '@/lib/tab';
import { errorMessage } from '@/lib/utils';
import { useDataSource } from './DataProvider';
import {
  PDF_EXPORT_LIMIT,
  type DataSource,
  type AddGlossaryTermInput,
  type AddInvoiceInput,
  type CreateOfficeReportInput,
  type CreateSiteInput,
  type InviteReporterInput,
  type LinkUnknownSenderInput,
  type PdfSelection,
  type RequestEvidencePackInput,
  type ResolveUnknownCompanyInput,
  type ReviewGlossaryTermInput,
  type UpdateOrgInput,
  type UpdateReporterInput,
  type UpdateSitePatch,
} from './source';
import type { OrgSettingsPatch, ReportFilters } from './types';

interface Opts {
  enabled?: boolean;
  refetchInterval?: number | false;
}

export function useOverview() {
  const s = useDataSource();
  return useQuery({ queryKey: qk.overview(s.orgId), queryFn: () => s.getOverview() });
}

export function useSites() {
  const s = useDataSource();
  return useQuery({ queryKey: qk.sites(s.orgId), queryFn: () => s.getSites() });
}

export function useSiteDetail(siteId: string, month: string) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.site(s.orgId, siteId, month),
    queryFn: () => s.getSiteDetail(siteId, month),
  });
}

export function useReports(filters: ReportFilters) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.reports(s.orgId, filters),
    queryFn: () => s.listReports(filters),
    placeholderData: (prev) => prev,
  });
}

export function useReportDetail(reportId: string, version?: number | null) {
  const s = useDataSource();
  return useQuery({
    queryKey: [...qk.report(s.orgId, reportId), version ?? 'current'],
    queryFn: () => s.getReportDetail(reportId, version),
  });
}

export function useHours(week: string, siteId: string | null) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.hours(s.orgId, week, siteId),
    queryFn: () => s.getHours(week, siteId),
    placeholderData: (prev) => prev,
  });
}

export function useWeather(month: string, siteId: string | null) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.weather(s.orgId, month, siteId),
    queryFn: () => s.getWeather(month, siteId),
    placeholderData: (prev) => prev,
  });
}

export function useTeam() {
  const s = useDataSource();
  return useQuery({ queryKey: qk.team(s.orgId), queryFn: () => s.getTeam() });
}

export function useGlossary() {
  const s = useDataSource();
  return useQuery({ queryKey: qk.glossary(s.orgId), queryFn: () => s.getGlossary() });
}

export function useSettings() {
  const s = useDataSource();
  return useQuery({ queryKey: qk.settings(s.orgId), queryFn: () => s.getSettings() });
}

export function useBilling() {
  const s = useDataSource();
  return useQuery({ queryKey: qk.billing(s.orgId), queryFn: () => s.getBilling() });
}

export function useNotifications(opts: Opts = {}) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.notifications(s.orgId),
    queryFn: () => s.getNotifications(),
    ...opts,
  });
}

export function useNavBadges() {
  const s = useDataSource();
  return useQuery({
    queryKey: [s.orgId, 'badges'],
    queryFn: () => s.getNavBadges(),
    staleTime: 15_000,
  });
}

export function useSetupState() {
  const s = useDataSource();
  return useQuery({ queryKey: qk.setup(s.orgId), queryFn: () => s.getSetupState() });
}

/**
 * The Demo phone also polls while it is open: realtime is the fast path, but a device code must
 * show even when the realtime channel never delivers (a hosted project's realtime settings, a
 * dropped socket). Never in a hidden tab.
 */
const DEMO_PHONE_POLL = { staleTime: 0, refetchInterval: 5_000 } as const;

/** /dev/phone (§11.1): the reporter list; `enabled` false keeps it closed for other orgs. */
export function useDemoPhone(opts: Opts = {}) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.demoPhone(s.orgId),
    queryFn: () => s.getDemoPhone(),
    enabled: opts.enabled ?? true,
    ...DEMO_PHONE_POLL,
  });
}

export function useDemoPhoneThread(reporterId: string | null) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.demoPhoneThread(s.orgId, reporterId ?? ''),
    queryFn: () => s.getDemoPhoneThread(reporterId!),
    enabled: reporterId !== null,
    ...DEMO_PHONE_POLL,
  });
}

export function useDemoPhoneEmails(opts: Opts = {}) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.demoPhoneEmails(s.orgId),
    queryFn: () => s.getDemoPhoneEmails(),
    enabled: opts.enabled ?? true,
    ...DEMO_PHONE_POLL,
  });
}

/** Refetches the Demo phone when a text or an email arrives (its own realtime channel). */
export function useDemoPhoneLive(enabled: boolean) {
  const s = useDataSource();
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return s.subscribeDemoPhone(() => {
      void qc.invalidateQueries({ queryKey: qk.demoPhone(s.orgId) });
    });
  }, [s, qc, enabled]);
}

/** Types a text as the reporter; the thread refreshes, the rest of the org stays cached. */
export function useDemoPhoneReply() {
  const s = useDataSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { reporterId: string; body: string }) =>
      s.sendDemoPhoneReply(vars.reporterId, vars.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.demoPhone(s.orgId) }),
    onError: (err) => toast.error(errorMessage(err, translate('devPhone.replyFailed'))),
  });
}

export function useSearch(q: string) {
  const s = useDataSource();
  const needle = q.trim();
  return useQuery({
    queryKey: qk.search(s.orgId, needle),
    queryFn: () => s.search(needle),
    enabled: needle.length >= 2,
    staleTime: 10_000,
  });
}

// ───────────────────────────── Mutations ─────────────────────────────

function useSourceMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: {
    success?: string | ((vars: TVars, result: TResult) => string);
    silent?: boolean;
    /** The caller toasts its own error (e.g. a more specific hint). */
    quietErrors?: boolean;
    invalidate?: boolean;
  } = {},
) {
  const s = useDataSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      if (opts.invalidate !== false) void qc.invalidateQueries({ queryKey: [s.orgId] });
      if (!opts.silent && opts.success) {
        toast.success(
          typeof opts.success === 'function' ? opts.success(vars, result) : opts.success,
        );
      }
    },
    onError: (err) => {
      if (!opts.quietErrors) toast.error(errorMessage(err, copy.errors.generic));
    },
  });
}

export function useSignOff() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { reportId: string; reportNo: string }) => s.signOff(vars.reportId),
    { success: (v) => copy.toasts.signedOff(v.reportNo) },
  );
}

export function useUndoSignOff() {
  const s = useDataSource();
  return useSourceMutation((vars: { reportId: string }) => s.undoSignOff(vars.reportId), {
    success: copy.toasts.undone,
  });
}

export function useCreateReportVersion() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: {
      reportId: string;
      data: StoredReportData;
      changeNote: string;
      photos?: OfficePhotoUpload[];
    }) => s.createReportVersion(vars.reportId, vars.data, vars.changeNote, vars.photos),
    {
      success: (_v, r) => copy.toasts.versionSaved(r.version),
    },
  );
}

/** New report page: file a report typed in the panel (create_office_report). */
export function useCreateOfficeReport() {
  const s = useDataSource();
  return useSourceMutation((vars: CreateOfficeReportInput) => s.createOfficeReport(vars), {
    silent: true,
  });
}

/**
 * A version's PDF: the stored one, or rendered in the browser with the worker's document
 * (@sitelog/pdf) and stored for that version (exports, later visits). `stored` is false when the
 * upload failed and `url` is a local object URL of the rendered file. Until the worker runs, this
 * is how reports typed in the panel and office edits get their PDF.
 */
async function makeReportPdf(
  s: DataSource,
  qc: QueryClient,
  reportId: string,
  version: number | null,
  opts: { invalidate?: boolean } = {},
): Promise<{ url: string; stored: boolean }> {
  const detail = await s.getReportDetail(reportId, version);
  if (detail.pdfUrl) return { url: detail.pdfUrl, stored: true };
  const [{ renderReportDetailPdf }, settings] = await Promise.all([
    import('@/lib/reportPdf'),
    qc.fetchQuery({ queryKey: qk.settings(s.orgId), queryFn: () => s.getSettings() }),
  ]);
  const pdf = await renderReportDetailPdf(detail, settings, s.now());
  try {
    const url = await s.saveReportPdf({
      reportId,
      reportNo: detail.report.reportNo,
      siteId: detail.site.id,
      version: detail.version,
      pdf,
    });
    if (opts.invalidate !== false) invalidateReportPdfs(s, qc, [reportId]);
    return { url, stored: true };
  } catch {
    return { url: URL.createObjectURL(pdf), stored: false };
  }
}

/** The report pages and the archive rows (their PDF button) see the newly stored PDFs. */
function invalidateReportPdfs(s: DataSource, qc: QueryClient, reportIds: string[]) {
  for (const id of reportIds) void qc.invalidateQueries({ queryKey: qk.report(s.orgId, id) });
  void qc.invalidateQueries({ queryKey: [s.orgId, 'reports'] });
}

/** A version's PDF (see makeReportPdf): opened in a new tab, or prepared after filing / an edit. */
export function useReportPdf() {
  const s = useDataSource();
  const qc = useQueryClient();
  const make = async (reportId: string, version: number | null): Promise<string> => {
    const { url, stored } = await makeReportPdf(s, qc, reportId, version);
    if (!stored) toast.warning(copy.report.pdfNotSaved);
    return url;
  };
  const m = useMutation({
    mutationFn: async (vars: {
      reportId: string;
      version: number | null;
      go: (url: string | null) => void;
    }) => {
      const id = toast.loading(copy.report.pdfPreparing);
      try {
        const url = await make(vars.reportId, vars.version);
        toast.dismiss(id);
        vars.go(url);
      } catch (err) {
        vars.go(null);
        toast.error(errorMessage(err, copy.report.pdfFailed), { id });
      }
    },
  });
  return {
    /** Call inside the click: the tab opens first so popup blockers allow it. */
    open: (reportId: string, version: number | null) =>
      m.mutate({ reportId, version, go: pendingTab() }),
    isPending: m.isPending,
    /** Render and store without opening (after filing or an edit); false when it failed. */
    prepare: (reportId: string, version: number | null) =>
      make(reportId, version).then(
        () => true,
        () => false,
      ),
  };
}

export function useMarkNoWork() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { siteDayId: string; siteName: string }) => s.markNoWork(vars.siteDayId),
    { success: (v) => copy.toasts.noWork(v.siteName) },
  );
}

export function useResolveUnknownCompany() {
  const s = useDataSource();
  return useSourceMutation((vars: ResolveUnknownCompanyInput) => s.resolveUnknownCompany(vars), {
    success: copy.toasts.companyResolved,
  });
}

export function useReviewGlossaryTerm() {
  const s = useDataSource();
  return useSourceMutation((vars: ReviewGlossaryTermInput) => s.reviewGlossaryTerm(vars), {
    success: copy.toasts.termReviewed,
  });
}

export function useAddGlossaryTerm() {
  const s = useDataSource();
  return useSourceMutation((vars: AddGlossaryTermInput) => s.addGlossaryTerm(vars), {
    success: copy.toasts.termAdded,
  });
}

export function useSaveSettings() {
  const s = useDataSource();
  return useSourceMutation((vars: OrgSettingsPatch) => s.saveSettings(vars), {
    success: copy.toasts.settingsSaved,
  });
}

export function useSaveSiteRecipients() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { siteId: string; emails: string[] }) => s.saveSiteRecipients(vars.siteId, vars.emails),
    { success: copy.toasts.saved },
  );
}

export function useAddInvoice() {
  const s = useDataSource();
  return useSourceMutation((vars: AddInvoiceInput) => s.addInvoice(vars), {
    success: copy.toasts.invoiceAdded,
  });
}

export function useSetInvoiceStatus() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { invoiceId: string; status: InvoiceStatus }) =>
      s.setInvoiceStatus(vars.invoiceId, vars.status),
    {
      success: (v) =>
        v.status === 'queried'
          ? copy.hours.queried
          : v.status === 'resolved'
            ? copy.hours.resolved
            : copy.toasts.saved,
    },
  );
}

export function useInviteReporter() {
  const s = useDataSource();
  return useSourceMutation((vars: InviteReporterInput) => s.inviteReporter(vars), {
    success: (v, result) =>
      result.status === 'opted_out'
        ? copy.toasts.reporterInvitedOptedOut(v.name)
        : copy.toasts.reporterInvited(v.name),
  });
}

export function useLinkUnknownSender() {
  const s = useDataSource();
  return useSourceMutation((vars: LinkUnknownSenderInput) => s.linkUnknownSender(vars), {
    success: copy.toasts.linked,
  });
}

export function useIgnoreUnknownSender() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { unknownSenderId: string }) => s.ignoreUnknownSender(vars.unknownSenderId),
    { success: copy.toasts.ignored },
  );
}

export function useSetReporterStatus() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { reporterId: string; status: ReporterStatus; name: string }) =>
      s.setReporterStatus(vars.reporterId, vars.status),
    {
      success: (v) =>
        v.status === 'disabled' ? copy.team.disabledToast(v.name) : copy.toasts.saved,
    },
  );
}

export function useResendInvite() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { reporterId: string; name: string }) => s.resendInvite(vars.reporterId),
    { success: (v) => copy.team.resent(v.name) },
  );
}

export function useUpdateReporter() {
  const s = useDataSource();
  return useSourceMutation((vars: UpdateReporterInput) => s.updateReporter(vars), {
    success: (v) => copy.team.edit.saved(v.name.trim()),
  });
}

export function useAddOfficeUser() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { email: string; role: MemberRole; name?: string }) => s.addOfficeUser(vars),
    { success: (v) => copy.toasts.memberAdded(v.email) },
  );
}

export function useChangeMemberRole() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { userId: string; role: MemberRole }) => s.changeMemberRole(vars.userId, vars.role),
    { success: copy.toasts.memberUpdated },
  );
}

export function useRemoveMember() {
  const s = useDataSource();
  return useSourceMutation((vars: { userId: string }) => s.removeMember(vars.userId), {
    success: copy.toasts.memberRemoved,
  });
}

export function useUpdateOrg() {
  const s = useDataSource();
  return useSourceMutation((vars: UpdateOrgInput) => s.updateOrg(vars), {
    success: copy.toasts.orgUpdated,
  });
}

export function useCreateSite() {
  const s = useDataSource();
  return useSourceMutation((vars: CreateSiteInput) => s.createSite(vars), {
    success: (v) => copy.toasts.siteCreated(v.name),
  });
}

export function useUpdateSite() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { siteId: string; patch: UpdateSitePatch }) => s.updateSite(vars.siteId, vars.patch),
    { success: copy.toasts.siteUpdated },
  );
}

/**
 * The org switcher's "N active sites" comes from the auth org list, not from a query, so a
 * pause or resume reloads that list too. A failed reload only leaves the count stale.
 */
function useRefreshOrgsQuietly() {
  const { refreshOrgs } = useAuth();
  return () => {
    refreshOrgs().catch(() => undefined);
  };
}

export function usePauseSite() {
  const s = useDataSource();
  const refreshOrgs = useRefreshOrgsQuietly();
  return useSourceMutation(
    async (vars: { siteId: string; siteName: string }) => {
      await s.pauseSite(vars.siteId);
      refreshOrgs();
    },
    { success: (v) => copy.toasts.sitePaused(v.siteName) },
  );
}

export function useResumeSite() {
  const s = useDataSource();
  const refreshOrgs = useRefreshOrgsQuietly();
  return useSourceMutation(
    async (vars: { siteId: string; siteName: string }) => {
      await s.resumeSite(vars.siteId);
      refreshOrgs();
    },
    { success: (v) => copy.toasts.siteResumed(v.siteName) },
  );
}

/**
 * Settings → PDF template / setup wizard: upload (File) or remove (null) the company logo.
 * `quiet` leaves both toasts to the caller (the wizard shows its own hint on failure).
 */
export function useSetOrgLogo(opts: { quiet?: boolean } = {}) {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { file: File | null; orgId?: string }) => s.setOrgLogo(vars.file, vars.orgId),
    {
      success: (v) => (v.file ? copy.toasts.logoUpdated : copy.toasts.logoRemoved),
      silent: opts.quiet,
      quietErrors: opts.quiet,
    },
  );
}

export function useRequestEvidencePack() {
  const s = useDataSource();
  return useSourceMutation((vars: RequestEvidencePackInput) => s.requestEvidencePack(vars), {
    success: copy.toasts.packRequested,
  });
}

export function usePayrollCsv() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { week: string; siteId: string | null }) => s.payrollCsvUrl(vars.week, vars.siteId),
    { success: copy.toasts.csvReady, invalidate: false },
  );
}

/**
 * "Today's PDFs" / "Export PDFs (.zip)": resolve signed URLs, download them in the browser and save
 * one zip of `{reportNo}.pdf` files. Progress and outcome are reported in a single sonner toast.
 */
export function usePdfZipExport() {
  const s = useDataSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { selection: PdfSelection; fileName: string }) => {
      const id = toast.loading(copy.pdfZip.preparing);
      const local: string[] = [];
      try {
        const batch = await s.getPdfUrls(vars.selection);
        if (batch.capped) toast.message(copy.pdfZip.capped(PDF_EXPORT_LIMIT, batch.total));
        // Reports without a stored PDF (typed in the panel, a failed upload, no worker yet): render
        // them here, one at a time, and store each so the next export has it.
        const files = [...batch.files];
        const made: string[] = [];
        let notMade = 0;
        for (const [i, r] of batch.missing.entries()) {
          toast.loading(copy.pdfZip.making(i + 1, batch.missing.length), { id });
          try {
            const pdf = await makeReportPdf(s, qc, r.reportId, null, { invalidate: false });
            if (pdf.stored) made.push(r.reportId);
            else local.push(pdf.url);
            files.push({ ...r, url: pdf.url });
          } catch {
            notMade += 1;
          }
        }
        if (made.length) invalidateReportPdfs(s, qc, made);
        if (!files.length) {
          toast.message(copy.pdfZip.none, { id });
          return { zipped: 0 };
        }
        const names = pdfFileNames(files);
        const result = await zipFromUrls(
          files.map((f, i) => ({ name: names[i]!, url: f.url })),
          { onProgress: (done, total) => toast.loading(copy.pdfZip.progress(done, total), { id }) },
        );
        if (!result.blob) {
          toast.error(copy.pdfZip.failed, { id });
          return { zipped: 0 };
        }
        saveBlob(result.blob, vars.fileName);
        const skipped = result.failed.length + notMade;
        if (skipped) toast.warning(copy.pdfZip.partial(result.added.length, skipped), { id });
        else toast.success(copy.pdfZip.ready(result.added.length), { id });
        return { zipped: result.added.length };
      } catch (err) {
        toast.error(errorMessage(err, copy.pdfZip.failed), { id });
        return { zipped: 0 };
      } finally {
        for (const url of local) URL.revokeObjectURL(url);
      }
    },
  });
}

/**
 * Reports archive row → open the current version's PDF (signed URL) in a new tab. The tab is
 * opened synchronously in `open()` (inside the click) so popup blockers allow it.
 */
export function useOpenReportPdf() {
  const s = useDataSource();
  const m = useMutation({
    mutationFn: async (vars: { reportId: string; go: (url: string | null) => void }) => {
      try {
        const batch = await s.getPdfUrls({ reportIds: [vars.reportId] });
        const url = batch.files[0]?.url ?? null;
        vars.go(url);
        if (!url) toast.message(copy.reports.pdfNotReady);
      } catch (err) {
        vars.go(null);
        toast.error(errorMessage(err, copy.errors.generic));
      }
    },
  });
  return {
    open: (reportId: string) => m.mutate({ reportId, go: pendingTab() }),
    isPending: m.isPending,
  };
}

/** Billing → Stripe customer portal (payment method, invoices). Same tab; Stripe links back. */
export function useBillingPortal() {
  return useStripeRedirect('portal');
}

export function useBillingCheckout() {
  return useStripeRedirect('checkout');
}

/** Opens a Stripe-hosted page (customer portal or Checkout) in the same tab. */
function useStripeRedirect(kind: 'portal' | 'checkout') {
  const s = useDataSource();
  return useMutation({
    mutationFn: async () => {
      const id = toast.loading(
        kind === 'portal' ? copy.billing.portalOpening : copy.billing.checkoutOpening,
      );
      try {
        const url = await (kind === 'portal' ? s.getBillingPortalUrl() : s.getBillingCheckoutUrl());
        toast.dismiss(id);
        window.location.assign(url);
      } catch (err) {
        toast.error(errorMessage(err, copy.errors.generic), { id });
      }
    },
  });
}

// ───────────────────────────── Platform ops (/ops) ─────────────────────────────

/** Is the signed-in user a SiteLog operator? Errors count as "no" (the page then 404s). */
export function usePlatformAdmin() {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.opsAccess(s.user.id),
    queryFn: () => s.isPlatformAdmin(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useOps(opts: Opts = {}) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.ops(s.user.id),
    queryFn: () => s.getOps(),
    refetchInterval: 30_000,
    ...opts,
  });
}

function useOpsMutation(fn: (jobId: number) => Promise<void>, success: (jobId: number) => string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { jobId: number }) => fn(vars.jobId),
    onSuccess: (_r, vars) => {
      void qc.invalidateQueries({ queryKey: ['ops'] });
      toast.success(success(vars.jobId));
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ['ops'] });
      toast.error(errorMessage(err, copy.errors.generic));
    },
  });
}

export function useRetryDeadJob() {
  const s = useDataSource();
  return useOpsMutation((id) => s.retryDeadJob(id), copy.ops.toasts.retried);
}

export function useDiscardDeadJob() {
  const s = useDataSource();
  return useOpsMutation((id) => s.discardDeadJob(id), copy.ops.toasts.discarded);
}

export function useMarkNotificationsRead() {
  const s = useDataSource();
  return useSourceMutation((vars: { ids: string[] }) => s.markNotificationsRead(vars.ids), {
    silent: true,
  });
}

export function useSimulateIncomingReport() {
  const s = useDataSource();
  return useSourceMutation(
    async () => {
      if (!s.simulateIncomingReport) return { changed: false };
      return s.simulateIncomingReport();
    },
    // A shell control (the demo menu), so the toast speaks the panel's language.
    {
      success: (_v, r) =>
        r.changed ? translate('shell.demo.simulated') : translate('shell.demo.alreadyFiled'),
    },
  );
}
