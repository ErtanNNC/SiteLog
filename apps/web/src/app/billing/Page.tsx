import { CreditCard, Download, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatMoneyCents, formatMonthDay, formatMonthYear } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState } from '@/components/sitelog/States';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { copy } from '@/copy/en';
import { useBilling, useBillingPortal, usePauseSite, useResumeSite } from '@/data/hooks';
import type { BillingData } from '@/data/types';
import { formatDateLong } from '@/lib/format';
import { cn } from '@/lib/utils';

type SiteRow = BillingData['sites'][number];
type InvoiceRow = BillingData['invoices'][number];

const INVOICE_CHIP: Record<InvoiceRow['status'], { box: string; label: string }> = {
  paid: { box: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg', label: copy.chips.paid },
  open: { box: 'border-chip-await-bg bg-chip-await-bg text-chip-await-fg', label: copy.chips.open },
  past_due: {
    box: 'border-chip-miss-bg bg-chip-miss-bg text-chip-miss-fg',
    label: copy.chips.pastDue,
  },
};

/** P13 · Billing — plan card, sites on the plan (pause / resume), invoices (§11.4, F19). */
export default function BillingPage() {
  const { isDemo } = useAuth();
  const billing = useBilling();
  const pause = usePauseSite();
  const resume = useResumeSite();
  const portal = useBillingPortal();
  /** Stripe customer portal (payment method, invoice PDFs); demo mode only explains it. */
  const openPortal = () => {
    if (isDemo) toast.message(copy.billing.portalDemo);
    else portal.mutate();
  };
  const [confirm, setConfirm] = useState<{ site: SiteRow; action: 'pause' | 'resume' } | null>(
    null,
  );

  const siteColumns: Column<SiteRow>[] = [
    {
      key: 'site',
      header: copy.billing.columns.site,
      cell: (s) => (
        <div className="min-w-[180px]">
          <div className="font-semibold">{s.name}</div>
          <div className="font-mono text-[12px] uppercase tracking-[0.08em] text-dust">
            {s.projectCode}
          </div>
        </div>
      ),
    },
    {
      key: 'since',
      header: copy.billing.columns.since,
      hideBelowMd: true,
      cell: (s) => (
        <span className="font-mono text-data">
          {s.activeSince ? formatMonthYear(s.activeSince.slice(0, 7)) : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: copy.billing.columns.status,
      cell: (s) =>
        s.status === 'paused' ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusChip variant="no_work" label={copy.chips.paused} />
            {s.pausedAt ? (
              <span className="text-caption text-dust">
                {copy.billing.pausedSince(formatMonthDay(s.pausedAt.slice(0, 10)))}
              </span>
            ) : null}
          </span>
        ) : (
          <StatusChip variant="filed" label={copy.chips.active} />
        ),
    },
    {
      key: 'monthly',
      header: copy.billing.columns.monthly,
      numeric: true,
      cell: (s) => (s.monthlyCents > 0 ? formatMoneyCents(s.monthlyCents) : copy.billing.notBilled),
    },
    {
      key: 'action',
      header: <span className="sr-only">{copy.common.moreActions}</span>,
      className: 'text-right',
      cell: (s) =>
        s.status === 'paused' ? (
          <Button
            variant="secondary"
            size="dense"
            onClick={() => setConfirm({ site: s, action: 'resume' })}
            aria-label={`${copy.billing.resume} ${s.name}`}
          >
            <Play aria-hidden="true" />
            {copy.billing.resume}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="dense"
            onClick={() => setConfirm({ site: s, action: 'pause' })}
            aria-label={`${copy.billing.pause} ${s.name}`}
          >
            <Pause aria-hidden="true" />
            {copy.billing.pause}
          </Button>
        ),
    },
  ];

  const invoiceColumns: Column<InvoiceRow>[] = [
    {
      key: 'date',
      header: copy.billing.invoiceColumns.date,
      cell: (i) => <span className="font-mono text-data">{formatDateLong(i.date)}</span>,
    },
    {
      key: 'sites',
      header: copy.billing.invoiceColumns.sites,
      numeric: true,
      cell: (i) => i.sites,
    },
    {
      key: 'amount',
      header: copy.billing.invoiceColumns.amount,
      numeric: true,
      cell: (i) => formatMoneyCents(i.amountCents),
    },
    {
      key: 'status',
      header: copy.billing.invoiceColumns.status,
      cell: (i) => (
        <span
          className={cn(
            'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
            INVOICE_CHIP[i.status].box,
          )}
        >
          {INVOICE_CHIP[i.status].label}
        </span>
      ),
    },
    {
      key: 'download',
      header: <span className="sr-only">{copy.billing.download}</span>,
      className: 'text-right',
      cell: (i) =>
        i.url && i.url !== '#' ? (
          <Button variant="ghost" size="dense" asChild>
            <a
              href={i.url}
              target="_blank"
              rel="noopener"
              aria-label={copy.billing.invoiceDownload(formatDateLong(i.date))}
            >
              <Download aria-hidden="true" />
              {copy.billing.download}
            </a>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="dense"
            aria-label={copy.billing.invoiceDownload(formatDateLong(i.date))}
            disabled={portal.isPending}
            onClick={openPortal}
          >
            <Download aria-hidden="true" />
            {copy.billing.download}
          </Button>
        ),
    },
  ];

  if (billing.isPending) return <PageSkeleton />;
  if (billing.isError || !billing.data)
    return (
      <ErrorState
        thing={copy.nav.billing.toLowerCase()}
        error={billing.error}
        onRetry={() => void billing.refetch()}
      />
    );

  const { plan, sites, invoices } = billing.data;

  return (
    <>
      <PageHeader title={copy.billing.title} subtitle={copy.billing.subtitle} />

      {plan.status === 'past_due' ? (
        <div
          role="alert"
          className="mb-6 rounded-card border border-missing/60 bg-chip-miss-bg/40 p-4 text-[15px]"
        >
          {copy.billing.statusBanner.past_due}
        </div>
      ) : null}

      <section
        className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"
        aria-label={copy.billing.plan}
      >
        <Card dark data-testid="plan-card">
          <CardContent className="p-6">
            <div className="eyebrow text-dust-light">{copy.billing.plan}</div>
            <div className="mt-3 flex flex-wrap items-baseline gap-2">
              <span
                className="font-display text-[44px] leading-[48px] tabular"
                data-testid="plan-total"
              >
                {formatMoneyCents(plan.monthlyCents)}
              </span>
              <span className="font-mono text-data text-dust-light">{copy.billing.perMonth}</span>
            </div>
            <p className="mt-1 text-[15px] text-dust-light">
              {copy.billing.sitesTimes(plan.activeSites)}
            </p>
            <dl className="mt-6 grid gap-4 border-t border-iron pt-4 sm:grid-cols-2">
              <div>
                <dt className="eyebrow text-dust-light">{copy.billing.nextInvoice}</dt>
                <dd className="mt-1 font-mono text-data">{formatDateLong(plan.nextInvoiceDate)}</dd>
              </div>
              <div>
                <dt className="eyebrow text-dust-light">{copy.billing.paymentMethod}</dt>
                <dd className="mt-1 flex items-center gap-2 font-mono text-data">
                  <CreditCard className="size-4 text-dust-light" aria-hidden="true" />
                  {plan.paymentMethod
                    ? copy.billing.card(plan.paymentMethod.brand, plan.paymentMethod.last4)
                    : copy.billing.noPaymentMethod}
                </dd>
              </div>
              {plan.trialEndsAt ? (
                <div>
                  <dt className="eyebrow text-dust-light">{copy.chips.pending}</dt>
                  <dd className="mt-1 font-mono text-data">
                    {copy.billing.trialEnds(formatDateLong(plan.trialEndsAt.slice(0, 10)))}
                  </dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{copy.billing.whatCounts}</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="space-y-2 text-[15px] text-dust">
              {copy.billing.whatCountsPoints.map((p) => (
                <li key={p} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-2.5 size-1.5 shrink-0 rounded-full bg-iron"
                  />
                  {p}
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              className="mt-5 w-full"
              loading={portal.isPending}
              onClick={openPortal}
              data-testid="update-payment"
            >
              <CreditCard aria-hidden="true" />
              {copy.billing.updatePayment}
            </Button>
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{copy.billing.sitesOnPlan}</CardTitle>
          <span className="font-mono text-[13px] text-dust">
            {copy.billing.activeSitesLabel} · {plan.activeSites}
          </span>
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          <DataTable
            columns={siteColumns}
            rows={sites}
            rowKey={(s) => s.id}
            aria-label={copy.billing.sitesOnPlan}
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{copy.billing.invoices}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          <DataTable
            columns={invoiceColumns}
            rows={invoices}
            rowKey={(i) => i.id ?? i.date}
            aria-label={copy.billing.invoices}
            empty={{ title: copy.billing.invoicesEmpty }}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm
            ? confirm.action === 'pause'
              ? copy.billing.pauseDialog.title(confirm.site.name)
              : copy.billing.resumeDialog.title(confirm.site.name)
            : ''
        }
        description={
          confirm?.action === 'pause'
            ? copy.billing.pauseDialog.body
            : copy.billing.resumeDialog.body
        }
        confirmLabel={
          confirm?.action === 'pause'
            ? copy.billing.pauseDialog.confirm
            : copy.billing.resumeDialog.confirm
        }
        destructive={confirm?.action === 'pause'}
        loading={pause.isPending || resume.isPending}
        onConfirm={() => {
          if (!confirm) return;
          const vars = { siteId: confirm.site.id, siteName: confirm.site.name };
          const m = confirm.action === 'pause' ? pause : resume;
          m.mutate(vars, { onSettled: () => setConfirm(null) });
        }}
      />
    </>
  );
}
