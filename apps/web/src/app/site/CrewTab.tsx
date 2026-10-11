import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { formatDateInTz, isoWeekOf } from '@sitelog/shared/format.ts';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { TableSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { TableCell, TableRow } from '@/components/ui/Table';
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useHours } from '@/data/hooks';
import type { HoursRow } from '@/data/types';
import { addWeeks, formatHoursNum, formatWeekLabel } from '@/lib/format';

/** Crew & subs tab: company × Mon–Fri hours for this site (the /hours matrix filtered). */
export function CrewTab({ siteId, timezone }: { siteId: string; timezone: string }) {
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
      header: copy.siteDetail.crewTab.columns.company,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{r.companyName}</span>
          {r.trade ? <span className="text-caption text-dust">{r.trade}</span> : null}
          {r.unconfirmed ? <Badge variant="dashed">{copy.chips.unconfirmed}</Badge> : null}
        </span>
      ),
    },
    ...copy.hours.columns.days.map((d, i) => ({
      key: `d${i}`,
      header: d,
      numeric: true,
      hideBelowMd: true,
      cell: (r: HoursRow) => (r.days[i] ? formatHoursNum(r.days[i]) : '—'),
    })),
    {
      key: 'reported',
      header: copy.siteDetail.crewTab.columns.reported,
      numeric: true,
      cell: (r) => <span className="font-semibold">{formatHoursNum(r.reported)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-col gap-3 md:flex-row md:items-center">
        <div>
          <CardTitle>{copy.siteDetail.crewTab.title}</CardTitle>
          <p className="text-caption text-dust">
            {copy.siteDetail.crewTab.subtitle(formatWeekLabel(week))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="subtle"
            size="iconDense"
            aria-label={copy.siteDetail.crewTab.previousWeek}
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
            aria-label={copy.siteDetail.crewTab.nextWeek}
            onClick={() => setWeek(addWeeks(week, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="dense" asChild>
            <Link to={`/hours?week=${week}&site=${siteId}`}>
              {copy.siteDetail.crewTab.openHours}
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
              thing={copy.nav.hours.toLowerCase()}
              error={hours.error}
              onRetry={() => void hours.refetch()}
            />
          </div>
        ) : hours.data.rows.length === 0 ? (
          <div className="px-5 pb-3">
            <EmptyState title={copy.siteDetail.crewTab.empty} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={hours.data.rows}
            rowKey={(r) => r.key}
            aria-label={copy.siteDetail.crewTab.title}
            footer={
              <TableRow>
                <TableCell className="font-semibold">{copy.common.total}</TableCell>
                {hours.data.totals.days.map((d, i) => (
                  <TableCell key={i} numeric className="hidden md:table-cell">
                    {formatHoursNum(d)}
                  </TableCell>
                ))}
                <TableCell numeric>{formatHoursNum(hours.data.totals.reported)}</TableCell>
              </TableRow>
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
