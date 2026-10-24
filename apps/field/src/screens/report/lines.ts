import type { AnswerConfirmation, ReportView } from '@sitelog/shared/field-contract.ts';
import type { CorrectionChange } from '@sitelog/shared/report/correction.ts';
import { abbreviateArea, formatAudioTimestamp, formatHoursIn } from '@sitelog/shared/format.ts';
import { intlLocaleOf } from '@sitelog/shared/locale.ts';
import type { DailyReportData, WeatherPeriod, WorkItem } from '@sitelog/shared/schemas/report.ts';
import type { useFieldCopy } from '@/i18n/useFieldCopy';
import type { FieldLanguage } from '@/i18n/language';

/**
 * The words of the question and draft screens (W1-13), from the view's data in the reporter's
 * language: numbers are the draft's (computed in code), never re-derived here, and a value the
 * draft does not have is "Not stated", never a guess. Pure.
 */

type T = ReturnType<typeof useFieldCopy>['t'];

/** 3.5 → "3.5" (en, es) · "3,5" (tr); no grouping, two decimals at most. */
export function formatNumberIn(n: number, language: FieldLanguage): string {
  return new Intl.NumberFormat(intlLocaleOf(language), {
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(n);
}

/** F7: "Delta Mechanical: 5 workers, 8 hours each — 40 hours." */
export function confirmationLine(c: AnswerConfirmation, t: T, language: FieldLanguage): string {
  const num = (n: number) => formatNumberIn(n, language);
  switch (c.kind) {
    case 'crew': {
      const { company, workers, hoursPerWorker: hours, totalHours: total } = c;
      if (workers !== null && hours !== null && total !== null) {
        return workers === 1
          ? t('confirmation.crewOne', { company, hours: num(hours) })
          : t('confirmation.crew', {
              company,
              workers: num(workers),
              hours: num(hours),
              total: num(total),
            });
      }
      if (workers !== null) {
        return workers === 1
          ? t('confirmation.workersOne', { company })
          : t('confirmation.workers', { company, workers: num(workers) });
      }
      if (hours !== null) return t('confirmation.hours', { company, hours: num(hours) });
      return t('confirmation.noted');
    }
    case 'company_added':
      return t('confirmation.companyAdded', { company: c.company });
    case 'company_mapped':
      return t('confirmation.companyMapped', { company: c.company });
    case 'weather':
      return c.lostHours > 0
        ? t('confirmation.weather', { hours: num(c.lostHours) })
        : t('confirmation.weatherNone');
    case 'noted':
      return t('confirmation.noted');
  }
}

/** Field-05 "Heard at 1:20 in your note": the crew's first voice-note second, if it has one. */
export function heardAt(view: Pick<ReportView, 'question' | 'data'>): string | null {
  const index = view.question?.manpowerIndex;
  if (index === null || index === undefined) return null;
  const source = view.data?.manpower[index]?.source.find((s) => s.type === 'voice_note');
  return source && source.type === 'voice_note' ? formatAudioTimestamp(source.start) : null;
}

/** A crew line's numbers as Field-06 shows them: "5 × 8 h" ("— × 8 h" while one is unknown). */
export function crewValue(
  entry: Pick<DailyReportData['manpower'][number], 'workers' | 'hoursPerWorker'>,
  language: FieldLanguage,
): string {
  const workers = entry.workers === null ? '—' : formatNumberIn(entry.workers, language);
  return `${workers} × ${formatHoursIn(entry.hoursPerWorker, language)}`;
}

/** The same, read out: "5 workers, 8 hours each"; "Not stated" when either is unknown. */
export function crewValueSpoken(
  entry: Pick<DailyReportData['manpower'][number], 'workers' | 'hoursPerWorker'>,
  t: T,
  language: FieldLanguage,
): string {
  if (entry.workers === null || entry.hoursPerWorker === null) return t('draft.notStated');
  const hours = formatNumberIn(entry.hoursPerWorker, language);
  return entry.workers === 1
    ? t('draft.crewValueOne', { hours })
    : t('draft.crewValue', { workers: formatNumberIn(entry.workers, language), hours });
}

/** A crew value came from an answer (Field-06's ANSWERED tag). */
export function answeredEntry(entry: Pick<DailyReportData['manpower'][number], 'source'>): boolean {
  return entry.source.some((s) => s.type === 'answer');
}

/** The first clause of an impact ("Exterior masonry stopped; crew moved" → "exterior masonry stopped"). */
function shortImpact(impact: string): string {
  const first = impact.split(/[;.]/)[0]?.trim() ?? impact.trim();
  return first.length > 40 ? `${first.slice(0, 39).trimEnd()}…` : first;
}

export interface WeatherLine {
  /** "Rain 07:00–10:30 · masonry stopped" */
  text: string;
  /** "3.5 h" (bold on Field-06), or the full-day words; null when no time was lost. */
  lost: string | null;
}

/** Field-06 WEATHER: one line per period, else the conditions, else null ("Not stated"). */
export function weatherLines(
  data: Pick<DailyReportData, 'weather'>,
  t: T,
  language: FieldLanguage,
): WeatherLine[] | null {
  const periods = data.weather.periods;
  if (periods.length === 0) {
    const text = data.weather.conditionsText.trim();
    return text ? [{ text, lost: null }] : null;
  }
  return periods.map((p: WeatherPeriod) => {
    const range = p.start && p.end ? ` ${p.start}–${p.end}` : p.start ? ` ${p.start}` : '';
    const impact = p.impact ? ` · ${shortImpact(p.impact)}` : '';
    const lost = p.fullDay
      ? t('draft.fullDayLost')
      : p.lostHours > 0
        ? formatHoursIn(p.lostHours, language)
        : null;
    return { text: `${p.condition}${range}${impact}`, lost };
  });
}

/** Field-06 DONE: "L4 slab pour complete · L3 electrical rough-in ~60%". */
export function workLine(items: readonly WorkItem[], t: T): string | null {
  if (items.length === 0) return null;
  return items
    .map((w) => {
      const status =
        w.status === 'in_progress' && w.percentComplete !== undefined
          ? t('draft.percent', { percent: w.percentComplete })
          : t(`draft.status.${w.status}`);
      return [w.area ? abbreviateArea(w.area) : '', w.activity, status].filter(Boolean).join(' ');
    })
    .join(' · ');
}

/** Field-06 DELIVERED: "Rebar, 2 loads (Ironclad)". */
export function deliveriesLine(data: Pick<DailyReportData, 'deliveries'>): string | null {
  if (data.deliveries.length === 0) return null;
  return data.deliveries
    .map(
      (d) =>
        `${d.item}${d.quantity ? `, ${d.quantity}` : ''}${d.supplier ? ` (${d.supplier})` : ''}`,
    )
    .join(' · ');
}

/** Field-06 SAFETY: "Toolbox talk · no incidents"; null when nothing was said. */
export function safetyLine(data: Pick<DailyReportData, 'safety'>, t: T): string | null {
  const parts: string[] = [];
  if (data.safety.toolboxTalk) parts.push(t('draft.toolboxTalk'));
  if (data.safety.incidents.length > 0) {
    parts.push(t('draft.incidents', { count: data.safety.incidents.length }));
  } else if (data.safety.noIncidentsStated) {
    parts.push(t('draft.noIncidents'));
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Field-06 NEXT WORKDAY. */
export function nextLine(data: Pick<DailyReportData, 'nextWorkday'>): string | null {
  return data.nextWorkday.length ? data.nextWorkday.map((n) => n.item).join(' · ') : null;
}

/**
 * A number the reporter typed (D28): digits with a dot or a comma (a Turkish keyboard), within
 * `max`; whole numbers only for a headcount. Null when it is not one.
 */
export function parseTypedNumber(
  raw: string,
  opts: { integer: boolean; max: number },
): number | null {
  const s = raw.trim().replace(',', '.');
  if (!(opts.integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= opts.max ? n : null;
}

/**
 * One line of a fix's preview (W2-10, F8): "Apex Concrete 6 → 7 workers, 48 → 56 h" from code's
 * numbers (`CorrectionChange`); a number the draft does not have is "—". Pure.
 */
export function correctionLine(change: CorrectionChange, t: T, language: FieldLanguage): string {
  const num = (n: number | null) => (n === null ? '—' : formatNumberIn(n, language));
  switch (change.kind) {
    case 'crew': {
      if (change.change === 'removed')
        return t('draft.fix.lines.removed', { company: change.company });
      if (change.change === 'added')
        return t('draft.fix.lines.added', {
          company: change.company,
          value: crewValue(
            { workers: change.workers[1], hoursPerWorker: change.hoursPerWorker[1] },
            language,
          ),
        });
      const parts: string[] = [];
      const pair = (p: readonly [number | null, number | null]) => ({
        from: num(p[0]),
        to: num(p[1]),
      });
      if (change.workers[0] !== change.workers[1])
        parts.push(t('draft.fix.lines.workers', pair(change.workers)));
      if (change.hoursPerWorker[0] !== change.hoursPerWorker[1])
        parts.push(t('draft.fix.lines.hoursEach', pair(change.hoursPerWorker)));
      if (change.totalHours[0] !== change.totalHours[1])
        parts.push(t('draft.fix.lines.total', pair(change.totalHours)));
      return `${change.company} ${parts.join(', ')}`.trim();
    }
    case 'lost_hours':
      return t('draft.fix.lines.lostHours', {
        from: num(change.lostHours[0]),
        to: num(change.lostHours[1]),
      });
    case 'section':
      return t('draft.fix.lines.section', {
        section: t(`draft.fix.sections.${change.section}`),
      });
  }
}
