import { formatDate, formatHoursIn, formatTimeInTz, hoursUnit } from '@sitelog/shared/format.ts';
import { intlLocaleOf, upperIn } from '@sitelog/shared/locale.ts';
import { CirclePause, FolderArchive, HardHat, Inbox, Phone, Plus, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
import { ChannelIcon } from '@/components/sitelog/ChannelIcon';
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
import { useMarkNoWork, useOverview, usePdfZipExport, useTextDailyLink } from '@/data/hooks';
import type {
  AttentionAction,
  AttentionItem,
  CopyRef,
  OverviewSiteRow,
  OverviewWeather,
} from '@/data/types';
import { renderCopyRef } from '@/i18n/copyRef';
import type { PanelLanguage } from '@/i18n/language';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

/** The kind tag on a Needs-attention card (Web-Overview: MISSING · NEEDS REVIEW · INVOICE CHECK). */
const TAG_TONE: Record<AttentionItem['kind'], string> = {
  missing: 'bg-chip-miss-bg text-chip-miss-fg',
  needs_review: 'bg-chip-review-bg text-chip-review-fg',
  invoice_gap: 'bg-chip-await-bg text-chip-await-fg',
  unknown_contact: 'bg-chip-wx-bg text-chip-wx-fg',
  glossary_review: 'bg-chip-wx-bg text-chip-wx-fg',
  undeliverable: 'bg-chip-miss-bg text-chip-miss-fg',
};

/** "FRI, OCT 9, 2026 · 19:05" · "CUM, 9 EKİ 2026 · 19:05" in the org's time zone. */
function eyebrow(instant: Date, tz: string, language: PanelLanguage): string {
  const date = formatDateInTz(instant, tz);
  return `${upperIn(language, formatDate(date, 'long', language))} · ${formatTimeInTz(instant, tz)}`;
}

/** Table and tile numbers: 184 · 3.5 (en) · 3,5 (tr); null → "—". */
function num(n: number | null | undefined, language: PanelLanguage): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(intlLocaleOf(language), { maximumFractionDigits: 2 }).format(
    Math.round(n * 100) / 100,
  );
}

/** "Rain AM 07:00–10:30 · stopped pour", "Rained out from 11:00" (as the reporter said it). */
function weatherText(w: OverviewWeather, t: CopyT): string {
  const range =
    w.start && w.end
      ? `${w.start}–${w.end}`
      : w.start
        ? t('overview.weatherFrom', { time: w.start })
        : '';
  const head = [w.condition, range].filter(Boolean).join(' ');
  return w.impact ? `${head} · ${w.impact}` : head;
}

/** P3 · Overview (today) — §11.4, F17; Web-Overview artboard plus the channel column (D35). */
export default function OverviewPage() {
  const source = useDataSource();
  const { isDemo, role, currentOrg } = useAuth();
  const { t, language } = useCopy();
  const text = (ref: CopyRef) => renderCopyRef(t, language, ref);
  // Sites are added in the setup wizard and paused / resumed in their settings, both admin-only
  // (RLS: sites_admin_insert, sites_admin_update).
  const canAddSite = canAccess(role, ROUTE_ROLES.setup!);
  // Linking a number and checking one are Team & numbers' (admin, ops; §2.2).
  const canOpenTeam = canAccess(role, ROUTE_ROLES.team!);
  // D29: a demo organisation's texts land on the Demo phone (admins, §11.1).
  const demoPhone =
    (isDemo || currentOrg?.demoOrg === true) && canAccess(role, ROUTE_ROLES.devPhone!);
  const overview = useOverview();
  const markNoWork = useMarkNoWork();
  const textLink = useTextDailyLink();
  const pdfZip = usePdfZipExport();
  const navigate = useNavigate();
  const [noWork, setNoWork] = useState<{
    siteDayId: string;
    siteName: string;
    date: string;
  } | null>(null);
  const [texting, setTexting] = useState<string | null>(null);
  const [clock, setClock] = useState(() => source.now());
  useEffect(() => {
    if (isDemo) return;
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [isDemo]);

  const data = overview.data;
  const tz = data?.timezone ?? 'UTC';

  /** One zip of today's filed PDFs (`{reportNo}.pdf`); demo mode has no rendered PDFs. */
  const onPdfs = () => {
    if (isDemo) {
      toast.message(t('overview.pdfsDemo'));
      return;
    }
    const ids = data?.pdfReportIds ?? [];
    if (!ids.length) {
      toast.message(t('overview.pdfsNone'));
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

  const onTextLink = (siteId: string, first: string) => {
    setTexting(siteId);
    textLink.mutate(
      { siteId, first },
      {
        onSuccess: (result) => {
          if (result.sent) toast.success(t('overview.textLink.sent', { first }));
          else if (result.detail === 'console_real_org')
            toast.message(t('overview.textLink.notSent.console_real_org', { first }));
          else toast.message(t(`overview.textLink.notSent.${result.reason}`, { first }));
        },
        onSettled: () => setTexting(null),
      },
    );
  };

  const act = (a: AttentionAction) => {
    switch (a.kind) {
      case 'call':
        window.location.assign(`tel:${a.tel}`);
        break;
      case 'text_link':
        onTextLink(a.siteId, a.first);
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
      case 'open_team':
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
      header: t('overview.columns.site'),
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
      header: t('overview.columns.status'),
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {r.reportId ? (
            <Link
              to={`/reports/${r.reportId}`}
              onClick={(e) => e.stopPropagation()}
              className="rounded-chip"
            >
              <StatusChip variant={r.chip.variant} />
            </Link>
          ) : (
            <StatusChip variant={r.chip.variant} />
          )}
          {r.isLate && r.inAt ? <LateBadge time={formatTimeInTz(r.inAt, r.timezone)} /> : null}
        </span>
      ),
    },
    {
      key: 'channel',
      header: t('overview.columns.channel'),
      cell: (r) =>
        r.channel ? (
          <ChannelIcon channel={r.channel} reported={r.channelReported} />
        ) : (
          <span className="text-dust">—</span>
        ),
    },
    {
      key: 'inAt',
      header: t('overview.columns.inAt'),
      numeric: true,
      cell: (r) => (r.inAt ? formatTimeInTz(r.inAt, r.timezone) : '—'),
    },
    {
      key: 'crew',
      header: t('overview.columns.crew'),
      numeric: true,
      cell: (r) => num(r.crew, language),
    },
    {
      key: 'hours',
      header: t('overview.columns.hours'),
      numeric: true,
      cell: (r) => num(r.hours, language),
    },
    {
      key: 'weather',
      header: t('overview.columns.weather'),
      hideBelowMd: true,
      cell: (r) => {
        const w = r.weather ? weatherText(r.weather, t) : null;
        return (
          <div className="w-[220px] max-w-[220px] min-w-0">
            {w ? (
              <span className="block truncate text-caption text-asphalt" title={w}>
                {w}
              </span>
            ) : r.siteDayStatus === 'missing' && r.remindersSent > 0 ? (
              <span className="text-caption text-dust">
                {t('overview.remindersSent', { count: r.remindersSent })}
              </span>
            ) : (
              <span className="text-caption text-dust">
                {r.reportId ? t('overview.weatherNone') : '—'}
              </span>
            )}
            {r.lostHours > 0 ? (
              <span className="font-mono text-[12px] font-semibold text-signal-deep">
                {t('overview.lostHours', { hours: formatHoursIn(r.lostHours, language) })}
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];

  if (overview.isPending) return <PageSkeleton />;
  if (overview.isError || !data)
    return (
      <ErrorState
        thing={t('nav.overview').toLowerCase()}
        error={overview.error}
        onRetry={() => void overview.refetch()}
      />
    );

  const k = data.kpis;
  const noReportsYet =
    k.segments.filed === 0 &&
    k.segments.missing === 0 &&
    k.segments.weather === 0 &&
    k.segments.noWork === 0 &&
    data.siteCount > 0;

  return (
    <>
      <PageHeader
        eyebrow={eyebrow(isDemo ? source.now() : clock, tz, language)}
        title={t('overview.title', { count: data.siteCount })}
        actions={
          <Button
            variant="secondary"
            onClick={onPdfs}
            loading={pdfZip.isPending}
            data-testid="todays-pdfs"
          >
            <FolderArchive aria-hidden="true" />
            {t('overview.pdfs')}
          </Button>
        }
      />

      {demoPhone && data.siteCount > 0 ? (
        <Card dark className="mb-6" data-testid="demo-phone-card">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
            <Smartphone className="size-8 shrink-0 text-dust-light" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="eyebrow text-dust-light">{t('overview.demoPhoneCard.eyebrow')}</div>
              <h2 className="font-h2 text-h2 text-chalk">{t('overview.demoPhoneCard.title')}</h2>
              <p className="mt-0.5 text-[14px] leading-5 text-dust-light">
                {t('overview.demoPhoneCard.body')}
              </p>
            </div>
            <Button asChild variant="primary" className="self-start sm:self-center">
              <Link to="/dev/phone">{t('overview.demoPhoneCard.cta')}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {data.siteCount === 0 && data.pausedCount > 0 ? (
        <EmptyState
          hero
          icon={CirclePause}
          title={t('overview.allPausedTitle')}
          body={canAddSite ? t('overview.allPaused') : t('overview.allPausedAskAdmin')}
          action={
            <Button variant="secondary" asChild>
              <Link to="/sites">{t('overview.openSites')}</Link>
            </Button>
          }
        />
      ) : data.siteCount === 0 ? (
        <EmptyState
          hero
          icon={HardHat}
          title={t('overview.noSitesTitle')}
          body={canAddSite ? t('overview.noSites') : t('overview.noSitesAskAdmin')}
          action={
            canAddSite ? (
              <Button variant="primary" asChild>
                <Link to="/setup/site">{t('overview.connectFirstSite')}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <section
            className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
            aria-label={t('overview.kpisLabel')}
          >
            <KpiTile
              label={t('overview.kpis.reportsIn')}
              value={
                <span data-testid="kpi-reports-in">
                  {k.reportsIn} <span className="text-dust">/ {k.total}</span>
                </span>
              }
              segments={[
                {
                  key: 'filed',
                  label: t('overview.kpis.segments.filed'),
                  value: k.segments.filed,
                  tone: 'filed',
                },
                {
                  key: 'weather',
                  label: t('overview.kpis.segments.weather'),
                  value: k.segments.weather + k.segments.noWork,
                  tone: 'weather',
                },
                {
                  key: 'missing',
                  label: t('overview.kpis.segments.missing'),
                  value: k.segments.missing,
                  tone: 'missing',
                },
                {
                  key: 'awaiting',
                  label: t('overview.kpis.segments.awaiting'),
                  value: k.segments.awaiting,
                  tone: 'awaiting',
                },
              ]}
            />
            <KpiTile
              label={t('overview.kpis.crew')}
              value={num(k.crewOnSite, language)}
              unit={t('overview.kpis.crewUnit')}
            />
            <KpiTile
              label={t('overview.kpis.hours')}
              value={num(k.laborHours, language)}
              unit={hoursUnit(language)}
            />
            <KpiTile
              dark
              label={t('overview.kpis.weather')}
              value={k.weatherAffectedSites}
              unit={
                k.weatherLostHours > 0
                  ? t('overview.lostHours', {
                      hours: formatHoursIn(k.weatherLostHours, language),
                    })
                  : undefined
              }
              link={{ to: '/weather', label: t('overview.kpis.weatherLink') }}
            />
          </section>

          <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
            <Card className="min-w-0">
              <CardHeader className="flex-wrap gap-x-4 gap-y-1">
                <CardTitle>{t('overview.sitesToday')}</CardTitle>
                <span className="inline-flex items-center gap-4">
                  {isDemo ? (
                    <span className="eyebrow text-dust">{t('overview.liveUpdates')}</span>
                  ) : null}
                  <Link
                    to="/sites"
                    className="text-caption font-semibold text-level underline-offset-4 hover:underline"
                  >
                    {t('overview.allSites')}
                  </Link>
                </span>
              </CardHeader>
              <CardContent className="px-0 pb-2 pt-3">
                {noReportsYet ? (
                  <div className="px-5 pb-4">
                    {data.hasReporter ? (
                      <EmptyState
                        icon={Inbox}
                        title={
                          data.remindersOn
                            ? t('overview.emptyBeforeReports', {
                                deadline: data.earliestDeadline,
                                r1: data.reminder1At,
                              })
                            : t('overview.emptyBeforeReportsNoReminders', {
                                deadline: data.earliestDeadline,
                              })
                        }
                      />
                    ) : (
                      // Nobody is set up to report yet, so nothing arrives and nobody is reminded.
                      <EmptyState
                        icon={Inbox}
                        title={t('overview.emptyNoReporter')}
                        body={t('overview.emptyNoReporterBody')}
                        action={
                          <Button variant="primary" asChild>
                            <Link to="/reports/new">
                              <Plus aria-hidden="true" />
                              {t('reports.newReport')}
                            </Link>
                          </Button>
                        }
                      />
                    )}
                  </div>
                ) : null}
                <DataTable
                  columns={columns}
                  rows={data.sitesToday}
                  rowKey={(r) => r.siteId}
                  rowHref={(r) => (r.reportId ? `/reports/${r.reportId}` : `/sites/${r.siteId}`)}
                  rowTone={(r) => (r.chip.variant === 'missing' ? 'missing' : 'default')}
                  aria-label={t('overview.sitesToday')}
                />
              </CardContent>
            </Card>

            <aside aria-label={t('overview.needsAttention')} className="min-w-0">
              <h2 className="font-h2 mb-3 text-h2">{t('overview.needsAttention')}</h2>
              {data.needsAttention.length === 0 ? (
                // A missing site always adds an item, so here a site is either in or still due.
                k.segments.awaiting > 0 ? (
                  <EmptyState
                    title={t('overview.nothingYet')}
                    body={t('overview.nothingYetBody', { count: k.segments.awaiting })}
                  />
                ) : (
                  <EmptyState title={t('overview.allClear')} body={t('overview.allClearBody')} />
                )
              ) : (
                <ul className="space-y-3" data-testid="needs-attention">
                  {data.needsAttention.map((item) => {
                    const actions = item.actions.filter(
                      (a) => canOpenTeam || (a.kind !== 'link_number' && a.kind !== 'open_team'),
                    );
                    return (
                      <li key={item.id}>
                        <Card
                          tone={
                            item.kind === 'missing' || item.kind === 'undeliverable'
                              ? 'attention'
                              : 'default'
                          }
                          data-kind={item.kind}
                        >
                          <CardContent className="flex flex-col gap-2 p-4">
                            <span
                              className={cn(
                                'inline-flex self-start rounded-chip px-2 py-0.5 text-[12px] font-bold uppercase tracking-[0.04em]',
                                TAG_TONE[item.kind],
                              )}
                            >
                              {t(`overview.attention.labels.${item.kind}`)}
                            </span>
                            <p className="font-semibold leading-5">{text(item.title)}</p>
                            <p className="text-[14px] leading-5 text-steel">
                              {item.body.map(text).join(' · ')}
                            </p>
                            {actions.length ? (
                              <div className="mt-1 flex flex-wrap gap-2">
                                {actions.map((a, i) =>
                                  a.kind === 'call' ? (
                                    <Button
                                      key={a.kind}
                                      variant={i === 0 ? 'secondary' : 'ghost'}
                                      size="dense"
                                      className="min-h-[44px]"
                                      asChild
                                    >
                                      <a href={`tel:${a.tel}`}>
                                        <Phone aria-hidden="true" />
                                        {text(a.label)}
                                      </a>
                                    </Button>
                                  ) : (
                                    <Button
                                      key={a.kind}
                                      variant={i === 0 ? 'secondary' : 'ghost'}
                                      size="dense"
                                      className="min-h-[44px]"
                                      loading={
                                        a.kind === 'text_link' &&
                                        textLink.isPending &&
                                        texting === a.siteId
                                      }
                                      onClick={() => act(a)}
                                    >
                                      {text(a.label)}
                                    </Button>
                                  ),
                                )}
                              </div>
                            ) : null}
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
        title={noWork ? t('overview.markNoWorkDialog.title', { site: noWork.siteName }) : ''}
        description={
          noWork
            ? t('overview.markNoWorkDialog.body', {
                date: formatDate(noWork.date, 'monthDay', language),
              })
            : undefined
        }
        confirmLabel={t('overview.markNoWorkDialog.confirm')}
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
