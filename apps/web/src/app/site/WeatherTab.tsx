import { CloudRain } from 'lucide-react';
import { Link } from 'react-router';
import {
  formatDate,
  formatHoursIn,
  formatMeasure,
  formatMonthYearIn,
} from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import { EvidenceChips } from '@/components/sitelog/EvidenceChips';
import { TableSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { useWeather } from '@/data/hooks';
import { useCopy } from '@/i18n/useCopy';

/** Weather & delays tab: the delay log filtered to this site and the calendar's month. */
export function WeatherTab({ siteId, month }: { siteId: string; month: string; timezone: string }) {
  const { t, language } = useCopy();
  const weather = useWeather(month, siteId);
  const period = (start: string | null, end: string | null) =>
    start && end
      ? t('siteDetail.weatherTab.period', { start, end })
      : start
        ? t('siteDetail.weatherTab.periodFrom', { start })
        : end
          ? t('siteDetail.weatherTab.periodUntil', { end })
          : '';
  return (
    <Card>
      <CardHeader className="flex-col gap-3 md:flex-row md:items-center">
        <div>
          <CardTitle>{t('siteDetail.weatherTab.title')}</CardTitle>
          <p className="text-caption text-dust">
            {t('siteDetail.weatherTab.subtitle', { month: formatMonthYearIn(month, language) })}
          </p>
        </div>
        <Button variant="ghost" size="dense" asChild>
          <Link to={`/weather?site=${siteId}&month=${month}`}>
            {t('siteDetail.weatherTab.openWeather')}
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="pt-3">
        {weather.isPending ? (
          <TableSkeleton rows={3} className="p-0" />
        ) : weather.isError || !weather.data ? (
          <ErrorState
            thing={t('siteDetail.weatherTab.thing')}
            error={weather.error}
            onRetry={() => void weather.refetch()}
          />
        ) : weather.data.entries.length === 0 ? (
          <EmptyState icon={CloudRain} title={t('siteDetail.weatherTab.empty')} />
        ) : (
          <ul className="divide-y divide-rebar" aria-label={t('siteDetail.weatherTab.title')}>
            {weather.data.entries.map((e) => (
              <li
                key={e.id}
                className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="eyebrow text-dust">
                    {upperIn(language, formatDate(e.date, 'long', language))}
                  </div>
                  <Link
                    to={`/reports/${e.reportId}`}
                    className="font-h2 mt-0.5 block text-[17px] leading-6 underline-offset-4 hover:underline"
                  >
                    {e.condition}
                    {e.impact ? ` — ${e.impact}` : ''}
                  </Link>
                  <p className="mt-1 text-caption text-dust">
                    {[
                      e.fullDay ? t('siteDetail.weatherTab.fullDay') : period(e.start, e.end),
                      e.observed
                        ? t('siteDetail.weatherTab.observed', {
                            // In the org's units (§10.11), the panel's language.
                            precip: formatMeasure(
                              e.observed.precip,
                              'precipitation',
                              weather.data!.units,
                              language,
                            ),
                          })
                        : null,
                      e.reportNo,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <EvidenceChips
                    evidence={e.evidence}
                    reportId={e.reportId}
                    reportNo={e.reportNo}
                    className="mt-2"
                  />
                </div>
                <div className="text-left md:text-right">
                  <span className="font-display text-[24px] leading-7 tabular text-signal-deep">
                    {formatHoursIn(e.lostHours, language)}
                  </span>
                  <div className="eyebrow text-dust">{t('siteDetail.weatherTab.lostLabel')}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
