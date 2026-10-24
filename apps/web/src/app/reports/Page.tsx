import { ChevronLeft, ChevronRight, FileDown, FolderArchive, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { formatDate, formatDateInTz, formatHoursIn } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
import { ChannelIcon } from '@/components/sitelog/ChannelIcon';
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
import {
  useOpenReportPdf,
  usePdfZipExport,
  useReportPdf,
  useReports,
  useSites,
} from '@/data/hooks';
import type {
  ReportChannel,
  ReportFilters,
  ReportFlag,
  ReportListItem,
  ReportStatusFilter,
} from '@/data/types';
import { useLooseCopy, type LooseT } from '@/i18n/useLooseCopy';
import { formatCrew, formatHoursNum, monthOf } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUSES: ReportStatusFilter[] = [
  'all',
  'filed',
  'needs_review',
  'signed_off',
  'weather_day',
];
const CHANNELS: ReportChannel[] = ['link', 'call'];
const TOGGLES = [
  { key: 'wx', filter: 'hasWeatherDelay', label: 'reports.filters.weatherDelay' },
  { key: 'edited', filter: 'edited', label: 'reports.filters.edited' },
  { key: 'late', filter: 'late', label: 'reports.filters.late' },
  { key: 'incident', filter: 'incident', label: 'reports.filters.incident' },
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
  no_photo: 'dashed',
};

/** A flag's words in the panel's language (P6). */
function flagLabel(f: ReportFlag, t: LooseT, language: string): string {
  switch (f.kind) {
    case 'rain':
      return t('reports.flags.rain', {
        hours: formatHoursIn(f.hours ?? 0, language === 'tr' ? 'tr-TR' : 'en-US'),
      });
    case 'version':
      return t('reports.flags.version', { version: f.version ?? 1 });
    case 'late':
      return t('reports.flags.late', { time: f.time ?? '' }).trim();
    case 'unknown_sub':
      return t('reports.flags.unknownSub');
    case 'weather_day':
      return t('reports.flags.weatherDay');
    case 'no_photo':
      return t('reports.flags.noPhoto');
    case 'incident':
      return t('reports.flags.incident');
  }
}

/** URL search params → DataSource filters (the URL is the single source of truth). */
function filtersFrom(params: URLSearchParams): ReportFilters {
  const status = params.get('status') as ReportStatusFilter | null;
  const page = Number(params.get('page') ?? '1');
  const channel = params.get('channel') as ReportChannel | null;
  return {
    siteId: params.get('site') || null,
    from: params.get('from') || null,
    to: params.get('to') || null,
    status: status && STATUSES.includes(status) ? status : 'all',
    hasWeatherDelay: params.get('wx') === '1',
    edited: params.get('edited') === '1',
    late: params.get('late') === '1',
    incident: params.get('incident') === '1',
    channel: channel && CHANNELS.includes(channel) ? channel : null,
    q: params.get('q') ?? '',
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function withoutPage(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete('page');
  return next.toString();
}

/** P6 · Reports archive — filters in the URL, 50 per page from the DataSource (§11.4). */
export default function ReportsPage() {
  const { isDemo, currentOrg, role } = useAuth();
  const { tx: t, language } = useLooseCopy();
  const source = useDataSource();
  const pdfZip = usePdfZipExport();
  const openPdf = useOpenReportPdf();
  const reportPdf = useReportPdf();
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
    const timer = setTimeout(() => {
      if ((filters.q ?? '') !== search) update({ q: search || null, page: null });
    }, 250);
    return () => clearTimeout(timer);
  }, [search, filters.q, update]);

  const activeFilterCount =
    (filters.siteId ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0) +
    (filters.status !== 'all' ? 1 : 0) +
    (filters.channel ? 1 : 0) +
    TOGGLES.filter((toggle) => filters[toggle.filter]).length +
    (filters.q ? 1 : 0);

  const data = reports.data;
  const items = data?.items ?? [];
  // A page past the last one (a stale or typed link, or the set shrank) goes back to page 1.
  const pastEnd = !!data && data.page > data.pageCount;
  const noSites = sites.data?.length === 0;
  // Sites are added in the setup wizard, which is admin-only (RLS: sites_admin_insert).
  const canAddSite = canAccess(role, ROUTE_ROLES.setup!);
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
      toast.message(t('reports.exportDemo', { count: n }));
      return;
    }
    if (!n) {
      toast.message(t('reports.exportNone'));
      return;
    }
    pdfZip.mutate({
      selection: selected.size
        ? { reportIds: [...selected] }
        : { filters: { ...filters, page: 1 } },
      fileName: copy.pdfZip.fileName(
        t('pdfZip.labels.archive'),
        formatDateInTz(source.now(), currentOrg?.timezone ?? 'UTC'),
      ),
    });
  };

  // A stored PDF opens by its signed URL. A report without one (typed in the panel, a failed
  // upload, no worker yet) is rendered here and stored, as the report page does; so is every
  // report in the demo, which has no stored files.
  const onPdf = (r: ReportListItem) => {
    if (r.pdfPath && !isDemo) openPdf.open(r.reportId);
    else reportPdf.open(r.reportId, null);
  };

  const columns: Column<ReportListItem>[] = [
    {
      key: 'select',
      header: (
        <Checkbox
          checked={allOnPageSelected}
          onCheckedChange={toggleAll}
          aria-label={t('reports.selectAll')}
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
            aria-label={t('reports.selectRow', { no: r.reportNo })}
          />
        </span>
      ),
    },
    {
      key: 'date',
      header: t('reports.columns.date'),
      cell: (r) => (
        <span className="whitespace-nowrap font-mono text-data">
          {formatDate(r.date, 'monthDay', language)}
        </span>
      ),
    },
    {
      key: 'no',
      header: t('reports.columns.reportNo'),
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
      header: t('reports.columns.site'),
      cell: (r) => (
        <div className="min-w-[160px]">
          <div className="font-medium">{r.siteName}</div>
          {r.managerName ? (
            <div className="text-caption text-dust">
              {t('reports.manager', { name: r.managerName })}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'crew',
      header: t('reports.columns.crew'),
      numeric: true,
      cell: (r) => formatCrew(r.crew),
    },
    {
      key: 'hours',
      header: t('reports.columns.hours'),
      numeric: true,
      cell: (r) => formatHoursNum(r.hours),
    },
    {
      key: 'flags',
      header: t('reports.columns.flags'),
      hideBelowMd: true,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          {r.channel ? (
            <ChannelIcon channel={r.channel} showLabel={false} className="mr-0.5" />
          ) : null}
          {r.flags.map((f) => (
            <Badge key={f.kind} variant={FLAG_VARIANT[f.kind]} data-flag={f.kind}>
              {flagLabel(f, t, language)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('reports.columns.status'),
      cell: (r) => <StatusChip variant={r.chip.variant} />,
    },
    {
      key: 'pdf',
      header: <span className="sr-only">{t('reports.columns.pdf')}</span>,
      className: 'w-12 pl-0',
      cell: (r) => (
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={t('reports.downloadPdf', { no: r.reportNo })}
          title={r.pdfPath ? undefined : t('reports.pdfNotStored')}
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
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={onExport}
              loading={pdfZip.isPending}
              data-testid="export-zip"
            >
              <FolderArchive aria-hidden="true" />
              {t('reports.exportZip')}
              {selected.size ? (
                <span className="font-mono text-[12px] opacity-80">{selected.size}</span>
              ) : null}
            </Button>
            <Button asChild data-testid="new-report">
              <Link to="/reports/new">
                <Plus aria-hidden="true" />
                {t('reports.newReport')}
              </Link>
            </Button>
          </>
        }
      />

      <Card className="mb-4 p-4" role="search" aria-label={t('reports.filterBar')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_auto_auto_minmax(150px,1fr)_minmax(130px,0.7fr)] lg:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="rf-site">{t('reports.filters.site')}</Label>
            <Select
              value={filters.siteId ?? 'all'}
              onValueChange={(v) => update({ site: v === 'all' ? null : v })}
            >
              <SelectTrigger id="rf-site" dense>
                <SelectValue placeholder={t('reports.filters.allSites')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('reports.filters.allSites')}</SelectItem>
                {(sites.data ?? []).map((s) => (
                  <SelectItem key={s.siteId} value={s.siteId}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-from">{t('reports.filters.from')}</Label>
            <Input
              id="rf-from"
              type="date"
              className="h-target-dense font-mono"
              value={filters.from ?? ''}
              max={filters.to ?? undefined}
              onChange={(e) => update({ from: e.target.value || null })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-to">{t('reports.filters.to')}</Label>
            <Input
              id="rf-to"
              type="date"
              className="h-target-dense font-mono"
              value={filters.to ?? ''}
              min={filters.from ?? undefined}
              onChange={(e) => update({ to: e.target.value || null })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-status">{t('reports.filters.status')}</Label>
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
                    {t(`reports.statuses.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-channel">{t('reports.filters.channel')}</Label>
            <Select
              value={filters.channel ?? 'any'}
              onValueChange={(v) => update({ channel: v === 'any' ? null : v })}
            >
              <SelectTrigger id="rf-channel" dense data-testid="channel-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">{t('reports.channels.any')}</SelectItem>
                {CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`reports.channels.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('reports.toggles')}>
            {TOGGLES.map((toggle) => {
              const on = !!filters[toggle.filter];
              return (
                <button
                  key={toggle.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ [toggle.key]: on ? null : '1' })}
                  className={cn(
                    'inline-flex h-target-dense items-center gap-1.5 rounded-chip border px-3 text-caption font-medium transition-colors',
                    on
                      ? 'border-asphalt bg-asphalt text-chalk'
                      : 'border-rebar bg-chalk text-asphalt hover:bg-concrete',
                  )}
                  data-testid={`toggle-${toggle.key}`}
                >
                  {t(toggle.label)}
                </button>
              );
            })}
          </div>
          <div className="relative flex-1 lg:max-w-md">
            <label className="sr-only" htmlFor="rf-q">
              {t('reports.filters.search')}
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-dust"
              aria-hidden="true"
            />
            <Input
              id="rf-q"
              type="search"
              className="h-target-dense pl-10"
              placeholder={t('reports.filters.search')}
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
              {t('reports.filters.clear')}
            </Button>
          ) : null}
        </div>
      </Card>

      <Card>
        {reports.isPending ? (
          <TableSkeleton rows={10} />
        ) : pastEnd ? (
          <>
            <Navigate to={{ search: withoutPage(params) }} replace />
            <TableSkeleton rows={10} />
          </>
        ) : reports.isError || !data ? (
          <ErrorState
            thing={t('reports.thing')}
            error={reports.error}
            onRetry={() => void reports.refetch()}
            className="m-5"
          />
        ) : items.length === 0 ? (
          <div className="p-5">
            {activeFilterCount === 0 ? (
              // Nothing filed yet: no filter to widen, so say what to do instead.
              <EmptyState
                title={t('reports.emptyNone')}
                body={
                  !noSites
                    ? t('reports.emptyNoneBody')
                    : canAddSite
                      ? t('reports.emptyNoSitesBody')
                      : t('reports.emptyNoSitesAskAdmin')
                }
                action={
                  noSites ? (
                    canAddSite ? (
                      <Button asChild>
                        <Link to="/setup/site">{t('reports.connectFirstSite')}</Link>
                      </Button>
                    ) : null
                  ) : (
                    <Button asChild>
                      <Link to="/reports/new">
                        <Plus aria-hidden="true" />
                        {t('reports.newReport')}
                      </Link>
                    </Button>
                  )
                }
              />
            ) : (
              <EmptyState title={t('reports.empty')} body={t('reports.emptyHint')} />
            )}
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={items}
            rowKey={(r) => r.reportId}
            rowHref={(r) => `/reports/${r.reportId}`}
            rowTone={(r) => (selected.has(r.reportId) ? 'attention' : 'default')}
            aria-label={t('reports.title')}
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
                  ? t('reports.countSelected', { count: data.total, selected: selected.size })
                  : t('reports.count', { count: data.total })}
              </span>
              {data.total > 0 ? (
                <span className="font-mono">
                  {t('reports.showing', { from, to, total: data.total })}
                </span>
              ) : null}
              {filters.hasWeatherDelay && data.total > 0 ? (
                <Link
                  to={packHref}
                  className="font-medium text-level underline-offset-4 hover:underline"
                  data-testid="build-pack"
                >
                  {t('reports.buildPack')} →
                  <span className="ml-1 font-mono text-[12px] text-dust">
                    {t('reports.buildPackHint', {
                      hours: formatHoursIn(
                        data.weatherHours,
                        language === 'tr' ? 'tr-TR' : 'en-US',
                      ),
                    })}
                  </span>
                </Link>
              ) : null}
            </div>
            <nav className="flex items-center gap-2" aria-label={t('reports.pagination')}>
              <Button
                variant="ghost"
                size="iconDense"
                aria-label={t('reports.previousPage')}
                disabled={data.page <= 1}
                onClick={() => update({ page: String(data.page - 1) })}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span className="font-mono">
                {t('reports.page', { page: data.page, total: data.pageCount })}
              </span>
              <Button
                variant="ghost"
                size="iconDense"
                aria-label={t('reports.nextPage')}
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
