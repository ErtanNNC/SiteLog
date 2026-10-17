import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatMoneyCents } from '@sitelog/shared/format.ts';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { KpiTile } from '@/components/sitelog/KpiTile';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useDiscardDeadJob, useOps, usePlatformAdmin, useRetryDeadJob } from '@/data/hooks';
import type { OpsCostOutlier, OpsDeadJob, OpsQueueRow } from '@/data/types';
import { formatDateTimeShort } from '@/lib/format';
import { cn } from '@/lib/utils';
import NotFoundPage from '../not-found/Page';
import { OrglessContacts } from './OrglessContacts';
import { OrgBilling } from './OrgBilling';
import { OutboundCalls } from './OutboundCalls';

/**
 * /ops — SiteLog staff only (§15 reliability "dead-letter visible in an internal /ops page",
 * §15 cost guardrail, §16.2 M9). Not in the sidebar; anyone who is not a platform admin gets the
 * not-found page. Data is platform-wide (every org), so times are shown in UTC.
 */
export default function OpsPage() {
  const access = usePlatformAdmin();
  if (access.isPending) return <PageSkeleton />;
  if (access.data !== true) return <NotFoundPage />;
  return <OpsDashboard />;
}

const utc = (iso: string) => copy.ops.utc(formatDateTimeShort(iso, 'UTC'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortValue = (v: string | number | boolean) =>
  typeof v === 'string' && UUID.test(v) ? `${v.slice(0, 8)}…` : String(v);
const count = (n: number) => <span className={cn(n === 0 && 'text-dust')}>{n}</span>;

/** Tables sit edge to edge in their card; an empty state keeps the card's side margin. */
const EMPTY_IN_CARD = 'mx-5 mb-3';

type Pending = { action: 'retry' | 'discard'; job: OpsDeadJob } | null;

function OpsDashboard() {
  const s = useDataSource();
  const ops = useOps();
  const retry = useRetryDeadJob();
  const discard = useDiscardDeadJob();
  const [pending, setPending] = useState<Pending>(null);

  if (ops.isPending) return <PageSkeleton />;
  if (ops.isError || !ops.data)
    return (
      <ErrorState
        thing={copy.ops.errorThing}
        error={ops.error}
        onRetry={() => void ops.refetch()}
      />
    );

  const { queue, deadJobs, costOutliers, outboundCalls } = ops.data;
  const total = (k: 'queued' | 'running' | 'dead') => queue.reduce((a, q) => a + q[k], 0);
  const waits = queue.map((q) => q.oldestDueSeconds).filter((v): v is number => v !== null);
  const oldest = waits.length ? Math.max(...waits) : null;
  const deadTotal = total('dead');

  const queueColumns: Column<OpsQueueRow>[] = [
    {
      key: 'type',
      header: copy.ops.queue.columns.type,
      cell: (q) => <span className="font-mono text-data">{q.type}</span>,
    },
    {
      key: 'queued',
      header: copy.ops.queue.columns.queued,
      numeric: true,
      cell: (q) => count(q.queued),
    },
    {
      key: 'running',
      header: copy.ops.queue.columns.running,
      numeric: true,
      cell: (q) => count(q.running),
    },
    {
      key: 'dead',
      header: copy.ops.queue.columns.dead,
      numeric: true,
      cell: (q) => (
        <span className={cn(q.dead > 0 ? 'font-semibold text-missing' : 'text-dust')}>
          {q.dead}
        </span>
      ),
    },
    {
      key: 'oldest',
      header: copy.ops.queue.columns.oldest,
      numeric: true,
      cell: (q) =>
        q.oldestDueSeconds === null ? (
          <span className="text-dust">—</span>
        ) : (
          copy.ops.age(q.oldestDueSeconds)
        ),
    },
  ];

  const deadColumns: Column<OpsDeadJob>[] = [
    {
      key: 'job',
      header: copy.ops.dead.columns.job,
      cell: (j) => (
        <div className="min-w-[140px]">
          <div className="font-mono text-data font-semibold">#{j.id}</div>
          <div className="font-mono text-caption text-dust">{j.type}</div>
        </div>
      ),
    },
    {
      key: 'attempts',
      header: copy.ops.dead.columns.attempts,
      numeric: true,
      cell: (j) => j.attempts,
    },
    {
      key: 'error',
      header: copy.ops.dead.columns.error,
      cell: (j) =>
        j.lastError ? (
          <p className="max-w-[420px] break-words font-mono text-[13px] leading-5">{j.lastError}</p>
        ) : (
          <span className="text-dust">{copy.ops.dead.noError}</span>
        ),
    },
    {
      key: 'payload',
      header: copy.ops.dead.columns.payload,
      hideBelowMd: true,
      cell: (j) => {
        const entries = Object.entries(j.payload);
        if (entries.length === 0)
          return <span className="text-dust">{copy.ops.dead.noPayload}</span>;
        return (
          <div className="flex max-w-[280px] flex-wrap gap-1">
            {entries.map(([k, v]) => (
              <span
                key={k}
                title={`${k}: ${String(v)}`}
                className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-chip border border-rebar px-1.5 font-mono text-[12px]"
              >
                <span className="text-dust">{k}</span>
                {shortValue(v)}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      key: 'died',
      header: copy.ops.dead.columns.died,
      hideBelowMd: true,
      cell: (j) => (
        <span className="whitespace-nowrap font-mono text-[13px]">
          {j.finishedAt ? utc(j.finishedAt) : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{copy.common.moreActions}</span>,
      cell: (j) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="dense"
            aria-label={copy.ops.dead.retryLabel(j.id)}
            onClick={() => setPending({ action: 'retry', job: j })}
          >
            <RotateCcw aria-hidden="true" />
            {copy.ops.dead.retry}
          </Button>
          <Button
            variant="destructive"
            size="dense"
            aria-label={copy.ops.dead.discardLabel(j.id)}
            onClick={() => setPending({ action: 'discard', job: j })}
          >
            <Trash2 aria-hidden="true" />
            {copy.ops.dead.discard}
          </Button>
        </div>
      ),
    },
  ];

  const costColumns: Column<OpsCostOutlier>[] = [
    {
      key: 'report',
      header: copy.ops.cost.columns.report,
      cell: (o) =>
        o.orgId === s.orgId ? (
          <Link
            to={`/reports/${o.reportId}`}
            className="whitespace-nowrap font-mono text-data font-semibold text-level underline-offset-4 hover:underline"
          >
            {o.reportNo}
          </Link>
        ) : (
          <div className="min-w-[140px]">
            <div className="font-mono text-data font-semibold">{o.reportNo}</div>
            <div className="text-caption text-dust">{copy.ops.cost.otherOrg}</div>
          </div>
        ),
    },
    { key: 'org', header: copy.ops.cost.columns.org, cell: (o) => o.orgName },
    {
      key: 'site',
      header: copy.ops.cost.columns.site,
      hideBelowMd: true,
      cell: (o) => o.siteName,
    },
    {
      key: 'filed',
      header: copy.ops.cost.columns.filed,
      hideBelowMd: true,
      cell: (o) => (
        <span className="whitespace-nowrap font-mono text-[13px]">{utc(o.filedAt)}</span>
      ),
    },
    {
      key: 'cost',
      header: copy.ops.cost.columns.cost,
      numeric: true,
      cell: (o) => (
        <div>
          <div className="font-semibold">{formatMoneyCents(o.costCents)}</div>
          {o.aiUsd !== null && o.waTemplates !== null ? (
            <div className="whitespace-nowrap text-caption text-dust">
              {copy.ops.cost.breakdown(formatMoneyCents(Math.round(o.aiUsd * 100)), o.waTemplates)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'median',
      header: copy.ops.cost.columns.median,
      numeric: true,
      cell: (o) =>
        o.medianCents === null ? (
          '—'
        ) : (
          <div>
            <div>{formatMoneyCents(Math.round(o.medianCents))}</div>
            <div className="whitespace-nowrap text-caption text-dust">
              {copy.ops.cost.sample(o.sample)}
            </div>
          </div>
        ),
    },
    {
      key: 'ratio',
      header: copy.ops.cost.columns.ratio,
      numeric: true,
      cell: (o) =>
        o.medianCents ? (
          <span className="font-semibold text-signal-deep">
            {copy.ops.cost.ratio(o.costCents / o.medianCents)}
          </span>
        ) : (
          '—'
        ),
    },
  ];

  const confirming = pending?.action === 'retry' ? retry : discard;
  const dialog =
    pending?.action === 'retry' ? copy.ops.dead.confirmRetry : copy.ops.dead.confirmDiscard;

  return (
    <>
      <PageHeader
        eyebrow={copy.ops.eyebrow}
        title={copy.ops.title}
        subtitle={copy.ops.subtitle}
        actions={
          <Button variant="ghost" loading={ops.isFetching} onClick={() => void ops.refetch()}>
            {ops.isFetching ? null : <RefreshCw aria-hidden="true" />}
            {copy.ops.refresh}
          </Button>
        }
      />

      <section aria-label={copy.ops.queue.title} className="mb-6">
        <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="ops-kpis">
          <KpiTile label={copy.ops.queue.queued} value={total('queued')} />
          <KpiTile label={copy.ops.queue.running} value={total('running')} />
          <KpiTile
            label={copy.ops.queue.dead}
            value={<span className={cn(deadTotal > 0 && 'text-missing')}>{deadTotal}</span>}
          />
          <KpiTile
            label={copy.ops.queue.oldest}
            value={oldest === null ? '—' : copy.ops.age(oldest)}
            hint={oldest === null ? copy.ops.queue.none : copy.ops.queue.oldestHint}
          />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{copy.ops.queue.title}</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-2 pt-3">
            <DataTable
              columns={queueColumns}
              rows={queue}
              rowKey={(q) => q.type}
              rowTone={(q) => (q.dead > 0 ? 'missing' : 'default')}
              aria-label={copy.ops.queue.label}
              dense
              empty={{ title: copy.ops.queue.empty }}
              className={queue.length === 0 ? EMPTY_IN_CARD : undefined}
            />
          </CardContent>
        </Card>
      </section>

      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>{copy.ops.dead.title}</CardTitle>
            <p className="mt-1 text-[15px] text-dust">{copy.ops.dead.hint}</p>
          </div>
          <span className="font-mono text-[13px] text-dust">{deadJobs.length}</span>
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          <DataTable
            columns={deadColumns}
            rows={deadJobs}
            rowKey={(j) => String(j.id)}
            aria-label={copy.ops.dead.title}
            empty={{ title: copy.ops.dead.empty, body: copy.ops.dead.emptyBody }}
            className={deadJobs.length === 0 ? EMPTY_IN_CARD : undefined}
          />
        </CardContent>
      </Card>

      <OrglessContacts />

      <OutboundCalls rows={outboundCalls ?? []} />

      <OrgBilling />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{copy.ops.cost.title}</CardTitle>
            <p className="mt-1 text-[15px] text-dust">{copy.ops.cost.hint}</p>
          </div>
          <span className="font-mono text-[13px] text-dust">{costOutliers.length}</span>
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          <DataTable
            columns={costColumns}
            rows={costOutliers}
            rowKey={(o) => o.reportId}
            rowHref={(o) => (o.orgId === s.orgId ? `/reports/${o.reportId}` : null)}
            aria-label={copy.ops.cost.title}
            empty={{ title: copy.ops.cost.empty }}
            className={costOutliers.length === 0 ? EMPTY_IN_CARD : undefined}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending ? dialog.title(pending.job.id, pending.job.type) : ''}
        description={dialog.body}
        confirmLabel={dialog.confirm}
        destructive={pending?.action === 'discard'}
        loading={confirming.isPending}
        onConfirm={() => {
          if (!pending) return;
          confirming.mutate({ jobId: pending.job.id }, { onSettled: () => setPending(null) });
        }}
      />
    </>
  );
}
