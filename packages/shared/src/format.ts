/**
 * Formatting helpers shared by SMS and WhatsApp copy, the PDF and the web panel.
 *
 * The functions without a locale argument are the original en-US helpers and keep their output.
 * The locale-aware helpers (`formatDate`, `formatHoursIn`, `formatMeasure` …) take an org or
 * reporter locale (spec Conventions, §9.6). Phone numbers go through libphonenumber-js.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import {
  intlLocaleOf,
  languageOf,
  upperIn,
  type AnyLocale,
  type Language,
  type UnitSystem,
} from './locale.ts';

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

// ---------------------------------------------------------------------------------------------
// Phone numbers (spec Conventions: stored in E.164).
//
// libphonenumber-js with its "min" metadata: about 80 kB of country formats and possible lengths,
// enough to parse, format and length-check every country. The "max" metadata (about 145 kB) adds
// per-type patterns (mobile, fixed line, toll free) that nothing in week 1 needs, and this module
// is in the panel's main chunk and the field app.
// ---------------------------------------------------------------------------------------------

declare const e164Brand: unique symbol;
/** A phone number in E.164 (`+15550143378`, `+905321234567`). */
export type E164 = string & { readonly [e164Brand]: true };

export interface ParsePhoneOptions {
  /** Country for numbers typed without a country code, e.g. 'US' or 'TR'. */
  defaultCountry?: CountryCode;
  /** Calling code for numbers typed without one, e.g. '1' or '90' (used when no defaultCountry). */
  defaultCallingCode?: string;
}

/**
 * Loose user input → E.164, or null. Accepts spaces, dashes, brackets, a leading `+` or `00`, and
 * national trunk prefixes ("0532 …" with TR). Checks the length for the country ("possible"), not
 * the number range, so the fictional 555-01xx demo numbers stay valid.
 */
export function parseE164(input: string, opts: ParsePhoneOptions = {}): E164 | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // "00 90 532 …" is the international prefix; libphonenumber reads it only with a known country.
  const text = /^00\s*[1-9]/.test(trimmed) ? `+${trimmed.replace(/^00/, '')}` : trimmed;
  const parsed = opts.defaultCountry
    ? parsePhoneNumberFromString(text, { defaultCountry: opts.defaultCountry })
    : opts.defaultCallingCode
      ? parsePhoneNumberFromString(text, { defaultCallingCode: opts.defaultCallingCode })
      : parsePhoneNumberFromString(text);
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number as E164;
}

/** Stored value → E164, or throws. For values that must already be E.164 (DB rows, env). */
export function assertE164(value: string): E164 {
  if (!isE164(value)) throw new Error(`Not an E.164 phone number: ${value}`);
  return value;
}

/**
 * E.164 → international display format: "+1 555 014 3378", "+90 532 123 45 67",
 * "+44 7700 900123". Input that is not a phone number is returned unchanged.
 */
export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164.trim());
  return parsed ? parsed.formatInternational() : e164;
}

/** E.164 shape: "+", a non-zero digit, 7 to 15 digits in all. */
export function isE164(phone: string): phone is E164 {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/** Loose user input → E.164, or null. `defaultCountryCode` is a calling code ('1', '90'). */
export function normalizeE164(input: string, defaultCountryCode = '1'): E164 | null {
  return parseE164(input, { defaultCallingCode: defaultCountryCode });
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

/** 239400 → "$2,394" ; 39900 → "$399" ; 159650 → "$1,596.50"; with 'tr-TR' and 'TRY' → "₺2.394" */
export function formatMoneyCents(
  cents: number,
  currency = 'USD',
  locale: AnyLocale = 'en-US',
): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(intlLocaleOf(locale), {
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

// ---------------------------------------------------------------------------------------------
// Locale-aware dates, hours and units (spec Conventions, §9.6).
//
// Day and month names come from fixed tables, not Intl, so Node, Deno, the browser and the PDF
// print the same text whatever ICU data they carry. en-US output equals the helpers above.
// ---------------------------------------------------------------------------------------------

interface DateNames {
  weekdays: readonly string[];
  weekdaysShort: readonly string[];
  months: readonly string[];
  monthsShort: readonly string[];
}

const DATE_NAMES: Record<Language, DateNames> = {
  en: {
    weekdays: WEEKDAYS,
    weekdaysShort: WEEKDAYS.map((d) => d.slice(0, 3)),
    months: MONTHS_LONG,
    monthsShort: MONTHS,
  },
  es: {
    weekdays: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
    weekdaysShort: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    months: [
      'enero',
      'febrero',
      'marzo',
      'abril',
      'mayo',
      'junio',
      'julio',
      'agosto',
      'septiembre',
      'octubre',
      'noviembre',
      'diciembre',
    ],
    monthsShort: [
      'ene',
      'feb',
      'mar',
      'abr',
      'may',
      'jun',
      'jul',
      'ago',
      'sep',
      'oct',
      'nov',
      'dic',
    ],
  },
  tr: {
    weekdays: ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'],
    weekdaysShort: ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'],
    months: [
      'Ocak',
      'Şubat',
      'Mart',
      'Nisan',
      'Mayıs',
      'Haziran',
      'Temmuz',
      'Ağustos',
      'Eylül',
      'Ekim',
      'Kasım',
      'Aralık',
    ],
    monthsShort: [
      'Oca',
      'Şub',
      'Mar',
      'Nis',
      'May',
      'Haz',
      'Tem',
      'Ağu',
      'Eyl',
      'Eki',
      'Kas',
      'Ara',
    ],
  },
};

/**
 * Date styles. Examples for 2026-10-09 in en / es / tr:
 * - `full`            "Friday, October 9, 2026" · "viernes, 9 de octubre de 2026" · "Cuma, 9 Ekim 2026"
 * - `long`            "Fri, Oct 9, 2026" · "vie, 9 oct 2026" · "Cum, 9 Eki 2026"
 * - `short`           "Fri Oct 9" · "vie 9 oct" · "Cum 9 Eki"
 * - `monthDay`        "Oct 9" · "9 oct" · "9 Eki"
 * - `weekdayMonthDay` "Friday, Oct 9" · "viernes, 9 oct" · "Cuma, 9 Eki"
 * - `weekday`         "Friday" · "viernes" · "Cuma"
 * - `eyebrow`         "FRI OCT 9" · "VIE 9 OCT" · "CUM 9 EKİ" (Draft card, Field-06)
 * - `todayEyebrow`    "FRI, OCT 9" · "VIE, 9 OCT" · "CUMA, 9 EKİM" (Today header: Field-03, and
 *                     Field-10, which spells the Turkish weekday and month in full)
 */
export type DateStyle =
  | 'full'
  | 'long'
  | 'short'
  | 'monthDay'
  | 'weekdayMonthDay'
  | 'weekday'
  | 'eyebrow'
  | 'todayEyebrow';

/** A `YYYY-MM-DD` date in the given style and locale (default en-US). */
export function formatDate(date: string, style: DateStyle, locale: AnyLocale = 'en-US'): string {
  const lang = languageOf(locale);
  const n = DATE_NAMES[lang];
  const p = parseIsoDate(date);
  const wd = n.weekdays[p.dow]!;
  const wdShort = n.weekdaysShort[p.dow]!;
  const mon = n.months[p.m - 1]!;
  const monShort = n.monthsShort[p.m - 1]!;
  switch (style) {
    case 'full':
      if (lang === 'en') return `${wd}, ${mon} ${p.d}, ${p.y}`;
      if (lang === 'es') return `${wd}, ${p.d} de ${mon} de ${p.y}`;
      return `${wd}, ${p.d} ${mon} ${p.y}`;
    case 'long':
      return lang === 'en'
        ? `${wdShort}, ${monShort} ${p.d}, ${p.y}`
        : `${wdShort}, ${p.d} ${monShort} ${p.y}`;
    case 'short':
      return lang === 'en' ? `${wdShort} ${monShort} ${p.d}` : `${wdShort} ${p.d} ${monShort}`;
    case 'monthDay':
      return lang === 'en' ? `${monShort} ${p.d}` : `${p.d} ${monShort}`;
    case 'weekdayMonthDay':
      return lang === 'en' ? `${wd}, ${monShort} ${p.d}` : `${wd}, ${p.d} ${monShort}`;
    case 'weekday':
      return wd;
    case 'eyebrow':
      return upperIn(lang, formatDate(date, 'short', lang));
    case 'todayEyebrow':
      if (lang === 'en') return upperIn(lang, `${wdShort}, ${monShort} ${p.d}`);
      if (lang === 'es') return upperIn(lang, `${wdShort}, ${p.d} ${monShort}`);
      return upperIn(lang, `${wd}, ${p.d} ${mon}`);
  }
}

/** "2026-10" → "October 2026" · "octubre de 2026" · "Ekim 2026" */
export function formatMonthYearIn(yearMonth: string, locale: AnyLocale = 'en-US'): string {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) throw new Error(`Invalid year-month: ${yearMonth}`);
  const lang = languageOf(locale);
  const month = DATE_NAMES[lang].months[Number(m[2]) - 1];
  if (!month) throw new Error(`Invalid year-month: ${yearMonth}`);
  return lang === 'es' ? `${month} de ${m[1]}` : `${month} ${m[1]}`;
}

/** "2026-10" → "Oct" · "oct" · "Eki" (Web-Sites: "2 weather days in Oct"). */
export function formatMonthShortIn(yearMonth: string, locale: AnyLocale = 'en-US'): string {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  const month = m ? DATE_NAMES[languageOf(locale)].monthsShort[Number(m[2]) - 1] : undefined;
  if (!month) throw new Error(`Invalid year-month: ${yearMonth}`);
  return month;
}

/** Short weekday names, Monday first: "Mon" … "Sun" · "lun" … "dom" · "Pzt" … "Paz". */
export function weekdaysShortIn(locale: AnyLocale = 'en-US'): string[] {
  const names = DATE_NAMES[languageOf(locale)].weekdaysShort;
  return [1, 2, 3, 4, 5, 6, 0].map((d) => names[d]!);
}

/** Number with the locale's decimal mark and no grouping: 3.5 → "3.5" (en-US, es-US) · "3,5" (tr-TR). */
function decimal(n: number, locale: AnyLocale, maxDigits: number): string {
  return new Intl.NumberFormat(intlLocaleOf(locale), {
    maximumFractionDigits: maxDigits,
    useGrouping: false,
  }).format(n);
}

/** Hours unit per locale (§P7): "h" in English and Spanish, "sa" (saat) in Turkish. */
export function hoursUnit(locale: AnyLocale): 'h' | 'sa' {
  return languageOf(locale) === 'tr' ? 'sa' : 'h';
}

/**
 * 184 → "184 h" · "184 sa"; 3.5 → "3.5 h" · "3,5 sa"; null → "—". Two decimals at most and no
 * thousands grouping, like `formatHours`, which it equals for en-US.
 */
export function formatHoursIn(hours: number | null | undefined, locale: AnyLocale): string {
  if (hours === null || hours === undefined) return '—';
  return `${decimal(Math.round(hours * 100) / 100, locale, 2)} ${hoursUnit(locale)}`;
}

/** Quantities that change unit between imperial (US) and metric (TR) reports (§9.6). */
export type MeasureKind = 'temperature' | 'precipitation' | 'wind' | 'volume';

/** §9.6 unit labels: °F, in, mph, yd³ (imperial) · °C, mm, km/h, m³ (metric). */
export const UNIT_LABELS: Record<UnitSystem, Record<MeasureKind, string>> = {
  imperial: { temperature: '°F', precipitation: 'in', wind: 'mph', volume: 'yd³' },
  metric: { temperature: '°C', precipitation: 'mm', wind: 'km/h', volume: 'm³' },
};

/** Default decimals per quantity, as the report prints them (0.42 in, 11 mm, 54 °F, 12 mph). */
export const MEASURE_DIGITS: Record<UnitSystem, Record<MeasureKind, number>> = {
  imperial: { temperature: 0, precipitation: 2, wind: 0, volume: 1 },
  metric: { temperature: 0, precipitation: 1, wind: 0, volume: 1 },
};

/** Convert a value between unit systems (exact factors; no rounding). */
export function convertMeasure(
  value: number,
  kind: MeasureKind,
  from: UnitSystem,
  to: UnitSystem,
): number {
  if (from === to) return value;
  const toMetric = to === 'metric';
  switch (kind) {
    case 'temperature':
      return toMetric ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
    case 'precipitation':
      return toMetric ? value * 25.4 : value / 25.4;
    case 'wind':
      return toMetric ? value * 1.609344 : value / 1.609344;
    case 'volume':
      return toMetric ? value * 0.764554857984 : value / 0.764554857984;
  }
}

/**
 * A measured value with its unit label: (54, 'temperature', 'imperial', 'en-US') → "54 °F";
 * (11.2, 'precipitation', 'metric', 'tr-TR') → "11,2 mm"; null → "—". The value must already be
 * in `units` (see `convertMeasure`).
 */
export function formatMeasure(
  value: number | null | undefined,
  kind: MeasureKind,
  units: UnitSystem,
  locale: AnyLocale,
  maxDigits: number = MEASURE_DIGITS[units][kind],
): string {
  if (value === null || value === undefined) return '—';
  return `${decimal(value, locale, maxDigits)} ${UNIT_LABELS[units][kind]}`;
}
