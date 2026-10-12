import { CheckCheck, FileText, Mail, Mic, X } from 'lucide-react';
import { Link } from 'react-router';
import { formatAudioTimestamp } from '@sitelog/shared/format.ts';
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
import { copy } from '@/copy/en';
import { useSetInvoiceStatus } from '@/data/hooks';
import type { HoursRow, InvoiceDetail, InvoiceEvidence } from '@/data/types';
import { formatHoursNum, formatMonthDay, weekdayName } from '@/lib/format';
import { useScrollRegion } from '@/lib/useScrollRegion';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<InvoiceDetail['status'], string> = {
  open: 'border-rebar bg-concrete text-dust',
  queried: 'border-chip-await-bg bg-chip-await-bg text-chip-await-fg',
  resolved: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg',
};

function signed(h: number): string {
  if (Math.abs(h) < 0.005) return '0';
  return `${h > 0 ? '+' : '−'}${formatHoursNum(Math.abs(h))}`;
}

/** mailto: draft with the day-by-day comparison and report links (F15 step 4). */
export function buildQueryMailto(invoice: InvoiceDetail, origin: string): string {
  const m = copy.hours.queryMail;
  const period = `${formatMonthDay(invoice.periodStart)} – ${formatMonthDay(invoice.periodEnd)}`;
  const h = (n: number) => `${formatHoursNum(n)} h`;
  const lines = [
    m.intro(invoice.companyName, invoice.invoiceNo, period),
    '',
    ...invoice.days.map((d) =>
      m.row(
        `${weekdayName(d.date)} ${formatMonthDay(d.date)}`,
        h(d.invoiced),
        h(d.reported),
        signed(d.gap),
      ),
    ),
    m.total(h(invoice.totals.invoiced), h(invoice.totals.reported), signed(invoice.totals.gap)),
  ];
  if (invoice.evidence.length) {
    lines.push('', m.evidence);
    for (const e of invoice.evidence) {
      lines.push(
        `- ${formatMonthDay(e.date)} · ${e.siteName} · ${e.reportNo}: “${e.quote}” ${origin}/reports/${e.reportId}`,
      );
    }
  }
  lines.push('', m.outro);
  const params = new URLSearchParams({
    subject: m.subject(invoice.companyName, invoice.invoiceNo),
    body: lines.join('\n'),
  });
  return `mailto:?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * The report behind a gap day: its voice note when it has one (a typed report has none), linked
 * to the report for the roles that can open reports (an accounts user sees the number only).
 */
function EvidenceChip({ e, canOpen }: { e: InvoiceEvidence; canOpen: boolean }) {
  const audio = e.audioStart !== null || !!e.messageId;
  const body = (
    <>
      {audio ? (
        <Mic className="size-4" aria-hidden="true" />
      ) : (
        <FileText className="size-4" aria-hidden="true" />
      )}
      {audio ? (
        <>
          {e.audioStart !== null
            ? copy.hours.audioLink(formatAudioTimestamp(e.audioStart))
            : copy.source.audio('').trim()}
          <span className="text-dust">· {e.reportNo}</span>
        </>
      ) : (
        e.reportNo
      )}
    </>
  );
  const chip =
    'inline-flex h-7 items-center gap-1 rounded-chip border border-rebar bg-chalk px-2 font-mono text-[12px] font-medium';
  return canOpen ? (
    <Link
      to={`/reports/${e.reportId}`}
      className={cn(chip, 'text-level hover:border-iron')}
      aria-label={copy.hours.openReport(e.reportNo)}
    >
      {body}
    </Link>
  ) : (
    <span className={cn(chip, 'text-asphalt')} data-testid="evidence-report">
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
  const setStatus = useSetInvoiceStatus();
  const { role } = useAuth();
  const canOpenReports = canAccess(role, ROUTE_ROLES.reports ?? []);
  const scrollRegion = useScrollRegion(copy.hours.invoiceCheck);
  const hasGapDay = invoice.days.some((d) => Math.abs(d.gap) >= 0.005);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const mailto = buildQueryMailto(invoice, origin);
  const period = `${formatMonthDay(invoice.periodStart)} – ${formatMonthDay(invoice.periodEnd)}`;

  return (
    <Card data-testid="invoice-check">
      <CardHeader className="items-start">
        <div className="min-w-0">
          <div className="eyebrow text-dust">{copy.hours.invoiceCheck}</div>
          <h2 className="font-h2 mt-1 text-h2">{row.companyName}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-dust">
            <span className="font-mono">{copy.hours.invoice(invoice.invoiceNo, period)}</span>
            <span
              className={cn(
                'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
                STATUS_STYLE[invoice.status],
              )}
              data-testid="invoice-status"
            >
              {copy.chips[invoice.status]}
            </span>
          </div>
        </div>
        <Button variant="subtle" size="iconDense" aria-label={copy.common.close} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="px-0 pt-4">
        <div {...scrollRegion} className="overflow-x-auto scrollbar-thin">
          <Table aria-label={copy.hours.invoiceCheck}>
            <TableHeader>
              <TableRow>
                <TableHead>{copy.hours.compare.day}</TableHead>
                <TableHead numeric>{copy.hours.compare.invoice}</TableHead>
                <TableHead numeric>{copy.hours.compare.reports}</TableHead>
                <TableHead numeric>{copy.hours.compare.gap}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.days.map((d) => (
                <TableRow key={d.date} tone={Math.abs(d.gap) >= 0.005 ? 'attention' : 'default'}>
                  <TableCell className="py-2">
                    <span className="font-medium">{weekdayName(d.date).slice(0, 3)}</span>{' '}
                    <span className="text-caption text-dust">{formatMonthDay(d.date)}</span>
                  </TableCell>
                  <TableCell numeric className="py-2">
                    {formatHoursNum(d.invoiced)}
                  </TableCell>
                  <TableCell numeric className="py-2">
                    {formatHoursNum(d.reported)}
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
                <TableCell className="py-2">{copy.common.total}</TableCell>
                <TableCell numeric className="py-2">
                  {formatHoursNum(invoice.totals.invoiced)}
                </TableCell>
                <TableCell numeric className="py-2">
                  {formatHoursNum(invoice.totals.reported)}
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
          <h3 className="eyebrow text-dust">{copy.hours.evidence}</h3>
          {invoice.evidence.length === 0 ? (
            <p className="mt-2 text-caption text-dust">
              {hasGapDay ? copy.hours.noReportEvidence : copy.hours.noEvidence}
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
                >
                  <div className="eyebrow text-dust">
                    {copy.hours.evidenceFor(formatMonthDay(e.date), e.siteName)}
                  </div>
                  <blockquote className="mt-1 text-[15px] leading-[22px]">“{e.quote}”</blockquote>
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
            {copy.hours.sendQuery}
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
          {copy.hours.markResolved}
        </Button>
      </CardFooter>
    </Card>
  );
}
