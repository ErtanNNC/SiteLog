import { addDays, formatDateInTz, formatTimeInTz, isoWeekday, parseIsoDate } from '../format.ts';

/** Site-local calendar helpers (§7.1, §F5, §F8). */

export function localDate(now: Date, tz: string): string {
  return formatDateInTz(now, tz);
}

export function localTime(now: Date, tz: string): string {
  return formatTimeInTz(now, tz);
}

/** working_days uses ISO weekdays (1 = Mon … 7 = Sun). */
export function isWorkingDay(date: string, workingDays: readonly number[]): boolean {
  return workingDays.includes(isoWeekday(date));
}

export function previousWorkingDay(date: string, workingDays: readonly number[]): string {
  let d = addDays(date, -1);
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(d, workingDays)) return d;
    d = addDays(d, -1);
  }
  return addDays(date, -1);
}

export function nextWorkingDay(date: string, workingDays: readonly number[]): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(d, workingDays)) return d;
    d = addDays(d, 1);
  }
  return addDays(date, 1);
}

/**
 * §F5 — any time after 12:00 site time counts as today's report; before 12:00 we ask
 * "today or yesterday?" (yesterday = previous working day).
 */
export function reportDateForInbound(
  now: Date,
  tz: string,
  workingDays: readonly number[] = [1, 2, 3, 4, 5],
  noonHour = 12,
): { date: string; ambiguous: boolean; alternative: string } {
  const today = localDate(now, tz);
  const hour = Number(localTime(now, tz).slice(0, 2));
  const yesterday = previousWorkingDay(today, workingDays);
  return { date: today, ambiguous: hour < noonHour, alternative: yesterday };
}

const WEEKDAY_WORDS: Record<string, number> = {
  monday: 1,
  mon: 1,
  lunes: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  martes: 2,
  wednesday: 3,
  wed: 3,
  miercoles: 3,
  miércoles: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  jueves: 4,
  friday: 5,
  fri: 5,
  viernes: 5,
  saturday: 6,
  sat: 6,
  sabado: 6,
  sábado: 6,
  sunday: 7,
  sun: 7,
  domingo: 7,
  // Turkish (W2-12: SMS EDIT on a two-way pack or WhatsApp; `SALI` lower-cases to "sali").
  pazartesi: 1,
  pzt: 1,
  salı: 2,
  sali: 2,
  çarşamba: 3,
  carsamba: 3,
  perşembe: 4,
  persembe: 4,
  cuma: 5,
  cumartesi: 6,
  cmt: 6,
  pazar: 7,
};

const MONTH_WORDS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * §F8 — "edit Friday", "yesterday", "Oct 9", "9 Oct", "10/9" (US m/d), "2026-10-09".
 * Returns the most recent matching date on or before today (site time), or null.
 */
export function resolveDayReference(text: string, now: Date, tz: string): string | null {
  const today = localDate(now, tz);
  // "İ" lower-cases to "i" and a combining dot: drop the dot ("CUMARTESİ" → "cumartesi").
  const t = text.toLowerCase().replace(/\u0307/g, '');
  if (/\b(today|hoy)\b/.test(t) || /(^|[^\p{L}])(bugün|bugun)(?=$|[^\p{L}])/u.test(t)) return today;
  if (/\b(yesterday|ayer)\b/.test(t) || /(^|[^\p{L}])(dün|dun)(?=$|[^\p{L}])/u.test(t))
    return addDays(today, -1);
  if (/\bday before yesterday\b|\banteayer\b/.test(t)) return addDays(today, -2);

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const { y } = parseIsoDate(today);
  const monthDay = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (monthDay && MONTH_WORDS[monthDay[1]!]) {
    return mostRecent(y, MONTH_WORDS[monthDay[1]!]!, Number(monthDay[2]), today);
  }
  const dayMonth = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/.exec(t);
  if (dayMonth && MONTH_WORDS[dayMonth[2]!]) {
    return mostRecent(y, MONTH_WORDS[dayMonth[2]!]!, Number(dayMonth[1]), today);
  }
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (slash) {
    const m = Number(slash[1]);
    const d = Number(slash[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const yy = slash[3]
        ? slash[3].length === 2
          ? 2000 + Number(slash[3])
          : Number(slash[3])
        : undefined;
      return yy ? isoOrNull(yy, m, d) : mostRecent(y, m, d, today);
    }
  }
  for (const word of t.split(/[^a-záéíóúçğışöü]+/)) {
    const dow = WEEKDAY_WORDS[word];
    if (dow) {
      const todayDow = isoWeekday(today);
      const back = (todayDow - dow + 7) % 7;
      return addDays(today, -back);
    }
  }
  return null;
}

function mostRecent(year: number, m: number, d: number, today: string): string | null {
  const candidate = isoOrNull(year, m, d);
  if (!candidate) return null;
  if (candidate > today) return isoOrNull(year - 1, m, d);
  return candidate;
}

function isoOrNull(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** §F8 — edits allowed up to 14 days after the report date. */
export const EDIT_WINDOW_DAYS = 14;

export function isWithinEditWindow(
  reportDate: string,
  today: string,
  days = EDIT_WINDOW_DAYS,
): boolean {
  const { y, m, d } = parseIsoDate(reportDate);
  const t = parseIsoDate(today);
  const diff = (Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(y, m - 1, d)) / 86400000;
  return diff >= 0 && diff <= days;
}
