import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router';
import type { BillingAlert } from '@sitelog/shared/billing.ts';
import { formatDate, formatDateInTz } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { useBillingAlert } from '@/data/hooks';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import type { PanelLanguage } from '@/i18n/language';

/**
 * F23 "past-due banner", spec §19 Q235 (W4-10): for admins, on every page of the shell, while the
 * org is past due (a failed payment, or a trial that ended with no subscription), blocked after
 * its grace days, or canceled. It says when reminders and calls stop, in the org's time zone and
 * the panel's language, and links to Billing. Words carry the state, never the colour alone.
 */
export function BillingBanner() {
  const { role, currentOrg } = useAuth();
  const { t, language } = useCopy();
  const alert = useBillingAlert(role === 'admin');
  if (role !== 'admin' || !alert.data) return null;
  const tz = currentOrg?.timezone ?? 'UTC';
  return (
    <div
      role="status"
      data-testid="billing-banner"
      data-kind={alert.data.kind}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-missing/60 bg-chip-miss-bg px-4 py-2 text-[15px] text-asphalt md:px-8"
    >
      <AlertTriangle className="size-4 shrink-0 text-missing" aria-hidden="true" />
      <span className="sr-only">{t('billing.banner.label')}: </span>
      <span className="min-w-0 flex-1">{bannerText(alert.data, t, language, tz)}</span>
      <Link
        to="/billing"
        className="inline-flex min-h-[44px] items-center font-semibold underline underline-offset-4"
      >
        {t('billing.banner.action')}
      </Link>
    </div>
  );
}

function bannerText(a: BillingAlert, t: CopyT, language: PanelLanguage, tz: string): string {
  const day = (iso: string) => formatDate(formatDateInTz(iso, tz), 'long', language);
  const manual = a.provider === 'manual';
  if (a.kind === 'canceled') return t('billing.banner.canceled');
  if (a.blocked) return manual ? t('billing.banner.manualBlocked') : t('billing.banner.blocked');
  if (!a.blocksAt) return t('billing.banner.pastDueNoDate');
  if (a.kind === 'trial_ended' && a.since)
    return t('billing.banner.trial_ended', { ended: day(a.since), date: day(a.blocksAt) });
  if (manual) return t('billing.banner.manualPastDue', { date: day(a.blocksAt) });
  return t('billing.banner.past_due', { date: day(a.blocksAt) });
}
