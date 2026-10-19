import { useState } from 'react';
import {
  BILLING_STATUSES,
  currencyDigits,
  formatBillingMoney,
  minorFromInput,
  type BillingStatus,
} from '@sitelog/shared/billing.ts';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
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
import { useOpsOrgBilling, useSetOrgBillingStatus, useSetOrgPrice } from '@/data/hooks';
import type { OpsOrgBilling } from '@/data/types';

/**
 * /ops (W4-10, spec §19 Q234, Q236): every organisation's billing. TalkOlog staff set the price
 * per active site and month (`ops_set_org_price()`) and, for an org TalkOlog invoices directly
 * (`manual`), its status (`ops_set_org_billing_status()`); both audited. A Stripe org's status
 * follows Stripe. English only, as the rest of /ops (§19 Q240).
 */
export function OrgBilling() {
  const c = copy.ops.billing;
  const data = useOpsOrgBilling();
  const [editing, setEditing] = useState<OpsOrgBilling | null>(null);

  if (data.isError)
    return <ErrorState thing={c.thing} error={data.error} onRetry={() => void data.refetch()} />;
  if (data.isPending) return null;
  const rows = data.data ?? [];

  const columns: Column<OpsOrgBilling>[] = [
    {
      key: 'org',
      header: c.columns.org,
      cell: (o) => (
        <span className="flex flex-wrap items-center gap-2">
          <span>{o.orgName}</span>
          <span className="font-mono text-[12px] text-dust">{o.country}</span>
          {o.isDemo ? (
            <span className="inline-flex h-6 items-center rounded-chip border border-rebar px-1.5 font-mono text-[12px] text-dust">
              {c.demo}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'provider', header: c.columns.provider, cell: (o) => c.providers[o.provider] },
    {
      key: 'status',
      header: c.columns.status,
      cell: (o) =>
        o.status && o.status in c.statuses
          ? c.statuses[o.status as BillingStatus]
          : (o.status ?? '—'),
    },
    {
      key: 'price',
      header: c.columns.price,
      numeric: true,
      cell: (o) =>
        o.price ? formatBillingMoney(o.price.minor, o.price.currency, 'en') : c.noPrice,
    },
    { key: 'sites', header: c.columns.sites, numeric: true, cell: (o) => o.activeSites },
    {
      key: 'edit',
      header: <span className="sr-only">{c.edit}</span>,
      className: 'text-right',
      cell: (o) => (
        <Button
          variant="ghost"
          size="dense"
          className="min-h-[44px]"
          aria-label={c.editLabel(o.orgName)}
          onClick={() => setEditing(o)}
        >
          {c.edit}
        </Button>
      ),
    },
  ];

  return (
    <Card className="mb-6" data-testid="ops-org-billing">
      <CardHeader>
        <div>
          <CardTitle>{c.title}</CardTitle>
          <p className="mt-1 text-[15px] text-dust">{c.hint}</p>
        </div>
        <span className="font-mono text-[13px] text-dust">{rows.length}</span>
      </CardHeader>
      <CardContent className="px-0 pb-2 pt-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(o) => o.orgId}
          aria-label={c.title}
          empty={{ title: c.empty }}
          className={rows.length === 0 ? 'mx-5 mb-3' : undefined}
        />
      </CardContent>
      {editing ? <EditOrgBilling org={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function EditOrgBilling({ org, onClose }: { org: OpsOrgBilling; onClose: () => void }) {
  const c = copy.ops.billing;
  const setPrice = useSetOrgPrice();
  const setStatus = useSetOrgBillingStatus();
  const [amount, setAmount] = useState(
    org.price ? formatAmount(org.price.minor, org.price.currency) : '',
  );
  const [currency, setCurrency] = useState(org.price?.currency ?? '');
  const [status, setStatusValue] = useState<BillingStatus | ''>(
    org.status && (BILLING_STATUSES as readonly string[]).includes(org.status)
      ? (org.status as BillingStatus)
      : '',
  );
  const [error, setError] = useState<string | null>(null);
  const manual = org.provider === 'manual';
  const busy = setPrice.isPending || setStatus.isPending;

  const save = async () => {
    const cur = currency.trim().toUpperCase();
    let price: { minor: number; currency: string } | null = null;
    if (amount.trim() !== '' || cur !== '') {
      if (!/^[A-Z]{3}$/.test(cur)) return setError(c.currencyInvalid);
      const minor = minorFromInput(amount, cur);
      if (minor === null) return setError(c.amountInvalid);
      price = { minor, currency: cur };
    }
    setError(null);
    const same =
      (price === null && org.price === null) ||
      (price !== null &&
        org.price !== null &&
        price.minor === org.price.minor &&
        price.currency === org.price.currency);
    if (!same) await setPrice.mutateAsync({ orgId: org.orgId, price });
    if (manual && status && status !== org.status)
      await setStatus.mutateAsync({ orgId: org.orgId, status });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{c.dialogTitle(org.orgName)}</DialogTitle>
          <DialogDescription>{c.dialogBody}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save().catch(() => undefined);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
            <div className="grid gap-1.5">
              <Label htmlFor="ops-price-amount">{c.amount}</Label>
              <Input
                id="ops-price-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-describedby="ops-price-hint"
                aria-invalid={error === c.amountInvalid || undefined}
              />
              <p id="ops-price-hint" className="text-caption text-dust">
                {c.amountHint}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ops-price-currency">{c.currency}</Label>
              <Input
                id="ops-price-currency"
                value={currency}
                maxLength={3}
                autoCapitalize="characters"
                onChange={(e) => setCurrency(e.target.value)}
                aria-invalid={error === c.currencyInvalid || undefined}
              />
            </div>
          </div>
          {manual ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ops-billing-status">{c.status}</Label>
              <Select value={status} onValueChange={(v) => setStatusValue(v as BillingStatus)}>
                <SelectTrigger id="ops-billing-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILLING_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {c.statuses[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-[15px] text-missing">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button">
                {copy.common.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" loading={busy}>
              {c.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 39900 USD → "399.00": the amount field's text in the currency's main unit. */
function formatAmount(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}
