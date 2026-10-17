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
import type { BillingPrice, BillingStatus } from '@sitelog/shared/billing.ts';
import { pdfFileNames, saveBlob, zipFromUrls } from '@/lib/pdfZip';
import { qk } from '@/lib/query';
import { pendingTab } from '@/lib/tab';
import { errorCode, errorMessage, uuid } from '@/lib/utils';
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
  type OfficeCallNowInput,
  type PdfSelection,
  type RequestEvidencePackInput,
  type ResolveUnknownCompanyInput,
  type ReviewGlossaryTermInput,
  type UpdateOrgInput,
  type SendTestMessageInput,
  type UpdateReporterContactInput,
  type UpdateReporterInput,
  type UpdateSitePatch,
} from './source';
import {
  TEAM_RPC_CODES,
  TEXT_LINK_ERROR_CODES,
  type OrgSettingsPatch,
  type ReportFilters,
  type TeamRpcCode,
  type TextDailyLinkErrorCode,
} from './types';
import type { OrgLocale } from '@sitelog/shared/locale.ts';
import { OFFICE_CALL_REFUSALS, type OfficeCallRefusal } from '@sitelog/shared/voice-outbound.ts';

interface Opts {
  enabled?: boolean;
  refetchInterval?: number | false;
}

/**
 * Realtime is the Overview's fast path (F17 step 4: the org channel invalidates it, so a filed
 * report flips its row in about 2 s). Against a database it also polls every 10 s while the tab is
 * visible, so the page still updates when the realtime channel never delivers (the hosted preview
 * project did not deliver postgres_changes to the Demo phone, DEMO_PHONE_POLL) or the socket
 * dropped. The in-memory demo emits its own changes and never polls.
 */
export const OVERVIEW_POLL_MS = 10_000;

export function useOverview() {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.overview(s.orgId),
    queryFn: () => s.getOverview(),
    refetchInterval: s.mode === 'supabase' ? OVERVIEW_POLL_MS : false,
  });
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

/** The shell's billing banner (F23, §19 Q235): admins only, refreshed every few minutes. */
export function useBillingAlert(enabled: boolean) {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.billingAlert(s.orgId),
    queryFn: () => s.getBillingAlert(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
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
    mutationFn: (vars: { reporterId: string; body: string; channel?: 'sms' | 'whatsapp' }) =>
      s.sendDemoPhoneReply(vars.reporterId, vars.body, vars.channel ?? 'sms'),
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
      if (!opts.quietErrors) toast.error(errorMessage(err, translate('errors.generic')));
    },
  });
}

export function useSignOff() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { reportId: string; reportNo: string }) => s.signOff(vars.reportId),
    { success: (v) => translate('toasts.signedOffReport', { no: v.reportNo }) },
  );
}

export function useUndoSignOff() {
  const s = useDataSource();
  return useSourceMutation((vars: { reportId: string }) => s.undoSignOff(vars.reportId), {
    success: () => translate('toasts.undone'),
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
      /** The version the edit was opened on (§19 Q106). */
      baseVersion?: number;
    }) =>
      s.createReportVersion(
        vars.reportId,
        vars.data,
        vars.changeNote,
        vars.photos,
        vars.baseVersion,
      ),
    {
      success: (_v, r) => translate('toasts.versionSavedN', { version: r.version }),
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
    if (!stored) toast.warning(translate('report.pdfNotSaved'));
    return url;
  };
  const m = useMutation({
    mutationFn: async (vars: {
      reportId: string;
      version: number | null;
      go: (url: string | null) => void;
    }) => {
      const id = toast.loading(translate('report.pdfPreparing'));
      try {
        const url = await make(vars.reportId, vars.version);
        toast.dismiss(id);
        vars.go(url);
      } catch (err) {
        vars.go(null);
        toast.error(errorMessage(err, translate('report.pdfFailed')), { id });
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
    { success: (v) => translate('overview.markNoWorkDialog.done', { site: v.siteName }) },
  );
}

/**
 * F17 "Text today's link" (W1-16; the Overview and Site detail, W1-18): one request id per tap, so
 * a retry never texts twice. The toast says whether the text went, or why not (consent, opt-out,
 * no sender for the country here), in the panel's language.
 */
export function useTextDailyLink() {
  const s = useDataSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { siteId: string; first: string; reporterId?: string }) =>
      s.textDailyLink(vars.siteId, uuid(), vars.reporterId),
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: [s.orgId] });
      const first = vars.first;
      if (result.sent) toast.success(translate('overview.textLink.sent', { first }));
      else if (result.detail === 'console_real_org')
        toast.message(translate('overview.textLink.notSent.console_real_org', { first }));
      else toast.message(translate(`overview.textLink.notSent.${result.reason}`, { first }));
    },
    onError: (err) => {
      // 409 no_reporter / no_active_reporter: the panel's copy, not the function's English.
      const code = errorCode(err);
      toast.error(
        isTextLinkErrorCode(code)
          ? translate(`overview.textLink.failed.${code}`)
          : errorMessage(err, translate('errors.generic')),
      );
    },
  });
}

function isTextLinkErrorCode(code: string | null): code is TextDailyLinkErrorCode {
  return (TEXT_LINK_ERROR_CODES as readonly (string | null)[]).includes(code);
}

export function useResolveUnknownCompany() {
  const s = useDataSource();
  return useSourceMutation((vars: ResolveUnknownCompanyInput) => s.resolveUnknownCompany(vars), {
    success: () => translate('toasts.companyResolved'),
  });
}

export function useReviewGlossaryTerm() {
  const s = useDataSource();
  return useSourceMutation((vars: ReviewGlossaryTermInput) => s.reviewGlossaryTerm(vars), {
    success: () => translate('toasts.termReviewed'),
  });
}

export function useAddGlossaryTerm() {
  const s = useDataSource();
  return useSourceMutation((vars: AddGlossaryTermInput) => s.addGlossaryTerm(vars), {
    success: () => translate('toasts.termAdded'),
  });
}

export function useSaveSettings() {
  const s = useDataSource();
  return useSourceMutation((vars: OrgSettingsPatch) => s.saveSettings(vars), {
    success: () => translate('toasts.settingsSaved'),
  });
}

/**
 * W4-05 (§19 Q233): Settings → PDF template, the report language and units through update_org()
 * (admin, audited), with the company details unchanged.
 */
export function useSaveReportLocale() {
  const s = useDataSource();
  return useSourceMutation((vars: UpdateOrgInput) => s.updateOrg(vars), {
    success: () => translate('settings.pdf.reportLocaleSaved'),
  });
}

/** W4-05 (§19 Q232): Settings → Field channels, _Send me a test message_ (the caller toasts). */
export function useSendTestMessage() {
  const s = useDataSource();
  return useSourceMutation((vars: SendTestMessageInput) => s.sendTestMessage(vars), {
    silent: true,
    quietErrors: true,
    invalidate: false,
  });
}

export function useSaveSiteRecipients() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { siteId: string; emails: string[] }) => s.saveSiteRecipients(vars.siteId, vars.emails),
    { success: () => translate('toasts.saved') },
  );
}

export function useAddInvoice() {
  const s = useDataSource();
  return useSourceMutation((vars: AddInvoiceInput) => s.addInvoice(vars), {
    success: () => translate('toasts.invoiceAdded'),
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
          ? translate('hours.queried')
          : v.status === 'resolved'
            ? translate('hours.resolved')
            : translate('toasts.saved'),
    },
  );
}

// ─── Team & numbers (P10; W4-03: toasts and refusals in the panel's language) ───

/** A Team RPC's refusal (`TEAM_RPC_CODES`) in the panel's language; anything else as it came. */
function teamError(err: unknown): string {
  const code = errorCode(err);
  return code && (TEAM_RPC_CODES as readonly string[]).includes(code)
    ? translate(`team.errors.${code as TeamRpcCode}`)
    : errorMessage(err, translate('errors.generic'));
}

/** useSourceMutation with Team's error wording. */
function useTeamMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  success: (vars: TVars, result: TResult) => string,
) {
  const s = useDataSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: [s.orgId] });
      toast.success(success(vars, result));
    },
    onError: (err) => toast.error(teamError(err)),
  });
}

export function useInviteReporter() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: InviteReporterInput) => s.inviteReporter(vars),
    (v, result) =>
      result.status === 'opted_out'
        ? translate('team.toasts.invitedOptedOut', { name: v.name })
        : translate('team.toasts.invited', { name: v.name }),
  );
}

export function useLinkUnknownSender() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: LinkUnknownSenderInput) => s.linkUnknownSender(vars),
    () => translate('team.toasts.linked'),
  );
}

export function useIgnoreUnknownSender() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { unknownSenderId: string }) => s.ignoreUnknownSender(vars.unknownSenderId),
    () => translate('team.toasts.ignored'),
  );
}

export function useSetReporterStatus() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { reporterId: string; status: ReporterStatus; name: string }) =>
      s.setReporterStatus(vars.reporterId, vars.status),
    (v) =>
      v.status === 'disabled'
        ? translate('team.toasts.disabled', { name: v.name })
        : translate('team.toasts.enabled', { name: v.name }),
  );
}

export function useResendInvite() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { reporterId: string; name: string }) => s.resendInvite(vars.reporterId),
    (v) => translate('team.toasts.resent', { name: v.name }),
  );
}

export function useUpdateReporter() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: UpdateReporterInput) => s.updateReporter(vars),
    (v) => translate('team.toasts.updated', { name: v.name.trim() }),
  );
}

/**
 * Team → Edit's second half (W4-03): preference, message channel and language (one audited RPC),
 * run after `useUpdateReporter` when they changed. Quiet: Edit toasts once for the whole save.
 */
export function useUpdateReporterContact() {
  const s = useDataSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: UpdateReporterContactInput) => s.updateReporterContact(vars),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [s.orgId] }),
    onError: (err) => toast.error(teamError(err)),
  });
}

export function useRevokeReporterDevices() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { reporterId: string; name: string }) => s.revokeReporterDevices(vars.reporterId),
    (v) => translate('team.toasts.devicesRevoked', { name: v.name }),
  );
}

export function useClearReporterOptOut() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { reporterId: string; name: string; attested: boolean }) =>
      s.clearReporterOptOut(vars.reporterId, vars.attested),
    (v) => translate('team.toasts.optOutCleared', { name: v.name }),
  );
}

/**
 * Team → Call now (W4-04, §19 Q230). A refusal comes back with its reason
 * (`OFFICE_CALL_REFUSALS`), worded by `team.callNow.refused.*`.
 */
export function useOfficeCallNow() {
  const s = useDataSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: OfficeCallNowInput & { name: string }) =>
      s.officeCallNow({
        reporterId: vars.reporterId,
        siteId: vars.siteId,
        attested: vars.attested,
      }),
    onSuccess: (_r, vars) => {
      void qc.invalidateQueries({ queryKey: [s.orgId] });
      toast.success(translate('team.toasts.callRequested', { name: vars.name }));
    },
    onError: (err) => {
      const code = errorCode(err);
      toast.error(
        code && (OFFICE_CALL_REFUSALS as readonly string[]).includes(code)
          ? translate(`team.callNow.refused.${code as OfficeCallRefusal}`)
          : teamError(err),
      );
    },
  });
}

export function useAddOfficeUser() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { email: string; role: MemberRole; name?: string; uiLocale?: OrgLocale | null }) =>
      s.addOfficeUser(vars),
    (v) => translate('team.toasts.memberAdded', { email: v.email }),
  );
}

export function useChangeMemberRole() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { userId: string; role: MemberRole }) => s.changeMemberRole(vars.userId, vars.role),
    () => translate('team.toasts.memberUpdated'),
  );
}

export function useRemoveMember() {
  const s = useDataSource();
  return useTeamMutation(
    (vars: { userId: string }) => s.removeMember(vars.userId),
    () => translate('team.toasts.memberRemoved'),
  );
}

export function useUpdateOrg() {
  const s = useDataSource();
  return useSourceMutation((vars: UpdateOrgInput) => s.updateOrg(vars), {
    success: () => translate('toasts.orgUpdated'),
  });
}

export function useCreateSite() {
  const s = useDataSource();
  return useSourceMutation((vars: CreateSiteInput) => s.createSite(vars), {
    success: (v) => translate('toasts.siteCreated', { site: v.name }),
  });
}

export function useUpdateSite() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { siteId: string; patch: UpdateSitePatch }) => s.updateSite(vars.siteId, vars.patch),
    { success: () => translate('toasts.siteUpdated') },
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
    { success: (v) => translate('toasts.sitePausedName', { site: v.siteName }) },
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
    { success: (v) => translate('toasts.siteResumedName', { site: v.siteName }) },
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
      success: (v) => translate(v.file ? 'toasts.logoUpdated' : 'toasts.logoRemoved'),
      silent: opts.quiet,
      quietErrors: opts.quiet,
    },
  );
}

export function useRequestEvidencePack() {
  const s = useDataSource();
  return useSourceMutation((vars: RequestEvidencePackInput) => s.requestEvidencePack(vars), {
    success: () => translate('toasts.packRequested'),
  });
}

export function usePayrollCsv() {
  const s = useDataSource();
  return useSourceMutation(
    (vars: { week: string; siteId: string | null }) => s.payrollCsvUrl(vars.week, vars.siteId),
    { success: () => translate('toasts.csvReady'), invalidate: false },
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
      const id = toast.loading(translate('pdfZip.preparing'));
      const local: string[] = [];
      try {
        const batch = await s.getPdfUrls(vars.selection);
        if (batch.capped)
          toast.message(
            translate('pdfZip.capped', { limit: PDF_EXPORT_LIMIT, total: batch.total }),
          );
        // Reports without a stored PDF (typed in the panel, a failed upload, no worker yet): render
        // them here, one at a time, and store each so the next export has it.
        const files = [...batch.files];
        const made: string[] = [];
        let notMade = 0;
        for (const [i, r] of batch.missing.entries()) {
          toast.loading(translate('pdfZip.making', { done: i + 1, total: batch.missing.length }), {
            id,
          });
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
          toast.message(translate('pdfZip.none'), { id });
          return { zipped: 0 };
        }
        const names = pdfFileNames(files);
        const result = await zipFromUrls(
          files.map((f, i) => ({ name: names[i]!, url: f.url })),
          {
            onProgress: (done, total) =>
              toast.loading(translate('pdfZip.progress', { done, total }), { id }),
          },
        );
        if (!result.blob) {
          toast.error(translate('pdfZip.failed'), { id });
          return { zipped: 0 };
        }
        saveBlob(result.blob, vars.fileName);
        const skipped = result.failed.length + notMade;
        const count = result.added.length;
        if (skipped) toast.warning(translate('pdfZip.partial', { count, skipped }), { id });
        else toast.success(translate('pdfZip.ready', { count }), { id });
        return { zipped: count };
      } catch (err) {
        toast.error(errorMessage(err, translate('pdfZip.failed')), { id });
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
        if (!url) toast.message(translate('reports.pdfNotReady'));
      } catch (err) {
        vars.go(null);
        toast.error(errorMessage(err, translate('errors.generic')));
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
        translate(kind === 'portal' ? 'billing.portalOpening' : 'billing.checkoutOpening'),
      );
      try {
        const url = await (kind === 'portal' ? s.getBillingPortalUrl() : s.getBillingCheckoutUrl());
        toast.dismiss(id);
        window.location.assign(url);
      } catch (err) {
        toast.error(errorMessage(err, translate('errors.generic')), { id });
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

/** /ops: org-less unknown contacts and the real orgs (spec §19 Q44, W1-16). */
export function useOrglessContacts() {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.orglessContacts(s.user.id),
    queryFn: () => s.getOrglessContacts(),
    refetchInterval: 30_000,
  });
}

function useOrglessMutation<V>(fn: (vars: V) => Promise<void>, success: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ops'] });
      toast.success(success);
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ['ops'] });
      toast.error(errorMessage(err, copy.errors.generic));
    },
  });
}

export function useAssignUnknownContact() {
  const s = useDataSource();
  return useOrglessMutation(
    (vars: { contactId: string; orgId: string }) =>
      s.assignUnknownContact(vars.contactId, vars.orgId),
    copy.ops.orgless.assigned,
  );
}

export function useIgnoreOrglessContact() {
  const s = useDataSource();
  return useOrglessMutation(
    (vars: { contactId: string }) => s.ignoreOrglessContact(vars.contactId),
    copy.ops.orgless.ignored,
  );
}

/** /ops (W4-10): every org's billing, the price and a manual org's status. */
export function useOpsOrgBilling() {
  const s = useDataSource();
  return useQuery({
    queryKey: qk.opsOrgBilling(s.user.id),
    queryFn: () => s.getOpsOrgBilling(),
  });
}

export function useSetOrgPrice() {
  const s = useDataSource();
  return useOrglessMutation(
    (vars: { orgId: string; price: BillingPrice | null }) => s.setOrgPrice(vars.orgId, vars.price),
    copy.ops.billing.saved,
  );
}

export function useSetOrgBillingStatus() {
  const s = useDataSource();
  return useOrglessMutation(
    (vars: { orgId: string; status: BillingStatus }) =>
      s.setOrgBillingStatus(vars.orgId, vars.status),
    copy.ops.billing.saved,
  );
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
