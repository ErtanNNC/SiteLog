import { ChevronLeft, ChevronRight, Download, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { weekdaysShortIn } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
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
import { useDataSource } from '@/data/DataProvider';
import { useHours, usePayrollCsv } from '@/data/hooks';
import type { HoursRow } from '@/data/types';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import type { PanelLanguage } from '@/i18n/language';
import { addWeeks, formatDateInTz, isoWeekOf, isValidIsoWeek } from '@/lib/format';
import { formatNumberIn, formatSignedHoursIn, formatWeekLabelIn } from '@/lib/localeFormat';
import { useScrollRegion } from '@/lib/useScrollRegion';
import { cn } from '@/lib/utils';
import { AddInvoiceDialog } from './AddInvoiceDialog';
import { InvoiceCheckAside } from './InvoiceCheckAside';

const ALL = 'all';

/** Signed gap text for the matrix: 0 → "match", +16 → "+16 h" · "+16 sa". */
function gapText(gap: number, t: CopyT, language: PanelLanguage): string {
  if (Math.abs(gap) < 0.005) return t('hours.gap.match');
  return formatSignedHoursIn(gap, language);
}

/**
 * P8 · Crew hours (§11.4, F19): company × Mon–Fri matrix with the invoice comparison. EN/TR since
 * W3-06 (hours "h" / "sa" and numbers in the panel's language; the canvas's Web-Hours artboard is
 * not exported, so the page keeps the v1.0 layout).
 */
export default function HoursPage() {
  const source = useDataSource();
  const { t, language } = useCopy();
  const { currentOrg } = useAuth();
  const tz = currentOrg?.timezone ?? 'UTC';
  const [params, setParams] = useSearchParams();
  const defaultWeek = useMemo(() => isoWeekOf(formatDateInTz(source.now(), tz)), [source, tz]);
  const week = isValidIsoWeek(params.get('week') ?? '') ? params.get('week')! : defaultWeek;
  const siteParam = params.get('site');
  const siteId = siteParam && siteParam !== ALL ? siteParam : null;
  const num = (n: number | null | undefined) => formatNumberIn(n, language);

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

  const weekLabel = formatWeekLabelIn(week, language);
  const controls = (
    <TopBarControls>
      <div
        className="flex items-center gap-1 rounded-btn border border-rebar bg-chalk"
        role="group"
        aria-label={t('hours.weekPicker')}
      >
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={t('hours.previousWeek')}
          onClick={() => setQuery({ week: addWeeks(week, -1) })}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="eyebrow min-w-[150px] text-center text-asphalt" data-testid="week-label">
          {weekLabel}
        </span>
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={t('hours.nextWeek')}
          onClick={() => setQuery({ week: addWeeks(week, 1) })}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <Select value={siteId ?? ALL} onValueChange={(v) => setQuery({ site: v === ALL ? null : v })}>
        <SelectTrigger dense className="w-[200px]" aria-label={t('hours.siteSelect')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('hours.allSites')}</SelectItem>
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
          thing={t('hours.thing')}
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
        eyebrow={weekLabel}
        title={t('hours.title')}
        subtitle={t('hours.subtitle')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" />
              {t('hours.addInvoice')}
            </Button>
            <Button variant="secondary" loading={payroll.isPending} onClick={downloadCsv}>
              <Download aria-hidden="true" />
              {t('hours.payrollCsv')}
            </Button>
          </>
        }
      />

      <section className="grid gap-4 md:grid-cols-3" aria-label={t('hours.kpisLabel')}>
        <KpiTile
          label={t('hours.kpis.subHours')}
          value={<span data-testid="kpi-sub-hours">{num(k.subHours)}</span>}
          unit={t('common.hoursUnit')}
        />
        <KpiTile label={t('hours.kpis.companies')} value={num(k.companies)} />
        <KpiTile
          dark
          label={t('hours.kpis.gaps')}
          value={<span data-testid="kpi-gaps">{num(k.gapSubs)}</span>}
          hint={
            k.gapSubs > 0
              ? t('hours.kpis.gapsDetail', {
                  hours: formatSignedHoursIn(k.gapHours, language),
                  count: k.gapSubs,
                })
              : undefined
          }
        />
      </section>

      {/* minmax(0, 1fr): the matrix scrolls inside its card at 390 px, not the page. */}
      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('hours.columns.company')}</CardTitle>
            {!data.hasInvoiceComparison ? (
              <span className="text-caption text-dust">{t('hours.perCompanyHint')}</span>
            ) : null}
          </CardHeader>
          <CardContent className="px-0 pb-2 pt-3">
            {data.rows.length === 0 ? (
              <div className="px-5 pb-4">
                <EmptyState title={t('hours.empty')} />
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

        <aside aria-label={t('hours.invoiceCheck')}>
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
                <h2 className="font-h2 text-h2">{t('hours.selectRowTitle')}</h2>
                <p className="mt-1 text-[15px] text-dust">{t('hours.selectRow')}</p>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      <AddInvoiceDialog
        // Remounted per week, so the period and the daily lines are the week on screen (audit
        // "Add invoice dialog keeps the period from the week it first loaded on").
        key={data.week}
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
  const { t, language } = useCopy();
  const num = (n: number | null | undefined) => formatNumberIn(n, language);
  const scrollRegion = useScrollRegion(t('hours.title'));
  const days = weekdaysShortIn(language).slice(0, 5);
  // No row has an invoice to compare (none yet, unconfirmed companies, or one site): the totals
  // say so instead of "0" and "match".
  const compared = rows.some((r) => r.invoiced !== null);
  return (
    <div
      {...scrollRegion}
      className="w-full overflow-x-auto scrollbar-thin"
      data-testid="hours-matrix"
    >
      <Table aria-label={t('hours.title')}>
        <TableHeader>
          <TableRow>
            <TableHead>{t('hours.columns.company')}</TableHead>
            {days.map((d) => (
              <TableHead key={d} numeric>
                {d}
              </TableHead>
            ))}
            <TableHead numeric>{t('hours.columns.reported')}</TableHead>
            <TableHead numeric>{t('hours.columns.invoiced')}</TableHead>
            <TableHead numeric>{t('hours.columns.gap')}</TableHead>
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
                aria-label={selectable ? t('hours.openRow', { company: r.companyName }) : undefined}
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
                          {t('hours.gap.unconfirmed')}
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
                    {h > 0 ? num(h) : <span className="text-dust-light">—</span>}
                  </TableCell>
                ))}
                <TableCell numeric className="font-semibold text-asphalt">
                  {num(r.reported)}
                </TableCell>
                <TableCell numeric>
                  {r.invoiced === null ? (
                    <span className="text-dust-light">—</span>
                  ) : (
                    num(r.invoiced)
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
            <TableCell>{t('hours.totalRow')}</TableCell>
            {totals.days.map((h, i) => (
              <TableCell key={i} numeric>
                {num(h)}
              </TableCell>
            ))}
            <TableCell numeric className="font-bold">
              {num(totals.reported)}
            </TableCell>
            <TableCell numeric>
              {compared ? num(totals.invoiced) : <span className="text-dust-light">—</span>}
            </TableCell>
            <TableCell numeric className={cn(compared && totals.gap > 0 && 'text-signal-deep')}>
              {compared ? (
                gapText(totals.gap, t, language)
              ) : (
                <span className="text-dust">{t('hours.gap.awaiting')}</span>
              )}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function GapCell({ row }: { row: HoursRow }) {
  const { t, language } = useCopy();
  const { role } = useAuth();
  if (row.unconfirmed) {
    // §2.2: confirming a company happens on its report (or the glossary), which an accounts user
    // cannot open (audit "Crew hours for accounts users links to report pages they cannot open").
    const reportId = row.reportIdsByDay.flat()[0];
    const target = reportId
      ? canAccess(role, ROUTE_ROLES.reports ?? [])
        ? `/reports/${reportId}`
        : null
      : canAccess(role, ROUTE_ROLES.glossary ?? [])
        ? '/glossary'
        : null;
    if (!target)
      return (
        <span
          className="font-sans text-[15px] text-dust"
          title={t('hours.unconfirmedAsk')}
          data-testid="unconfirmed-ask"
        >
          {t('hours.gap.awaiting')}
          <span className="sr-only"> · {t('hours.unconfirmedAsk')}</span>
        </span>
      );
    return (
      <Link
        to={target}
        onClick={(e) => e.stopPropagation()}
        className="font-sans text-[15px] font-semibold text-level underline-offset-4 hover:underline"
        title={t('hours.unconfirmedHint')}
      >
        {t('hours.gap.confirm')}
      </Link>
    );
  }
  if (row.gap === null) return <span className="text-dust">{t('hours.gap.awaiting')}</span>;
  if (Math.abs(row.gap) < 0.005)
    return <span className="font-semibold text-filed">{t('hours.gap.match')}</span>;
  return (
    <span className="font-semibold text-signal-deep" data-testid="gap-cell">
      {gapText(row.gap, t, language)}
      {row.invoiceStatus && row.invoiceStatus !== 'open' ? (
        <span className="ml-1.5 font-sans text-[12px] font-medium text-dust">
          · {t(`chips.${row.invoiceStatus}`)}
        </span>
      ) : null}
    </span>
  );
}
