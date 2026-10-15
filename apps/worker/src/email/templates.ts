import {
  colors,
  formatDate,
  formatDateShort,
  formatHours,
  formatHoursIn,
  type ReportLanguage,
  type ReportTotals,
} from '@sitelog/shared';
import { REPORT_EMAIL_COPY, type ReportEmailCopy } from './report-copy';
import type { DigestStats } from '../db';

/**
 * §13 email content. SiteLog-styled (tokens from §14), table layout for mail clients, text alternative
 * for every message, no emoji. Subjects follow `Daily report · {site short} · {Ddd Mon d} · {report_no}`.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** §14.1 colours from the shared tokens (packages/shared/src/tokens.ts). */
const T = colors;

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "Riverside Lofts — Block B" → "Riverside Lofts" */
export function siteShort(name: string): string {
  return name.split(/\s+[—–-]\s+/)[0]?.trim() || name;
}

export function layout(opts: {
  title: string;
  eyebrow?: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  footerNote?: string;
}): string {
  const cta = opts.cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 8px 0"><tr><td style="background:${T.signal};border-radius:6px">
        <a href="${esc(opts.cta.url)}" style="display:inline-block;padding:12px 20px;font:700 15px/20px Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${T.asphalt};text-decoration:none">${esc(opts.cta.label)}</a></td></tr></table>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:${T.concrete};font-family:Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${T.asphalt}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${T.concrete}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:${T.chalk};border:1px solid ${T.rebar};border-radius:8px">
<tr><td style="padding:20px 28px;border-bottom:2px solid ${T.asphalt}">
  <table role="presentation" cellspacing="0" cellpadding="0"><tr>
    <td style="width:28px;height:28px;background:${T.signal};border-radius:6px"></td>
    <td style="padding-left:10px;font:800 18px/28px Archivo,Helvetica,Arial,sans-serif;letter-spacing:-0.01em">SiteLog</td>
  </tr></table>
</td></tr>
<tr><td style="padding:24px 28px 8px 28px">
  ${opts.eyebrow ? `<div style="font:500 12px/18px 'IBM Plex Mono',Menlo,monospace;letter-spacing:0.08em;text-transform:uppercase;color:${T.dust}">${esc(opts.eyebrow)}</div>` : ''}
  <h1 style="margin:6px 0 16px 0;font:800 24px/30px Archivo,Helvetica,Arial,sans-serif;letter-spacing:-0.01em">${esc(opts.title)}</h1>
  <div style="font:400 15px/22px Archivo,Helvetica,Arial,sans-serif">${opts.bodyHtml}</div>
  ${cta}
</td></tr>
<tr><td style="padding:16px 28px 22px 28px;border-top:1px solid ${T.rebar};font:500 12px/18px Archivo,Helvetica,Arial,sans-serif;color:${T.dust}">
  ${esc(opts.footerNote ?? REPORT_EMAIL_COPY.en.footer)}
</td></tr>
</table></td></tr></table></body></html>`;
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:6px 12px 6px 0;font:500 12px/18px 'IBM Plex Mono',Menlo,monospace;letter-spacing:0.08em;text-transform:uppercase;color:${T.dust};white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;font:400 15px/22px Archivo,Helvetica,Arial,sans-serif">${value}</td></tr>`;
}

function kv(rows: Array<[string, string]>): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 12px 0">${rows.map(([k, v]) => row(k, v)).join('')}</table>`;
}

function chip(text: string, bg: string, fg: string): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${bg};color:${fg};font:600 12px/18px Archivo,Helvetica,Arial,sans-serif">${esc(text)}</span>`;
}

function reasonLabel(r: string, c: ReportEmailCopy = REPORT_EMAIL_COPY.en): string {
  const [kind, detail] = r.split(':');
  switch (kind) {
    case 'unknown_company':
      return `${c.reasons.unknownCompany}${detail ? `: ${detail}` : ''}`;
    case 'low_confidence':
      return `${c.reasons.lowConfidence}${detail ? ` (${detail})` : ''}`;
    case 'unanswered':
      return `${c.reasons.unanswered}${detail ? ` (${detail})` : ''}`;
    case 'unconfirmed':
      return c.reasons.unconfirmed;
    case 'missing':
      return `${c.reasons.missing}${detail ? `: ${detail.replace(/_/g, ' ')}` : ''}`;
    default:
      return r.replace(/_/g, ' ');
  }
}

// ---------------------------------------------------------------------------------------------

export interface ReportFiledInput {
  kind: 'report_filed' | 'report_updated';
  /**
   * The org's report language (§9.6, `data.reportLanguage`): EN or TR subject and body (§13;
   * W1-15). Default EN.
   */
  language?: ReportLanguage;
  orgName: string;
  siteName: string;
  reportNo: string;
  reportDate: string;
  version: number;
  changeNote: string | null;
  summary: string;
  totals: ReportTotals;
  reviewReasons: string[];
  isLate: boolean;
  reporterFirstName: string | null;
  url: string;
}

/**
 * §13 "Report filed" / "Report updated": subject `Daily report · {site} · {date} · {report_no}`
 * (TR `Günlük rapor · …`), the day's numbers, the summary, review reasons and the PDF attached,
 * in the report's language; the footer names no channel (W1-15: no WhatsApp).
 */
export function reportFiledEmail(i: ReportFiledInput): RenderedEmail {
  const lang = i.language ?? 'en';
  const c = REPORT_EMAIL_COPY[lang];
  const locale = lang === 'tr' ? 'tr-TR' : 'en-US';
  const updated = i.kind === 'report_updated';
  const date = formatDate(i.reportDate, 'short', locale);
  const site = siteShort(i.siteName);
  const subject = updated
    ? c.subjectUpdated(i.reportNo, site, date, i.version)
    : c.subjectFiled(site, date, i.reportNo);
  const crew = i.totals.headcountKnown
    ? c.crew(i.totals.crewOnSite, i.totals.subcontractors)
    : c.headcountPending;
  const hours = i.totals.hoursKnown ? formatHoursIn(i.totals.totalHours, locale) : c.hoursPending;
  const weather = i.totals.weatherAffected
    ? c.weatherLost(formatHoursIn(i.totals.lostHours, locale))
    : c.noWeatherStop;
  const chips = [
    ...(i.isLate ? [chip(c.late, T.chipAwaitBg, T.chipAwaitFg)] : []),
    ...(i.reviewReasons.length
      ? [chip(c.needsReview, T.chipReviewBg, T.chipReviewFg)]
      : [chip(updated ? c.versionChip(i.version) : c.filedChip, T.chipFiledBg, T.chipFiledFg)]),
  ].join(' ');
  const reasons = i.reviewReasons.length
    ? `<p style="margin:12px 0 0 0"><strong>${esc(c.reviewReasons)}</strong></p><ul style="margin:4px 0 0 18px;padding:0">${i.reviewReasons.map((r) => `<li>${esc(reasonLabel(r, c))}</li>`).join('')}</ul>`
    : '';
  const change =
    updated && i.changeNote
      ? `<p style="margin:0 0 12px 0;padding:10px 12px;background:${T.concrete};border-radius:6px"><strong>${esc(c.updatedLabel)}</strong> ${esc(i.changeNote)}</p>`
      : '';
  const bodyHtml = `${chips ? `<p style="margin:0 0 12px 0">${chips}</p>` : ''}${change}
    ${kv([
      [c.labels.site, esc(i.siteName)],
      [c.labels.date, esc(date)],
      [c.labels.report, `${esc(i.reportNo)} · v${i.version}`],
      [c.labels.crew, esc(crew)],
      [c.labels.hours, esc(hours)],
      [c.labels.weather, esc(weather)],
      ...(i.reporterFirstName
        ? [[c.labels.reportedBy, esc(i.reporterFirstName)] as [string, string]]
        : []),
    ])}
    <p style="margin:0">${esc(i.summary || c.noSummary)}</p>${reasons}
    <p style="margin:16px 0 0 0;color:${T.dust}">${esc(c.pdfAttached)}</p>`;
  const text = [
    subject,
    '',
    ...(updated && i.changeNote ? [`${c.updatedLabel} ${i.changeNote}`, ''] : []),
    `${c.labels.site}: ${i.siteName}`,
    `${c.labels.date}: ${date}`,
    `${c.labels.report}: ${i.reportNo} v${i.version}`,
    `${c.labels.crew}: ${crew}`,
    `${c.labels.hours}: ${hours}`,
    `${c.labels.weather}: ${weather}`,
    ...(i.isLate ? [c.late] : []),
    '',
    i.summary || c.noSummary,
    ...(i.reviewReasons.length
      ? ['', `${c.reviewReasons}:`, ...i.reviewReasons.map((r) => `- ${reasonLabel(r, c)}`)]
      : []),
    '',
    `${c.open}: ${i.url}`,
    c.pdfAttached,
    '',
    c.footer,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: updated ? c.titleUpdated(i.reportNo) : c.titleFiled(i.reportNo),
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: c.open, url: i.url },
      footerNote: c.footer,
    }),
    text,
  };
}

export interface ReportMissingInput {
  orgName: string;
  siteName: string;
  date: string;
  reporterFirstName: string | null;
  reporterPhone: string | null;
  url: string;
}

export function reportMissingEmail(i: ReportMissingInput): RenderedEmail {
  const who = i.reporterFirstName ?? 'The site manager';
  const subject = `${siteShort(i.siteName)} — no report · ${formatDateShort(i.date)}`;
  // Spec §19 Q55: no reminder is sent until M6 brings the ladder back, so none is mentioned.
  const line = `${i.siteName} — no report. ${who} hasn't sent the report for ${formatDateShort(i.date)}, and the deadline has passed.`;
  const call = i.reporterPhone
    ? `<p style="margin:12px 0 0 0"><a href="tel:${esc(i.reporterPhone)}" style="color:${T.level}">Call ${esc(who)}</a></p>`
    : '';
  const bodyHtml = `<p style="margin:0 0 8px 0">${chip('Missing', T.chipMissBg, T.chipMissFg)}</p><p style="margin:0">${esc(line)}</p>${call}`;
  const text = [
    subject,
    '',
    line,
    ...(i.reporterPhone ? [`Call ${who}: ${i.reporterPhone}`] : []),
    '',
    `Open in SiteLog: ${i.url}`,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: 'No report',
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: 'Open in SiteLog', url: i.url },
    }),
    text,
  };
}

export interface InvoiceQueryInput {
  orgName: string;
  companyName: string;
  invoiceNo: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  invoicedHours: number;
  reportedHours: number;
  url: string;
}

export function invoiceQueryEmail(i: InvoiceQueryInput): RenderedEmail {
  const gap = Math.round((i.invoicedHours - i.reportedHours) * 100) / 100;
  const period =
    i.periodStart && i.periodEnd
      ? `${formatDateShort(i.periodStart)} – ${formatDateShort(i.periodEnd)}`
      : 'the invoice period';
  const subject = `Hours query · ${i.companyName}${i.invoiceNo ? ` · ${i.invoiceNo}` : ''}`;
  const bodyHtml = `<p style="margin:0 0 12px 0">${esc(i.orgName)} compared invoice ${esc(i.invoiceNo ?? '')} with the daily site reports for ${esc(period)}.</p>
    ${kv([
      ['Invoiced', `${formatHours(i.invoicedHours)}`],
      ['Reported', `${formatHours(i.reportedHours)}`],
      [
        'Difference',
        `<strong style="color:${gap > 0 ? T.missing : T.filed}">${gap > 0 ? '+' : ''}${formatHours(gap)}</strong>`,
      ],
    ])}
    <p style="margin:0">Could you check the days where the hours differ? The daily reports with audio evidence are available on request.</p>`;
  const text = [
    subject,
    '',
    `${i.orgName} compared invoice ${i.invoiceNo ?? ''} with the daily site reports for ${period}.`,
    `Invoiced: ${formatHours(i.invoicedHours)}`,
    `Reported: ${formatHours(i.reportedHours)}`,
    `Difference: ${gap > 0 ? '+' : ''}${formatHours(gap)}`,
    '',
    'Could you check the days where the hours differ?',
  ].join('\n');
  return {
    subject,
    html: layout({
      title: 'Hours query',
      eyebrow: i.orgName,
      bodyHtml,
      footerNote: 'Sent with SiteLog.',
    }),
    text,
  };
}

export interface EvidencePackReadyInput {
  orgName: string;
  siteName: string;
  periodStart: string;
  periodEnd: string;
  downloadUrl: string;
  panelUrl: string;
}

export function evidencePackReadyEmail(i: EvidencePackReadyInput): RenderedEmail {
  const subject = `EOT evidence pack ready · ${siteShort(i.siteName)} · ${formatDateShort(i.periodStart)} – ${formatDateShort(i.periodEnd)}`;
  const bodyHtml = `<p style="margin:0 0 12px 0">The evidence pack for ${esc(i.siteName)}, ${esc(formatDateShort(i.periodStart))} – ${esc(formatDateShort(i.periodEnd))}, is ready.</p>
    <p style="margin:0">The download link is valid for 7 days. Weather data: Open-Meteo.</p>`;
  const text = [
    subject,
    '',
    `Download (valid 7 days): ${i.downloadUrl}`,
    `Weather & delays: ${i.panelUrl}`,
    'Weather data: Open-Meteo.',
  ].join('\n');
  return {
    subject,
    html: layout({
      title: 'Evidence pack ready',
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: 'Download the pack', url: i.downloadUrl },
    }),
    text,
  };
}

export interface WeeklyDigestInput {
  orgName: string;
  weekStart: string;
  weekEnd: string;
  stats: DigestStats;
  url: string;
}

export function weeklyDigestEmail(i: WeeklyDigestInput): RenderedEmail {
  const s = i.stats;
  const onTimePct = s.siteDays ? Math.round((s.onTime / s.siteDays) * 100) : 0;
  const subject = `SiteLog weekly · ${formatDateShort(i.weekStart)} – ${formatDateShort(i.weekEnd)} · ${onTimePct}% on time`;
  const weather = s.weatherHoursBySite.length
    ? s.weatherHoursBySite
        .map((w) => `<li>${esc(w.siteName)}: ${esc(formatHours(w.hours))}</li>`)
        .join('')
    : '<li>No weather stoppages</li>';
  const gaps = s.invoiceGaps.length
    ? s.invoiceGaps
        .map(
          (g) =>
            `<li>${esc(g.companyName)}: ${g.gap > 0 ? '+' : ''}${esc(formatHours(g.gap))}</li>`,
        )
        .join('')
    : '<li>No open invoice gaps</li>';
  const unsigned = s.unsigned.length
    ? s.unsigned
        .map(
          (u) =>
            `<li>${esc(u.reportNo)} · ${esc(u.siteName)} · ${esc(formatDateShort(u.date))}</li>`,
        )
        .join('')
    : '<li>All filed reports are signed off</li>';
  const bodyHtml = `${kv([
    [
      'On time',
      `<strong>${onTimePct}%</strong> (${s.onTime} of ${s.siteDays} site-days; ${s.filed} filed)`,
    ],
  ])}
    <p style="margin:8px 0 4px 0"><strong>Weather hours by site</strong></p><ul style="margin:0 0 12px 18px;padding:0">${weather}</ul>
    <p style="margin:8px 0 4px 0"><strong>Invoice gaps</strong></p><ul style="margin:0 0 12px 18px;padding:0">${gaps}</ul>
    <p style="margin:8px 0 4px 0"><strong>Unsigned reports</strong></p><ul style="margin:0 0 12px 18px;padding:0">${unsigned}</ul>`;
  const text = [
    subject,
    '',
    `On time: ${onTimePct}% (${s.onTime} of ${s.siteDays} site-days; ${s.filed} filed)`,
    '',
    'Weather hours by site:',
    ...(s.weatherHoursBySite.length
      ? s.weatherHoursBySite.map((w) => `- ${w.siteName}: ${formatHours(w.hours)}`)
      : ['- No weather stoppages']),
    '',
    'Invoice gaps:',
    ...(s.invoiceGaps.length
      ? s.invoiceGaps.map((g) => `- ${g.companyName}: ${g.gap > 0 ? '+' : ''}${formatHours(g.gap)}`)
      : ['- No open invoice gaps']),
    '',
    'Unsigned reports:',
    ...(s.unsigned.length
      ? s.unsigned.map((u) => `- ${u.reportNo} · ${u.siteName} · ${formatDateShort(u.date)}`)
      : ['- All filed reports are signed off']),
    '',
    `Open SiteLog: ${i.url}`,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: 'Weekly digest',
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: 'Open SiteLog', url: i.url },
    }),
    text,
  };
}

export interface UnknownContactInput {
  orgName: string;
  phone: string;
  snippet: string | null;
  url: string;
}

export function unknownContactEmail(i: UnknownContactInput): RenderedEmail {
  const subject = 'Unknown number tried to report';
  const bodyHtml = `${kv([
    ['Number', esc(i.phone)],
    ['Message', esc(i.snippet ?? '(no text)')],
  ])}<p style="margin:0">Link the number to a site or ignore it on the Team page. Nothing was filed.</p>`;
  const text = [
    subject,
    '',
    `Number: ${i.phone}`,
    `Message: ${i.snippet ?? '(no text)'}`,
    '',
    'Nothing was filed. Link or ignore it on the Team page:',
    i.url,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: subject,
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: 'Open Team & numbers', url: i.url },
    }),
    text,
  };
}

export interface ReportEditedAfterSignoffInput {
  orgName: string;
  reportNo: string;
  changeNote: string;
  version: number;
  url: string;
}

export function reportEditedAfterSignoffEmail(i: ReportEditedAfterSignoffInput): RenderedEmail {
  const subject = `${i.reportNo} was edited after sign-off`;
  const bodyHtml = `<p style="margin:0 0 12px 0">${esc(i.reportNo)} was edited after you signed it off. Version ${i.version} needs a fresh sign-off.</p>
    <p style="margin:0;padding:10px 12px;background:${T.concrete};border-radius:6px"><strong>Change:</strong> ${esc(i.changeNote || '(no note)')}</p>`;
  const text = [
    subject,
    '',
    `${i.reportNo} was edited after you signed it off. Version ${i.version} needs a fresh sign-off.`,
    `Change: ${i.changeNote || '(no note)'}`,
    '',
    `Review: ${i.url}`,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: subject,
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: 'Review the report', url: i.url },
    }),
    text,
  };
}
