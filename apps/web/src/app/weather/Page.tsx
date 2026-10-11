import { ChevronLeft, ChevronRight, CloudRain, FileDown, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { formatHours } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
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
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useWeather } from '@/data/hooks';
import type { DelayEntry, PackItem } from '@/data/types';
import {
  addMonths,
  formatDateInTz,
  formatDateTimeShort,
  formatMonthDay,
  formatMonthLabel,
  formatWeekdayMonthDay,
  monthOf,
} from '@/lib/format';
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

/** P9 · Weather & delays — KPIs, heatmap, delay log and EOT packs (§11.4, F16). */
export default function WeatherPage() {
  const source = useDataSource();
  const { currentOrg, isDemo } = useAuth();
  const tz = currentOrg?.timezone ?? 'UTC';
  const [params, setParams] = useSearchParams();
  const today = useMemo(() => formatDateInTz(source.now(), tz), [source, tz]);
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '')
    ? params.get('month')!
    : monthOf(today);
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
  const monthOptions = useMemo(() => {
    const list: string[] = [];
    for (let i = 0; i < 12; i += 1) list.push(addMonths(monthOf(today), -i));
    if (!list.includes(month)) list.push(month);
    return list;
  }, [today, month]);

  const controls = (
    <TopBarControls>
      <Select value={siteId ?? ALL} onValueChange={(v) => setQuery({ site: v === ALL ? null : v })}>
        <SelectTrigger dense className="w-[200px]" aria-label={copy.weather.siteSelect}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{copy.weather.allSites}</SelectItem>
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
        aria-label={copy.weather.monthSelect}
      >
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={copy.weather.previousMonth}
          onClick={() => setQuery({ month: addMonths(month, -1) })}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Select value={month} onValueChange={(v) => setQuery({ month: v })}>
          <SelectTrigger
            dense
            className="h-9 w-[150px] border-0 bg-transparent font-mono text-[12px] font-medium uppercase tracking-[0.08em]"
            aria-label={copy.weather.monthSelect}
            data-testid="month-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {monthOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {formatMonthLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={copy.weather.nextMonth}
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
          thing={copy.nav.weather.toLowerCase()}
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
        eyebrow={formatMonthLabel(month).toUpperCase()}
        title={copy.weather.title}
        subtitle={copy.weather.subtitle}
        actions={
          <Button variant="primary" onClick={() => setPackOpen(true)}>
            <FileText aria-hidden="true" />
            {copy.weather.buildPack}
          </Button>
        }
      />

      <section className="grid gap-4 md:grid-cols-3" aria-label="KPIs">
        <KpiTile
          label={copy.weather.kpis.siteDays}
          value={<span data-testid="kpi-site-days">{k.siteDays}</span>}
        />
        <KpiTile
          label={copy.weather.kpis.hours}
          value={<span data-testid="kpi-hours">{formatHours(k.hours, '')}</span>}
          unit={copy.common.hoursUnit}
        />
        <KpiTile
          dark
          label={copy.weather.kpis.claimReady}
          value={
            <span data-testid="kpi-claim-ready">
              {k.claimReady} <span className="text-dust-light">/ {k.entries}</span>
            </span>
          }
          hint={copy.weather.kpis.claimReadyHint}
        />
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{copy.weather.heatmap}</CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          <HeatmapGrid
            sites={data.sites}
            days={data.days}
            cells={data.cells}
            maxHours={data.maxHours}
            title={copy.weather.heatmap}
          />
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <section aria-label={copy.weather.log}>
          <h2 className="font-h2 mb-3 text-h2">
            {copy.weather.log}{' '}
            <span className="font-mono text-[13px] font-medium text-dust">
              {copy.weather.entries(data.entries.length)}
            </span>
          </h2>
          {data.entries.length === 0 ? (
            <EmptyState icon={CloudRain} title={copy.weather.empty} />
          ) : (
            <>
              <ul className="space-y-3" data-testid="delay-log">
                {visible.map((e) => (
                  <li key={e.id}>
                    <DelayCard entry={e} />
                  </li>
                ))}
              </ul>
              {data.entries.length > shown ? (
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-caption text-dust">
                    {copy.weather.showingOf(visible.length, data.entries.length)}
                  </span>
                  <Button variant="ghost" size="dense" onClick={() => setShown((n) => n + PAGE)}>
                    {copy.common.showMore}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <aside aria-label={copy.weather.pack.history}>
          <h2 className="font-h2 mb-3 text-h2">{copy.weather.pack.history}</h2>
          {data.packs.length === 0 ? (
            <EmptyState icon={FileText} title={copy.weather.packs.empty} />
          ) : (
            <ul className="space-y-3" data-testid="pack-history">
              {data.packs.map((p) => (
                <li key={p.id}>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold">
                            {p.siteName ?? copy.weather.packs.allSites}
                          </div>
                          <div className="font-mono text-[12px] text-dust">
                            {formatMonthDay(p.periodStart)} – {formatMonthDay(p.periodEnd)} ·{' '}
                            {copy.weather.packs.sections(p.sections.length)}
                          </div>
                          <div className="mt-1 text-caption text-dust">
                            {copy.weather.packs.requestedBy(formatDateTimeShort(p.createdAt, tz))}
                          </div>
                        </div>
                        <span
                          className={cn(
                            'inline-flex h-6 shrink-0 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
                            PACK_CHIP[p.status],
                          )}
                          data-testid="pack-status"
                        >
                          {copy.chips[p.status]}
                        </span>
                      </div>
                      {p.status === 'ready' ? (
                        <div className="mt-3">
                          {p.url ? (
                            <Button variant="ghost" size="dense" asChild>
                              <a href={p.url} download>
                                <FileDown aria-hidden="true" />
                                {copy.weather.pack.download}
                              </a>
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="dense"
                              onClick={() =>
                                toast.message(
                                  isDemo ? copy.weather.packs.demoDownload : copy.errors.generic,
                                )
                              }
                            >
                              <FileDown aria-hidden="true" />
                              {copy.weather.pack.download}
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
        key={packOpen ? `open-${siteId ?? ALL}-${month}` : 'closed'}
        open={packOpen}
        onOpenChange={setPackOpen}
        sites={data.sites}
        defaultSiteId={siteId}
        month={month}
        entries={data.entries}
      />
    </>
  );
}

function DelayCard({ entry }: { entry: DelayEntry }) {
  const precip = entry.observed?.precipIn;
  const details: string[] = [];
  if (typeof precip === 'number') details.push(copy.weather.observed(`${precip} in`));
  if (entry.fullDay) details.push(copy.weather.fullDay);
  else if (entry.start && entry.end)
    details.push(copy.weather.stoppedBetween(entry.start, entry.end));
  else if (entry.start) details.push(copy.weather.stoppedFrom(entry.start));
  return (
    <Card data-testid="delay-entry" data-claim-ready={entry.claimReady || undefined}>
      <CardContent className="p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="eyebrow text-dust">
              {formatWeekdayMonthDay(entry.date).toUpperCase()} · {entry.siteShort.toUpperCase()}
            </div>
            <h3 className="mt-1 text-[17px] font-semibold leading-6">
              <Link
                to={`/reports/${entry.reportId}`}
                className="underline-offset-4 hover:underline"
                aria-label={copy.weather.openReport(entry.reportNo)}
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
            <EvidenceChips evidence={entry.evidence} className="mt-3" />
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-[22px] font-semibold leading-7 text-signal-deep tabular">
              {formatHours(entry.lostHours)}
            </div>
            <div className="eyebrow text-dust">{copy.weather.lostHours('').trim()}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
