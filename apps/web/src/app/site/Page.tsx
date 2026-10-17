import { Link2, MessageSquareText, Phone, Plus, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { formatDate, formatDateInTz, formatDeadline, formatPhone } from '@sitelog/shared/format.ts';
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
import { useDataSource } from '@/data/DataProvider';
import { useSiteDetail, useTextDailyLink } from '@/data/hooks';
import type { CrewBadge, CrewRow, SiteDetail } from '@/data/types';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import { formatNumberIn, joinLanguageCodes, zoneShortName } from '@/lib/localeFormat';
import { cn } from '@/lib/utils';
import { CrewTab } from './CrewTab';
import { PhotosTab } from './PhotosTab';
import { SiteSettingsDrawer } from './SiteSettingsDrawer';
import { WeatherTab } from './WeatherTab';

const TABS = ['reports', 'crew', 'weather', 'photos'] as const;
type Tab = (typeof TABS)[number];

const BADGE_VARIANT: Record<CrewBadge['kind'], 'level' | 'tint' | 'dashed' | 'filed'> = {
  edited: 'level',
  asked: 'tint',
  unconfirmed: 'dashed',
  confirmed_by_answer: 'filed',
};

/** P5 badges in the panel's language ("CONFIRMED BY ANSWER", "EDITED V2"). */
function crewBadgeLabel(t: CopyT, badge: CrewBadge): string {
  switch (badge.kind) {
    case 'edited':
      return t('siteDetail.badges.edited', { version: badge.version });
    case 'asked':
      return t('siteDetail.badges.asked', { time: badge.time });
    case 'confirmed_by_answer':
      return t('siteDetail.badges.confirmedByAnswer');
    case 'unconfirmed':
      return t('siteDetail.badges.unconfirmed');
  }
}

/**
 * P5 · Site detail — calendar, latest report, crew today, crew & subs, delay log, photos (§11.4),
 * in the panel's language (W1-18).
 */
export default function SiteDetailPage() {
  const { siteId = '' } = useParams();
  const { t, language } = useCopy();
  const source = useDataSource();
  const { currentOrg, role } = useAuth();
  // Site settings (edit, recipients, Pause) are admin only, as RLS (sites_admin_update,
  // site_recipients: admin; W4-10 closes docs/AUDIT_BACKLOG.md "Site settings drawer … open to
  // pm/ops").
  const canEditSite = role === 'admin';
  const navigate = useNavigate();
  const textLink = useTextDailyLink();
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
        thing={t('nav.sites').toLocaleLowerCase(language)}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );

  const data = detail.data;
  const site = data.site;
  const primary = data.reporters.find((r) => r.isPrimary) ?? data.reporters[0] ?? null;
  const zone = zoneShortName(site.timezone, language, source.now());
  const speaks = primary?.languages.length
    ? t('siteDetail.speaks', {
        languages: joinLanguageCodes(primary.languages, (first, last) =>
          t('siteDetail.languagesAnd', { first, last }),
        ),
      })
    : null;
  const PrefIcon = primary?.contactPref === 'call' ? Phone : Link2;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: t('siteDetail.breadcrumb'), to: '/sites' }, { label: site.name }]}
        title={site.name}
        subtitle={
          <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-dust">
            <span className="font-mono uppercase tracking-[0.08em]">{site.projectCode}</span>
            <span>{t('siteDetail.deadline', { time: formatDeadline(site.deadline), zone })}</span>
            {primary ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Avatar name={primary.name} size="sm" />
                <span className="font-medium text-asphalt">{primary.name}</span>
                <span aria-hidden="true">·</span>
                <a
                  href={`tel:${primary.phone}`}
                  className="inline-flex min-h-6 items-center font-mono text-[12px] hover:text-asphalt"
                >
                  {formatPhone(primary.phone)}
                </a>
              </span>
            ) : null}
            {primary ? (
              <span className="inline-flex items-center gap-1.5" data-testid="contact-pref">
                <PrefIcon className="size-4" aria-hidden="true" />
                {[t(`sites.prefers.${primary.contactPref}`), speaks].filter(Boolean).join(' · ')}
              </span>
            ) : null}
            {site.status === 'paused' && site.pausedAt ? (
              <StatusChip variant="no_work" label={t('sites.paused')} size="sm" />
            ) : null}
          </span>
        }
        actions={
          <>
            {canEditSite ? (
              <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
                <Settings2 aria-hidden="true" />
                {t('siteDetail.siteSettings')}
              </Button>
            ) : null}
            {/* D30: typed reports stay; orange only while nobody reports from the site. */}
            <Button variant={primary ? 'ghost' : 'primary'} asChild>
              <Link to={`/reports/new?site=${site.id}`}>
                <Plus aria-hidden="true" />
                {t('siteDetail.newReport')}
              </Link>
            </Button>
            {/* P5 (W1-16's action, api-text-daily-link): today's link to the site manager. */}
            {primary && site.status === 'active' ? (
              <Button
                variant="secondary"
                loading={textLink.isPending}
                data-testid="text-link"
                onClick={() => textLink.mutate({ siteId: site.id, first: primary.firstName })}
              >
                <MessageSquareText aria-hidden="true" />
                {t('siteDetail.textLink')}
              </Button>
            ) : null}
            {primary ? (
              <Button
                variant="secondary"
                asChild
                title={t('siteDetail.callHint', { phone: formatPhone(primary.phone) })}
              >
                <a href={`tel:${primary.phone}`}>
                  <Phone aria-hidden="true" />
                  {t('siteDetail.call', { first: primary.firstName })}
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setParam('tab', v === 'reports' ? null : v)}>
        <TabsList aria-label={t('siteDetail.sectionsLabel')} className="max-w-full overflow-x-auto">
          <TabsTrigger value="reports">{t('siteDetail.tabs.reports')}</TabsTrigger>
          <TabsTrigger value="crew">{t('siteDetail.tabs.crew')}</TabsTrigger>
          <TabsTrigger value="weather">{t('siteDetail.tabs.weather')}</TabsTrigger>
          <TabsTrigger value="photos">
            {t('siteDetail.tabs.photos')}
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

      {canEditSite ? (
        <SiteSettingsDrawer
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          detail={data}
          orgDeadline={formatDeadline(site.deadline)}
        />
      ) : null}
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
  const { t, language } = useCopy();
  const num = (n: number | null | undefined) => formatNumberIn(n, language);
  const latest = data.latest;
  const stats = data.monthStats;
  const crewColumns: Column<CrewRow>[] = [
    {
      key: 'company',
      header: t('siteDetail.columns.company'),
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{r.companyName}</span>
          {r.badges.map((b) => (
            <Badge key={b.kind} variant={BADGE_VARIANT[b.kind]}>
              {crewBadgeLabel(t, b)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'trade',
      header: t('siteDetail.columns.trade'),
      hideBelowMd: true,
      cell: (r) => (
        <span className="text-caption text-dust">
          {[r.trade, r.area].filter(Boolean).join(' · ') || '—'}
        </span>
      ),
    },
    {
      key: 'workers',
      header: t('siteDetail.columns.workers'),
      numeric: true,
      cell: (r) => num(r.workers),
    },
    {
      key: 'hours',
      header: t('siteDetail.columns.hours'),
      numeric: true,
      cell: (r) => num(r.hours),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <CalendarMonth month={month} cells={data.cells} onMonthChange={onMonthChange} />
        <aside className="space-y-4" aria-label={t('siteDetail.thisMonth')}>
          <Card dark data-testid="latest-card">
            <CardContent className="p-5">
              {latest ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="eyebrow text-dust-light">
                      {t('siteDetail.latest', {
                        date: formatDate(latest.date, 'monthDay', language),
                      })}
                    </div>
                    <StatusChip variant={latest.chip.variant} size="sm" />
                  </div>
                  <p className="mt-3 line-clamp-5 text-[15px] leading-[22px] text-chalk">
                    {latest.summary || t('siteDetail.summaryEmpty')}
                  </p>
                  <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-iron pt-4">
                    <Trio label={t('siteDetail.trio.crew')} value={num(latest.crew)} />
                    <Trio label={t('siteDetail.trio.hours')} value={num(latest.hours)} />
                    <Trio
                      label={t('siteDetail.trio.weatherHours')}
                      value={num(latest.weatherHours)}
                      signal={latest.weatherHours > 0}
                    />
                  </dl>
                  <Button
                    variant="primary"
                    className="mt-4 w-full"
                    onClick={() => onOpenReport(latest.reportId)}
                  >
                    {t('siteDetail.openReport')}
                  </Button>
                </>
              ) : (
                <p className="text-[15px] text-dust-light">{t('siteDetail.latestEmpty')}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pt-4">
              <CardTitle className="text-[17px]">{t('siteDetail.thisMonth')}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Stat
                  label={t('siteDetail.stats.reports')}
                  value={stats.reports}
                  hint={t('siteDetail.stats.reportsOf', {
                    count: stats.reports,
                    workdays: stats.workdaysSoFar,
                  })}
                />
                <Stat label={t('siteDetail.stats.onTime')} value={stats.onTime} />
                <Stat
                  label={t('siteDetail.stats.weatherHours')}
                  value={num(stats.weatherHours)}
                  signal={stats.weatherHours > 0}
                />
                <Stat label={t('siteDetail.stats.laborHours')} value={num(stats.laborHours)} />
                <Stat label={t('siteDetail.stats.avgCrew')} value={num(stats.avgCrew)} />
              </dl>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('siteDetail.crewToday')}</CardTitle>
          {data.crewToday ? (
            <span className="eyebrow text-dust">
              {formatDate(data.crewToday.date, 'monthDay', language)}
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          {data.crewToday && data.crewToday.rows.length ? (
            <DataTable
              columns={crewColumns}
              rows={data.crewToday.rows}
              rowKey={(r) => `${r.companyId ?? 'heard'}-${r.companyName}`}
              aria-label={t('siteDetail.crewToday')}
              footer={
                <TableRow>
                  <TableCell className="font-semibold">{t('siteDetail.total')}</TableCell>
                  <TableCell className="hidden md:table-cell" />
                  <TableCell numeric>{num(data.crewToday.totalWorkers)}</TableCell>
                  <TableCell numeric>{num(data.crewToday.totalHours)}</TableCell>
                </TableRow>
              }
            />
          ) : (
            <div className="px-5 pb-3">
              <EmptyState title={t('siteDetail.crewTodayEmpty')} />
            </div>
          )}
        </CardContent>
      </Card>
      {data.latest ? (
        <p className="text-caption text-dust">
          <Link to={`/reports?site=${data.site.id}`} className="text-level hover:underline">
            {t('siteDetail.viewAll')} →
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
