/**
 * TanStack Query hooks over the DataSource. Query keys are org-scoped (lib/query.ts);
 * mutations invalidate the org and toast (sonner). Pages never call the source directly.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceStatus, MemberRole, ReporterStatus } from '@sitelog/shared/enums.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { toast } from 'sonner';
import { copy } from '@/copy/en';
import { pdfFileNames, saveBlob, zipFromUrls } from '@/lib/pdfZip';
import { qk } from '@/lib/query';
import { pendingTab } from '@/lib/tab';
import { errorMessage } from '@/lib/utils';
import { useDataSource } from './DataProvider';
import {
  PDF_EXPORT_LIMIT,
  type AddGlossaryTermInput,
  type AddInvoiceInput,
  type CreateOrgInput,
  type CreateSiteInput,
  type InviteReporterInput,
  type LinkUnknownSenderInput,
  type PdfSelection,
  type RequestEvidencePackInput,
  type ResolveUnknownCompanyInput,
  type ReviewGlossaryTermInput,
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
    (vars: { reportId: string; data: DailyReportData; changeNote: string }) =>
      s.createReportVersion(vars.reportId, vars.data, vars.changeNote),
    {
      success: (_v, r) => copy.toasts.versionSaved(r.version),
    },
  );
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
    success: (v) => copy.toasts.reporterInvited(v.name),
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

export function useCreateOrg() {
  const s = useDataSource();
  return useSourceMutation((vars: CreateOrgInput) => s.createOrg(vars), {
    success: (v) => copy.toasts.orgCreated(v.name),
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

export function usePauseSite() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { siteId: string; siteName: string }) => s.pauseSite(vars.siteId),
    { success: (v) => copy.toasts.sitePaused(v.siteName) },
  );
}

export function useResumeSite() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { siteId: string; siteName: string }) => s.resumeSite(vars.siteId),
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
  return useMutation({
    mutationFn: async (vars: { selection: PdfSelection; fileName: string }) => {
      const id = toast.loading(copy.pdfZip.preparing);
      try {
        const batch = await s.getPdfUrls(vars.selection);
        if (batch.capped) toast.message(copy.pdfZip.capped(PDF_EXPORT_LIMIT, batch.total));
        if (!batch.files.length) {
          toast.message(copy.pdfZip.none, { id });
          return { zipped: 0 };
        }
        const names = pdfFileNames(batch.files.map((f) => f.reportNo));
        const result = await zipFromUrls(
          batch.files.map((f, i) => ({ name: names[i]!, url: f.url })),
          { onProgress: (done, total) => toast.loading(copy.pdfZip.progress(done, total), { id }) },
        );
        if (!result.blob) {
          toast.error(copy.pdfZip.failed, { id });
          return { zipped: 0 };
        }
        saveBlob(result.blob, vars.fileName);
        const skipped = result.failed.length + batch.missing.length;
        if (skipped) toast.warning(copy.pdfZip.partial(result.added.length, skipped), { id });
        else toast.success(copy.pdfZip.ready(result.added.length), { id });
        return { zipped: result.added.length };
      } catch (err) {
        toast.error(errorMessage(err, copy.pdfZip.failed), { id });
        return { zipped: 0 };
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
    { success: (_v, r) => (r.changed ? copy.shell.demo.simulated : copy.shell.demo.alreadyFiled) },
  );
}
