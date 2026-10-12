import { CloudRain, Phone, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatMonthDay, formatPhone } from '@sitelog/shared/format.ts';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { CardsSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { StreakBar, StreakLegend } from '@/components/sitelog/StreakBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { copy } from '@/copy/en';
import { useSites } from '@/data/hooks';
import type { SiteCard } from '@/data/types';
import { formatCrew } from '@/lib/format';
import { cn } from '@/lib/utils';

type Tab = 'all' | 'attention' | 'paused';

/** P4 · Sites — cards grid with 14-workday streaks (§11.4). */
export default function SitesPage() {
  const sites = useSites();
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
        title={copy.sites.title}
        subtitle={copy.sites.subtitle(active.length)}
        actions={
          <Button variant="primary" asChild>
            <Link to="/setup/site">
              <Plus aria-hidden="true" />
              {copy.sites.addSite}
            </Link>
          </Button>
        }
      />
      {/* The filter tabs control the card grid below, which is their tab panel. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <TabsList aria-label={copy.common.filter}>
            <TabsTrigger value="all">{copy.sites.tabs.all}</TabsTrigger>
            <TabsTrigger value="attention">
              {copy.sites.tabs.attention}
              {all.some((s) => s.needsAttention) ? (
                <span className="font-mono text-[12px]">
                  {all.filter((s) => s.needsAttention).length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="paused">{copy.sites.tabs.paused}</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-3 text-caption text-dust">
            <span className="eyebrow">{copy.sites.legend}</span>
            <StreakLegend />
          </div>
        </div>

        <TabsContent value={tab} className="mt-0">
          {sites.isPending ? (
            <CardsSkeleton />
          ) : sites.isError ? (
            <ErrorState
              thing={copy.nav.sites.toLowerCase()}
              error={sites.error}
              onRetry={() => void sites.refetch()}
            />
          ) : visible.length === 0 && tab !== 'all' ? (
            <EmptyState
              title={tab === 'attention' ? copy.sites.emptyAttention : copy.sites.emptyPaused}
            />
          ) : (
            <ul
              className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(330px,1fr))]"
              aria-label={copy.sites.title}
            >
              {visible.map((s) => (
                <li key={s.siteId}>
                  <SiteCardView site={s} />
                </li>
              ))}
              {tab === 'all' ? (
                <li>
                  <Link
                    to="/setup/site"
                    className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-card border border-dashed border-iron bg-transparent p-6 text-center hover:border-asphalt hover:bg-chalk/60"
                    data-testid="connect-site-card"
                  >
                    <span className="flex size-11 items-center justify-center rounded-full bg-signal text-asphalt">
                      <Plus aria-hidden="true" className="size-6" />
                    </span>
                    <span className="font-h2 mt-3 text-h2">{copy.sites.connectAnother}</span>
                    <span className="mt-1 font-mono text-[12px] uppercase tracking-[0.08em] text-dust">
                      {copy.sites.connectAnotherPrice}
                    </span>
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
  return (
    <Card
      className={cn('flex h-full flex-col', site.needsAttention && 'border-missing/60')}
      aria-label={copy.a11y.siteCard(site.name)}
      data-testid="site-card"
      data-attention={site.needsAttention || undefined}
    >
      <div className="flex items-start justify-between gap-3 p-5 pb-3">
        <div className="min-w-0">
          <Link
            to={`/sites/${site.siteId}`}
            className="font-h2 block text-h2 leading-6 underline-offset-4 hover:underline"
            aria-label={copy.sites.openSite(site.name)}
          >
            {site.name}
          </Link>
          <div className="font-mono text-[12px] uppercase tracking-[0.08em] text-dust">
            {site.projectCode}
          </div>
        </div>
        {site.reportId ? (
          <Link to={`/reports/${site.reportId}`} className="shrink-0 rounded-chip">
            <StatusChip variant={site.chip.variant} label={site.chip.label} />
          </Link>
        ) : (
          <StatusChip variant={site.chip.variant} label={site.chip.label} />
        )}
      </div>
      <div className="px-5 pb-4">
        <div className="mb-2 text-caption text-dust">
          {site.status === 'paused' && site.pausedAt
            ? copy.sites.pausedSince(formatMonthDay(site.pausedAt.slice(0, 10)))
            : copy.sites.lastWorkdays(site.onTime14)}
        </div>
        <StreakBar cells={site.streak} />
      </div>
      <div className="mt-auto grid grid-cols-[1fr_auto_auto] items-center gap-3 border-t border-rebar px-5 py-3 text-caption">
        <div className="min-w-0">
          <div className="truncate font-medium text-asphalt">{site.reporterName ?? '—'}</div>
          {site.reporterPhone ? (
            <a
              href={`tel:${site.reporterPhone}`}
              className="inline-flex items-center gap-1 font-mono text-[12px] text-dust hover:text-asphalt"
            >
              <Phone className="size-3.5" aria-hidden="true" />
              {formatPhone(site.reporterPhone)}
            </a>
          ) : null}
        </div>
        <div className="text-right" title={copy.sites.crewToday}>
          <div className="eyebrow text-dust">{copy.sites.crewToday}</div>
          <div className="inline-flex items-center gap-1 font-mono text-data tabular">
            <Users className="size-4 text-dust" aria-hidden="true" />
            {formatCrew(site.crewToday)}
          </div>
        </div>
        <div className="text-right" title={copy.sites.weatherDaysMonth}>
          <div className="eyebrow text-dust">Wx</div>
          <div className="inline-flex items-center gap-1 font-mono text-data tabular">
            <CloudRain className="size-4 text-dust" aria-hidden="true" />
            {site.weatherDaysMonth}
          </div>
        </div>
      </div>
    </Card>
  );
}
