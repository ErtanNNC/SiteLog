import { ChevronLeft, ChevronRight, Download, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { TopBarControls } from '@/components/shell/TopBar';
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
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useHours, usePayrollCsv } from '@/data/hooks';
import type { HoursRow } from '@/data/types';
import {
  addWeeks,
  formatDateInTz,
  formatHoursNum,
  formatWeekLabel,
  isoWeekOf,
  isValidIsoWeek,
} from '@/lib/format';
import { useScrollRegion } from '@/lib/useScrollRegion';
import { cn } from '@/lib/utils';
import { AddInvoiceDialog } from './AddInvoiceDialog';
import { InvoiceCheckAside } from './InvoiceCheckAside';

const ALL = 'all';

/** Signed gap text for the matrix: 0 → "match", +16 → "+16 h", awaiting / Confirm handled by the cell. */
function gapText(gap: number): string {
  if (Math.abs(gap) < 0.005) return copy.hours.gap.match;
  return `${gap > 0 ? '+' : '−'}${formatHoursNum(Math.abs(gap))} ${copy.common.hoursUnit}`;
}

/** P8 · Crew hours — matrix company × Mon–Fri with invoice comparison (§11.4, F15). */
export default function HoursPage() {
  const source = useDataSource();
  const { currentOrg } = useAuth();
  const tz = currentOrg?.timezone ?? 'UTC';
  const [params, setParams] = useSearchParams();
  const defaultWeek = useMemo(() => isoWeekOf(formatDateInTz(source.now(), tz)), [source, tz]);
  const week = isValidIsoWeek(params.get('week') ?? '') ? params.get('week')! : defaultWeek;
  const siteParam = params.get('site');
  const siteId = siteParam && siteParam !== ALL ? siteParam : null;

  const hours = useHours(week, siteId);
  const payroll = usePayrollCsv();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const setQuery = (next: { week?: string; site?: string | null }) => {
    const p = new URLSearchParams(params);
    p.set('week', next.week ?? week);
    const s = next.site === undefined ? siteId : next.site;
    if (s) p.set('site', s);
    else p.delete('site');
    setParams(p, { replace: true });
  };

  const data = hours.data;
  // The selection is keyed by company; a week without that row simply shows the hint.
  const selectedRow = data?.rows.find((r) => r.key === selectedKey) ?? null;
  const selectedInvoice =
    selectedRow?.invoiceId && data
      ? (data.invoices.find((i) => i.invoiceId === selectedRow.invoiceId) ?? null)
      : null;

  const downloadCsv = () => {
    payroll.mutate(
      { week, siteId },
      {
        onSuccess: (url) => {
          const a = document.createElement('a');
          a.href = url;
          a.download = `payroll-${week}${siteId ? `-${siteId}` : ''}.csv`;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        },
      },
    );
  };

  const controls = (
    <TopBarControls>
      <div
        className="flex items-center gap-1 rounded-btn border border-rebar bg-chalk"
        role="group"
        aria-label={copy.hours.weekPicker}
      >
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={copy.hours.previousWeek}
          onClick={() => setQuery({ week: addWeeks(week, -1) })}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="eyebrow min-w-[150px] text-center text-asphalt" data-testid="week-label">
          {formatWeekLabel(week)}
        </span>
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={copy.hours.nextWeek}
          onClick={() => setQuery({ week: addWeeks(week, 1) })}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <Select value={siteId ?? ALL} onValueChange={(v) => setQuery({ site: v === ALL ? null : v })}>
        <SelectTrigger dense className="w-[200px]" aria-label={copy.hours.siteSelect}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{copy.hours.allSites}</SelectItem>
          {(data?.sites ?? []).map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </TopBarControls>
  );

  if (hours.isPending) {
    return (
      <>
        {controls}
        <PageSkeleton />
      </>
    );
  }
  if (hours.isError || !data) {
    return (
      <>
        {controls}
        <ErrorState
          thing={copy.nav.hours.toLowerCase()}
          error={hours.error}
          onRetry={() => void hours.refetch()}
        />
      </>
    );
  }

  const k = data.kpis;

  return (
    <>
      {controls}
      <PageHeader
        eyebrow={formatWeekLabel(week)}
        title={copy.hours.title}
        subtitle={copy.hours.subtitle}
        actions={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" />
              {copy.hours.addInvoice}
            </Button>
            <Button variant="secondary" loading={payroll.isPending} onClick={downloadCsv}>
              <Download aria-hidden="true" />
              {copy.hours.payrollCsv}
            </Button>
          </>
        }
      />

      <section className="grid gap-4 md:grid-cols-3" aria-label="KPIs">
        <KpiTile
          label={copy.hours.kpis.subHours}
          value={<span data-testid="kpi-sub-hours">{formatHoursNum(k.subHours)}</span>}
          unit={copy.common.hoursUnit}
        />
        <KpiTile label={copy.hours.kpis.companies} value={k.companies} />
        <KpiTile
          dark
          label={copy.hours.kpis.gaps}
          value={<span data-testid="kpi-gaps">{k.gapSubs}</span>}
          hint={
            k.gapSubs > 0
              ? copy.hours.kpis.gapsDetail(`+${formatHoursNum(k.gapHours)} h`, k.gapSubs)
              : undefined
          }
        />
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{copy.hours.columns.company}</CardTitle>
            {!data.hasInvoiceComparison ? (
              <span className="text-caption text-dust">{copy.hours.perCompanyHint}</span>
            ) : null}
          </CardHeader>
          <CardContent className="px-0 pb-2 pt-3">
            {data.rows.length === 0 ? (
              <div className="px-5 pb-4">
                <EmptyState title={copy.hours.empty} />
              </div>
            ) : (
              <HoursMatrix
                rows={data.rows}
                totals={data.totals}
                selectedKey={selectedKey}
                onSelect={(r) => setSelectedKey(r.key === selectedKey ? null : r.key)}
              />
            )}
          </CardContent>
        </Card>

        <aside aria-label={copy.hours.invoiceCheck}>
          {selectedInvoice && selectedRow ? (
            <InvoiceCheckAside
              key={selectedInvoice.invoiceId}
              invoice={selectedInvoice}
              row={selectedRow}
              onClose={() => setSelectedKey(null)}
            />
          ) : (
            <Card tone="dashed" className="border-rebar">
              <CardContent>
                <h2 className="font-h2 text-h2">{copy.hours.selectRowTitle}</h2>
                <p className="mt-1 text-[15px] text-dust">{copy.hours.selectRow}</p>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      <AddInvoiceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        matrix={data}
        // A known company's row is keyed by its id, also when the invoice is its first row this
        // week (no reported hours): select it once the matrix reloads.
        onAdded={(companyId) => setSelectedKey(companyId)}
      />
    </>
  );
}

function HoursMatrix({
  rows,
  totals,
  selectedKey,
  onSelect,
}: {
  rows: HoursRow[];
  totals: { days: number[]; reported: number; invoiced: number; gap: number };
  selectedKey: string | null;
  onSelect: (row: HoursRow) => void;
}) {
  const scrollRegion = useScrollRegion(copy.hours.title);
  // No row has an invoice to compare (none yet, unconfirmed companies, or one site): the totals
  // say so instead of "0" and "match".
  const compared = rows.some((r) => r.invoiced !== null);
  return (
    <div
      {...scrollRegion}
      className="w-full overflow-x-auto scrollbar-thin"
      data-testid="hours-matrix"
    >
      <Table aria-label={copy.hours.title}>
        <TableHeader>
          <TableRow>
            <TableHead>{copy.hours.columns.company}</TableHead>
            {copy.hours.columns.days.map((d) => (
              <TableHead key={d} numeric>
                {d}
              </TableHead>
            ))}
            <TableHead numeric>{copy.hours.columns.reported}</TableHead>
            <TableHead numeric>{copy.hours.columns.invoiced}</TableHead>
            <TableHead numeric>{copy.hours.columns.gap}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const selectable = r.status === 'gap' || (r.status === 'match' && !!r.invoiceId);
            const selected = r.key === selectedKey;
            return (
              <TableRow
                key={r.key}
                tone={r.status === 'gap' ? 'attention' : 'default'}
                data-status={r.status}
                data-company={r.companyName}
                aria-pressed={selectable ? selected : undefined}
                tabIndex={selectable ? 0 : undefined}
                role={selectable ? 'button' : undefined}
                aria-label={selectable ? copy.hours.openRow(r.companyName) : undefined}
                onClick={selectable ? () => onSelect(r) : undefined}
                onKeyDown={
                  selectable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(r);
                        }
                      }
                    : undefined
                }
                className={cn(
                  selectable && 'cursor-pointer hover:bg-concrete/70',
                  selected && 'outline outline-2 -outline-offset-2 outline-asphalt',
                )}
              >
                <TableCell>
                  <div className="min-w-[180px]">
                    <div className="flex flex-wrap items-center gap-2 font-semibold">
                      {r.companyName}
                      {r.unconfirmed ? (
                        <span className="rounded-chip border border-dashed border-signal-deep px-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-signal-deep">
                          {copy.hours.gap.unconfirmed}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-caption text-dust">
                      {[r.trade, r.siteNames.join(' · ')].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </TableCell>
                {r.days.map((h, i) => (
                  <TableCell key={i} numeric>
                    {h > 0 ? formatHoursNum(h) : <span className="text-dust-light">—</span>}
                  </TableCell>
                ))}
                <TableCell numeric className="font-semibold text-asphalt">
                  {formatHoursNum(r.reported)}
                </TableCell>
                <TableCell numeric>
                  {r.invoiced === null ? (
                    <span className="text-dust-light">—</span>
                  ) : (
                    formatHoursNum(r.invoiced)
                  )}
                </TableCell>
                <TableCell numeric>
                  <GapCell row={r} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow data-testid="hours-total">
            <TableCell>{copy.hours.totalRow}</TableCell>
            {totals.days.map((h, i) => (
              <TableCell key={i} numeric>
                {formatHoursNum(h)}
              </TableCell>
            ))}
            <TableCell numeric className="font-bold">
              {formatHoursNum(totals.reported)}
            </TableCell>
            <TableCell numeric>
              {compared ? (
                formatHoursNum(totals.invoiced)
              ) : (
                <span className="text-dust-light">—</span>
              )}
            </TableCell>
            <TableCell numeric className={cn(compared && totals.gap > 0 && 'text-signal-deep')}>
              {compared ? (
                gapText(totals.gap)
              ) : (
                <span className="text-dust">{copy.hours.gap.awaiting}</span>
              )}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function GapCell({ row }: { row: HoursRow }) {
  if (row.unconfirmed) {
    const reportId = row.reportIdsByDay.flat()[0];
    return (
      <Link
        to={reportId ? `/reports/${reportId}` : '/glossary'}
        onClick={(e) => e.stopPropagation()}
        className="font-sans text-[15px] font-semibold text-level underline-offset-4 hover:underline"
        title={copy.hours.unconfirmedHint}
      >
        {copy.hours.gap.confirm}
      </Link>
    );
  }
  if (row.gap === null) return <span className="text-dust">{copy.hours.gap.awaiting}</span>;
  if (Math.abs(row.gap) < 0.005)
    return <span className="font-semibold text-filed">{copy.hours.gap.match}</span>;
  return (
    <span className="font-semibold text-signal-deep" data-testid="gap-cell">
      {gapText(row.gap)}
      {row.invoiceStatus && row.invoiceStatus !== 'open' ? (
        <span className="ml-1.5 font-sans text-[12px] font-medium text-dust">
          · {copy.chips[row.invoiceStatus]}
        </span>
      ) : null}
    </span>
  );
}
