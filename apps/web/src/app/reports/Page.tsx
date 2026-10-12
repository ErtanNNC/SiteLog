import { ChevronLeft, ChevronRight, FileDown, FolderArchive, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { formatDateInTz, formatDateShort, formatHours } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { TableSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useOpenReportPdf, usePdfZipExport, useReports, useSites } from '@/data/hooks';
import type { ReportFilters, ReportFlag, ReportListItem, ReportStatusFilter } from '@/data/types';
import { formatCrew, formatHoursNum, monthOf } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUSES: ReportStatusFilter[] = [
  'all',
  'filed',
  'needs_review',
  'signed_off',
  'weather_day',
];
const TOGGLES = [
  { key: 'wx', filter: 'hasWeatherDelay', label: copy.reports.filters.weatherDelay },
  { key: 'edited', filter: 'edited', label: copy.reports.filters.edited },
  { key: 'late', filter: 'late', label: copy.reports.filters.late },
  { key: 'incident', filter: 'incident', label: copy.reports.filters.incident },
] as const;

const FLAG_VARIANT: Record<
  ReportFlag['kind'],
  'tint' | 'level' | 'dashed' | 'missing' | 'neutral'
> = {
  rain: 'tint',
  weather_day: 'neutral',
  version: 'level',
  unknown_sub: 'dashed',
  late: 'missing',
  incident: 'missing',
};

/** URL search params → DataSource filters (the URL is the single source of truth). */
function filtersFrom(params: URLSearchParams): ReportFilters {
  const status = params.get('status') as ReportStatusFilter | null;
  const page = Number(params.get('page') ?? '1');
  return {
    siteId: params.get('site') || null,
    from: params.get('from') || null,
    to: params.get('to') || null,
    status: status && STATUSES.includes(status) ? status : 'all',
    hasWeatherDelay: params.get('wx') === '1',
    edited: params.get('edited') === '1',
    late: params.get('late') === '1',
    incident: params.get('incident') === '1',
    q: params.get('q') ?? '',
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** P6 · Reports archive — filters in the URL, 50 per page from the DataSource (§11.4). */
export default function ReportsPage() {
  const { isDemo, currentOrg } = useAuth();
  const source = useDataSource();
  const pdfZip = usePdfZipExport();
  const openPdf = useOpenReportPdf();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFrom(params), [params]);
  const reports = useReports(filters);
  const sites = useSites();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState(filters.q ?? '');
  // When the URL query changes from outside the box (clear filters, back button), adopt it.
  const [urlQ, setUrlQ] = useState(filters.q ?? '');
  if (urlQ !== (filters.q ?? '')) {
    setUrlQ(filters.q ?? '');
    setSearch(filters.q ?? '');
  }

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
      setSelected(new Set());
    },
    [setParams],
  );

  // Debounce the search box into the URL; typing a new query resets to page 1.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? '') !== search) update({ q: search || null, page: null });
    }, 250);
    return () => clearTimeout(t);
  }, [search, filters.q, update]);

  const activeFilterCount =
    (filters.siteId ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0) +
    (filters.status !== 'all' ? 1 : 0) +
    TOGGLES.filter((t) => filters[t.filter]).length +
    (filters.q ? 1 : 0);

  const data = reports.data;
  const items = data?.items ?? [];
  const allOnPageSelected = items.length > 0 && items.every((i) => selected.has(i.reportId));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) items.forEach((i) => next.delete(i.reportId));
      else items.forEach((i) => next.add(i.reportId));
      return next;
    });
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Selected rows, or every report matching the current filters (capped server-side). */
  const onExport = () => {
    const n = selected.size || data?.total || 0;
    if (isDemo) {
      toast.message(copy.reports.exportDemo(n));
      return;
    }
    if (!n) {
      toast.message(copy.reports.exportNone);
      return;
    }
    pdfZip.mutate({
      selection: selected.size
        ? { reportIds: [...selected] }
        : { filters: { ...filters, page: 1 } },
      fileName: copy.pdfZip.fileName(
        copy.pdfZip.labels.archive,
        formatDateInTz(source.now(), currentOrg?.timezone ?? 'UTC'),
      ),
    });
  };

  const onPdf = (r: ReportListItem) => {
    if (isDemo) toast.message(copy.toasts.pdfDemo);
    else if (!r.pdfPath) toast.message(copy.reports.pdfNotReady);
    else openPdf.open(r.reportId);
  };

  const columns: Column<ReportListItem>[] = [
    {
      key: 'select',
      header: (
        <Checkbox
          checked={allOnPageSelected}
          onCheckedChange={toggleAll}
          aria-label={copy.reports.selectAll}
          disabled={items.length === 0}
        />
      ),
      className: 'w-10 pr-0',
      headerClassName: 'w-10 pr-0',
      cell: (r) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected.has(r.reportId)}
            onCheckedChange={() => toggleOne(r.reportId)}
            aria-label={copy.reports.selectRow(r.reportNo)}
          />
        </span>
      ),
    },
    {
      key: 'date',
      header: copy.reports.columns.date,
      cell: (r) => (
        <span className="whitespace-nowrap font-mono text-data">{formatDateShort(r.date)}</span>
      ),
    },
    {
      key: 'no',
      header: copy.reports.columns.reportNo,
      cell: (r) => (
        <Link
          to={`/reports/${r.reportId}`}
          onClick={(e) => e.stopPropagation()}
          className="whitespace-nowrap font-mono text-data font-semibold text-asphalt underline-offset-4 hover:underline"
        >
          {r.reportNo}
        </Link>
      ),
    },
    {
      key: 'site',
      header: copy.reports.columns.site,
      cell: (r) => (
        <div className="min-w-[160px]">
          <div className="font-medium">{r.siteName}</div>
          {r.managerName ? (
            <div className="text-caption text-dust">{copy.reports.manager(r.managerName)}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'crew',
      header: copy.reports.columns.crew,
      numeric: true,
      cell: (r) => formatCrew(r.crew),
    },
    {
      key: 'hours',
      header: copy.reports.columns.hours,
      numeric: true,
      cell: (r) => formatHoursNum(r.hours),
    },
    {
      key: 'flags',
      header: copy.reports.columns.flags,
      hideBelowMd: true,
      cell: (r) => (
        <span className="inline-flex flex-wrap gap-1">
          {r.flags.map((f) => (
            <Badge key={`${f.kind}-${f.label}`} variant={FLAG_VARIANT[f.kind]} data-flag={f.kind}>
              {f.label}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'status',
      header: copy.reports.columns.status,
      cell: (r) => <StatusChip variant={r.chip.variant} label={r.chip.label} />,
    },
    {
      key: 'pdf',
      header: <span className="sr-only">{copy.reports.columns.pdf}</span>,
      className: 'w-12 pl-0',
      cell: (r) => (
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={copy.reports.downloadPdf(r.reportNo)}
          title={r.pdfPath ? undefined : copy.reports.pdfNotReady}
          onClick={(e) => {
            e.stopPropagation();
            onPdf(r);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <FileDown aria-hidden="true" />
        </Button>
      ),
    },
  ];

  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.pageSize) : 0;
  const packHref = `/weather?${new URLSearchParams({
    ...(filters.siteId ? { site: filters.siteId } : {}),
    month: monthOf(filters.from ?? filters.to ?? new Date().toISOString().slice(0, 10)),
  }).toString()}`;

  return (
    <>
      <PageHeader
        title={copy.reports.title}
        subtitle={copy.reports.subtitle}
        actions={
          <Button
            variant="secondary"
            onClick={onExport}
            loading={pdfZip.isPending}
            data-testid="export-zip"
          >
            <FolderArchive aria-hidden="true" />
            {copy.reports.exportZip}
            {selected.size ? (
              <span className="font-mono text-[12px] opacity-80">{selected.size}</span>
            ) : null}
          </Button>
        }
      />

      <Card className="mb-4 p-4" role="search" aria-label={copy.reports.filterBar}>
        <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_auto_auto_minmax(160px,1fr)] md:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="rf-site">{copy.reports.filters.site}</Label>
            <Select
              value={filters.siteId ?? 'all'}
              onValueChange={(v) => update({ site: v === 'all' ? null : v })}
            >
              <SelectTrigger id="rf-site" dense>
                <SelectValue placeholder={copy.reports.filters.allSites} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.reports.filters.allSites}</SelectItem>
                {(sites.data ?? []).map((s) => (
                  <SelectItem key={s.siteId} value={s.siteId}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-from">{copy.reports.filters.from}</Label>
            <Input
              id="rf-from"
              type="date"
              className="h-10 font-mono"
              value={filters.from ?? ''}
              max={filters.to ?? undefined}
              onChange={(e) => update({ from: e.target.value || null })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-to">{copy.reports.filters.to}</Label>
            <Input
              id="rf-to"
              type="date"
              className="h-10 font-mono"
              value={filters.to ?? ''}
              min={filters.from ?? undefined}
              onChange={(e) => update({ to: e.target.value || null })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-status">{copy.reports.filters.status}</Label>
            <Select
              value={filters.status ?? 'all'}
              onValueChange={(v) => update({ status: v === 'all' ? null : v })}
            >
              <SelectTrigger id="rf-status" dense>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {copy.reports.statuses[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2" role="group" aria-label={copy.reports.toggles}>
            {TOGGLES.map((t) => {
              const on = !!filters[t.filter];
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ [t.key]: on ? null : '1' })}
                  className={cn(
                    'inline-flex h-10 items-center gap-1.5 rounded-chip border px-3 text-caption font-medium transition-colors',
                    on
                      ? 'border-asphalt bg-asphalt text-chalk'
                      : 'border-rebar bg-chalk text-asphalt hover:bg-concrete',
                  )}
                  data-testid={`toggle-${t.key}`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="relative flex-1 lg:max-w-md">
            <label className="sr-only" htmlFor="rf-q">
              {copy.reports.filters.search}
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-dust"
              aria-hidden="true"
            />
            <Input
              id="rf-q"
              type="search"
              className="h-10 pl-10"
              placeholder={copy.reports.filters.search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {activeFilterCount > 0 ? (
            <Button
              variant="subtle"
              size="dense"
              onClick={() => {
                setSearch('');
                setParams(new URLSearchParams(), { replace: true });
                setSelected(new Set());
              }}
            >
              <X aria-hidden="true" />
              {copy.reports.filters.clear}
            </Button>
          ) : null}
        </div>
      </Card>

      <Card>
        {reports.isPending ? (
          <TableSkeleton rows={10} />
        ) : reports.isError || !data ? (
          <ErrorState
            thing={copy.nav.reports.toLowerCase()}
            error={reports.error}
            onRetry={() => void reports.refetch()}
            className="m-5"
          />
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState title={copy.reports.empty} body={copy.reports.emptyHint} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={items}
            rowKey={(r) => r.reportId}
            rowHref={(r) => `/reports/${r.reportId}`}
            rowLabel={(r) => r.reportNo}
            rowTone={(r) => (selected.has(r.reportId) ? 'attention' : 'default')}
            aria-label={copy.reports.title}
            className={cn(reports.isFetching && 'opacity-70')}
          />
        )}
        {data ? (
          <div
            className="flex flex-col gap-3 border-t border-rebar px-5 py-3 text-caption text-dust md:flex-row md:items-center md:justify-between"
            data-testid="reports-footer"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span data-testid="result-count">
                {selected.size
                  ? copy.reports.countSelected(data.total, selected.size)
                  : copy.reports.count(data.total)}
              </span>
              {data.total > 0 ? (
                <span className="font-mono">{copy.reports.showing(from, to, data.total)}</span>
              ) : null}
              {filters.hasWeatherDelay && data.total > 0 ? (
                <Link
                  to={packHref}
                  className="font-medium text-level underline-offset-4 hover:underline"
                  data-testid="build-pack"
                >
                  {copy.reports.buildPack} →
                  <span className="ml-1 font-mono text-[12px] text-dust">
                    {copy.reports.buildPackHint(formatHours(data.weatherHours))}
                  </span>
                </Link>
              ) : null}
            </div>
            <nav className="flex items-center gap-2" aria-label={copy.reports.pagination}>
              <Button
                variant="ghost"
                size="iconDense"
                aria-label={copy.common.previousPage}
                disabled={data.page <= 1}
                onClick={() => update({ page: String(data.page - 1) })}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span className="font-mono">{copy.common.page(data.page, data.pageCount)}</span>
              <Button
                variant="ghost"
                size="iconDense"
                aria-label={copy.common.nextPage}
                disabled={data.page >= data.pageCount}
                onClick={() => update({ page: String(data.page + 1) })}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          </div>
        ) : null}
      </Card>
    </>
  );
}
