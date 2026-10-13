import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertE164,
  convertMeasure,
  formatDate,
  formatDateLong,
  formatDateShort,
  formatDraftDate,
  formatHours,
  formatHoursIn,
  formatMeasure,
  formatMoneyCents,
  formatMonthDay,
  formatMonthYear,
  formatMonthYearIn,
  formatPhone,
  formatWeekdayMonthDay,
  hoursUnit,
  isE164,
  normalizeE164,
  parseE164,
  UNIT_LABELS,
  weekdayName,
} from './format.ts';
import { languageOf, reportLanguageFor, unitsFor, upperIn } from './locale.ts';
import { kestrelDemo } from './demo/kestrel.ts';

/** The formatter that W1-02 replaced, kept here to prove US numbers print exactly as before. */
function legacyUsFormat(e164: string): string {
  const d = e164.replace(/\D/g, '');
  return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
}

describe('phones (libphonenumber-js)', () => {
  it('groups Turkish numbers the Turkish way (was "+905 321 234 567")', () => {
    expect(formatPhone('+905321234567')).toBe('+90 532 123 45 67');
    expect(formatPhone('+902161234567')).toBe('+90 216 123 45 67');
    expect(formatPhone('+908501234567')).toBe('+90 850 123 4567');
  });

  it('prints every US demo number exactly as the old formatter did', () => {
    const phones = DEMO_PHONES.filter((p) => p.startsWith('+1'));
    expect(phones.length).toBeGreaterThan(3);
    for (const p of phones) expect(formatPhone(p)).toBe(legacyUsFormat(p));
    expect(formatPhone('+15550142290')).toBe('+1 555 014 2290');
  });

  it('formats other countries by their own rules', () => {
    expect(formatPhone('+525512345678')).toBe('+52 55 1234 5678');
    expect(formatPhone('+34612345678')).toBe('+34 612 34 56 78');
  });

  it('returns input that is not a phone number unchanged', () => {
    expect(formatPhone('')).toBe('');
    expect(formatPhone('n/a')).toBe('n/a');
  });

  it('parses loose input to E.164', () => {
    expect(parseE164('(555) 014-3378', { defaultCountry: 'US' })).toBe('+15550143378');
    expect(parseE164('0532 123 45 67', { defaultCountry: 'TR' })).toBe('+905321234567');
    expect(parseE164('532 123 45 67', { defaultCallingCode: '90' })).toBe('+905321234567');
    expect(parseE164('0532 123 45 67', { defaultCallingCode: '90' })).toBe('+905321234567');
    expect(parseE164('00 90 532 123 45 67')).toBe('+905321234567');
    expect(parseE164('+90 (532) 123-45-67')).toBe('+905321234567');
    expect(parseE164('+1 555 014 3378')).toBe('+15550143378');
    expect(parseE164('555 014 3378')).toBeNull(); // no country, no "+"
    expect(parseE164('   ')).toBeNull();
    expect(parseE164('+1 234')).toBeNull(); // too short for the country
    expect(parseE164('+90 532 123')).toBeNull();
  });

  it('keeps normalizeE164 (calling-code default) working for US input', () => {
    expect(normalizeE164('(555) 014-3378')).toBe('+15550143378');
    expect(normalizeE164('555 014 8001')).toBe('+15550148001');
    expect(normalizeE164('1 555 014 3378')).toBe('+15550143378');
    expect(normalizeE164('+1 555 014 3378', '90')).toBe('+15550143378');
    expect(normalizeE164('0532 123 45 67', '90')).toBe('+905321234567');
    expect(normalizeE164('abc')).toBeNull();
  });

  it('checks and asserts the E.164 shape', () => {
    expect(isE164('+15550143378')).toBe(true);
    expect(isE164('15550143378')).toBe(false);
    expect(assertE164('+905321234567')).toBe('+905321234567');
    expect(() => assertE164('0532 123 45 67')).toThrow(/E\.164/);
  });
});

describe('locale-aware dates', () => {
  it('matches the en-US helpers for every day of a year', () => {
    for (let i = 0; i < 366; i += 1) {
      const d = addDays('2026-01-01', i);
      expect(formatDate(d, 'long')).toBe(formatDateLong(d));
      expect(formatDate(d, 'short', 'en-US')).toBe(formatDateShort(d));
      expect(formatDate(d, 'monthDay', 'en')).toBe(formatMonthDay(d));
      expect(formatDate(d, 'weekdayMonthDay', 'en-US')).toBe(formatWeekdayMonthDay(d));
      expect(formatDate(d, 'weekday', 'en-US')).toBe(weekdayName(d));
      expect(formatDate(d, 'eyebrow', 'en-US')).toBe(formatDraftDate(d));
    }
    expect(formatMonthYearIn('2026-10')).toBe(formatMonthYear('2026-10'));
  });

  it('formats the Today and Draft eyebrows as the EN artboards show them', () => {
    // Field-03-Today header "FRI, OCT 9 · DUE 17:30"; Field-06-Draft "FRI OCT 9".
    expect(formatDate('2026-10-09', 'todayEyebrow', 'en-US')).toBe('FRI, OCT 9');
    expect(formatDate('2026-10-09', 'eyebrow', 'en-US')).toBe('FRI OCT 9');
  });

  it('formats Turkish dates (Field-10 eyebrow "CUMA, 9 EKİM")', () => {
    expect(formatDate('2026-10-09', 'full', 'tr-TR')).toBe('Cuma, 9 Ekim 2026');
    expect(formatDate('2026-10-09', 'long', 'tr-TR')).toBe('Cum, 9 Eki 2026');
    expect(formatDate('2026-10-09', 'short', 'tr-TR')).toBe('Cum 9 Eki');
    expect(formatDate('2026-10-09', 'monthDay', 'tr')).toBe('9 Eki');
    expect(formatDate('2026-10-09', 'weekdayMonthDay', 'tr-TR')).toBe('Cuma, 9 Eki');
    expect(formatDate('2026-10-09', 'eyebrow', 'tr-TR')).toBe('CUM 9 EKİ');
    // Field-10-Today-TR header: "CUMA, 9 EKİM · SON SAAT 17:30".
    expect(formatDate('2026-10-09', 'todayEyebrow', 'tr-TR')).toBe('CUMA, 9 EKİM');
    expect(formatDate('2026-08-19', 'todayEyebrow', 'tr')).toBe('ÇARŞAMBA, 19 AĞUSTOS');
    expect(formatDate('2026-09-01', 'todayEyebrow', 'tr')).toBe('SALI, 1 EYLÜL');
    expect(upperIn('tr-TR', formatDate('2026-10-09', 'weekday', 'tr-TR'))).toBe('CUMA');
    expect(formatDate('2026-08-19', 'full', 'tr-TR')).toBe('Çarşamba, 19 Ağustos 2026');
    expect(upperIn('tr', 'Salı, 1 Eylül')).toBe('SALI, 1 EYLÜL');
    expect(formatMonthYearIn('2026-02', 'tr-TR')).toBe('Şubat 2026');
  });

  it('formats Spanish dates', () => {
    expect(formatDate('2026-10-09', 'full', 'es-US')).toBe('viernes, 9 de octubre de 2026');
    expect(formatDate('2026-10-09', 'long', 'es')).toBe('vie, 9 oct 2026');
    expect(formatDate('2026-10-07', 'weekday', 'es-US')).toBe('miércoles');
    expect(formatDate('2026-10-10', 'eyebrow', 'es-US')).toBe('SÁB 10 OCT');
    expect(formatDate('2026-10-09', 'todayEyebrow', 'es-US')).toBe('VIE, 9 OCT');
    expect(formatDate('2026-10-10', 'todayEyebrow', 'es')).toBe('SÁB, 10 OCT');
    expect(formatMonthYearIn('2026-10', 'es-US')).toBe('octubre de 2026');
  });

  it('rejects unsupported locales and bad input', () => {
    expect(() => formatDate('2026-10-09', 'long', 'de-DE' as never)).toThrow(/Unsupported locale/);
    expect(() => formatMonthYearIn('2026-13', 'tr-TR')).toThrow(/Invalid year-month/);
  });
});

describe('hours, units and money per locale', () => {
  it('uses h / sa and the locale decimal mark', () => {
    expect(hoursUnit('en-US')).toBe('h');
    expect(hoursUnit('es-US')).toBe('h');
    expect(hoursUnit('tr-TR')).toBe('sa');
    expect(formatHoursIn(184, 'tr-TR')).toBe('184 sa');
    expect(formatHoursIn(3.5, 'tr-TR')).toBe('3,5 sa');
    expect(formatHoursIn(3.5, 'es-US')).toBe('3.5 h'); // es-US writes a decimal point
    expect(formatHoursIn(1234.5, 'tr-TR')).toBe('1234,5 sa');
    expect(formatHoursIn(null, 'tr-TR')).toBe('—');
  });

  it('equals formatHours for en-US', () => {
    for (const h of [0, 0.25, 3.5, 8, 56, 184, 192.25, 1234.567, 0.005, 7.999]) {
      expect(formatHoursIn(h, 'en-US')).toBe(formatHours(h));
    }
    expect(formatHoursIn(undefined, 'en-US')).toBe(formatHours(undefined));
  });

  it('picks units and report language per org locale (§9.6)', () => {
    expect(unitsFor('en-US')).toBe('imperial');
    expect(unitsFor('tr-TR')).toBe('metric');
    expect(reportLanguageFor('en-US')).toBe('en');
    expect(reportLanguageFor('tr-TR')).toBe('tr');
    expect(languageOf('es-US')).toBe('es');
    expect(UNIT_LABELS.imperial).toEqual({
      temperature: '°F',
      precipitation: 'in',
      wind: 'mph',
      volume: 'yd³',
    });
    expect(UNIT_LABELS.metric).toEqual({
      temperature: '°C',
      precipitation: 'mm',
      wind: 'km/h',
      volume: 'm³',
    });
  });

  it('formats and converts measures', () => {
    expect(formatMeasure(54, 'temperature', 'imperial', 'en-US')).toBe('54 °F');
    expect(formatMeasure(0.42, 'precipitation', 'imperial', 'en-US')).toBe('0.42 in');
    expect(formatMeasure(9, 'wind', 'imperial', 'en-US')).toBe('9 mph');
    expect(formatMeasure(11.2, 'precipitation', 'metric', 'tr-TR')).toBe('11,2 mm');
    expect(formatMeasure(14.48, 'wind', 'metric', 'tr-TR')).toBe('14 km/h');
    expect(formatMeasure(38.2, 'volume', 'metric', 'tr-TR')).toBe('38,2 m³');
    expect(formatMeasure(null, 'temperature', 'metric', 'tr-TR')).toBe('—');
    expect(convertMeasure(212, 'temperature', 'imperial', 'metric')).toBeCloseTo(100, 10);
    expect(convertMeasure(0, 'temperature', 'metric', 'imperial')).toBeCloseTo(32, 10);
    expect(convertMeasure(1, 'precipitation', 'imperial', 'metric')).toBeCloseTo(25.4, 10);
    expect(convertMeasure(10, 'wind', 'imperial', 'metric')).toBeCloseTo(16.09344, 10);
    expect(convertMeasure(1, 'volume', 'imperial', 'metric')).toBeCloseTo(0.764554857984, 12);
    expect(convertMeasure(7, 'wind', 'metric', 'metric')).toBe(7);
    for (const kind of ['temperature', 'precipitation', 'wind', 'volume'] as const) {
      const back = convertMeasure(
        convertMeasure(42, kind, 'imperial', 'metric'),
        kind,
        'metric',
        'imperial',
      );
      expect(back).toBeCloseTo(42, 10);
    }
  });

  it('formats money per locale and keeps en-US output', () => {
    expect(formatMoneyCents(239400)).toBe('$2,394');
    expect(formatMoneyCents(159650, 'USD', 'en-US')).toBe('$1,596.50');
    expect(formatMoneyCents(239400, 'TRY', 'tr-TR')).toBe('₺2.394');
    expect(formatMoneyCents(159650, 'TRY', 'tr-TR')).toBe('₺1.596,50');
  });
});

/** Every reporter and site phone in the §18 demo data. */
const DEMO_PHONES: string[] = collectPhones(kestrelDemo());

function collectPhones(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^\+\d{8,15}$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectPhones(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectPhones(v, out);
  }
  return out;
}
