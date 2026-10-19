import {
  colors,
  formatDate,
  formatHoursIn,
  type ReportLanguage,
  type ReportTotals,
} from '@sitelog/shared';
import { OFFICE_EMAIL_COPY } from './office-copy';
import { REPORT_EMAIL_COPY, type ReportEmailCopy } from './report-copy';
import type { DigestStats } from '../db';

/**
 * §13 email content. TalkOlog-styled (tokens from §14), table layout for mail clients, text alternative
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
    <td style="padding-left:10px;font:800 18px/28px Archivo,Helvetica,Arial,sans-serif;letter-spacing:-0.01em">TalkOlog</td>
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

/** BCP 47 locale for the email's language (dates, hours). */
function localeOf(lang: ReportLanguage): 'en-US' | 'tr-TR' {
  return lang === 'tr' ? 'tr-TR' : 'en-US';
}

/** "Fri Oct 9" · "Cum 9 Eki" */
function shortDate(date: string, lang: ReportLanguage): string {
  return formatDate(date, 'short', localeOf(lang));
}

/** "16 h" · "16 sa"; signed with + when asked. */
function hoursIn(hours: number, lang: ReportLanguage, signed = false): string {
  return `${signed && hours > 0 ? '+' : ''}${formatHoursIn(hours, localeOf(lang))}`;
}

/**
 * The office emails take `language` (W4-09, spec §19 Q239): the reader's panel language
 * (`OFFICE_EMAIL_LANGUAGE`, chosen per recipient by the send_email job), or for the invoice query
 * the org's report language. Default EN. Copy: `./office-copy.ts`.
 */
export interface OfficeEmailLanguage {
  language?: ReportLanguage;
}

export interface ReportMissingInput extends OfficeEmailLanguage {
  orgName: string;
  siteName: string;
  date: string;
  reporterFirstName: string | null;
  reporterPhone: string | null;
  url: string;
  /** The reminders (R1, R2) that reached the reporter (W2-06); 0 or absent = none. */
  reminders?: number;
}

export function reportMissingEmail(i: ReportMissingInput): RenderedEmail {
  const lang = i.language ?? 'en';
  const c = OFFICE_EMAIL_COPY[lang];
  const who = i.reporterFirstName ?? c.missing.someone;
  const date = shortDate(i.date, lang);
  const subject = c.missing.subject(siteShort(i.siteName), date);
  // §13 "{first} didn't answer {n} reminders" when the ladder reached them (W2-06); with none
  // (every reporter skipped, or nobody linked), spec §19 Q55's wording.
  const n = i.reminders ?? 0;
  const line =
    n > 0 ? c.missing.reminded(i.siteName, who, n) : c.missing.notSent(i.siteName, who, date);
  const call = i.reporterPhone
    ? `<p style="margin:12px 0 0 0"><a href="tel:${esc(i.reporterPhone)}" style="color:${T.level}">${esc(c.missing.call(who))}</a></p>`
    : '';
  const bodyHtml = `<p style="margin:0 0 8px 0">${chip(c.missing.chip, T.chipMissBg, T.chipMissFg)}</p><p style="margin:0">${esc(line)}</p>${call}`;
  const text = [
    subject,
    '',
    line,
    ...(i.reporterPhone ? [c.missing.callText(who, i.reporterPhone)] : []),
    '',
    `${c.open}: ${i.url}`,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: c.missing.title,
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: c.open, url: i.url },
      footerNote: REPORT_EMAIL_COPY[lang].footer,
    }),
    text,
  };
}

export interface InvoiceQueryInput extends OfficeEmailLanguage {
  orgName: string;
  companyName: string;
  invoiceNo: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  invoicedHours: number;
  reportedHours: number;
  url: string;
}

/** To the subcontractor, in the org's report language (§19 Q239). */
export function invoiceQueryEmail(i: InvoiceQueryInput): RenderedEmail {
  const lang = i.language ?? 'en';
  const c = OFFICE_EMAIL_COPY[lang].invoice;
  const gap = Math.round((i.invoicedHours - i.reportedHours) * 100) / 100;
  const period =
    i.periodStart && i.periodEnd
      ? `${shortDate(i.periodStart, lang)} – ${shortDate(i.periodEnd, lang)}`
      : null;
  const subject = c.subject(i.companyName, i.invoiceNo);
  const intro = c.intro(i.orgName, i.invoiceNo, period);
  const bodyHtml = `<p style="margin:0 0 12px 0">${esc(intro)}</p>
    ${kv([
      [c.invoiced, esc(hoursIn(i.invoicedHours, lang))],
      [c.reported, esc(hoursIn(i.reportedHours, lang))],
      [
        c.difference,
        `<strong style="color:${gap > 0 ? T.missing : T.filed}">${esc(hoursIn(gap, lang, true))}</strong>`,
      ],
    ])}
    <p style="margin:0">${esc(c.ask)}</p>`;
  const text = [
    subject,
    '',
    intro,
    `${c.invoiced}: ${hoursIn(i.invoicedHours, lang)}`,
    `${c.reported}: ${hoursIn(i.reportedHours, lang)}`,
    `${c.difference}: ${hoursIn(gap, lang, true)}`,
    '',
    c.askShort,
  ].join('\n');
  return {
    subject,
    html: layout({ title: c.title, eyebrow: i.orgName, bodyHtml, footerNote: c.footer }),
    text,
  };
}

export interface EvidencePackReadyInput extends OfficeEmailLanguage {
  orgName: string;
  /** null: a pack of all the org's sites. */
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  downloadUrl: string;
  panelUrl: string;
}

export function evidencePackReadyEmail(i: EvidencePackReadyInput): RenderedEmail {
  const lang = i.language ?? 'en';
  const c = OFFICE_EMAIL_COPY[lang].pack;
  const from = shortDate(i.periodStart, lang);
  const to = shortDate(i.periodEnd, lang);
  const siteName = i.siteName ?? c.allSites;
  const subject = c.subject(siteShort(siteName), from, to);
  const bodyHtml = `<p style="margin:0 0 12px 0">${esc(c.body(siteName, from, to))}</p>
    <p style="margin:0">${esc(c.validity)}</p>`;
  const text = [
    subject,
    '',
    `${c.download}: ${i.downloadUrl}`,
    `${c.panel}: ${i.panelUrl}`,
    c.weatherData,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: c.title,
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: c.cta, url: i.downloadUrl },
      footerNote: REPORT_EMAIL_COPY[lang].footer,
    }),
    text,
  };
}

export interface WeeklyDigestInput extends OfficeEmailLanguage {
  orgName: string;
  weekStart: string;
  weekEnd: string;
  stats: DigestStats;
  url: string;
}

export function weeklyDigestEmail(i: WeeklyDigestInput): RenderedEmail {
  const lang = i.language ?? 'en';
  const c = OFFICE_EMAIL_COPY[lang].digest;
  const s = i.stats;
  const onTimePct = s.siteDays ? Math.round((s.onTime / s.siteDays) * 100) : 0;
  const subject = c.subject(shortDate(i.weekStart, lang), shortDate(i.weekEnd, lang), onTimePct);
  const list = (items: string[], none: string) =>
    (items.length ? items : [none]).map((x) => `<li>${esc(x)}</li>`).join('');
  const weatherItems = s.weatherHoursBySite.map((w) => `${w.siteName}: ${hoursIn(w.hours, lang)}`);
  const gapItems = s.invoiceGaps.map((g) => `${g.companyName}: ${hoursIn(g.gap, lang, true)}`);
  const unsignedItems = s.unsigned.map(
    (u) => `${u.reportNo} · ${u.siteName} · ${shortDate(u.date, lang)}`,
  );
  // W3-17 (M8): only when TalkOlog called a reporter this week.
  const calls = s.outboundCalls;
  const callsLine = calls
    ? c.callsLine(
        Math.round((calls.filedByCall / calls.callDays) * 100),
        calls.filedByCall,
        calls.callDays,
      )
    : null;
  const detail = c.onTimeDetail(s.onTime, s.siteDays, s.filed);
  const bodyHtml = `${kv([
    [c.onTime, `<strong>${esc(c.percent(onTimePct))}</strong> ${esc(detail)}`],
    ...(callsLine ? ([[c.calls, esc(callsLine)]] as Array<[string, string]>) : []),
  ])}
    <p style="margin:8px 0 4px 0"><strong>${esc(c.weather)}</strong></p><ul style="margin:0 0 12px 18px;padding:0">${list(weatherItems, c.noWeather)}</ul>
    <p style="margin:8px 0 4px 0"><strong>${esc(c.gaps)}</strong></p><ul style="margin:0 0 12px 18px;padding:0">${list(gapItems, c.noGaps)}</ul>
    <p style="margin:8px 0 4px 0"><strong>${esc(c.unsigned)}</strong></p><ul style="margin:0 0 12px 18px;padding:0">${list(unsignedItems, c.allSigned)}</ul>`;
  const bullets = (items: string[], none: string) =>
    (items.length ? items : [none]).map((x) => `- ${x}`);
  const text = [
    subject,
    '',
    `${c.onTime}: ${c.percent(onTimePct)} ${detail}`,
    ...(callsLine ? [`${c.calls}: ${callsLine}`] : []),
    '',
    `${c.weather}:`,
    ...bullets(weatherItems, c.noWeather),
    '',
    `${c.gaps}:`,
    ...bullets(gapItems, c.noGaps),
    '',
    `${c.unsigned}:`,
    ...bullets(unsignedItems, c.allSigned),
    '',
    `${c.openTalkOlog}: ${i.url}`,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: c.title,
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: c.openTalkOlog, url: i.url },
      footerNote: REPORT_EMAIL_COPY[lang].footer,
    }),
    text,
  };
}

export interface UnknownContactInput extends OfficeEmailLanguage {
  orgName: string;
  /** null: the number is not known (the email still says someone tried). */
  phone: string | null;
  snippet: string | null;
  url: string;
}

export function unknownContactEmail(i: UnknownContactInput): RenderedEmail {
  const lang = i.language ?? 'en';
  const c = OFFICE_EMAIL_COPY[lang].unknown;
  const subject = c.subject;
  const phone = i.phone ?? c.unknownNumber;
  const bodyHtml = `${kv([
    [c.number, esc(phone)],
    [c.message, esc(i.snippet ?? c.noText)],
  ])}<p style="margin:0">${esc(c.body)}</p>`;
  const text = [
    subject,
    '',
    `${c.number}: ${phone}`,
    `${c.message}: ${i.snippet ?? c.noText}`,
    '',
    c.textLine,
    i.url,
  ].join('\n');
  return {
    subject,
    html: layout({
      title: subject,
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: c.cta, url: i.url },
      footerNote: REPORT_EMAIL_COPY[lang].footer,
    }),
    text,
  };
}

export interface ReportEditedAfterSignoffInput extends OfficeEmailLanguage {
  orgName: string;
  reportNo: string;
  changeNote: string;
  version: number;
  url: string;
}

export function reportEditedAfterSignoffEmail(i: ReportEditedAfterSignoffInput): RenderedEmail {
  const lang = i.language ?? 'en';
  const c = OFFICE_EMAIL_COPY[lang].edited;
  const subject = c.subject(i.reportNo);
  const body = c.body(i.reportNo, i.version);
  const note = i.changeNote || c.noNote;
  const bodyHtml = `<p style="margin:0 0 12px 0">${esc(body)}</p>
    <p style="margin:0;padding:10px 12px;background:${T.concrete};border-radius:6px"><strong>${esc(c.change)}</strong> ${esc(note)}</p>`;
  const text = [subject, '', body, `${c.change} ${note}`, '', `${c.review}: ${i.url}`].join('\n');
  return {
    subject,
    html: layout({
      title: subject,
      eyebrow: i.orgName,
      bodyHtml,
      cta: { label: c.cta, url: i.url },
      footerNote: REPORT_EMAIL_COPY[lang].footer,
    }),
    text,
  };
}
