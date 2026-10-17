import { HardHat, Link2, Phone, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  formatDate,
  formatDateInTz,
  formatMonthShortIn,
  formatPhone,
} from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { CardsSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { StreakBar, StreakLegend } from '@/components/sitelog/StreakBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useDataSource } from '@/data/DataProvider';
import { useSites } from '@/data/hooks';
import type { SiteCard } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { sitePriceFor } from './price';

type Tab = 'all' | 'attention' | 'paused';

/** P4 · Sites — cards grid with 14-workday streaks (§11.4), in the panel's language (W1-18). */
export default function SitesPage() {
  const sites = useSites();
  const { t, language } = useCopy();
  const { role, currentOrg } = useAuth();
  const price = sitePriceFor(currentOrg?.price, language);
  // Sites are added in the setup wizard, which is admin-only (RLS: sites_admin_insert).
  const canAddSite = canAccess(role, ROUTE_ROLES.setup!);
  const [tab, setTab] = useState<Tab>('all');
  const all = sites.data ?? [];
  const active = all.filter((s) => s.status === 'active');
  const visible =
    tab === 'attention'
      ? all.filter((s) => s.needsAttention)
      : tab === 'paused'
        ? all.filter((s) => s.status === 'paused')
        : all;

  return (
    <>
      <PageHeader
        title={t('sites.title')}
        subtitle={t('sites.subtitle', { count: active.length })}
        actions={
          canAddSite ? (
            <Button variant="primary" asChild>
              <Link to="/setup/site">
                <Plus aria-hidden="true" />
                {t('sites.addSite')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      {/* The filter tabs control the card grid below, which is their tab panel. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <TabsList aria-label={t('sites.filterLabel')}>
            <TabsTrigger value="all">{t('sites.tabs.all')}</TabsTrigger>
            <TabsTrigger value="attention">
              {t('sites.tabs.attention')}
              {all.some((s) => s.needsAttention) ? (
                <span className="font-mono text-[12px]">
                  {all.filter((s) => s.needsAttention).length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="paused">{t('sites.tabs.paused')}</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-3 text-caption text-dust">
            <span className="eyebrow">{t('sites.legend')}</span>
            <StreakLegend />
          </div>
        </div>

        <TabsContent value={tab} className="mt-0">
          {sites.isPending ? (
            <CardsSkeleton />
          ) : sites.isError ? (
            <ErrorState
              thing={t('nav.sites').toLocaleLowerCase(language)}
              error={sites.error}
              onRetry={() => void sites.refetch()}
            />
          ) : all.length === 0 && tab === 'all' ? (
            // A new org: "Connect another site" is the last card of a populated grid (§11.4).
            <EmptyState
              hero
              icon={HardHat}
              title={t('sites.empty')}
              body={canAddSite ? t('sites.emptyBody') : t('sites.emptyBodyAskAdmin')}
              action={
                canAddSite ? (
                  <Button variant="primary" asChild>
                    <Link to="/setup/site">{t('sites.connectFirstSite')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : visible.length === 0 && tab !== 'all' ? (
            <EmptyState
              title={tab === 'attention' ? t('sites.emptyAttention') : t('sites.emptyPaused')}
            />
          ) : (
            <ul
              className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(330px,1fr))]"
              aria-label={t('sites.title')}
            >
              {visible.map((s) => (
                <li key={s.siteId}>
                  <SiteCardView site={s} />
                </li>
              ))}
              {tab === 'all' && canAddSite ? (
                <li>
                  <Link
                    to="/setup/site"
                    className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-card border border-dashed border-iron bg-transparent p-6 text-center hover:border-asphalt hover:bg-chalk/60"
                    data-testid="connect-site-card"
                  >
                    <span className="flex size-11 items-center justify-center rounded-full bg-signal text-asphalt">
                      <Plus aria-hidden="true" className="size-6" />
                    </span>
                    <span className="font-h2 mt-3 text-h2">{t('sites.connectAnother')}</span>
                    {price ? (
                      <span className="mt-1 font-mono text-[12px] uppercase tracking-[0.08em] text-dust">
                        {t('sites.connectAnotherPrice', { price })}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ) : null}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function SiteCardView({ site }: { site: SiteCard }) {
  const { t, language } = useCopy();
  const source = useDataSource();
  const month = formatMonthShortIn(
    formatDateInTz(source.now(), site.timezone).slice(0, 7),
    language,
  );
  const PrefIcon = site.reporterContactPref === 'call' ? Phone : Link2;
  return (
    <Card
      className={cn('flex h-full flex-col', site.needsAttention && 'border-missing/60')}
      aria-label={t('sites.cardLabel', { name: site.name })}
      data-testid="site-card"
      data-attention={site.needsAttention || undefined}
    >
      <div className="flex items-start justify-between gap-3 p-5 pb-3">
        <div className="min-w-0">
          <Link
            to={`/sites/${site.siteId}`}
            className="font-h2 block text-h2 leading-6 underline-offset-4 hover:underline"
            aria-label={t('sites.openSite', { name: site.name })}
          >
            {site.name}
          </Link>
          <div className="font-mono text-[12px] uppercase tracking-[0.08em] text-dust">
            {site.projectCode}
          </div>
        </div>
        {site.status === 'paused' ? (
          <StatusChip variant="no_work" label={t('sites.paused')} />
        ) : site.reportId ? (
          <Link to={`/reports/${site.reportId}`} className="shrink-0 rounded-chip">
            <StatusChip variant={site.chip.variant} />
          </Link>
        ) : (
          <StatusChip variant={site.chip.variant} />
        )}
      </div>
      <div className="px-5 pb-4">
        <div className="mb-2 text-caption text-dust">
          {site.status === 'paused' && site.pausedAt
            ? t('sites.pausedSince', {
                date: formatDate(site.pausedAt.slice(0, 10), 'monthDay', language),
              })
            : t('sites.lastWorkdays', { onTime: site.onTime14 })}
        </div>
        <StreakBar cells={site.streak} />
      </div>
      <div className="mt-auto flex items-start justify-between gap-3 border-t border-rebar px-5 py-3 text-caption">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-semibold text-asphalt">{site.reporterName ?? '—'}</span>
            {site.reporterContactPref ? (
              <span
                className="inline-flex shrink-0 text-dust"
                title={t(`sites.prefers.${site.reporterContactPref}`)}
                data-testid="contact-pref"
                data-pref={site.reporterContactPref}
              >
                <PrefIcon className="size-4" aria-hidden="true" />
                <span className="sr-only">{t(`sites.prefers.${site.reporterContactPref}`)}</span>
              </span>
            ) : null}
          </div>
          {site.reporterPhone ? (
            <a
              href={`tel:${site.reporterPhone}`}
              className="inline-flex min-h-6 items-center font-mono text-[12px] text-dust hover:text-asphalt"
            >
              {formatPhone(site.reporterPhone)}
            </a>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-semibold text-asphalt tabular">
            {site.crewToday === null
              ? t('sites.crewTodayNone')
              : t('sites.crewToday', { count: site.crewToday })}
          </div>
          <div className="text-[12px] text-dust">
            {site.weatherDaysMonth === 0
              ? t('sites.weatherDaysNone', { month })
              : t('sites.weatherDays', { count: site.weatherDaysMonth, month })}
          </div>
        </div>
      </div>
    </Card>
  );
}
