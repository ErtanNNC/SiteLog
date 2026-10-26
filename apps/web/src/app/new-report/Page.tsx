import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { emptyReportData } from '@sitelog/shared/schemas/report.ts';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Form } from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { useDataSource } from '@/data/DataProvider';
import { useCreateOfficeReport, useGlossary, useReportPdf, useSettings } from '@/data/hooks';
import type { CompanyOption, SiteOption } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { errorMessage } from '@/lib/utils';
import { PhotoPicker } from '../report/PhotoPicker';
import { ReportEditor } from '../report/ReportEditor';
import { usePhotoDraft } from '../report/usePhotoDraft';
import {
  reportFormSchema,
  toFormValues,
  toReportData,
  withoutOfficeEdits,
  type ReportFormValues,
} from '../report/reportForm';
import { newReportDraftKey, readNewReportDraft, writeNewReportDraft } from './draft';

/**
 * Report data v2 (W1-12). create_office_report stamps the org's report language and units (and the
 * date) on the server, so these are placeholders the server replaces.
 */
const OFFICE_REPORT_STAMPS = { reportLanguage: 'en', units: 'imperial' } as const;

/**
 * New report — the office types a site's daily report (no WhatsApp, no AI), with photos. It is
 * filed on save as version 1 (create_office_report, after the photos are uploaded) and its PDF
 * is rendered in the browser with the worker's document. `?site=` and `?date=` preselect the
 * fields. A day that already has a report is caught before anything is uploaded, and the page
 * keeps what was typed (also across a reload: ./draft). EN/TR since W4-09.
 */
export default function NewReportPage() {
  const { t } = useCopy();
  // The glossary view model carries the org's sites and companies.
  const lists = useGlossary();
  if (lists.isPending) return <PageSkeleton />;
  if (lists.isError || !lists.data)
    return (
      <ErrorState
        thing={t('reports.thing')}
        error={lists.error}
        onRetry={() => void lists.refetch()}
      />
    );
  const sites = lists.data.sites.filter((s) => s.status !== 'archived');
  return <NewReportForm sites={sites} companies={lists.data.companies} />;
}

function NewReportForm({ sites, companies }: { sites: SiteOption[]; companies: CompanyOption[] }) {
  const { t } = useCopy();
  const source = useDataSource();
  const { currentOrg } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const create = useCreateOfficeReport();
  const reportPdf = useReportPdf();
  const settings = useSettings();
  const draftKey = newReportDraftKey(source.orgId, source.user.id);
  // The form with nothing typed (the report date is chosen above, not in the form).
  const [blank] = useState(() =>
    toFormValues(emptyReportData(source.now().toISOString().slice(0, 10), OFFICE_REPORT_STAMPS)),
  );
  const paramSite = () => {
    const wanted = params.get('site');
    if (wanted && sites.some((s) => s.id === wanted)) return wanted;
    return sites.length === 1 ? sites[0]!.id : '';
  };
  const paramDate = () => {
    const wanted = params.get('date');
    return wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : null;
  };
  // What this tab was typing before a reload, unless the link asks for another site or day.
  const [{ draft: restoredDraft, skipped: skippedDraft }] = useState(() => {
    const d = readNewReportDraft(draftKey, blank);
    if (!d) return { draft: null, skipped: false };
    const wantSite = params.get('site');
    const wantDate = params.get('date');
    if ((wantSite && wantSite !== d.siteId) || (wantDate && wantDate !== d.date))
      return { draft: null, skipped: true };
    return { draft: d, skipped: false };
  });
  // The tab's draft slot is this page's, except while another day's draft sits there untouched.
  const ownsDraft = useRef(!skippedDraft);
  const [restored, setRestored] = useState(restoredDraft !== null);
  const [siteId, setSiteId] = useState(() =>
    restoredDraft && sites.some((s) => s.id === restoredDraft.siteId)
      ? restoredDraft.siteId
      : paramSite(),
  );
  const site = sites.find((s) => s.id === siteId) ?? null;
  // "Today" is the site's local date (before a site is picked, the org's).
  const today = formatDateInTz(source.now(), site?.timezone ?? currentOrg?.timezone ?? 'UTC');
  // null: follow the selected site's today until the user picks a date.
  const [pickedDate, setPickedDate] = useState<string | null>(
    () => restoredDraft?.date ?? paramDate(),
  );
  const date = pickedDate ?? today;
  const [fieldError, setFieldError] = useState<{ site?: string; date?: string; body?: string }>({});
  const [busy, setBusy] = useState(false);
  // The site-day's report when it already has one: nothing is filed or uploaded then.
  const [existing, setExisting] = useState<{ reportId: string; reportNo: string } | null>(null);
  const photos = usePhotoDraft();
  // False once the page is gone (the user left mid-save): nothing is filed after that.
  const alive = useRef(true);
  const filed = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [defaultValues] = useState(() => restoredDraft?.values ?? blank);
  const form = useForm<ReportFormValues>({
    resolver: zodResolver(reportFormSchema),
    defaultValues,
  });

  // Keeps the draft while typing, and at once when the tab is hidden (the camera opens).
  useEffect(() => {
    const saveDraft = () => {
      if (filed.current) return;
      const values = form.getValues();
      if (JSON.stringify(values) === JSON.stringify(blank)) {
        if (ownsDraft.current) writeNewReportDraft(draftKey, null);
        return;
      }
      ownsDraft.current = true;
      writeNewReportDraft(draftKey, { v: 1, siteId, date, values });
    };
    saveDraft();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = form.subscribe({
      formState: { values: true },
      callback: () => {
        clearTimeout(timer);
        timer = setTimeout(saveDraft, 400);
      },
    });
    const flush = () => {
      clearTimeout(timer);
      saveDraft();
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flush);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flush);
    };
  }, [form, draftKey, blank, siteId, date]);

  const discardDraft = () => {
    if (ownsDraft.current) writeNewReportDraft(draftKey, null);
  };
  const startOver = () => {
    discardDraft();
    form.reset(blank);
    photos.reset();
    setSiteId(paramSite());
    setPickedDate(paramDate());
    setFieldError({});
    setExisting(null);
    setRestored(false);
  };

  const fileReport = async (values: ReportFormValues) => {
    const errors: typeof fieldError = {};
    if (!site) errors.site = t('newReport.pickSite');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) errors.date = t('newReport.future');
    const empty =
      !values.summary.trim() &&
      values.manpower.length === 0 &&
      values.workPerformed.length === 0 &&
      values.periods.length === 0 &&
      values.deliveries.length === 0;
    if (empty) errors.body = t('newReport.empty');
    setFieldError(errors);
    if (!site || errors.site || errors.date || errors.body) return;

    let data;
    try {
      data = withoutOfficeEdits(
        toReportData(values, emptyReportData(date, OFFICE_REPORT_STAMPS), {
          userId: source.user.id,
          at: source.now().toISOString(),
          companies,
        }),
      );
    } catch (err) {
      toast.error(errorMessage(err, t('errors.generic')));
      return;
    }
    setBusy(true);
    setExisting(null);
    // One toast follows the save: photo uploads, then the PDF.
    let toastId: string | number | undefined;
    try {
      // A day that has a report already: say so before uploading anything.
      let found;
      try {
        found = await source.findDayReport(site.id, date);
      } catch (err) {
        toast.error(errorMessage(err, t('errors.generic')));
        return;
      }
      if (!alive.current) return;
      if (found) {
        setExisting(found);
        return;
      }
      const picked = await photos.settle();
      if (!alive.current) return;
      if (!picked) {
        toast.error(t('report.editMode.photos.notReady'));
        return;
      }
      let uploads: Awaited<ReturnType<typeof photos.upload>> = [];
      if (picked.length) {
        toastId = toast.loading(
          t('report.editMode.photos.uploadingProgress', { i: 1, n: picked.length }),
        );
        try {
          uploads = await photos.upload(source, site.id, picked, (i, n) =>
            toast.loading(t('report.editMode.photos.uploadingProgress', { i, n }), {
              id: toastId,
            }),
          );
        } catch {
          if (alive.current) toast.error(t('report.editMode.photos.uploadFailed'), { id: toastId });
          else toast.dismiss(toastId);
          return;
        }
      }
      // The user left while the photos uploaded: file nothing.
      if (!alive.current) {
        if (toastId !== undefined) toast.dismiss(toastId);
        return;
      }
      const res = await create.mutateAsync({ siteId: site.id, date, data, photos: uploads });
      if (!res.created) {
        // Filed from elsewhere meanwhile: keep what was typed here.
        if (toastId !== undefined) toast.dismiss(toastId);
        if (alive.current) setExisting({ reportId: res.reportId, reportNo: res.reportNo });
        return;
      }
      filed.current = true;
      discardDraft();
      const id = toast.loading(t('report.pdfPreparing'), { id: toastId });
      const ok = await reportPdf.prepare(res.reportId, 1);
      if (ok) toast.success(t('newReport.filed', { no: res.reportNo }), { id });
      else toast.warning(t('newReport.pdfLater'), { id });
      if (alive.current) void navigate(`/reports/${res.reportId}`);
    } catch {
      // useSourceMutation already showed the error.
      if (toastId !== undefined) toast.dismiss(toastId);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const onSubmit = () => form.handleSubmit(fileReport)();

  // While saving, Cancel would leave a save that still files: it waits instead.
  const cancel = busy ? (
    <Button variant="ghost" disabled>
      {t('newReport.cancel')}
    </Button>
  ) : (
    <Button variant="ghost" asChild>
      <Link to="/reports" onClick={discardDraft}>
        {t('newReport.cancel')}
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: t('newReport.breadcrumb'), to: '/reports' },
          { label: t('newReport.title') },
        ]}
        title={t('newReport.title')}
        subtitle={t('newReport.subtitle')}
        actions={
          sites.length ? (
            <>
              {cancel}
              <Button onClick={() => void onSubmit()} loading={busy} data-testid="file-report">
                {t('newReport.submit')}
              </Button>
            </>
          ) : null
        }
      />

      {sites.length === 0 ? (
        <EmptyState
          title={t('newReport.noSites')}
          action={
            <Button variant="secondary" asChild>
              <Link to="/sites">{t('nav.sites')}</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {restored ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-rebar bg-chalk px-4 py-3 text-caption"
              data-testid="draft-restored"
            >
              <span>{t('newReport.restored')}</span>
              <Button variant="link" size="sm" onClick={startOver} disabled={busy}>
                {t('newReport.startOver')}
              </Button>
            </div>
          ) : null}
          {existing ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-signal bg-signal-tint/40 px-4 py-3 text-caption"
              data-testid="day-has-report"
            >
              <span className="font-medium">
                {t('newReport.exists', { no: existing.reportNo })}
              </span>
              <Button variant="secondary" size="sm" asChild>
                <Link to={`/reports/${existing.reportId}`}>
                  {t('newReport.openExisting', { no: existing.reportNo })}
                </Link>
              </Button>
            </div>
          ) : null}
          {/* Locked while saving: the report was read when the save started. `inert` also stops
              the Radix selects, which open on pointerdown even in a disabled fieldset. */}
          <fieldset
            disabled={busy}
            inert={busy}
            className="min-w-0 space-y-4"
            data-testid="new-report-form"
          >
            <Card className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="nr-site">{t('newReport.site')}</Label>
                <Select
                  value={siteId}
                  onValueChange={(v) => {
                    setSiteId(v);
                    setExisting(null);
                    setFieldError((e) => ({ ...e, site: undefined }));
                  }}
                  disabled={busy}
                >
                  <SelectTrigger
                    id="nr-site"
                    aria-invalid={!!fieldError.site}
                    data-testid="new-report-site"
                  >
                    <SelectValue placeholder={t('newReport.pickSite')} />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} · {s.projectCode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldError.site ? (
                  <p role="alert" className="text-caption font-medium text-missing">
                    {fieldError.site}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="nr-date">{t('newReport.date')}</Label>
                <Input
                  id="nr-date"
                  type="date"
                  value={date}
                  max={today}
                  onChange={(e) => {
                    setPickedDate(e.target.value);
                    setExisting(null);
                    setFieldError((x) => ({ ...x, date: undefined }));
                  }}
                  aria-invalid={!!fieldError.date}
                  className="font-mono"
                  data-testid="new-report-date"
                />
                {fieldError.date ? (
                  <p role="alert" className="text-caption font-medium text-missing">
                    {fieldError.date}
                  </p>
                ) : null}
              </div>
            </Card>

            {fieldError.body ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {fieldError.body}
              </p>
            ) : null}

            <Form {...form}>
              <ReportEditor
                companies={companies}
                photos={
                  <PhotoPicker
                    draft={photos}
                    timezone={site?.timezone}
                    reportDate={date}
                    pdfMaxPhotos={settings.data?.settings.pdf_max_photos}
                    disabled={busy}
                  />
                }
              />
            </Form>
          </fieldset>

          <div className="flex justify-end gap-2 pb-6">
            {cancel}
            <Button onClick={() => void onSubmit()} loading={busy}>
              {t('newReport.submit')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
