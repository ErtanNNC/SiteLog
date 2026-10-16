import { CheckCheck, FileText, Mail, MessageSquareText, Mic, Phone, X } from 'lucide-react';
import { Link } from 'react-router';
import { formatDate } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { useSetInvoiceStatus } from '@/data/hooks';
import type { HoursRow, InvoiceDetail, InvoiceEvidence } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { formatNumberIn, formatSignedHoursIn } from '@/lib/localeFormat';
import { useScrollRegion } from '@/lib/useScrollRegion';
import { cn } from '@/lib/utils';
import {
  buildQueryMailto,
  evidenceHref,
  evidenceQuote,
  evidenceSourceLabel,
  monthDay,
} from './evidence';

const STATUS_STYLE: Record<InvoiceDetail['status'], string> = {
  open: 'border-rebar bg-concrete text-dust',
  queried: 'border-chip-await-bg bg-chip-await-bg text-chip-await-fg',
  resolved: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg',
};

const KIND_ICON = {
  voice_note: Mic,
  call: Phone,
  answer: MessageSquareText,
  report: FileText,
} as const;

/**
 * The source behind a gap day: a voice note or call second opening P7 there, an answer, or the
 * report; linked for the roles that can open reports (an accounts user sees the number only).
 */
function EvidenceChip({ e, canOpen }: { e: InvoiceEvidence; canOpen: boolean }) {
  const { t } = useCopy();
  const Icon = KIND_ICON[e.kind];
  const label = evidenceSourceLabel(e, t);
  const body = (
    <>
      <Icon className="size-4" aria-hidden="true" />
      {e.kind === 'report' ? (
        e.reportNo
      ) : (
        <>
          {label}
          <span className="text-dust">· {e.reportNo}</span>
        </>
      )}
    </>
  );
  const chip =
    'inline-flex min-h-7 items-center gap-1 rounded-chip border border-rebar bg-chalk px-2 font-mono text-[12px] font-medium';
  return canOpen ? (
    <Link
      to={evidenceHref(e)}
      className={cn(chip, 'text-level hover:border-iron')}
      aria-label={
        e.kind === 'report'
          ? t('hours.openReport', { no: e.reportNo })
          : t('hours.openReportAt', { no: e.reportNo, source: label })
      }
      data-testid="evidence-link"
      data-kind={e.kind}
    >
      {body}
    </Link>
  ) : (
    <span className={cn(chip, 'text-asphalt')} data-testid="evidence-report" data-kind={e.kind}>
      {body}
    </span>
  );
}

export function InvoiceCheckAside({
  invoice,
  row,
  onClose,
}: {
  invoice: InvoiceDetail;
  row: HoursRow;
  onClose: () => void;
}) {
  const { t, language } = useCopy();
  const setStatus = useSetInvoiceStatus();
  const { role } = useAuth();
  const canOpenReports = canAccess(role, ROUTE_ROLES.reports ?? []);
  const scrollRegion = useScrollRegion(t('hours.invoiceCheck'));
  const hasGapDay = invoice.days.some((d) => Math.abs(d.gap) >= 0.005);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const mailto = buildQueryMailto(invoice, origin, t, language, { links: canOpenReports });
  const period = `${monthDay(invoice.periodStart, language)} – ${monthDay(invoice.periodEnd, language)}`;
  const num = (n: number) => formatNumberIn(n, language);
  const signed = (n: number) => formatSignedHoursIn(n, language, { unit: false });

  return (
    <Card data-testid="invoice-check">
      <CardHeader className="items-start">
        <div className="min-w-0">
          <div className="eyebrow text-dust">{t('hours.invoiceCheck')}</div>
          <h2 className="font-h2 mt-1 text-h2">{row.companyName}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-dust">
            <span className="font-mono">
              {t('hours.invoice', { no: invoice.invoiceNo, period })}
            </span>
            <span
              className={cn(
                'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
                STATUS_STYLE[invoice.status],
              )}
              data-testid="invoice-status"
            >
              {t(`chips.${invoice.status}`)}
            </span>
          </div>
        </div>
        <Button variant="subtle" size="iconDense" aria-label={t('common.close')} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="px-0 pt-4">
        <div {...scrollRegion} className="overflow-x-auto scrollbar-thin">
          <Table aria-label={t('hours.invoiceCheck')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('hours.compare.day')}</TableHead>
                <TableHead numeric>{t('hours.compare.invoice')}</TableHead>
                <TableHead numeric>{t('hours.compare.reports')}</TableHead>
                <TableHead numeric>{t('hours.compare.gap')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.days.map((d) => (
                <TableRow key={d.date} tone={Math.abs(d.gap) >= 0.005 ? 'attention' : 'default'}>
                  <TableCell className="py-2">
                    <span className="font-medium">{formatDate(d.date, 'short', language)}</span>
                  </TableCell>
                  <TableCell numeric className="py-2">
                    {num(d.invoiced)}
                  </TableCell>
                  <TableCell numeric className="py-2">
                    {num(d.reported)}
                  </TableCell>
                  <TableCell
                    numeric
                    className={cn(
                      'py-2',
                      Math.abs(d.gap) >= 0.005 && 'font-semibold text-signal-deep',
                    )}
                  >
                    {signed(d.gap)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="py-2">{t('common.total')}</TableCell>
                <TableCell numeric className="py-2">
                  {num(invoice.totals.invoiced)}
                </TableCell>
                <TableCell numeric className="py-2">
                  {num(invoice.totals.reported)}
                </TableCell>
                <TableCell
                  numeric
                  className={cn('py-2', invoice.totals.gap !== 0 && 'text-signal-deep')}
                  data-testid="invoice-total-gap"
                >
                  {signed(invoice.totals.gap)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>

        <div className="px-5 pt-5">
          <h3 className="eyebrow text-dust">{t('hours.evidence')}</h3>
          {invoice.evidence.length === 0 ? (
            <p className="mt-2 text-caption text-dust">
              {hasGapDay ? t('hours.noReportEvidence') : t('hours.noEvidence')}
            </p>
          ) : (
            <ul
              className="mt-2 max-h-[400px] space-y-3 overflow-y-auto scrollbar-thin"
              data-testid="invoice-evidence"
            >
              {invoice.evidence.map((e) => (
                <li
                  key={`${e.reportId}-${e.date}`}
                  className="rounded-card border border-rebar p-3"
                  data-kind={e.kind}
                >
                  <div className="eyebrow text-dust">
                    {t('hours.evidenceFor', {
                      date: formatDate(e.date, 'short', language),
                      site: e.siteName,
                    })}
                  </div>
                  <blockquote className="mt-1 text-[15px] leading-[22px]">
                    “{evidenceQuote(e, t, language)}”
                  </blockquote>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <EvidenceChip e={e} canOpen={canOpenReports} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
      <CardFooter className="flex-wrap">
        <Button
          variant="primary"
          size="dense"
          asChild
          className={cn(invoice.status === 'resolved' && 'pointer-events-none opacity-50')}
          onClick={() => {
            if (invoice.status === 'open')
              setStatus.mutate({ invoiceId: invoice.invoiceId, status: 'queried' });
          }}
        >
          <a
            href={mailto}
            data-testid="send-query"
            aria-disabled={invoice.status === 'resolved' || undefined}
          >
            <Mail aria-hidden="true" />
            {t('hours.sendQuery')}
          </a>
        </Button>
        <Button
          variant="ghost"
          size="dense"
          loading={setStatus.isPending}
          disabled={invoice.status === 'resolved'}
          onClick={() => setStatus.mutate({ invoiceId: invoice.invoiceId, status: 'resolved' })}
        >
          <CheckCheck aria-hidden="true" />
          {t('hours.markResolved')}
        </Button>
      </CardFooter>
    </Card>
  );
}
