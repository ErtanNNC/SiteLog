/**
 * Panel formatters. Shared helpers come from @sitelog/shared/format.ts; everything here is
 * presentation-only (eyebrows, week labels, signed gaps…). Locale en-US, times in the site tz.
 */
import {
  addDays,
  formatDateInTz,
  formatDateLong,
  formatHours,
  formatMonthDay,
  formatNumber,
  formatTimeInTz,
  isoWeekOf,
  isoWeekRange,
  monthName,
  parseIsoDate,
} from '@sitelog/shared/format.ts';

export {
  abbreviateArea,
  addDays,
  daysBetween,
  firstName,
  formatAudioTimestamp,
  formatDateInTz,
  formatDateLong,
  formatDateShort,
  formatDeadline,
  formatDuration,
  formatHours,
  formatMoneyCents,
  formatMonthDay,
  formatMonthYear,
  formatNumber,
  formatPercent,
  formatPhone,
  formatTimeInTz,
  formatWeekdayMonthDay,
  initials,
  isE164,
  isoWeekOf,
  isoWeekRange,
  isoWeekday,
  monthName,
  normalizeE164,
  parseIsoDate,
  weekdayName,
} from '@sitelog/shared/format.ts';

/** "FRI, OCT 9, 2026 · 19:05" — page eyebrow in the org / site time zone. */
export function formatEyebrowDateTime(instant: Date | string, tz: string): string {
  const date = formatDateInTz(instant, tz);
  return `${formatDateLong(date).toUpperCase()} · ${formatTimeInTz(instant, tz)}`;
}

/** "FRI, OCT 9, 2026" */
export function formatEyebrowDate(date: string): string {
  return formatDateLong(date).toUpperCase();
}

/** "OCT 5 – OCT 9, 2026" — ISO week label for the hours page. */
export function formatWeekLabel(isoWeek: string): string {
  const { start, end } = isoWeekRange(isoWeek);
  const y = parseIsoDate(end).y;
  return `${formatMonthDay(start).toUpperCase()} – ${formatMonthDay(end).toUpperCase()}, ${y}`;
}

/** "2026-10" → "October 2026"; also accepts a full date. */
export function formatMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-');
  return `${monthName(Number(m), true)} ${y}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "2026-10" with a real month (a `?month=` URL param; "2026-13" is not one). */
export function isValidYearMonth(yearMonth: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth);
}

/** "2026-W41" naming a week that exists in that year (a `?week=` URL param; W00 or W54 is not one). */
export function isValidIsoWeek(isoWeek: string): boolean {
  return /^\d{4}-W\d{2}$/.test(isoWeek) && isoWeekOf(isoWeekRange(isoWeek).start) === isoWeek;
}

export function addWeeks(isoWeek: string, delta: number): string {
  const { start } = isoWeekRange(isoWeek);
  return isoWeekOf(addDays(start, delta * 7));
}

/** Hours as a bare number for table cells: 192 → "192", 3.5 → "3.5", null → "—". */
export function formatHoursNum(h: number | null | undefined): string {
  if (h === null || h === undefined) return '—';
  const n = Math.round(h * 100) / 100;
  return Number.isInteger(n) ? formatNumber(n) : n.toString();
}

/** +16 → "+16 h", −4 → "−4 h", 0 → "match". */
export function formatGap(gap: number | null | undefined): string {
  if (gap === null || gap === undefined) return '—';
  if (Math.abs(gap) < 0.005) return 'match';
  const n = Math.round(Math.abs(gap) * 100) / 100;
  return `${gap > 0 ? '+' : '−'}${formatHoursNum(n)} h`;
}

/** "3.5 h lost" */
export function formatLostHours(h: number): string {
  return `${formatHours(h)} lost`;
}

export function formatCrew(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return formatNumber(n);
}

/** "ES · EN" from ["es", "en"]. */
export function formatLanguages(codes: readonly string[]): string {
  return codes.map((c) => c.toUpperCase()).join(' · ');
}

/** "17:38" in the site tz, or "—". */
export function formatTimeOrDash(instant: string | null | undefined, tz: string): string {
  return instant ? formatTimeInTz(instant, tz) : '—';
}

/** "Oct 9 · 17:38" */
export function formatDateTimeShort(instant: string, tz: string): string {
  return `${formatMonthDay(formatDateInTz(instant, tz))} · ${formatTimeInTz(instant, tz)}`;
}

/** Relative wording for activity feeds, in the site tz: today → "17:38", else "Oct 7 · 09:12". */
export function formatWhen(instant: string, tz: string, today: string): string {
  const date = formatDateInTz(instant, tz);
  return date === today ? formatTimeInTz(instant, tz) : formatDateTimeShort(instant, tz);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}
