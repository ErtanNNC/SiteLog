import type { DailyReportDataV1 } from '../schemas/report.ts';
import { abbreviateArea, formatDraftDate, formatHours } from '../format.ts';
import { deriveTotals, type ReportTotals } from './hours.ts';

export interface DraftCardOptions {
  siteName: string;
  totals?: ReportTotals;
  /** Wrap the card body in a WhatsApp monospace block so the label column lines up. */
  monospace?: boolean;
  footer?: string | null;
  eyebrow?: string;
}

const LABEL_WIDTH = 10;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

export function workItemPhrase(w: DailyReportDataV1['workPerformed'][number]): string {
  const area = w.area ? abbreviateArea(w.area) : '';
  const activity = w.activity.charAt(0).toLowerCase() + w.activity.slice(1);
  let suffix = '';
  switch (w.status) {
    case 'complete':
      suffix = ' complete';
      break;
    case 'in_progress':
      suffix = w.percentComplete !== undefined ? ` ~${w.percentComplete}%` : '';
      break;
    case 'started':
      suffix = ' started';
      break;
    case 'stopped':
      suffix = ' stopped';
      break;
    case 'planned':
      suffix = ' planned';
      break;
  }
  return `${area ? `${area} ` : ''}${activity}${suffix}`.trim();
}

export function weatherPhraseForCard(data: DailyReportDataV1): string {
  const periods = data.weather.periods;
  if (periods.length === 0) return data.weather.conditionsText || 'Not stated';
  return periods
    .map((p) => {
      const range = p.start && p.end ? ` ${p.start}–${p.end}` : p.start ? ` from ${p.start}` : '';
      const impact = p.fullDay
        ? ' · full day lost'
        : p.lostHours > 0
          ? ` · ${p.impact ? shortImpact(p.impact) + ' ' : ''}${formatHours(p.lostHours)}`
          : p.impact
            ? ` · ${shortImpact(p.impact)}`
            : '';
      return `${p.condition}${range}${impact}`;
    })
    .join(' · ');
}

function shortImpact(impact: string): string {
  const first = impact.split(/[;.]/)[0]?.trim() ?? impact;
  const lowered = first.charAt(0).toLowerCase() + first.slice(1);
  return lowered.length > 40 ? `${lowered.slice(0, 39).trimEnd()}…` : lowered;
}

export function safetyPhrase(data: DailyReportDataV1): string {
  const parts: string[] = [];
  if (data.safety.toolboxTalk) parts.push('Toolbox talk');
  if (data.safety.incidents.length > 0) {
    parts.push(
      `${data.safety.incidents.length} incident${data.safety.incidents.length > 1 ? 's' : ''}`,
    );
  } else if (data.safety.noIncidentsStated) {
    parts.push('no incidents');
  }
  return parts.length ? parts.join(' · ') : 'Not stated';
}

/** §F7 — the draft card sent to WhatsApp. */
export function formatDraftCard(data: DailyReportDataV1, opts: DraftCardOptions): string {
  const totals = opts.totals ?? deriveTotals(data);
  const crew = totals.headcountKnown ? `${totals.crewOnSite} on site` : 'headcount pending';
  const subs = `${totals.subcontractors} sub${totals.subcontractors === 1 ? '' : 's'}`;
  const hours = totals.hoursKnown ? formatHours(totals.totalHours) : 'hours pending';
  const lines: string[] = [
    `${opts.eyebrow ?? 'DRAFT'} · ${formatDraftDate(data.reportDate)}`,
    opts.siteName,
    line('CREW', `${crew} · ${subs} · ${hours}`),
    line('WEATHER', weatherPhraseForCard(data)),
    line(
      'DONE',
      data.workPerformed.length
        ? data.workPerformed.slice(0, 3).map(workItemPhrase).join(' · ')
        : 'Not stated',
    ),
  ];
  if (data.deliveries.length) {
    lines.push(
      line(
        'DELIVERED',
        data.deliveries
          .slice(0, 3)
          .map(
            (d) =>
              `${d.item}${d.quantity ? `, ${d.quantity}` : ''}${d.supplier ? ` (${d.supplier})` : ''}`,
          )
          .join(' · '),
      ),
    );
  }
  lines.push(line('SAFETY', safetyPhrase(data)));
  if (data.safety.incidents.length) {
    lines.push(line('INCIDENT', data.safety.incidents.map((i) => i.description).join(' · ')));
  }
  const body = opts.monospace === false ? lines.join('\n') : '```\n' + lines.join('\n') + '\n```';
  const footer =
    opts.footer === undefined ? 'Reply OK to file it, or tell me what to fix.' : opts.footer;
  return footer ? `${body}\n${footer}` : body;
}

/** The static example shown after a test note (§F4 "Show an example"). */
export function exampleDraftCard(): string {
  return [
    '```',
    'EXAMPLE · FRI OCT 9',
    'Riverside Lofts — Block B',
    line('CREW', '23 on site · 4 subs · 184 h'),
    line('WEATHER', 'Rain 07:00–10:30 · masonry stopped 3.5 h'),
    line('DONE', 'L4 slab pour complete · L3 electrical rough-in ~60% · L2 ductwork'),
    line('DELIVERED', 'Rebar, 2 loads (Ironclad)'),
    line('SAFETY', 'Toolbox talk · no incidents'),
    '```',
    'This is an example. Nothing is filed from a test note.',
  ].join('\n');
}
