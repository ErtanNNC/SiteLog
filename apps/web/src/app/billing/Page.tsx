import { CreditCard, Download, Pause, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { formatBillingMoney } from '@sitelog/shared/billing.ts';
import { formatDate, formatMonthYearIn } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState } from '@/components/sitelog/States';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import {
  useBilling,
  useBillingCheckout,
  useBillingPortal,
  usePauseSite,
  useResumeSite,
} from '@/data/hooks';
import type { BillingData } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

type SiteRow = BillingData['sites'][number];
type InvoiceRow = BillingData['invoices'][number];

const INVOICE_CHIP: Record<
  InvoiceRow['status'],
  { box: string; label: 'chips.paid' | 'chips.open' | 'chips.pastDue' }
> = {
  paid: { box: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg', label: 'chips.paid' },
  open: { box: 'border-chip-await-bg bg-chip-await-bg text-chip-await-fg', label: 'chips.open' },
  past_due: {
    box: 'border-chip-miss-bg bg-chip-miss-bg text-chip-miss-fg',
    label: 'chips.pastDue',
  },
};

const STATUS_KEYS = ['trialing', 'active', 'past_due', 'canceled', 'paused'] as const;
type StatusKey = (typeof STATUS_KEYS)[number];
const isStatusKey = (s: string | null): s is StatusKey =>
  s !== null && (STATUS_KEYS as readonly string[]).includes(s);

/**
 * P13 · Billing (§11.4, F23; W4-10): the plan card from the org's own price (spec §19 Q234) in its
 * currency and the panel's language, the sites on the plan with Pause / Resume (admin only, as
 * the route), invoices. A Stripe org starts its subscription in Checkout and manages it in the
 * customer portal; a `manual` org (§19 Q236: a TR org until Q8) sees the trial, its sites and its
 * price, and "TalkOlog invoices you directly", with no Checkout or portal. The past-due banner is
 * the shell's (`BillingBanner`, every page). EN/TR.
 */
export default function BillingPage() {
  const { t, language } = useCopy();
  const { isDemo } = useAuth();
  const billing = useBilling();
  const pause = usePauseSite();
  const resume = useResumeSite();
  const portal = useBillingPortal();
  const checkout = useBillingCheckout();
  const manual = billing.data?.plan.provider === 'manual';
  const hasSubscription = billing.data?.plan.hasSubscription ?? true;
  // Checkout subscribes one unit per active site, so it needs at least one (api-billing: 409).
  const needsSite = !manual && !hasSubscription && (billing.data?.plan.activeSites ?? 0) === 0;
  // Paused sites are listed below with Resume: point there rather than to a new site.
  const canResume = needsSite && (billing.data?.sites ?? []).some((s) => s.status === 'paused');
  const date = (d: string) => formatDate(d.slice(0, 10), 'long', language);
  /**
   * Stripe customer portal (payment method, invoice PDFs) once a subscription exists; before that,
   * Stripe Checkout starts it (14-day trial). Demo mode only explains it.
   */
  const openPortal = () => {
    if (isDemo)
      toast.message(hasSubscription ? t('billing.portalDemo') : t('billing.checkoutDemo'));
    else if (hasSubscription) portal.mutate();
    else checkout.mutate();
  };
  const stripeBusy = portal.isPending || checkout.isPending;

  // Back from Stripe Checkout: ?checkout=success|canceled (api-billing success/cancel URLs).
  const [params, setParams] = useSearchParams();
  const checkoutResult = params.get('checkout');
  const refetchBilling = billing.refetch;
  useEffect(() => {
    if (!checkoutResult) return;
    if (checkoutResult === 'success') {
      toast.success(t('billing.checkoutSuccess'));
      void refetchBilling();
    } else if (checkoutResult === 'canceled') toast.message(t('billing.checkoutCanceled'));
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('checkout');
        next.delete('session_id');
        return next;
      },
      { replace: true },
    );
  }, [checkoutResult, refetchBilling, setParams, t]);
  const [confirm, setConfirm] = useState<{ site: SiteRow; action: 'pause' | 'resume' } | null>(
    null,
  );

  if (billing.isPending) return <PageSkeleton />;
  if (billing.isError || !billing.data)
    return (
      <ErrorState
        thing={t('billing.thing')}
        error={billing.error}
        onRetry={() => void billing.refetch()}
      />
    );

  const { plan, sites, invoices } = billing.data;
  const price = plan.price;
  const money = (minor: number, currency = price?.currency ?? 'USD') =>
    formatBillingMoney(minor, currency, language);
  const priceText = price ? money(price.minor) : null;
  const totalText = price && plan.monthlyMinor !== null ? money(plan.monthlyMinor) : null;
  // §19 Q235: the trial ended without a subscription (the shell's banner says what follows).
  const trialOver = billing.data.alert?.kind === 'trial_ended';

  const siteColumns: Column<SiteRow>[] = [
    {
      key: 'site',
      header: t('billing.columns.site'),
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
      header: t('billing.columns.since'),
      hideBelowMd: true,
      cell: (s) => (
        <span className="font-mono text-data">
          {s.activeSince ? formatMonthYearIn(s.activeSince.slice(0, 7), language) : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('billing.columns.status'),
      cell: (s) =>
        s.status === 'paused' ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusChip variant="no_work" label={t('chips.paused')} />
            {s.pausedAt ? (
              <span className="text-caption text-dust">
                {t('billing.pausedSince', {
                  date: formatDate(s.pausedAt.slice(0, 10), 'monthDay', language),
                })}
              </span>
            ) : null}
          </span>
        ) : (
          <StatusChip variant="filed" label={t('chips.active')} />
        ),
    },
    {
      key: 'monthly',
      header: t('billing.columns.monthly'),
      numeric: true,
      cell: (s) => (s.monthlyMinor !== null ? money(s.monthlyMinor) : t('billing.notBilled')),
    },
    {
      key: 'action',
      header: <span className="sr-only">{t('billing.columns.action')}</span>,
      className: 'text-right',
      cell: (s) =>
        s.status === 'paused' ? (
          <Button
            variant="secondary"
            size="dense"
            onClick={() => setConfirm({ site: s, action: 'resume' })}
            aria-label={t('billing.resumeSiteLabel', { site: s.name })}
          >
            <Play aria-hidden="true" />
            {t('billing.resume')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="dense"
            onClick={() => setConfirm({ site: s, action: 'pause' })}
            aria-label={t('billing.pauseSiteLabel', { site: s.name })}
          >
            <Pause aria-hidden="true" />
            {t('billing.pause')}
          </Button>
        ),
    },
  ];

  const invoiceColumns: Column<InvoiceRow>[] = [
    {
      key: 'date',
      header: t('billing.invoiceColumns.date'),
      cell: (i) => <span className="font-mono text-data">{date(i.date)}</span>,
    },
    {
      key: 'sites',
      header: t('billing.invoiceColumns.sites'),
      numeric: true,
      cell: (i) => i.sites,
    },
    {
      key: 'amount',
      header: t('billing.invoiceColumns.amount'),
      numeric: true,
      cell: (i) => money(i.amountMinor, i.currency),
    },
    {
      key: 'status',
      header: t('billing.invoiceColumns.status'),
      cell: (i) => (
        <span
          className={cn(
            'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
            INVOICE_CHIP[i.status].box,
          )}
        >
          {t(INVOICE_CHIP[i.status].label)}
        </span>
      ),
    },
    {
      key: 'download',
      header: <span className="sr-only">{t('billing.download')}</span>,
      className: 'text-right',
      cell: (i) =>
        i.url && i.url !== '#' ? (
          <Button variant="ghost" size="dense" asChild>
            <a
              href={i.url}
              target="_blank"
              rel="noopener"
              aria-label={t('billing.invoiceDownload', { date: date(i.date) })}
            >
              <Download aria-hidden="true" />
              {t('billing.download')}
            </a>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="dense"
            aria-label={t('billing.invoiceDownload', { date: date(i.date) })}
            disabled={stripeBusy}
            onClick={openPortal}
          >
            <Download aria-hidden="true" />
            {t('billing.download')}
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('billing.title')}
        subtitle={
          priceText ? t('billing.subtitlePrice', { price: priceText }) : t('billing.subtitle')
        }
      />

      {manual ? (
        <Card className="mb-6" data-testid="manual-billing">
          <CardContent className="p-5">
            <h2 className="font-h2 text-h2">{t('billing.manual.title')}</h2>
            <p className="mt-1 max-w-[720px] text-[15px] text-dust">{t('billing.manual.body')}</p>
          </CardContent>
        </Card>
      ) : !plan.hasSubscription ? (
        <Card className="mb-6" data-testid="start-subscription">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="max-w-[640px]">
              <h2 className="font-h2 text-h2">{t('billing.startTitle')}</h2>
              <p className="mt-1 text-[15px] text-dust">{t('billing.startBody')}</p>
              {needsSite ? (
                <p className="mt-1 text-[15px] font-medium" data-testid="start-needs-site">
                  {canResume ? t('billing.startResumeSite') : t('billing.startNoSites')}
                </p>
              ) : null}
            </div>
            {needsSite ? (
              <Button variant={canResume ? 'ghost' : 'secondary'} asChild>
                <Link to="/setup/site">{t('billing.addSite')}</Link>
              </Button>
            ) : (
              <Button loading={stripeBusy} onClick={openPortal}>
                <CreditCard aria-hidden="true" />
                {t('billing.startCta')}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : null}

      <section
        className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"
        aria-label={t('billing.plan')}
      >
        <Card dark data-testid="plan-card">
          <CardContent className="p-6">
            <div className="eyebrow text-dust-light">{t('billing.plan')}</div>
            {totalText && priceText ? (
              <>
                <div className="mt-3 flex flex-wrap items-baseline gap-2">
                  <span
                    className="font-display text-[44px] leading-[48px] tabular"
                    data-testid="plan-total"
                  >
                    {totalText}
                  </span>
                  <span className="font-mono text-data text-dust-light">
                    {t('billing.perMonth')}
                  </span>
                </div>
                <p
                  className="mt-1 font-mono text-data text-dust-light tabular"
                  data-testid="plan-equation"
                >
                  {t('billing.equation', {
                    count: plan.activeSites,
                    price: priceText,
                    total: totalText,
                  })}
                </p>
              </>
            ) : (
              <p className="mt-3 max-w-[560px] text-[15px] text-dust-light" data-testid="no-price">
                {t('billing.noPrice')}
              </p>
            )}
            <dl className="mt-6 grid gap-4 border-t border-iron pt-4 sm:grid-cols-2">
              {manual ? (
                <div>
                  <dt className="eyebrow text-dust-light">{t('billing.status')}</dt>
                  <dd className="mt-1 font-mono text-data" data-testid="billing-status">
                    {isStatusKey(plan.status) ? t(`billing.statuses.${plan.status}`) : '—'}
                  </dd>
                </div>
              ) : (
                <>
                  <div>
                    <dt className="eyebrow text-dust-light">{t('billing.nextInvoice')}</dt>
                    <dd className="mt-1 font-mono text-data" data-testid="next-invoice">
                      {/* Only a subscription has an invoice date (Stripe's current period end). */}
                      {plan.hasSubscription
                        ? date(plan.nextInvoiceDate)
                        : t('billing.noSubscription')}
                    </dd>
                  </div>
                  <div>
                    <dt className="eyebrow text-dust-light">{t('billing.paymentMethod')}</dt>
                    <dd className="mt-1 flex items-center gap-2 font-mono text-data">
                      <CreditCard className="size-4 text-dust-light" aria-hidden="true" />
                      {plan.paymentMethod
                        ? t('billing.card', {
                            brand: plan.paymentMethod.brand,
                            last4: plan.paymentMethod.last4,
                          })
                        : t('billing.noPaymentMethod')}
                    </dd>
                  </div>
                </>
              )}
              {plan.trialEndsAt && plan.status === 'trialing' ? (
                <div>
                  <dt className="eyebrow text-dust-light">{t('billing.trial')}</dt>
                  <dd className="mt-1 font-mono text-data" data-testid="trial">
                    {trialOver
                      ? t('billing.trialEnded', { date: date(plan.trialEndsAt) })
                      : t('billing.trialEnds', { date: date(plan.trialEndsAt) })}
                  </dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('billing.whatCounts')}</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="space-y-2 text-[15px] text-dust">
              {(
                [
                  'billing.whatCountsActive',
                  'billing.whatCountsPaused',
                  manual ? 'billing.whatCountsManual' : 'billing.whatCountsProrated',
                ] as const
              ).map((key) => (
                <li key={key} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-2.5 size-1.5 shrink-0 rounded-full bg-iron"
                  />
                  {t(key)}
                </li>
              ))}
            </ul>
            {manual ? null : (
              <Button
                variant="ghost"
                className="mt-5 w-full"
                loading={stripeBusy}
                disabled={needsSite}
                onClick={openPortal}
                data-testid="update-payment"
              >
                <CreditCard aria-hidden="true" />
                {t('billing.updatePayment')}
              </Button>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('billing.sitesOnPlan')}</CardTitle>
          <span className="font-mono text-[13px] text-dust">
            {t('billing.activeSitesLabel')} · {plan.activeSites}
          </span>
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          <DataTable
            columns={siteColumns}
            rows={sites}
            rowKey={(s) => s.id}
            aria-label={t('billing.sitesOnPlan')}
            empty={{
              title: t('billing.noSitesTitle'),
              body: priceText
                ? t('billing.noSitesBodyPrice', { price: priceText })
                : t('billing.noSitesBody'),
              action: (
                <Button variant="secondary" asChild>
                  <Link to="/setup/site">{t('billing.addSite')}</Link>
                </Button>
              ),
            }}
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('billing.invoices')}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2 pt-3">
          <DataTable
            columns={invoiceColumns}
            rows={invoices}
            rowKey={(i) => i.id ?? i.date}
            aria-label={t('billing.invoices')}
            empty={{ title: manual ? t('billing.manual.invoices') : t('billing.invoicesEmpty') }}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm
            ? confirm.action === 'pause'
              ? t('billing.pauseDialog.title', { site: confirm.site.name })
              : t('billing.resumeDialog.title', { site: confirm.site.name })
            : ''
        }
        description={
          confirm?.action === 'pause'
            ? t('billing.pauseDialog.body')
            : t('billing.resumeDialog.body')
        }
        confirmLabel={
          confirm?.action === 'pause'
            ? t('billing.pauseDialog.confirm')
            : t('billing.resumeDialog.confirm')
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
