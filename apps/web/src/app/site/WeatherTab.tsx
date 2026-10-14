import { CloudRain } from 'lucide-react';
import { Link } from 'react-router';
import { formatHours } from '@sitelog/shared/format.ts';
import { EvidenceChips } from '@/components/sitelog/EvidenceChips';
import { TableSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { copy } from '@/copy/en';
import { useWeather } from '@/data/hooks';
import { formatEyebrowDate, formatMonthLabel } from '@/lib/format';

/** Weather & delays tab: the delay log filtered to this site and the calendar's month. */
export function WeatherTab({ siteId, month }: { siteId: string; month: string; timezone: string }) {
  const weather = useWeather(month, siteId);
  return (
    <Card>
      <CardHeader className="flex-col gap-3 md:flex-row md:items-center">
        <div>
          <CardTitle>{copy.siteDetail.weatherTab.title}</CardTitle>
          <p className="text-caption text-dust">
            {copy.siteDetail.weatherTab.subtitle(formatMonthLabel(month))}
          </p>
        </div>
        <Button variant="ghost" size="dense" asChild>
          <Link to={`/weather?site=${siteId}&month=${month}`}>
            {copy.siteDetail.weatherTab.openWeather}
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="pt-3">
        {weather.isPending ? (
          <TableSkeleton rows={3} className="p-0" />
        ) : weather.isError || !weather.data ? (
          <ErrorState
            thing={copy.nav.weather.toLowerCase()}
            error={weather.error}
            onRetry={() => void weather.refetch()}
          />
        ) : weather.data.entries.length === 0 ? (
          <EmptyState icon={CloudRain} title={copy.siteDetail.weatherTab.empty} />
        ) : (
          <ul className="divide-y divide-rebar" aria-label={copy.siteDetail.weatherTab.title}>
            {weather.data.entries.map((e) => (
              <li
                key={e.id}
                className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="eyebrow text-dust">{formatEyebrowDate(e.date)}</div>
                  <Link
                    to={`/reports/${e.reportId}`}
                    className="font-h2 mt-0.5 block text-[17px] leading-6 underline-offset-4 hover:underline"
                  >
                    {e.condition}
                    {e.impact ? ` — ${e.impact}` : ''}
                  </Link>
                  <p className="mt-1 text-caption text-dust">
                    {[
                      e.fullDay
                        ? copy.siteDetail.weatherTab.fullDay
                        : copy.report.period(e.start ?? undefined, e.end ?? undefined),
                      e.observed
                        ? copy.weather.observed(`${e.observed.precip.toFixed(2)} in`)
                        : null,
                      e.reportNo,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <EvidenceChips evidence={e.evidence} className="mt-2" />
                </div>
                <div className="text-left md:text-right">
                  <span className="font-display text-[24px] leading-7 tabular text-signal-deep">
                    {formatHours(e.lostHours)}
                  </span>
                  <div className="eyebrow text-dust">{copy.siteDetail.weatherTab.lostLabel}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
