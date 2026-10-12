import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
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
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useCreateOfficeReport, useGlossary, useReportPdf } from '@/data/hooks';
import type { CompanyOption, SiteOption } from '@/data/types';
import { errorMessage } from '@/lib/utils';
import { ReportEditor } from '../report/ReportEditor';
import {
  reportFormSchema,
  toFormValues,
  toReportData,
  withoutOfficeEdits,
  type ReportFormValues,
} from '../report/reportForm';

const c = copy.newReport;

/**
 * New report — the office types a site's daily report (no WhatsApp, no AI). It is filed on save
 * as version 1 (create_office_report) and its PDF is rendered in the browser with the worker's
 * document. `?site=` and `?date=` preselect the fields.
 */
export default function NewReportPage() {
  // The glossary view model carries the org's sites and companies.
  const lists = useGlossary();
  if (lists.isPending) return <PageSkeleton />;
  if (lists.isError || !lists.data)
    return (
      <ErrorState
        thing={copy.nav.reports.toLowerCase()}
        error={lists.error}
        onRetry={() => void lists.refetch()}
      />
    );
  const sites = lists.data.sites.filter((s) => s.status !== 'archived');
  return <NewReportForm sites={sites} companies={lists.data.companies} />;
}

function NewReportForm({ sites, companies }: { sites: SiteOption[]; companies: CompanyOption[] }) {
  const source = useDataSource();
  const { currentOrg } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const create = useCreateOfficeReport();
  const reportPdf = useReportPdf();
  const [siteId, setSiteId] = useState(() => {
    const wanted = params.get('site');
    if (wanted && sites.some((s) => s.id === wanted)) return wanted;
    return sites.length === 1 ? sites[0]!.id : '';
  });
  const site = sites.find((s) => s.id === siteId) ?? null;
  // "Today" is the site's local date (before a site is picked, the org's).
  const today = formatDateInTz(source.now(), site?.timezone ?? currentOrg?.timezone ?? 'UTC');
  // null: follow the selected site's today until the user picks a date.
  const [pickedDate, setPickedDate] = useState<string | null>(() => {
    const wanted = params.get('date');
    return wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : null;
  });
  const date = pickedDate ?? today;
  const [fieldError, setFieldError] = useState<{ site?: string; date?: string; body?: string }>({});
  const [busy, setBusy] = useState(false);

  // An empty report: every section starts with no rows (the date is chosen above).
  const [defaultValues] = useState(() => toFormValues(emptyReportData(today)));
  const form = useForm<ReportFormValues>({
    resolver: zodResolver(reportFormSchema),
    defaultValues,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const errors: typeof fieldError = {};
    if (!site) errors.site = c.pickSite;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) errors.date = c.future;
    const empty =
      !values.summary.trim() &&
      values.manpower.length === 0 &&
      values.workPerformed.length === 0 &&
      values.periods.length === 0 &&
      values.deliveries.length === 0;
    if (empty) errors.body = c.empty;
    setFieldError(errors);
    if (!site || errors.site || errors.date || errors.body) return;

    let data;
    try {
      data = withoutOfficeEdits(
        toReportData(values, emptyReportData(date), {
          userId: source.user.id,
          at: source.now().toISOString(),
          companies,
        }),
      );
    } catch (err) {
      toast.error(errorMessage(err, copy.errors.generic));
      return;
    }
    setBusy(true);
    try {
      const res = await create.mutateAsync({ siteId: site.id, date, data });
      if (!res.created) {
        toast.message(c.exists(res.reportNo));
      } else {
        const id = toast.loading(copy.report.pdfPreparing);
        const ok = await reportPdf.prepare(res.reportId, 1);
        if (ok) toast.success(c.filed(res.reportNo), { id });
        else toast.warning(c.pdfLater, { id });
      }
      void navigate(`/reports/${res.reportId}`);
    } catch {
      // useSourceMutation already showed the error.
    } finally {
      setBusy(false);
    }
  });

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: c.breadcrumb, to: '/reports' }, { label: c.title }]}
        title={c.title}
        subtitle={c.subtitle}
        actions={
          sites.length ? (
            <>
              <Button variant="ghost" asChild>
                <Link to="/reports">{c.cancel}</Link>
              </Button>
              <Button onClick={() => void onSubmit()} loading={busy} data-testid="file-report">
                {c.submit}
              </Button>
            </>
          ) : null
        }
      />

      {sites.length === 0 ? (
        <EmptyState
          title={c.noSites}
          action={
            <Button variant="secondary" asChild>
              <Link to="/sites">{copy.nav.sites}</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="nr-site">{c.site}</Label>
              <Select
                value={siteId}
                onValueChange={(v) => {
                  setSiteId(v);
                  setFieldError((e) => ({ ...e, site: undefined }));
                }}
              >
                <SelectTrigger
                  id="nr-site"
                  aria-invalid={!!fieldError.site}
                  data-testid="new-report-site"
                >
                  <SelectValue placeholder={c.pickSite} />
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
              <Label htmlFor="nr-date">{c.date}</Label>
              <Input
                id="nr-date"
                type="date"
                value={date}
                max={today}
                onChange={(e) => {
                  setPickedDate(e.target.value);
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
            <ReportEditor companies={companies} />
          </Form>

          <div className="flex justify-end gap-2 pb-6">
            <Button variant="ghost" asChild>
              <Link to="/reports">{c.cancel}</Link>
            </Button>
            <Button onClick={() => void onSubmit()} loading={busy}>
              {c.submit}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
