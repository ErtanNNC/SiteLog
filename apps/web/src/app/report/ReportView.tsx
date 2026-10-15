import { Camera, CloudRain, Package, ShieldCheck, Sunrise } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatHoursIn, formatMeasure } from '@sitelog/shared/format.ts';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import type { ReportDetail } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ManpowerTable, SourceLinks } from './ManpowerTable';

export interface ReportViewProps {
  detail: ReportDetail;
  /** Reveals an answer (question id, or a v1 reply's message id) in the Activity timeline. */
  onShowAnswer: (anchor: string) => void;
  onOpenHistory: () => void;
}

function Section({
  id,
  title,
  aside,
  children,
  flush,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <Card id={id} data-testid={`section-${id}`}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {aside}
      </CardHeader>
      <CardContent className={cn(flush ? 'px-0 pb-2 pt-3' : 'pt-3')}>{children}</CardContent>
    </Card>
  );
}

/** Read-only report article: Summary · Weather & impact · Manpower · Work · Deliveries/Safety/Next · Photos. */
export function ReportView({ detail, onShowAnswer, onOpenHistory }: ReportViewProps) {
  const { t, language } = useCopy();
  const d = detail.data;
  const tz = detail.site.timezone;
  const locale = language === 'tr' ? 'tr-TR' : 'en-US';
  const hours = (h: number) => formatHoursIn(h, locale);
  const links = (sources: Parameters<typeof SourceLinks>[0]['sources']) => (
    <SourceLinks
      sources={sources}
      detail={detail}
      onShowAnswer={onShowAnswer}
      onOpenHistory={onOpenHistory}
    />
  );
  const observed = d.weather.observed;
  // Observed values are in the report's units (imperial: in, °F, mph; metric: mm, °C, km/h).
  const measure = (v: number, kind: 'temperature' | 'precipitation' | 'wind', digits?: number) =>
    formatMeasure(v, kind, d.units, locale, digits);
  const weatherDay = detail.report.kind === 'weather_day';
  const period = (start?: string, end?: string) =>
    start && end
      ? t('report.periodRange', { start, end })
      : start
        ? t('report.periodFrom', { start })
        : end
          ? t('report.periodUntil', { end })
          : '';
  const when = (at: string) => formatWhen(at, tz, detail.report.date, language);

  return (
    <article className="space-y-4" aria-label={detail.report.reportNo}>
      <Section id="summary" title={t('report.sections.summary')}>
        <p className="text-[15px] leading-[22px]" data-testid="summary">
          {d.summary || t('report.summaryEmpty')}
        </p>
        {weatherDay ? (
          <p className="mt-2 text-caption text-dust">{t('report.weatherDayNote')}</p>
        ) : null}
        <p className="mt-3 font-mono text-data text-dust tabular">
          {t('report.manpowerSummary', {
            workers: t('report.workers', { count: detail.totals.crewOnSite }),
            companies: t('report.companies', { count: detail.totals.companies }),
            hours: detail.totals.hoursKnown
              ? hours(detail.totals.totalHours)
              : t('report.hoursUnknown'),
          })}
        </p>
      </Section>

      <Section
        id="weather"
        title={t('report.sections.weather')}
        aside={
          detail.delayLogHours > 0 ? (
            <Badge variant="tint" data-testid="delay-log-chip">
              {t('report.inDelayLog', { hours: hours(detail.delayLogHours) })}
            </Badge>
          ) : null
        }
      >
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div>
            <div className="eyebrow text-dust">{t('report.weather.observed')}</div>
            <p className="mt-1 text-[15px]">{d.weather.conditionsText || '—'}</p>
            {observed ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-caption">
                <Obs
                  label={t('report.weather.precip')}
                  value={measure(observed.precip, 'precipitation')}
                />
                <Obs
                  label={t('report.weather.temp')}
                  value={`${Math.round(observed.tempMin)}–${measure(Math.round(observed.tempMax), 'temperature')}`}
                />
                <Obs
                  label={t('report.weather.wind')}
                  value={measure(Math.round(observed.wind), 'wind')}
                />
                {observed.gust !== undefined ? (
                  <Obs
                    label={t('report.weather.gusts')}
                    value={measure(Math.round(observed.gust), 'wind')}
                  />
                ) : null}
              </dl>
            ) : null}
            {/* Credit Open-Meteo only for its observations, as the PDF does. */}
            {observed ? (
              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                {t('report.weather.attribution')}
              </p>
            ) : null}
          </div>
          <div>
            <div className="eyebrow text-dust">{t('report.weather.impact')}</div>
            {d.weather.periods.length === 0 ? (
              <p className="mt-1 text-caption text-dust">{t('report.weather.none')}</p>
            ) : (
              <ul className="mt-1 space-y-2">
                {d.weather.periods.map((p, i) => (
                  <li
                    key={i}
                    className="rounded-card border border-signal-tint bg-signal-tint/40 p-3"
                    data-testid="weather-period"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold">
                        <CloudRain
                          className="mr-1.5 inline size-4 align-[-2px] text-signal-deep"
                          aria-hidden="true"
                        />
                        {p.condition}
                        {p.fullDay
                          ? ` · ${t('report.weather.fullDay')}`
                          : period(p.start, p.end)
                            ? ` ${period(p.start, p.end)}`
                            : ''}
                      </span>
                      <span className="font-mono text-data font-semibold text-signal-deep">
                        {t('report.lostHours', { hours: hours(p.lostHours) })}
                      </span>
                    </div>
                    {p.impact ? <p className="mt-1 text-[15px]">{p.impact}</p> : null}
                    <div className="mt-1">{links(p.source)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section id="manpower" title={t('report.sections.manpower')} flush>
        {d.manpower.length === 0 ? (
          <p className="px-5 pb-3 text-caption text-dust">
            {weatherDay ? t('report.weatherDayNote') : t('report.manpowerEmpty')}
          </p>
        ) : (
          <ManpowerTable
            detail={detail}
            onShowAnswer={onShowAnswer}
            onOpenHistory={onOpenHistory}
          />
        )}
      </Section>

      <Section id="work" title={t('report.sections.work')}>
        {d.workPerformed.length === 0 ? (
          <p className="text-caption text-dust">{t('report.workEmpty')}</p>
        ) : (
          <ul className="divide-y divide-rebar" aria-label={t('report.sections.work')}>
            {d.workPerformed.map((w, i) => (
              <li
                key={i}
                className="grid gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0 md:grid-cols-[120px_minmax(0,1fr)_auto]"
              >
                <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-dust">
                  {w.area || '—'}
                </span>
                <span>
                  <span className="font-medium">{w.activity}</span>
                  <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
                    <Badge variant={w.status === 'complete' ? 'filed' : 'outline'}>
                      {t(`report.workStatus.${w.status}`)}
                    </Badge>
                    {w.percentComplete !== undefined ? (
                      <Badge variant="outline">
                        {t('report.percent', { value: w.percentComplete })}
                      </Badge>
                    ) : null}
                    {w.quantity ? (
                      <Badge variant="outline">
                        {t('report.quantity', {
                          value: String(w.quantity.value),
                          unit: w.quantity.unit,
                        })}
                      </Badge>
                    ) : null}
                    {w.quantity?.heardAs ? (
                      <Badge variant="neutral" className="normal-case tracking-normal">
                        {t('report.work.heardAs', { words: w.quantity.heardAs })}
                      </Badge>
                    ) : null}
                  </span>
                </span>
                <span>{links(w.source)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section id="deliveries" title={t('report.sections.deliveries')}>
          {d.deliveries.length === 0 ? (
            <p className="text-caption text-dust">{t('report.deliveriesEmpty')}</p>
          ) : (
            <ul className="space-y-3">
              {d.deliveries.map((x, i) => (
                <li key={i} className="flex gap-2">
                  <Package className="mt-0.5 size-4 shrink-0 text-dust" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="font-medium">
                      {x.item}
                      {x.quantity ? `, ${x.quantity}` : ''}
                    </div>
                    <div className="text-caption text-dust">
                      {[x.supplier, x.time].filter(Boolean).join(' · ')}
                    </div>
                    {links(x.source)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section id="safety" title={t('report.sections.safety')}>
          <ul className="space-y-2">
            <li className="flex gap-2">
              <ShieldCheck
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  d.safety.incidents.length ? 'text-missing' : 'text-filed',
                )}
                aria-hidden="true"
              />
              <div>
                <div className="font-medium">
                  {d.safety.incidents.length
                    ? t('report.safety.incidents', { count: d.safety.incidents.length })
                    : d.safety.noIncidentsStated
                      ? t('report.safety.noIncidents')
                      : t('report.safety.notStated')}
                </div>
                {d.safety.toolboxTalk ? (
                  <div className="text-caption text-dust">
                    {t('report.safety.toolboxTalk', { topic: d.safety.toolboxTalk })}
                  </div>
                ) : null}
                {d.safety.visitors.length ? (
                  <div className="text-caption text-dust">
                    {t('report.safety.visitors', { names: d.safety.visitors.join(', ') })}
                  </div>
                ) : null}
                {links(d.safety.source)}
              </div>
            </li>
            {d.safety.incidents.map((x, i) => (
              <li key={i} className="rounded-card border border-missing/40 bg-chip-miss-bg/30 p-3">
                <Badge variant="missing">{t(`report.editMode.severities.${x.severity}`)}</Badge>
                <p className="mt-1 text-[15px]">{x.description}</p>
                {links(x.source)}
              </li>
            ))}
          </ul>
        </Section>
        <Section id="next" title={t('report.sections.nextWorkday')}>
          {d.nextWorkday.length === 0 ? (
            <p className="text-caption text-dust">{t('report.nextEmpty')}</p>
          ) : (
            <ul className="space-y-3">
              {d.nextWorkday.map((n, i) => (
                <li key={i} className="flex gap-2">
                  <Sunrise className="mt-0.5 size-4 shrink-0 text-dust" aria-hidden="true" />
                  <div>
                    <div>{n.item}</div>
                    {links(n.source)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {d.issues.length ? (
            <div className="mt-4 border-t border-rebar pt-3">
              <div className="eyebrow text-dust">{t('report.sections.issues')}</div>
              <ul className="mt-1 space-y-2">
                {d.issues.map((x, i) => (
                  <li key={i}>
                    <div>{x.description}</div>
                    {x.impact ? <div className="text-caption text-dust">{x.impact}</div> : null}
                    {links(x.source)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      </div>

      <Section id="photos" title={t('report.sections.photos')}>
        {detail.photos.length === 0 ? (
          <p className="text-caption text-dust">{t('report.photosEmpty')}</p>
        ) : (
          <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
            {detail.photos.map((p) => (
              <li
                key={p.messageId}
                className="overflow-hidden rounded-card border border-rebar"
                data-testid="report-photo"
              >
                {p.url ? (
                  <img
                    src={p.url}
                    alt={
                      p.caption ??
                      (p.takenAt
                        ? t('report.photoAlt', { when: when(p.takenAt) })
                        : t('report.photoAltNoTime'))
                    }
                    className="aspect-[4/3] w-full object-cover"
                  />
                ) : (
                  <div
                    className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 bg-concrete text-dust"
                    role="img"
                    aria-label={p.caption ?? t('report.photoPreview')}
                    title={t('report.photoPreview')}
                  >
                    <Camera className="size-6 stroke-2" aria-hidden="true" />
                  </div>
                )}
                <div className="px-2.5 py-2">
                  <div className="truncate text-caption font-medium">{p.caption ?? '—'}</div>
                  {p.takenAt ? (
                    <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                      {/* A photo taken another day than the report's shows that date too. */}
                      {t('report.photoTaken', { when: when(p.takenAt) })}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </article>
  );
}

function Obs({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow text-dust">{label}</dt>
      <dd className="font-mono text-data tabular">{value}</dd>
    </div>
  );
}
