import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { formatDateInTz, isoWeekOf, weekdaysShortIn } from '@sitelog/shared/format.ts';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { TableSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { TableCell, TableRow } from '@/components/ui/Table';
import { useDataSource } from '@/data/DataProvider';
import { useHours } from '@/data/hooks';
import type { HoursRow } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { addWeeks } from '@/lib/format';
import { formatNumberIn, formatWeekLabelIn as weekLabelIn } from '@/lib/localeFormat';

/** Crew & subs tab: company × Mon–Fri hours for this site (the /hours matrix filtered). */
export function CrewTab({ siteId, timezone }: { siteId: string; timezone: string }) {
  const { t, language } = useCopy();
  const num = (n: number | null | undefined) => formatNumberIn(n, language);
  const source = useDataSource();
  const [params, setParams] = useSearchParams();
  const currentWeek = isoWeekOf(formatDateInTz(source.now(), timezone));
  const weekParam = params.get('week');
  const week = weekParam && /^\d{4}-W\d{2}$/.test(weekParam) ? weekParam : currentWeek;
  const hours = useHours(week, siteId);
  const setWeek = (w: string) => {
    const next = new URLSearchParams(params);
    if (w === currentWeek) next.delete('week');
    else next.set('week', w);
    setParams(next, { replace: true });
  };

  const columns: Column<HoursRow>[] = [
    {
      key: 'company',
      header: t('siteDetail.crewTab.columns.company'),
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{r.companyName}</span>
          {r.trade ? <span className="text-caption text-dust">{r.trade}</span> : null}
          {r.unconfirmed ? (
            <Badge variant="dashed">{t('siteDetail.badges.unconfirmed')}</Badge>
          ) : null}
        </span>
      ),
    },
    ...weekdaysShortIn(language)
      .slice(0, 5)
      .map((d, i) => ({
        key: `d${i}`,
        header: d,
        numeric: true,
        hideBelowMd: true,
        cell: (r: HoursRow) => (r.days[i] ? num(r.days[i]) : '—'),
      })),
    {
      key: 'reported',
      header: t('siteDetail.crewTab.columns.reported'),
      numeric: true,
      cell: (r) => <span className="font-semibold">{num(r.reported)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-col gap-3 md:flex-row md:items-center">
        <div>
          <CardTitle>{t('siteDetail.crewTab.title')}</CardTitle>
          <p className="text-caption text-dust">
            {t('siteDetail.crewTab.subtitle', { week: weekLabelIn(week, language) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="subtle"
            size="iconDense"
            aria-label={t('siteDetail.crewTab.previousWeek')}
            onClick={() => setWeek(addWeeks(week, -1))}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-dust">
            {week}
          </span>
          <Button
            variant="subtle"
            size="iconDense"
            aria-label={t('siteDetail.crewTab.nextWeek')}
            onClick={() => setWeek(addWeeks(week, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="dense" asChild>
            <Link to={`/hours?week=${week}&site=${siteId}`}>
              {t('siteDetail.crewTab.openHours')}
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-2 pt-3">
        {hours.isPending ? (
          <TableSkeleton />
        ) : hours.isError || !hours.data ? (
          <div className="px-5 pb-3">
            <ErrorState
              thing={t('siteDetail.crewTab.thing')}
              error={hours.error}
              onRetry={() => void hours.refetch()}
            />
          </div>
        ) : hours.data.rows.length === 0 ? (
          <div className="px-5 pb-3">
            <EmptyState title={t('siteDetail.crewTab.empty')} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={hours.data.rows}
            rowKey={(r) => r.key}
            aria-label={t('siteDetail.crewTab.title')}
            footer={
              <TableRow>
                <TableCell className="font-semibold">{t('siteDetail.total')}</TableCell>
                {hours.data.totals.days.map((d, i) => (
                  <TableCell key={i} numeric className="hidden md:table-cell">
                    {num(d)}
                  </TableCell>
                ))}
                <TableCell numeric>{num(hours.data.totals.reported)}</TableCell>
              </TableRow>
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
