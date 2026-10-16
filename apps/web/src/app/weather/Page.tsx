import { ChevronLeft, ChevronRight, CloudRain, FileDown, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  formatDate,
  formatHoursIn,
  formatMeasure,
  formatMonthYearIn,
} from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import type { OrgLocale, UnitSystem } from '@sitelog/shared/locale.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
import { TopBarControls } from '@/components/shell/TopBar';
import { EvidenceChips } from '@/components/sitelog/EvidenceChips';
import { HeatmapGrid } from '@/components/sitelog/HeatmapGrid';
import { KpiTile } from '@/components/sitelog/KpiTile';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { useDataSource } from '@/data/DataProvider';
import { useWeather } from '@/data/hooks';
import type { DelayEntry, PackItem } from '@/data/types';
import type { PanelLanguage } from '@/i18n/language';
import { useCopy } from '@/i18n/useCopy';
import { addMonths, formatDateInTz, formatTimeInTz, isValidYearMonth, monthOf } from '@/lib/format';
import { formatNumberIn } from '@/lib/localeFormat';
import { cn } from '@/lib/utils';
import { PackDialog } from './PackDialog';

const ALL = 'all';
const PAGE = 6;

const PACK_CHIP: Record<PackItem['status'], string> = {
  queued: 'border-rebar bg-concrete text-dust',
  building: 'border-chip-await-bg bg-chip-await-bg text-chip-await-fg',
  ready: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg',
  failed: 'border-chip-miss-bg bg-chip-miss-bg text-chip-miss-fg',
};

/**
 * P9 · Weather & delays — KPIs, heatmap, delay log and EOT packs (§11.4, F20). EN/TR since W3-07:
 * dates, hours ("h" / "sa") and observed values in the panel's language and the org's units; the
 * evidence chips show *Voice note ts* or *Call ts*. The canvas's Web-Weather artboard is not
 * exported, so the page keeps the v1.0 layout.
 */
export default function WeatherPage() {
  const source = useDataSource();
  const { t, language } = useCopy();
  const { currentOrg, isDemo, role } = useAuth();
  const tz = currentOrg?.timezone ?? 'UTC';
  const [params, setParams] = useSearchParams();
  const today = useMemo(() => formatDateInTz(source.now(), tz), [source, tz]);
  const month = isValidYearMonth(params.get('month') ?? '') ? params.get('month')! : monthOf(today);
  const siteParam = params.get('site');
  const siteId = siteParam && siteParam !== ALL ? siteParam : null;

  const weather = useWeather(month, siteId);
  const [packOpen, setPackOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);

  const setQuery = (next: { month?: string; site?: string | null }) => {
    const p = new URLSearchParams(params);
    p.set('month', next.month ?? month);
    const s = next.site === undefined ? siteId : next.site;
    if (s) p.set('site', s);
    else p.delete('site');
    setParams(p, { replace: true });
    setShown(PAGE);
  };

  const data = weather.data;
  // The site the log is for: the data drops a site that is not the org's (a stale or typed link),
  // so the picker then reads "All sites" instead of going blank.
  const activeSite = data && !weather.isPlaceholderData ? data.siteId : siteId;

  const monthOptions = useMemo(() => {
    const list: string[] = [];
    for (let i = 0; i < 12; i += 1) list.push(addMonths(monthOf(today), -i));
    if (!list.includes(month)) list.push(month);
    return list;
  }, [today, month]);

  const monthLabel = (m: string) => formatMonthYearIn(m, language);

  const controls = (
    <TopBarControls>
      <Select
        value={activeSite ?? ALL}
        onValueChange={(v) => setQuery({ site: v === ALL ? null : v })}
      >
        <SelectTrigger dense className="w-[200px]" aria-label={t('weather.siteSelect')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('weather.allSites')}</SelectItem>
          {(data?.sites ?? []).map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div
        className="flex items-center gap-1 rounded-btn border border-rebar bg-chalk"
        role="group"
        aria-label={t('weather.monthSelect')}
      >
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={t('weather.previousMonth')}
          onClick={() => setQuery({ month: addMonths(month, -1) })}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Select value={month} onValueChange={(v) => setQuery({ month: v })}>
          <SelectTrigger
            dense
            className="h-9 w-[150px] border-0 bg-transparent font-mono text-[12px] font-medium uppercase tracking-[0.08em]"
            aria-label={t('weather.monthSelect')}
            data-testid="month-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {monthOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {monthLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={t('weather.nextMonth')}
          disabled={month >= monthOf(today)}
          onClick={() => setQuery({ month: addMonths(month, 1) })}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </TopBarControls>
  );

  if (weather.isPending) {
    return (
      <>
        {controls}
        <PageSkeleton />
      </>
    );
  }
  if (weather.isError || !data) {
    return (
      <>
        {controls}
        <ErrorState
          thing={t('weather.thing')}
          error={weather.error}
          onRetry={() => void weather.refetch()}
        />
      </>
    );
  }

  const k = data.kpis;
  const visible = data.entries.slice(0, shown);

  return (
    <>
      {controls}
      <PageHeader
        eyebrow={upperIn(language, monthLabel(month))}
        title={t('weather.title')}
        subtitle={t('weather.subtitle')}
        actions={
          <Button
            variant="primary"
            disabled={data.sites.length === 0}
            onClick={() => setPackOpen(true)}
          >
            <FileText aria-hidden="true" />
            {t('weather.buildPack')}
          </Button>
        }
      />

      <section className="grid gap-4 md:grid-cols-3" aria-label={t('weather.kpisLabel')}>
        <KpiTile
          label={t('weather.kpis.siteDays')}
          value={<span data-testid="kpi-site-days">{k.siteDays}</span>}
        />
        <KpiTile
          label={t('weather.kpis.hours')}
          value={<span data-testid="kpi-hours">{formatNumberIn(k.hours, language)}</span>}
          unit={t('common.hoursUnit')}
        />
        <KpiTile
          dark
          label={t('weather.kpis.claimReady')}
          value={
            <span data-testid="kpi-claim-ready">
              {k.claimReady} <span className="text-dust-light">/ {k.entries}</span>
            </span>
          }
          hint={t('weather.kpis.claimReadyHint')}
        />
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('weather.heatmap')}</CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {data.sites.length === 0 ? (
            <EmptyState
              icon={CloudRain}
              title={t('weather.noSitesTitle')}
              body={t('weather.noSites')}
              action={
                canAccess(role, ROUTE_ROLES.setup ?? []) ? (
                  <Button variant="secondary" asChild>
                    <Link to="/setup/site">{t('sites.addSite')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : data.days.length === 0 ? (
            <EmptyState icon={CloudRain} title={t('weather.noWorkdays')} />
          ) : (
            <HeatmapGrid
              sites={activeSite ? data.sites.filter((s) => s.id === activeSite) : data.sites}
              days={data.days}
              cells={data.cells}
              maxHours={data.maxHours}
              title={t('weather.heatmap')}
            />
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <section aria-label={t('weather.log')}>
          <h2 className="font-h2 mb-3 text-h2">
            {t('weather.log')}{' '}
            <span className="font-mono text-[13px] font-medium text-dust">
              {t('weather.entries', { count: data.entries.length })}
            </span>
          </h2>
          {data.entries.length === 0 ? (
            <EmptyState icon={CloudRain} title={t('weather.empty')} />
          ) : (
            <>
              <ul className="space-y-3" data-testid="delay-log">
                {visible.map((e) => (
                  <li key={e.id}>
                    <DelayCard
                      entry={e}
                      units={data.units}
                      language={language}
                      orgLocale={currentOrg?.locale ?? 'en-US'}
                    />
                  </li>
                ))}
              </ul>
              {data.entries.length > shown ? (
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-caption text-dust">
                    {t('weather.showingOf', { shown: visible.length, total: data.entries.length })}
                  </span>
                  <Button variant="ghost" size="dense" onClick={() => setShown((n) => n + PAGE)}>
                    {t('common.showMore')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <aside aria-label={t('weather.pack.history')}>
          <h2 className="font-h2 mb-3 text-h2">{t('weather.pack.history')}</h2>
          {data.packs.length === 0 ? (
            <EmptyState icon={FileText} title={t('weather.packs.empty')} />
          ) : (
            <ul className="space-y-3" data-testid="pack-history">
              {data.packs.map((p) => (
                <li key={p.id}>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold">
                            {p.siteName ?? t('weather.packs.allSites')}
                          </div>
                          <div className="font-mono text-[12px] text-dust">
                            {t('weather.packs.period', {
                              from: formatDate(p.periodStart, 'monthDay', language),
                              to: formatDate(p.periodEnd, 'monthDay', language),
                            })}{' '}
                            · {t('weather.packs.sections', { count: p.sections.length })}
                          </div>
                          <div className="mt-1 text-caption text-dust">
                            {t('weather.packs.requestedBy', {
                              when: `${formatDate(formatDateInTz(p.createdAt, tz), 'monthDay', language)} · ${formatTimeInTz(p.createdAt, tz)}`,
                            })}
                          </div>
                          {p.notStarted ? (
                            <p
                              className="mt-1 text-caption font-medium text-signal-deep"
                              data-testid="pack-not-started"
                            >
                              {t('weather.packs.notStarted')}
                            </p>
                          ) : null}
                        </div>
                        <span
                          className={cn(
                            'inline-flex h-6 shrink-0 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
                            PACK_CHIP[p.status],
                          )}
                          data-testid="pack-status"
                        >
                          {t(`chips.${p.status}`)}
                        </span>
                      </div>
                      {p.status === 'ready' ? (
                        <div className="mt-3">
                          {p.url ? (
                            <Button variant="ghost" size="dense" asChild>
                              <a href={p.url} download>
                                <FileDown aria-hidden="true" />
                                {t('weather.pack.download')}
                              </a>
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="dense"
                              onClick={() =>
                                toast.message(
                                  isDemo ? t('weather.packs.demoDownload') : t('errors.generic'),
                                )
                              }
                            >
                              <FileDown aria-hidden="true" />
                              {t('weather.pack.download')}
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <PackDialog
        key={packOpen ? `open-${activeSite ?? ALL}-${month}` : 'closed'}
        open={packOpen}
        onOpenChange={setPackOpen}
        sites={data.sites}
        defaultSiteId={activeSite}
        month={month}
        entries={data.entries}
      />
    </>
  );
}

/** "0.40 in" · "10,2 mm": an observed value in the org's units, in the panel's language. */
function observedPrecip(precip: number, units: UnitSystem, language: PanelLanguage): string {
  return formatMeasure(precip, 'precipitation', units, language);
}

function DelayCard({
  entry,
  units,
  language,
  orgLocale,
}: {
  entry: DelayEntry;
  units: UnitSystem;
  language: PanelLanguage;
  /** Site names are the org's words: upper case in its locale, not the panel's. */
  orgLocale: OrgLocale;
}) {
  const { t } = useCopy();
  const precip = entry.observed?.precip;
  const details: string[] = [];
  if (typeof precip === 'number')
    details.push(t('weather.observed', { precip: observedPrecip(precip, units, language) }));
  if (entry.fullDay) details.push(t('weather.fullDay'));
  else if (entry.start && entry.end)
    details.push(t('weather.stoppedBetween', { start: entry.start, end: entry.end }));
  else if (entry.start) details.push(t('weather.stoppedFrom', { start: entry.start }));
  return (
    <Card data-testid="delay-entry" data-claim-ready={entry.claimReady || undefined}>
      <CardContent className="p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="eyebrow text-dust">
              {upperIn(language, formatDate(entry.date, 'weekdayMonthDay', language))} ·{' '}
              {upperIn(orgLocale, entry.siteShort)}
            </div>
            <h3 className="mt-1 text-[17px] font-semibold leading-6">
              <Link
                to={`/reports/${entry.reportId}`}
                className="underline-offset-4 hover:underline"
                aria-label={t('weather.openReport', { no: entry.reportNo })}
              >
                {entry.condition}
                {entry.impact ? (
                  <span className="font-normal text-dust"> — {entry.impact}</span>
                ) : null}
              </Link>
            </h3>
            {details.length ? (
              <p className="mt-1 text-caption text-dust">{details.join(' · ')}</p>
            ) : null}
            {entry.awaitingSignOff ? (
              <p className="mt-1 text-caption text-dust" data-testid="awaiting-sign-off">
                {t('weather.notConfirmed')}
              </p>
            ) : null}
            <EvidenceChips
              evidence={entry.evidence}
              reportId={entry.reportId}
              reportNo={entry.reportNo}
              className="mt-3"
            />
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-[22px] font-semibold leading-7 text-signal-deep tabular">
              {formatHoursIn(entry.lostHours, language)}
            </div>
            <div className="eyebrow text-dust">{t('weather.lostLabel')}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
