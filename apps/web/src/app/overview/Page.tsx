import {
  BookOpen,
  FolderArchive,
  HardHat,
  Inbox,
  Link2,
  Phone,
  Scale,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { formatDateInTz, formatHours, formatTimeInTz } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { KpiTile } from '@/components/sitelog/KpiTile';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { LateBadge, StatusChip } from '@/components/sitelog/StatusChip';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useMarkNoWork, useOverview, usePdfZipExport } from '@/data/hooks';
import type { AttentionAction, AttentionItem, OverviewSiteRow } from '@/data/types';
import { formatCrew, formatEyebrowDateTime, formatHoursNum, formatMonthDay } from '@/lib/format';
import { cn } from '@/lib/utils';

const ATTENTION_ICON: Record<AttentionItem['kind'], LucideIcon> = {
  missing: Phone,
  needs_review: Search,
  invoice_gap: Scale,
  unknown_sender: Link2,
  glossary_review: BookOpen,
};

/** P3 · Overview (today) — §11.4 + F13. */
export default function OverviewPage() {
  const source = useDataSource();
  const { isDemo } = useAuth();
  const overview = useOverview();
  const markNoWork = useMarkNoWork();
  const pdfZip = usePdfZipExport();
  const navigate = useNavigate();
  const [noWork, setNoWork] = useState<{
    siteDayId: string;
    siteName: string;
    date: string;
  } | null>(null);
  const [clock, setClock] = useState(() => source.now());
  useEffect(() => {
    if (isDemo) return;
    const t = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(t);
  }, [isDemo]);

  const data = overview.data;
  const tz = data?.timezone ?? 'UTC';

  /** One zip of today's filed PDFs (`{reportNo}.pdf`); demo mode has no rendered PDFs. */
  const onPdfs = () => {
    if (isDemo) {
      toast.message(copy.overview.pdfsDemo);
      return;
    }
    const ids = data?.pdfReportIds ?? [];
    if (!ids.length) {
      toast.message(copy.overview.pdfsNone);
      return;
    }
    pdfZip.mutate({
      selection: { reportIds: ids },
      fileName: copy.pdfZip.fileName(
        copy.pdfZip.labels.today,
        formatDateInTz(source.now(), data?.timezone ?? 'UTC'),
      ),
    });
  };

  const act = (a: AttentionAction) => {
    switch (a.kind) {
      case 'call':
        window.location.assign(`tel:${a.tel}`);
        break;
      case 'mark_no_work':
        setNoWork({ siteDayId: a.siteDayId, siteName: a.siteName, date: a.date });
        break;
      case 'review_report':
        void navigate(`/reports/${a.reportId}`);
        break;
      case 'compare_hours':
        void navigate(`/hours?week=${a.week}`);
        break;
      case 'link_number':
        void navigate('/team');
        break;
      case 'review_terms':
        void navigate('/glossary');
        break;
    }
  };

  const columns: Column<OverviewSiteRow>[] = [
    {
      key: 'site',
      header: copy.overview.columns.site,
      cell: (r) => (
        <div className="min-w-[180px]">
          <Link
            to={`/sites/${r.siteId}`}
            className="font-semibold text-asphalt underline-offset-4 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {r.siteName}
          </Link>
          <div className="text-caption text-dust">
            {r.managerName ?? '—'} · <span className="font-mono">{r.projectCode}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: copy.overview.columns.status,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {r.reportId ? (
            <Link
              to={`/reports/${r.reportId}`}
              onClick={(e) => e.stopPropagation()}
              className="rounded-chip"
            >
              <StatusChip variant={r.chip.variant} label={r.chip.label} />
            </Link>
          ) : (
            <StatusChip variant={r.chip.variant} label={r.chip.label} />
          )}
          {r.isLate && r.inAt ? <LateBadge time={formatTimeInTz(r.inAt, r.timezone)} /> : null}
        </span>
      ),
    },
    {
      key: 'inAt',
      header: copy.overview.columns.inAt,
      numeric: true,
      cell: (r) => (r.inAt ? formatTimeInTz(r.inAt, r.timezone) : '—'),
    },
    {
      key: 'crew',
      header: copy.overview.columns.crew,
      numeric: true,
      cell: (r) => formatCrew(r.crew),
    },
    {
      key: 'hours',
      header: copy.overview.columns.hours,
      numeric: true,
      cell: (r) => formatHoursNum(r.hours),
    },
    {
      key: 'weather',
      header: copy.overview.columns.weather,
      hideBelowMd: true,
      cell: (r) => (
        <div className="w-[220px] max-w-[220px] min-w-0">
          {r.weatherImpact ? (
            <span className="block truncate text-caption text-asphalt" title={r.weatherImpact}>
              {r.weatherImpact}
            </span>
          ) : (
            <span className="text-caption text-dust">
              {r.siteDayStatus ? copy.overview.weatherNone : '—'}
            </span>
          )}
          {r.lostHours > 0 ? (
            <span className="font-mono text-[12px] font-semibold text-signal-deep">
              {copy.overview.lostHours(formatHours(r.lostHours))}
            </span>
          ) : null}
        </div>
      ),
    },
  ];

  if (overview.isPending) return <PageSkeleton />;
  if (overview.isError || !data)
    return (
      <ErrorState
        thing={copy.nav.overview.toLowerCase()}
        error={overview.error}
        onRetry={() => void overview.refetch()}
      />
    );

  const k = data.kpis;
  const noReportsYet =
    k.segments.filed === 0 &&
    k.segments.missing === 0 &&
    k.segments.weather === 0 &&
    data.siteCount > 0;

  return (
    <>
      <PageHeader
        eyebrow={formatEyebrowDateTime(isDemo ? source.now() : clock, tz)}
        title={copy.overview.title(data.siteCount)}
        actions={
          <Button
            variant="secondary"
            onClick={onPdfs}
            loading={pdfZip.isPending}
            data-testid="todays-pdfs"
          >
            <FolderArchive aria-hidden="true" />
            {copy.overview.pdfs}
          </Button>
        }
      />

      {data.siteCount === 0 ? (
        <EmptyState
          hero
          icon={HardHat}
          title={copy.overview.noSitesTitle}
          body={copy.overview.noSites}
          action={
            <Button variant="primary" asChild>
              <Link to="/setup/site">{copy.overview.connectFirstSite}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="KPIs">
            <KpiTile
              label={copy.overview.kpis.reportsIn}
              value={
                <span data-testid="kpi-reports-in">
                  {k.reportsIn} <span className="text-dust">/ {k.total}</span>
                </span>
              }
              segments={[
                {
                  key: 'filed',
                  label: copy.overview.kpis.segments.filed,
                  value: k.segments.filed,
                  tone: 'filed',
                },
                {
                  key: 'weather',
                  label: copy.overview.kpis.segments.weather,
                  value: k.segments.weather + k.segments.noWork,
                  tone: 'weather',
                },
                {
                  key: 'missing',
                  label: copy.overview.kpis.segments.missing,
                  value: k.segments.missing,
                  tone: 'missing',
                },
                {
                  key: 'awaiting',
                  label: copy.overview.kpis.segments.awaiting,
                  value: k.segments.awaiting,
                  tone: 'awaiting',
                },
              ]}
            />
            <KpiTile
              label={copy.overview.kpis.crew}
              value={formatCrew(k.crewOnSite)}
              unit={copy.overview.kpis.crewUnit}
            />
            <KpiTile
              label={copy.overview.kpis.hours}
              value={formatHoursNum(k.laborHours)}
              unit={copy.overview.kpis.hoursUnit}
            />
            <KpiTile
              dark
              label={copy.overview.kpis.weather}
              value={k.weatherAffectedSites}
              unit={k.weatherLostHours > 0 ? `${formatHours(k.weatherLostHours)} lost` : undefined}
              link={{ to: '/weather', label: copy.overview.kpis.weatherLink }}
            />
          </section>

          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
            <Card>
              <CardHeader>
                <CardTitle>{copy.overview.sitesToday}</CardTitle>
                {isDemo ? (
                  <span className="eyebrow text-dust">{copy.overview.liveUpdates}</span>
                ) : null}
              </CardHeader>
              <CardContent className="px-0 pb-2 pt-3">
                {noReportsYet ? (
                  <div className="px-5 pb-4">
                    <EmptyState
                      icon={Inbox}
                      title={copy.overview.emptyBeforeReports(
                        data.earliestDeadline,
                        data.reminder1At,
                      )}
                    />
                  </div>
                ) : null}
                <DataTable
                  columns={columns}
                  rows={data.sitesToday}
                  rowKey={(r) => r.siteId}
                  rowHref={(r) => (r.reportId ? `/reports/${r.reportId}` : `/sites/${r.siteId}`)}
                  rowTone={(r) => (r.chip.variant === 'missing' ? 'missing' : 'default')}
                  aria-label={copy.overview.sitesToday}
                />
              </CardContent>
            </Card>

            <aside aria-label={copy.overview.needsAttention}>
              <h2 className="font-h2 mb-3 text-h2">{copy.overview.needsAttention}</h2>
              {data.needsAttention.length === 0 ? (
                <EmptyState title={copy.overview.allClear} body={copy.overview.allClearBody} />
              ) : (
                <ul className="space-y-3" data-testid="needs-attention">
                  {data.needsAttention.map((item) => {
                    const Icon = ATTENTION_ICON[item.kind];
                    return (
                      <li key={item.id}>
                        <Card
                          tone={item.kind === 'missing' ? 'attention' : 'default'}
                          data-kind={item.kind}
                        >
                          <CardContent className="p-4">
                            <div className="flex items-start gap-3">
                              <Icon
                                className={cn(
                                  'mt-0.5 size-5 shrink-0 stroke-2',
                                  item.kind === 'missing'
                                    ? 'text-missing'
                                    : item.kind === 'needs_review'
                                      ? 'text-level'
                                      : 'text-dust',
                                )}
                                aria-hidden="true"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold leading-5">{item.title}</p>
                                <p className="mt-0.5 text-caption text-dust">{item.body}</p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {item.actions.map((a, i) =>
                                    a.kind === 'call' ? (
                                      <Button
                                        key={a.kind}
                                        variant={i === 0 ? 'secondary' : 'ghost'}
                                        size="dense"
                                        asChild
                                      >
                                        <a href={`tel:${a.tel}`}>
                                          <Phone aria-hidden="true" />
                                          {a.label}
                                        </a>
                                      </Button>
                                    ) : (
                                      <Button
                                        key={a.kind}
                                        variant={i === 0 ? 'secondary' : 'ghost'}
                                        size="dense"
                                        onClick={() => act(a)}
                                      >
                                        {a.label}
                                      </Button>
                                    ),
                                  )}
                                </div>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!noWork}
        onOpenChange={(o) => !o && setNoWork(null)}
        title={noWork ? copy.overview.markNoWorkDialog.title(noWork.siteName) : ''}
        description={
          noWork ? copy.overview.markNoWorkDialog.body(formatMonthDay(noWork.date)) : undefined
        }
        confirmLabel={copy.overview.markNoWorkDialog.confirm}
        loading={markNoWork.isPending}
        onConfirm={() => {
          if (!noWork) return;
          markNoWork.mutate(
            { siteDayId: noWork.siteDayId, siteName: noWork.siteName },
            { onSettled: () => setNoWork(null) },
          );
        }}
      />
    </>
  );
}
