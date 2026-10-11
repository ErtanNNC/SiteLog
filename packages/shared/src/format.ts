/** Formatting helpers shared by WhatsApp copy, PDF and the web panel. Locale: en-US. */

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function parseIsoDate(date: string): { y: number; m: number; d: number; dow: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid ISO date: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { y, m: mo, d, dow };
}

export function weekdayName(date: string): string {
  return WEEKDAYS[parseIsoDate(date).dow]!;
}

export function monthName(month: number, long = false): string {
  return (long ? MONTHS_LONG : MONTHS)[month - 1]!;
}

/** "Fri, Oct 9, 2026" */
export function formatDateLong(date: string): string {
  const p = parseIsoDate(date);
  return `${WEEKDAYS[p.dow]!.slice(0, 3)}, ${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

/** "Fri Oct 9" */
export function formatDateShort(date: string): string {
  const p = parseIsoDate(date);
  return `${WEEKDAYS[p.dow]!.slice(0, 3)} ${MONTHS[p.m - 1]} ${p.d}`;
}

/** "Oct 9" */
export function formatMonthDay(date: string): string {
  const p = parseIsoDate(date);
  return `${MONTHS[p.m - 1]} ${p.d}`;
}

/** "FRI OCT 9" — draft card eyebrow */
export function formatDraftDate(date: string): string {
  return formatDateShort(date).toUpperCase();
}

/** "Friday, Oct 9" — report header */
export function formatWeekdayMonthDay(date: string): string {
  const p = parseIsoDate(date);
  return `${WEEKDAYS[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}`;
}

/** "October 2026" */
export function formatMonthYear(yearMonth: string): string {
  const [y, m] = yearMonth.split('-');
  return `${MONTHS_LONG[Number(m) - 1]} ${y}`;
}

/** Local wall-clock "HH:MM" for an instant in a time zone (Intl, no library). */
export function formatTimeInTz(instant: Date | string, tz: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

/** Local "YYYY-MM-DD" for an instant in a time zone. */
export function formatDateInTz(instant: Date | string, tz: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "17:30:00" | "17:30" → "17:30" */
export function formatDeadline(time: string): string {
  return time.slice(0, 5);
}

/** 184 → "184 h", 3.5 → "3.5 h", 192.25 → "192.25 h" */
export function formatHours(hours: number | null | undefined, unit = 'h'): string {
  if (hours === null || hours === undefined) return '—';
  const n = Math.round(hours * 100) / 100;
  return `${Number.isInteger(n) ? n : n.toString()} ${unit}`.trim();
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/** 41 → "0:41", 725 → "12:05" */
export function formatAudioTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 168 → "2 min 48 s", 48 → "48 s" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} s`;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

/** "+15550143378" → "+1 555 014 3378" (US); other countries grouped in threes. */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  const groups = digits.match(/.{1,3}/g) ?? [digits];
  return `+${groups.join(' ')}`;
}

export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/** Loose user input → E.164, or null. */
export function normalizeE164(input: string, defaultCountryCode = '1'): string | null {
  const trimmed = input.trim();
  let digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith('+')) {
    const d = digits.replace(/\D/g, '');
    digits =
      d.length === 10 && defaultCountryCode === '1' ? `+1${d}` : `+${defaultCountryCode}${d}`;
  }
  digits = `+${digits.slice(1).replace(/\D/g, '')}`;
  return isE164(digits) ? digits : null;
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export function initials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** 239400 → "$2,394" ; 39900 → "$399" ; 159650 → "$1,596.50" */
export function formatMoneyCents(cents: number, currency = 'USD'): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** "Level 4" → "L4", "Exterior — south elevation" → "Ext. south elevation" */
export function abbreviateArea(area: string): string {
  const level = /^level\s+(\d+[a-z]?)$/i.exec(area.trim());
  if (level) return `L${level[1]}`;
  return area
    .replace(/^exterior\s*[—–-]?\s*/i, 'Ext. ')
    .replace(/^basement\s*(\d*)/i, 'B$1')
    .trim();
}

/** ISO week "2026-W41" → { start: '2026-10-05', end: '2026-10-09' (Fri) , sunday: '2026-10-11' } */
export function isoWeekRange(isoWeek: string): { start: string; end: string; sunday: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!m) throw new Error(`Invalid ISO week: ${isoWeek}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO week 1 contains Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4.getTime() - (jan4Dow - 1) * 86400000);
  const monday = new Date(mondayWeek1.getTime() + (week - 1) * 7 * 86400000);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: toIso(monday),
    end: toIso(new Date(monday.getTime() + 4 * 86400000)),
    sunday: toIso(new Date(monday.getTime() + 6 * 86400000)),
  };
}

export function isoWeekOf(date: string): string {
  const { y, m, d } = parseIsoDate(date);
  const target = new Date(Date.UTC(y, m - 1, d));
  const dow = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseIsoDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday 1 = Monday … 7 = Sunday */
export function isoWeekday(date: string): number {
  const dow = parseIsoDate(date).dow;
  return dow === 0 ? 7 : dow;
}

export function daysBetween(a: string, b: string): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}
