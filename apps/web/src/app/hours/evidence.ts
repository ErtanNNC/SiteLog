/** Crew hours evidence (P8, W3-06): chip labels, quotes, P7 links and the query email. */
import { formatAudioTimestamp, formatDate } from '@sitelog/shared/format.ts';
import type { InvoiceDetail, InvoiceEvidence } from '@/data/types';
import type { PanelLanguage } from '@/i18n/language';
import type { CopyT } from '@/i18n/useCopy';
import { formatNumberIn, formatSignedHoursIn } from '@/lib/localeFormat';

export const monthDay = (date: string, language: PanelLanguage) =>
  formatDate(date, 'monthDay', language);

/**
 * The evidence's source as a chip label (P8 "evidence links can be voice-note or call
 * timestamps"): "audio 0:41", "call 2:15", "voice note", "answer", or the report.
 */
export function evidenceSourceLabel(e: InvoiceEvidence, t: CopyT): string {
  const ts = e.at !== null ? formatAudioTimestamp(e.at) : null;
  switch (e.kind) {
    case 'call':
      return ts !== null ? t('source.links.call', { ts }) : t('player.labelCall');
    case 'voice_note':
      return ts !== null ? t('source.links.audio', { ts }) : t('hours.evidenceKinds.voiceNote');
    case 'answer':
      return t('hours.evidenceKinds.answer');
    case 'report':
      return t('hours.evidenceKinds.report');
  }
}

/** The words behind a gap day, or its crew lines when there are none to read. */
export function evidenceQuote(e: InvoiceEvidence, t: CopyT, language: PanelLanguage): string {
  if (e.quote) return e.quote;
  const hours = (h: number) => `${formatNumberIn(h, language)} ${t('common.hoursUnit')}`;
  return t('hours.crewQuote', {
    company: e.crew.company,
    lines: e.crew.lines
      .map((l) => t('hours.crewLine', { workers: l.workers, hours: hours(l.hoursEach) }))
      .join(', '),
    total: hours(e.crew.total),
  });
}

/** P7 at the cited second: `/reports/:id?clip=<voice note or call>&at=<s>` (W3-06). */
export function evidenceHref(e: InvoiceEvidence): string {
  const base = `/reports/${e.reportId}`;
  if (!e.clipId) return base;
  const q = new URLSearchParams({ clip: e.clipId });
  if (e.at !== null) q.set('at', String(Math.floor(e.at)));
  return `${base}?${q.toString()}`;
}

/**
 * mailto: draft with the day-by-day comparison and each gap day's evidence: the report number, the
 * source (voice note or call second, answer) and the words (F19 "Send query with evidence"). The
 * report link only for roles that can open reports (§2.2: not accounts).
 */
export function buildQueryMailto(
  invoice: InvoiceDetail,
  origin: string,
  t: CopyT,
  language: PanelLanguage,
  opts: { links: boolean } = { links: true },
): string {
  const period = `${monthDay(invoice.periodStart, language)} – ${monthDay(invoice.periodEnd, language)}`;
  const h = (n: number) => `${formatNumberIn(n, language)} ${t('common.hoursUnit')}`;
  const signed = (n: number) => formatSignedHoursIn(n, language, { unit: false });
  const lines = [
    t('hours.queryMail.intro', {
      company: invoice.companyName,
      no: invoice.invoiceNo,
      period,
    }),
    '',
    ...invoice.days.map((d) =>
      t('hours.queryMail.row', {
        date: formatDate(d.date, 'short', language),
        invoiced: h(d.invoiced),
        reported: h(d.reported),
        gap: signed(d.gap),
      }),
    ),
    t('hours.queryMail.total', {
      invoiced: h(invoice.totals.invoiced),
      reported: h(invoice.totals.reported),
      gap: signed(invoice.totals.gap),
    }),
  ];
  if (invoice.evidence.length) {
    lines.push('', t('hours.queryMail.evidence'));
    for (const e of invoice.evidence) {
      const line = t('hours.queryMail.evidenceLine', {
        date: monthDay(e.date, language),
        site: e.siteName,
        reportNo: e.reportNo,
        source: evidenceSourceLabel(e, t),
        quote: evidenceQuote(e, t, language),
      });
      lines.push(opts.links ? `${line} ${origin}${evidenceHref(e)}` : line);
    }
  }
  lines.push('', t('hours.queryMail.outro'));
  const params = new URLSearchParams({
    subject: t('hours.queryMail.subject', { no: invoice.invoiceNo }),
    body: lines.join('\n'),
  });
  return `mailto:?${params.toString().replace(/\+/g, '%20')}`;
}
