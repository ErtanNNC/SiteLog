import { ExternalLink, MessageCircle, Phone, Plus, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  formatDateInTz,
  formatDeadline,
  formatMonthDay,
  formatPhone,
} from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { CalendarMonth } from '@/components/sitelog/CalendarMonth';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { TableCell, TableRow } from '@/components/ui/Table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useSiteDetail } from '@/data/hooks';
import type { CrewRow, SiteDetail } from '@/data/types';
import { formatCrew, formatHoursNum, formatLanguages } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CrewTab } from './CrewTab';
import { PhotosTab } from './PhotosTab';
import { SiteSettingsDrawer } from './SiteSettingsDrawer';
import { WeatherTab } from './WeatherTab';

const TABS = ['reports', 'crew', 'weather', 'photos'] as const;
type Tab = (typeof TABS)[number];

const BADGE_VARIANT: Record<
  CrewRow['badges'][number]['kind'],
  'level' | 'tint' | 'dashed' | 'filed'
> = {
  edited: 'level',
  asked: 'tint',
  unconfirmed: 'dashed',
  confirmed_by_reply: 'filed',
};

/** P5 · Site detail — calendar, latest report, crew today, crew & subs, delay log, photos (§11.4). */
export default function SiteDetailPage() {
  const { siteId = '' } = useParams();
  const source = useDataSource();
  const { currentOrg } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'reports';
  const defaultMonth = formatDateInTz(source.now(), currentOrg?.timezone ?? 'UTC').slice(0, 7);
  const monthParam = params.get('month');
  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : defaultMonth;
  const detail = useSiteDetail(siteId, month);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError || !detail.data)
    return (
      <ErrorState
        thing={copy.nav.sites.toLowerCase()}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );

  const data = detail.data;
  const site = data.site;
  const primary = data.reporters.find((r) => r.isPrimary) ?? data.reporters[0] ?? null;
  const waHref = primary ? `https://wa.me/${primary.phone.replace(/\D/g, '')}` : null;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: copy.siteDetail.breadcrumb, to: '/sites' }, { label: site.name }]}
        title={site.name}
        subtitle={
          <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-dust">
            <span className="font-mono uppercase tracking-[0.08em]">{site.projectCode}</span>
            <span>{copy.siteDetail.deadline(formatDeadline(site.deadline), site.timezone)}</span>
            {primary ? (
              <span className="inline-flex items-center gap-2">
                <Avatar name={primary.name} size="sm" />
                <span className="font-medium text-asphalt">{primary.name}</span>
                <a
                  href={`tel:${primary.phone}`}
                  className="inline-flex items-center gap-1 font-mono text-[12px] hover:text-asphalt"
                >
                  <Phone className="size-3.5" aria-hidden="true" />
                  {formatPhone(primary.phone)}
                </a>
                <span>{copy.siteDetail.speaks(formatLanguages(primary.languages))}</span>
              </span>
            ) : null}
            {site.status === 'paused' && site.pausedAt ? (
              <StatusChip variant="no_work" label={copy.chips.paused} size="sm" />
            ) : null}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
              <Settings2 aria-hidden="true" />
              {copy.siteDetail.siteSettings}
            </Button>
            {/* One orange button: WhatsApp when the site has a manager, else typing the report. */}
            <Button variant={primary && waHref ? 'secondary' : 'primary'} asChild>
              <Link to={`/reports/new?site=${site.id}`}>
                <Plus aria-hidden="true" />
                {copy.reports.newReport}
              </Link>
            </Button>
            {primary && waHref ? (
              <Button variant="primary" asChild title={copy.siteDetail.whatsAppHint}>
                <a href={waHref} target="_blank" rel="noopener noreferrer">
                  <MessageCircle aria-hidden="true" />
                  {copy.siteDetail.message(primary.firstName)}
                  <ExternalLink className="!size-4 opacity-70" aria-hidden="true" />
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setParam('tab', v === 'reports' ? null : v)}>
        <TabsList aria-label={copy.siteDetail.breadcrumb} className="max-w-full overflow-x-auto">
          <TabsTrigger value="reports">{copy.siteDetail.tabs.reports}</TabsTrigger>
          <TabsTrigger value="crew">{copy.siteDetail.tabs.crew}</TabsTrigger>
          <TabsTrigger value="weather">{copy.siteDetail.tabs.weather}</TabsTrigger>
          <TabsTrigger value="photos">
            {copy.siteDetail.tabs.photos}
            <span className="font-mono text-[12px]">{data.photoCount}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="reports">
          <ReportsTab
            data={data}
            month={month}
            onMonthChange={(m) => setParam('month', m === defaultMonth ? null : m)}
            onOpenReport={(id) => void navigate(`/reports/${id}`)}
          />
        </TabsContent>
        <TabsContent value="crew">
          <CrewTab siteId={siteId} timezone={site.timezone} />
        </TabsContent>
        <TabsContent value="weather">
          <WeatherTab siteId={siteId} month={month} timezone={site.timezone} />
        </TabsContent>
        <TabsContent value="photos">
          <PhotosTab photos={data.photos ?? []} timezone={site.timezone} />
        </TabsContent>
      </Tabs>

      <SiteSettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        detail={data}
        orgDeadline={formatDeadline(site.deadline)}
      />
    </>
  );
}

function ReportsTab({
  data,
  month,
  onMonthChange,
  onOpenReport,
}: {
  data: SiteDetail;
  month: string;
  onMonthChange: (month: string) => void;
  onOpenReport: (reportId: string) => void;
}) {
  const latest = data.latest;
  const stats = data.monthStats;
  const crewColumns: Column<CrewRow>[] = [
    {
      key: 'company',
      header: copy.siteDetail.columns.company,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{r.companyName}</span>
          {r.badges.map((b) => (
            <Badge key={b.kind} variant={BADGE_VARIANT[b.kind]}>
              {b.label}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'trade',
      header: copy.siteDetail.columns.trade,
      hideBelowMd: true,
      cell: (r) => (
        <span className="text-caption text-dust">
          {[r.trade, r.area].filter(Boolean).join(' · ') || '—'}
        </span>
      ),
    },
    {
      key: 'workers',
      header: copy.siteDetail.columns.workers,
      numeric: true,
      cell: (r) => formatCrew(r.workers),
    },
    {
      key: 'hours',
      header: copy.siteDetail.columns.hours,
      numeric: true,
      cell: (r) => formatHoursNum(r.hours),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <CalendarMonth month={month} cells={data.cells} onMonthChange={onMonthChange} />
        <aside className="space-y-4" aria-label={copy.siteDetail.thisMonth}>
          <Card dark data-testid="latest-card">
            <CardContent className="p-5">
              {latest ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="eyebrow text-dust-light">
                      {copy.siteDetail.latest(formatMonthDay(latest.date))}
                    </div>
                    <StatusChip variant={latest.chip.variant} label={latest.chip.label} size="sm" />
                  </div>
                  <p className="mt-3 line-clamp-5 text-[15px] leading-[22px] text-chalk">
                    {latest.summary || copy.report.summaryEmpty}
                  </p>
                  <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-iron pt-4">
                    <Trio label={copy.siteDetail.trio.crew} value={formatCrew(latest.crew)} />
                    <Trio label={copy.siteDetail.trio.hours} value={formatHoursNum(latest.hours)} />
                    <Trio
                      label={copy.siteDetail.trio.weatherHours}
                      value={formatHoursNum(latest.weatherHours)}
                      signal={latest.weatherHours > 0}
                    />
                  </dl>
                  <Button
                    variant="primary"
                    className="mt-4 w-full"
                    onClick={() => onOpenReport(latest.reportId)}
                  >
                    {copy.siteDetail.openReport}
                  </Button>
                </>
              ) : (
                <p className="text-[15px] text-dust-light">{copy.siteDetail.latestEmpty}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pt-4">
              <CardTitle className="text-[17px]">{copy.siteDetail.thisMonth}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Stat
                  label={copy.siteDetail.stats.reports}
                  value={stats.reports}
                  hint={copy.siteDetail.stats.reportsOf(stats.reports, stats.workdaysSoFar)}
                />
                <Stat label={copy.siteDetail.stats.onTime} value={stats.onTime} />
                <Stat
                  label={copy.siteDetail.stats.weatherHours}
                  value={formatHoursNum(stats.weatherHours)}
                  signal={stats.weatherHours > 0}
                />
                <Stat
                  label={copy.siteDetail.stats.laborHours}
                  value={formatHoursNum(stats.laborHours)}
                />
                <Stat label={copy.siteDetail.stats.avgCrew} value={formatCrew(stats.avgCrew)} />
              </dl>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{copy.siteDetail.crewToday}</CardTitle>
          {data.crewToday ? (
            <span className="eyebrow text-dust">{formatMonthDay(data.crewToday.date)}</span>
          ) : null}
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          {data.crewToday && data.crewToday.rows.length ? (
            <DataTable
              columns={crewColumns}
              rows={data.crewToday.rows}
              rowKey={(r) => `${r.companyId ?? 'heard'}-${r.companyName}`}
              aria-label={copy.siteDetail.crewToday}
              footer={
                <TableRow>
                  <TableCell className="font-semibold">{copy.common.total}</TableCell>
                  <TableCell className="hidden md:table-cell" />
                  <TableCell numeric>{formatCrew(data.crewToday.totalWorkers)}</TableCell>
                  <TableCell numeric>{formatHoursNum(data.crewToday.totalHours)}</TableCell>
                </TableRow>
              }
            />
          ) : (
            <div className="px-5 pb-3">
              <EmptyState title={copy.siteDetail.crewTodayEmpty} />
            </div>
          )}
        </CardContent>
      </Card>
      {data.latest ? (
        <p className="text-caption text-dust">
          <Link to={`/reports?site=${data.site.id}`} className="text-level hover:underline">
            {copy.common.viewAll} →
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function Trio({ label, value, signal }: { label: string; value: string; signal?: boolean }) {
  return (
    <div>
      <dt className="eyebrow text-dust-light">{label}</dt>
      <dd className={cn('font-display text-[24px] leading-7 tabular', signal && 'text-signal')}>
        {value}
      </dd>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  signal,
}: {
  label: string;
  value: string | number;
  hint?: string;
  signal?: boolean;
}) {
  return (
    <div>
      <dt className="eyebrow text-dust">{label}</dt>
      <dd
        className={cn('font-display text-[22px] leading-7 tabular', signal && 'text-signal-deep')}
      >
        {value}
      </dd>
      {hint ? <dd className="text-[12px] text-dust">{hint}</dd> : null}
    </div>
  );
}
