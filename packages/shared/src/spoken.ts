import type { Language } from './locale.ts';

/**
 * The spoken form of a line (W4-07; spec §9.4 "numbers spoken naturally (… TR: 'yüz seksen dört
 * saat')", §16.2 M11 "Azure `tr-TR` voice tuned (numbers, units, company names)"; §19 Q245,
 * recommended default `SPOKEN_FORM`): code turns every line the agent speaks into words before
 * TTS, so no voice reads a symbol or a written number as it likes.
 *
 * - Report numbers in groups ("RL-2041-0187" → "RL iki bin kırk bir, sıfır yüz seksen yedi").
 * - Times ("17:30" → "on yedi otuz"; EN "five thirty p.m."; ES "cinco y media de la tarde").
 * - Percentages ("%40", "40%" → "yüzde kırk", "forty percent", "cuarenta por ciento").
 * - Units after a number as words ("45 m³" → "kırk beş metreküp", "18 °C" → "on sekiz derece",
 *   "40 km/sa" → "saatte kırk kilometre").
 * - Decimals: TR ",5" → "buçuk" ("7,5" → "yedi buçuk", "0,5" → "yarım"); EN ".5" → "and a half";
 *   ES "3.5 horas" → "tres horas y media"; any other fraction "virgül" / "point" / "punto".
 * - Every other number as words (TR "3. Kat" → "üçüncü Kat": a number with a dot before a word is
 *   an ordinal in Turkish); Turkish suffixes after an apostrophe join the word ("14'te" →
 *   "on dörtte").
 * - A per-language pronunciation list for names the owner's listening test flags (W4-14), applied
 *   first: empty until then (`SPOKEN_PRONUNCIATIONS`).
 *
 * Idempotent (a spoken line has no digit or symbol left to change), pure, Node, browser and Deno.
 * The Python agent has the same rules (`sitelog_voice/spoken.py`): `pnpm voice:contract` writes the
 * lists and every case of `SPOKEN_FORM_CASES` to `apps/voice-agent/copy/spoken.json`, and the
 * agent's tests check its port against each case.
 */

/**
 * §19 Q245: `code` (recommended, the default) turns lines into words; `tts` leaves them as written
 * (the "leave it to the TTS" option), for the owner's listening test to compare (W4-14).
 */
export type SpokenFormPolicy = 'code' | 'tts';
export const SPOKEN_FORM: SpokenFormPolicy = 'code';

/**
 * Names the listening test flags, as written → as the voice should say them (W4-14 fills them;
 * whole words, case-sensitive). Empty until the owner's listening test.
 */
export const SPOKEN_PRONUNCIATIONS: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  en: {},
  es: {},
  tr: {},
};

/** A unit after a number: its spoken words (singular and plural; TR has one form). */
export interface SpokenUnit {
  /** The written forms, matched case-sensitively right after the number (a space between or not). */
  written: string[];
  one: string;
  many: string;
  /** ES: the unit's gender ("una yarda cúbica"). */
  feminine?: boolean;
  /** TR speed: "saatte {n} kilometre" (the number inside). */
  around?: [before: string, after: string];
}

/** The units a spoken line may carry (deliveries, quantities, weather), per language. */
export const SPOKEN_UNITS: Readonly<Record<Language, readonly SpokenUnit[]>> = {
  en: [
    { written: ['yd³', 'yd3', 'cu yd', 'CY'], one: 'cubic yard', many: 'cubic yards' },
    { written: ['m³', 'm3'], one: 'cubic meter', many: 'cubic meters' },
    { written: ['ft²', 'sq ft', 'SF'], one: 'square foot', many: 'square feet' },
    { written: ['m²', 'm2'], one: 'square meter', many: 'square meters' },
    { written: ['°F', '°C', '°'], one: 'degree', many: 'degrees' },
    { written: ['mph'], one: 'mile per hour', many: 'miles per hour' },
    { written: ['km/h'], one: 'kilometer per hour', many: 'kilometers per hour' },
    { written: ['km'], one: 'kilometer', many: 'kilometers' },
    { written: ['mm'], one: 'millimeter', many: 'millimeters' },
    { written: ['cm'], one: 'centimeter', many: 'centimeters' },
    { written: ['ft'], one: 'foot', many: 'feet' },
    { written: ['lbs', 'lb'], one: 'pound', many: 'pounds' },
    { written: ['kg'], one: 'kilogram', many: 'kilograms' },
    { written: ['hrs', 'hr', 'h'], one: 'hour', many: 'hours' },
    { written: ['m'], one: 'meter', many: 'meters' },
  ],
  es: [
    { written: ['yd³', 'yd3'], one: 'yarda cúbica', many: 'yardas cúbicas', feminine: true },
    { written: ['m³', 'm3'], one: 'metro cúbico', many: 'metros cúbicos' },
    { written: ['m²', 'm2'], one: 'metro cuadrado', many: 'metros cuadrados' },
    { written: ['°F', '°C', '°'], one: 'grado', many: 'grados' },
    { written: ['mph'], one: 'milla por hora', many: 'millas por hora', feminine: true },
    { written: ['km/h'], one: 'kilómetro por hora', many: 'kilómetros por hora' },
    { written: ['km'], one: 'kilómetro', many: 'kilómetros' },
    { written: ['mm'], one: 'milímetro', many: 'milímetros' },
    { written: ['cm'], one: 'centímetro', many: 'centímetros' },
    { written: ['ft'], one: 'pie', many: 'pies' },
    { written: ['kg'], one: 'kilo', many: 'kilos' },
    { written: ['h'], one: 'hora', many: 'horas', feminine: true },
    { written: ['m'], one: 'metro', many: 'metros' },
  ],
  tr: [
    { written: ['m³', 'm3'], one: 'metreküp', many: 'metreküp' },
    { written: ['m²', 'm2'], one: 'metrekare', many: 'metrekare' },
    { written: ['°C', '°'], one: 'derece', many: 'derece' },
    {
      written: ['km/sa', 'km/s', 'km/h'],
      one: 'kilometre',
      many: 'kilometre',
      around: ['saatte', 'kilometre'],
    },
    { written: ['km'], one: 'kilometre', many: 'kilometre' },
    { written: ['mm'], one: 'milimetre', many: 'milimetre' },
    { written: ['cm'], one: 'santimetre', many: 'santimetre' },
    { written: ['kg'], one: 'kilogram', many: 'kilogram' },
    { written: ['ton'], one: 'ton', many: 'ton' },
    { written: ['lt'], one: 'litre', many: 'litre' },
    { written: ['sa'], one: 'saat', many: 'saat' },
    { written: ['dk'], one: 'dakika', many: 'dakika' },
    { written: ['m'], one: 'metre', many: 'metre' },
  ],
};

/** ES nouns a number agrees with in the feminine ("una empresa", "veintiuna horas"). */
export const SPOKEN_ES_FEMININE: readonly string[] = [
  'hora',
  'horas',
  'empresa',
  'empresas',
  'persona',
  'personas',
  'carga',
  'cargas',
  'yarda',
  'yardas',
  'tonelada',
  'toneladas',
  'losa',
  'losas',
  'semana',
  'semanas',
  'planta',
  'plantas',
  'cuadrilla',
  'cuadrillas',
  'entrega',
  'entregas',
  'versión',
];

/** TR nouns after which "3." is an ordinal even when capitalised ("3. Kat" → "üçüncü Kat"). */
export const SPOKEN_TR_ORDINAL_NOUNS: readonly string[] = [
  'Kat',
  'Blok',
  'Etap',
  'Bölüm',
  'Daire',
  'Gün',
  'Hafta',
  'Sürüm',
  'Bodrum',
];

// ───────────────────────────── Number words ─────────────────────────────

const EN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

function enBelow1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(`${EN_ONES[h]} hundred`);
  if (r) {
    if (r < 20) parts.push(EN_ONES[r]!);
    else
      parts.push(r % 10 ? `${EN_TENS[Math.floor(r / 10)]}-${EN_ONES[r % 10]}` : EN_TENS[r / 10]!);
  }
  return parts.join(' ');
}

function enWords(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = [];
  const m = Math.floor(n / 1_000_000);
  const t = Math.floor((n % 1_000_000) / 1000);
  const r = n % 1000;
  if (m) parts.push(`${enBelow1000(m)} million`);
  if (t) parts.push(`${enBelow1000(t)} thousand`);
  if (r) parts.push(enBelow1000(r));
  return parts.join(' ');
}

const ES_UNITS = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const ES_TENS = [
  '',
  '',
  '',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const ES_HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

/** How an ES number ending in "uno" agrees: alone, before a masculine or a feminine noun. */
type EsForm = 'alone' | 'masc' | 'fem';

function esAgree(words: string, form: EsForm): string {
  if (form === 'alone') return words;
  const one = form === 'masc' ? 'un' : 'una';
  if (words.endsWith('veintiuno'))
    return `${words.slice(0, -'veintiuno'.length)}veinti${form === 'masc' ? 'ún' : 'una'}`;
  if (words === 'uno') return one;
  if (words.endsWith(' uno')) return `${words.slice(0, -3)}${one}`;
  return words;
}

function esBelow1000(n: number, form: EsForm): string {
  if (n === 100) return 'cien';
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  // "doscientas horas": the hundreds agree in the feminine too ("ciento" does not change).
  if (h)
    parts.push(form === 'fem' ? ES_HUNDREDS[h]!.replace(/ientos$/, 'ientas') : ES_HUNDREDS[h]!);
  if (r) {
    if (r < 30) parts.push(ES_UNITS[r]!);
    else
      parts.push(
        r % 10 ? `${ES_TENS[Math.floor(r / 10)]} y ${ES_UNITS[r % 10]}` : ES_TENS[r / 10]!,
      );
  }
  return esAgree(parts.join(' '), form);
}

function esWords(n: number, form: EsForm): string {
  if (n === 0) return 'cero';
  const parts: string[] = [];
  const m = Math.floor(n / 1_000_000);
  const t = Math.floor((n % 1_000_000) / 1000);
  const r = n % 1000;
  if (m) parts.push(m === 1 ? 'un millón' : `${esBelow1000(m, 'masc')} millones`);
  if (t) parts.push(t === 1 ? 'mil' : `${esBelow1000(t, 'masc')} mil`);
  if (r) parts.push(esBelow1000(r, form));
  return parts.join(' ');
}

const TR_ONES = ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TR_TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];

function trBelow1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h) parts.push(h === 1 ? 'yüz' : `${TR_ONES[h]} yüz`);
  if (t) parts.push(TR_TENS[t]!);
  if (o) parts.push(TR_ONES[o]!);
  return parts.join(' ');
}

function trWords(n: number): string {
  if (n === 0) return 'sıfır';
  const parts: string[] = [];
  const m = Math.floor(n / 1_000_000);
  const t = Math.floor((n % 1_000_000) / 1000);
  const r = n % 1000;
  if (m) parts.push(`${trBelow1000(m)} milyon`);
  if (t) parts.push(t === 1 ? 'bin' : `${trBelow1000(t)} bin`);
  if (r) parts.push(trBelow1000(r));
  return parts.join(' ');
}

/** The TR ordinal of a cardinal, by its last word ("üç" → "üçüncü", "yüz seksen" → "yüz sekseninci"). */
const TR_ORDINAL: Readonly<Record<string, string>> = {
  sıfır: 'sıfırıncı',
  bir: 'birinci',
  iki: 'ikinci',
  üç: 'üçüncü',
  dört: 'dördüncü',
  beş: 'beşinci',
  altı: 'altıncı',
  yedi: 'yedinci',
  sekiz: 'sekizinci',
  dokuz: 'dokuzuncu',
  on: 'onuncu',
  yirmi: 'yirminci',
  otuz: 'otuzuncu',
  kırk: 'kırkıncı',
  elli: 'ellinci',
  altmış: 'altmışıncı',
  yetmiş: 'yetmişinci',
  seksen: 'sekseninci',
  doksan: 'doksanıncı',
  yüz: 'yüzüncü',
  bin: 'bininci',
  milyon: 'milyonuncu',
};

function trOrdinal(words: string): string {
  const i = words.lastIndexOf(' ');
  const last = words.slice(i + 1);
  return `${words.slice(0, i + 1)}${TR_ORDINAL[last] ?? last}`;
}

/** Longer than this many digits, a number is read digit by digit. */
const MAX_DIGITS = 9;

const ZERO: Readonly<Record<Language, string>> = { en: 'zero', es: 'cero', tr: 'sıfır' };

/**
 * A whole number written in digits as words: leading zeros each as "zero" ("0187" → "sıfır yüz
 * seksen yedi"), a very long one digit by digit. ES agrees with the noun after it (`form`).
 */
function integerWords(digits: string, language: Language, form: EsForm = 'alone'): string {
  if (digits.length > MAX_DIGITS)
    return [...digits].map((d) => integerWords(d, language)).join(' ');
  const zeros = /^0*/.exec(digits)![0].length;
  if (zeros === digits.length) return Array(digits.length).fill(ZERO[language]).join(' ');
  const n = Number(digits.slice(zeros));
  const words = language === 'en' ? enWords(n) : language === 'es' ? esWords(n, form) : trWords(n);
  return [...Array<string>(zeros).fill(ZERO[language]), words].join(' ');
}

/** A whole number as words in the call language (TR 184 → "yüz seksen dört"). */
export function spokenInteger(n: number, language: Language): string {
  return integerWords(String(Math.trunc(Math.abs(n))), language);
}

// ───────────────────────────── Times ─────────────────────────────

/** "17:30" as said: TR 24-hour ("on yedi otuz"), EN and ES 12-hour with the part of the day. */
export function spokenTime(hh: number, mm: number, language: Language): string {
  if (language === 'tr') {
    const h = trWords(hh);
    if (mm === 0) return h;
    return `${h} ${mm < 10 ? `sıfır ${trWords(mm)}` : trWords(mm)}`;
  }
  const h12 = hh % 12 || 12;
  if (language === 'en') {
    if (mm === 0 && hh === 12) return 'noon';
    if (mm === 0 && hh === 0) return 'midnight';
    const m = mm === 0 ? '' : mm < 10 ? ` oh ${enWords(mm)}` : ` ${enWords(mm)}`;
    return `${enWords(h12)}${m} ${hh < 12 ? 'a.m.' : 'p.m.'}`;
  }
  if (mm === 0 && hh === 12) return 'doce del mediodía';
  const hour = h12 === 1 ? 'una' : esWords(h12, 'alone');
  const m =
    mm === 0 ? '' : mm === 15 ? ' y cuarto' : mm === 30 ? ' y media' : ` y ${esWords(mm, 'alone')}`;
  const part =
    hh < 6 ? 'de la madrugada' : hh < 12 ? 'de la mañana' : hh < 20 ? 'de la tarde' : 'de la noche';
  return `${hour}${m} ${part}`;
}

// ───────────────────────────── Decimals ─────────────────────────────

/** A number with a fraction ("7,5" / "3.5"): `whole` and `fraction` are its digits. */
function decimalWords(whole: string, fraction: string, language: Language, form: EsForm): string {
  const w = integerWords(whole, language);
  const half = /^50*$/.test(fraction);
  if (language === 'tr') {
    if (half) return Number(whole) === 0 ? 'yarım' : `${w} buçuk`;
    return `${w} virgül ${integerWords(fraction, 'tr')}`;
  }
  if (language === 'en') {
    if (half && Number(whole) > 0) return `${w} and a half`;
    return `${w} point ${[...fraction].map((d) => EN_ONES[Number(d)]).join(' ')}`;
  }
  if (half && Number(whole) > 0) return `${integerWords(whole, 'es', form)} y medio`;
  return `${integerWords(whole, 'es', form)} punto ${integerWords(fraction, 'es')}`;
}

// ───────────────────────────── speakable ─────────────────────────────

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Not inside a word or a longer number. */
const BEFORE = String.raw`(?<![\p{L}\d_])`;
const AFTER = String.raw`(?!\d)`;

/** The number syntax of each language's written lines (Intl's en-US, es-US, tr-TR, and the model's). */
const NUMBER_RE: Readonly<Record<Language, string>> = {
  // 1,234.5 · 7.5 · 184
  en: String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`,
  // es-US writes 3.5; a model may write 3,5 (one or two decimals: a thousands group has three)
  es: String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+,\d{1,2}(?!\d)|\d+`,
  // tr-TR: 1.234,5 · 7,5; a model may write 7.5 (one or two decimals)
  tr: String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+|\d+\.\d{1,2}(?![\d])(?!\.)|\d+`,
};

/** Splits a written number into its whole and fraction digits, per language. */
function parseNumber(written: string, language: Language): { whole: string; fraction: string } {
  let s = written;
  if (language === 'tr') {
    if (/^\d{1,3}(?:\.\d{3})+/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
  } else if (/^\d{1,3}(?:,\d{3})+/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const [whole = '0', fraction = ''] = s.split('.');
  return { whole, fraction };
}

/** A written number as words (`form`: ES agreement with the next noun). */
function numberWords(written: string, language: Language, form: EsForm = 'alone'): string {
  const { whole, fraction } = parseNumber(written, language);
  if (fraction && /[1-9]/.test(fraction)) return decimalWords(whole, fraction, language, form);
  return integerWords(whole, language, form);
}

/** ES words after a number that are not its noun ("1 en la obra" stays "uno"). */
const ES_NOT_A_NOUN = ['en', 'de', 'del', 'y', 'o', 'a', 'al', 'por', 'para', 'con', 'que', 'se'];

/** ES agreement from the word after the number. */
function esFormOf(rest: string): EsForm {
  const next = /^\s+(\p{L}+)/u.exec(rest)?.[1]?.toLocaleLowerCase('es');
  if (!next || ES_NOT_A_NOUN.includes(next)) return 'alone';
  return SPOKEN_ES_FEMININE.includes(next) ? 'fem' : 'masc';
}

const AND: Readonly<Record<Language, string>> = { en: 'and', es: 'y', tr: 've' };
const PERCENT: Readonly<Record<Language, string>> = {
  en: 'percent',
  es: 'por ciento',
  tr: 'yüzde',
};

/** Replaces each match of `re` in `text` with `fn(match, rest-of-text)`. */
function replaceWithRest(
  text: string,
  re: RegExp,
  fn: (m: RegExpExecArray, rest: string) => string,
): string {
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += text.slice(last, m.index) + fn(m, text.slice(m.index + m[0].length));
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + text.slice(last);
}

/**
 * `text` as the agent says it in `language` (§19 Q245 `SPOKEN_FORM`): names from the listening
 * test's list, report numbers, times, percentages, units and numbers in words. A line without
 * digits or symbols comes back as it was. Pure.
 */
export function speakable(
  text: string,
  language: Language,
  opts: { policy?: SpokenFormPolicy } = {},
): string {
  if ((opts.policy ?? SPOKEN_FORM) === 'tts' || !text) return text;
  let s = text;

  // 1. Names the listening test flagged (whole words).
  for (const [written, said] of Object.entries(SPOKEN_PRONUNCIATIONS[language])) {
    s = s.replace(new RegExp(`(?<![\\p{L}\\d])${escape(written)}(?![\\p{L}\\d])`, 'gu'), said);
  }

  // 2. "&" between words.
  s = s.replace(/\s&\s/g, ` ${AND[language]} `);

  // 3. Report numbers in groups: "RL-2041-0187" → "RL two thousand forty-one, zero one hundred
  //    eighty-seven".
  s = s.replace(
    /(?<![\p{L}\d-])([A-Z]{1,6})((?:-\d{2,6})+)(?![\p{L}\d-])/gu,
    (_m, letters: string, groups: string) =>
      `${letters} ${groups
        .slice(1)
        .split('-')
        .map((g) => integerWords(g, language))
        .join(', ')}`,
  );

  // 4. Times. ES "las 13:00" → "la una de la tarde"; TR also "saat 17.30".
  const timeRe =
    language === 'tr'
      ? /(?<![\d:.,])(?:(?<=[Ss]aat\s)([01]?\d|2[0-3])\.([0-5]\d)|([01]?\d|2[0-3]):([0-5]\d))(?![\d:])(?:['’](\p{Ll}+))?/gu
      : /(\blas\s+)?(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/gu;
  s = s.replace(timeRe, (...m: unknown[]) => {
    if (language === 'tr') {
      const hh = Number((m[1] ?? m[3]) as string);
      const mm = Number((m[2] ?? m[4]) as string);
      return `${spokenTime(hh, mm, 'tr')}${(m[5] as string | undefined) ?? ''}`;
    }
    const las = m[1] as string | undefined;
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    const said = spokenTime(hh, mm, language);
    if (!las) return said;
    // "a las una" → "a la una"; "a las doce del mediodía" stays.
    return `${(hh % 12 || 12) === 1 && said.startsWith('una') ? las.replace(/las/, 'la') : las}${said}`;
  });
  // "at five thirty p.m.." at the end of a sentence: one full stop.
  if (language === 'en') s = s.replace(/([ap])\.m\.\./g, '$1.m.');

  const num = NUMBER_RE[language];

  // 5. Percentages.
  if (language === 'tr') {
    s = s.replace(
      new RegExp(`%\\s?(${num})${AFTER}|${BEFORE}(${num})\\s?%`, 'gu'),
      (_m, a: string | undefined, b: string | undefined) => `yüzde ${numberWords((a ?? b)!, 'tr')}`,
    );
  } else {
    s = s.replace(
      new RegExp(`${BEFORE}(${num})\\s?%`, 'gu'),
      (_m, n: string) => `${numberWords(n, language)} ${PERCENT[language]}`,
    );
  }

  // 6. Units after a number (longest written form first, so "m³" before "m").
  const units = SPOKEN_UNITS[language]
    .flatMap((u) => u.written.map((w) => ({ w, u })))
    .sort((a, b) => b.w.length - a.w.length);
  const unitAlt = units.map((x) => escape(x.w)).join('|');
  s = replaceWithRest(
    s,
    new RegExp(`${BEFORE}(${num})\\s?(${unitAlt})(?![\\p{L}\\d²³])`, 'gu'),
    (m) => {
      const written = m[1]!;
      const unit = units.find((x) => x.w === m[2])!.u;
      const { whole, fraction } = parseNumber(written, language);
      const one = Number(whole) === 1 && !/[1-9]/.test(fraction);
      const form: EsForm = unit.feminine ? 'fem' : 'masc';
      const words = numberWords(written, language, form);
      if (unit.around) return `${unit.around[0]} ${words} ${unit.around[1]}`;
      return `${words} ${one ? unit.one : unit.many}`;
    },
  );

  // 7. ES halves before a noun: "3.5 horas" → "tres horas y media".
  if (language === 'es') {
    s = s.replace(
      new RegExp(`${BEFORE}([1-9]\\d*)[.,]50?${AFTER}\\s+(\\p{L}+)`, 'gu'),
      (_m, whole: string, noun: string) => {
        const fem = SPOKEN_ES_FEMININE.includes(noun.toLocaleLowerCase('es'));
        return `${integerWords(whole, 'es', fem ? 'fem' : 'masc')} ${noun} y ${fem ? 'media' : 'medio'}`;
      },
    );
  }

  // 8. Every other number. TR: "3. Kat" is an ordinal; "14'te" joins its suffix.
  const ordinals = SPOKEN_TR_ORDINAL_NOUNS.map(escape).join('|');
  const rest =
    language === 'tr'
      ? `(?:(\\.)(?=\\s+(?:\\p{Ll}|(?:${ordinals})(?![\\p{L}])))|['’](\\p{Ll}+))?`
      : '';
  s = replaceWithRest(s, new RegExp(`${BEFORE}(${num})${AFTER}${rest}`, 'gu'), (m, after) => {
    const written = m[1]!;
    if (language === 'tr') {
      if (m[2]) return trOrdinal(numberWords(written.replace(/\.$/, ''), 'tr'));
      return `${numberWords(written, 'tr')}${m[3] ?? ''}`;
    }
    return numberWords(written, language, language === 'es' ? esFormOf(after) : 'alone');
  });

  return s;
}

// ───────────────────────────── field-api's answers ─────────────────────────────

/**
 * The spoken strings of a `/voice/tools/*` answer (spec Appendix B) and the contract's longest
 * length for each: a spoken form that would not fit is handed as written (never cut).
 */
const SPOKEN_FIELDS: Readonly<Record<string, number>> = {
  confirmation: 400,
  summary: 1200,
  lines: 400,
  choices: 80,
};

/**
 * field-api's half of §19 Q245: every line it hands the agent in the spoken form, wherever the
 * answer carries one: `readBack` (a draft state's ≤ 1200, a correction's ≤ 800), `question.text`
 * and `choices`, `lines`, `confirmation`, `summary`, in a nested `draft` too. Ids, names, report
 * numbers as data and every other key are left as they are. Pure; returns a new value.
 */
export function speakableVoiceAnswer<T>(body: T, language: Language, policy?: SpokenFormPolicy): T {
  const say = (text: string, max: number): string => {
    const spoken = speakable(text, language, policy ? { policy } : {});
    return spoken.length <= max ? spoken : text;
  };
  const walk = (
    value: unknown,
    key: string | null,
    parent: Record<string, unknown> | null,
  ): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key, parent));
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, walk(v, k, obj)]));
    }
    if (typeof value !== 'string' || key === null) return value;
    if (key === 'readBack') return say(value, parent && 'draftRev' in parent ? 1200 : 800);
    if (key === 'text') return parent && 'choices' in parent ? say(value, 400) : value;
    const max = SPOKEN_FIELDS[key];
    return max === undefined ? value : say(value, max);
  };
  return walk(body, null, null) as T;
}

// ───────────────────────────── The golden table ─────────────────────────────

/**
 * Every rule, by example, per language (W4-07's `speakable` tables): the shared tests check them,
 * and `pnpm voice:contract` writes them to the agent, whose Python port must say the same.
 */
export const SPOKEN_FORM_CASES: ReadonlyArray<
  readonly [language: Language, written: string, spoken: string]
> = [
  // TR: §9.4's own example, decimals, units, times, percentages, report numbers, ordinals.
  [
    'tr',
    'Elimdeki bilgiler: 5 firmadan sahada 23 kişi, toplam 184 saat.',
    'Elimdeki bilgiler: beş firmadan sahada yirmi üç kişi, toplam yüz seksen dört saat.',
  ],
  ['tr', 'Hava nedeniyle 3,5 saat çalışılamadı.', 'Hava nedeniyle üç buçuk saat çalışılamadı.'],
  ['tr', 'kişi başı 7,5 saat', 'kişi başı yedi buçuk saat'],
  ['tr', '0,5 saat kayıp', 'yarım saat kayıp'],
  ['tr', 'toplam 54,25 saat', 'toplam elli dört virgül yirmi beş saat'],
  ['tr', 'toplam 1.250 saat', 'toplam bin iki yüz elli saat'],
  ['tr', '2041', 'iki bin kırk bir'],
  ['tr', '100 kişi, 1000 saat, 1.000.000', 'yüz kişi, bin saat, bir milyon'],
  ['tr', 'Usta Beton firmasından 45 m³ beton', 'Usta Beton firmasından kırk beş metreküp beton'],
  [
    'tr',
    '12 m2 kalıp, 3 ton demir, 250 kg',
    'on iki metrekare kalıp, üç ton demir, iki yüz elli kilogram',
  ],
  [
    'tr',
    'Sıcaklık 18 °C, rüzgâr 40 km/sa.',
    'Sıcaklık on sekiz derece, rüzgâr saatte kırk kilometre.',
  ],
  ['tr', 'yaklaşık %60', 'yaklaşık yüzde altmış'],
  ['tr', 'yaklaşık 60%', 'yaklaşık yüzde altmış'],
  ['tr', 'iş saat 11:00 itibarıyla durdu', 'iş saat on bir itibarıyla durdu'],
  ['tr', 'sizi saat 17:30 gibi arayacağım', 'sizi saat on yedi otuz gibi arayacağım'],
  ['tr', 'saat 08:05', 'saat sekiz sıfır beş'],
  ['tr', 'saat 14.30 gibi', 'saat on dört otuz gibi'],
  ['tr', "saat 14'te bitti, 07:00'de pompa", 'saat on dörtte bitti, yedide pompa'],
  [
    'tr',
    'Cuma raporu, RL-2041-0187: sahada 6 kişi.',
    'Cuma raporu, RL iki bin kırk bir, sıfır yüz seksen yedi: sahada altı kişi.',
  ],
  ['tr', 'KK-1203-0001', 'KK bin iki yüz üç, sıfır sıfır sıfır bir'],
  ['tr', '3. Kat döşeme betonu dökümü tamamlandı', 'üçüncü Kat döşeme betonu dökümü tamamlandı'],
  [
    'tr',
    '4. katın donatısı, 10. kat, 100. gün',
    'dördüncü katın donatısı, onuncu kat, yüzüncü gün',
  ],
  ['tr', 'Not edilen iş: 5. Teslimatlar: 1.', 'Not edilen iş: beş. Teslimatlar: bir.'],
  ['tr', 'Kaydedildi. Sürüm 2 ofise gidiyor.', 'Kaydedildi. Sürüm iki ofise gidiyor.'],
  ['tr', 'Usta & Oğulları', 'Usta ve Oğulları'],
  ['tr', 'B2 blok, A-3', 'B2 blok, A-üç'],
  ['tr', 'Kaydedeyim mi?', 'Kaydedeyim mi?'],
  // EN
  [
    'en',
    "Here's what I've got: 23 on site from 5 companies, 184 hours.",
    "Here's what I've got: twenty-three on site from five companies, one hundred eighty-four hours.",
  ],
  ['en', 'Weather stopped work for 3.5 hours.', 'Weather stopped work for three and a half hours.'],
  [
    'en',
    '0.5 hours, 7.25 hours, 1,250 hours',
    'zero point five hours, seven point two five hours, one thousand two hundred fifty hours',
  ],
  [
    'en',
    'Level 3 electrical rough-in about 60 percent',
    'Level three electrical rough-in about sixty percent',
  ],
  ['en', 'rough-in 60% done', 'rough-in sixty percent done'],
  [
    'en',
    'Delivered: 68 yd³ of concrete, 1 cu yd of grout, 40 ft of pipe',
    'Delivered: sixty-eight cubic yards of concrete, one cubic yard of grout, forty feet of pipe',
  ],
  ['en', 'gusts 17 mph, 64 °F', 'gusts seventeen miles per hour, sixty-four degrees'],
  [
    'en',
    "OK, I'll call you back at 17:30. Goodbye.",
    "OK, I'll call you back at five thirty p.m. Goodbye.",
  ],
  [
    'en',
    'work stopped at 11:00, 08:05, 12:00, 00:00',
    'work stopped at eleven a.m., eight oh five a.m., noon, midnight',
  ],
  [
    'en',
    "Friday's report, NG-2210-0060: 6 on site.",
    "Friday's report, NG two thousand two hundred ten, zero zero sixty: six on site.",
  ],
  [
    'en',
    'Apex Concrete: 7 workers, 8 hours each — 56 hours.',
    'Apex Concrete: seven workers, eight hours each — fifty-six hours.',
  ],
  ['en', '4, full day', 'four, full day'],
  ['en', 'Saved. Version 2 goes to the office.', 'Saved. Version two goes to the office.'],
  ['en', 'Shall I file it?', 'Shall I file it?'],
  // ES
  [
    'es',
    'Esto es lo que tengo: 23 en la obra de 5 empresas, 184 horas.',
    'Esto es lo que tengo: veintitrés en la obra de cinco empresas, ciento ochenta y cuatro horas.',
  ],
  ['es', 'El clima detuvo el trabajo 3.5 horas.', 'El clima detuvo el trabajo tres horas y media.'],
  ['es', '3,5 horas', 'tres horas y media'],
  ['es', '7.25 horas, 0.5', 'siete punto veinticinco horas, cero punto cinco'],
  [
    'es',
    '1 empresa, 21 horas, 1 trabajador, 31 días, 1',
    'una empresa, veintiuna horas, un trabajador, treinta y un días, uno',
  ],
  [
    'es',
    'Esto es lo que tengo: 1 en la obra de 1 empresa, 8 horas.',
    'Esto es lo que tengo: uno en la obra de una empresa, ocho horas.',
  ],
  ['es', '-3 °C, 4-5 trabajadores', '-tres grados, cuatro-cinco trabajadores'],
  [
    'es',
    '100 horas, 101 trabajadores, 1,500 horas',
    'cien horas, ciento un trabajadores, mil quinientas horas',
  ],
  ['es', 'al 60 por ciento, al 60%', 'al sesenta por ciento, al sesenta por ciento'],
  ['es', '68 yd³ de concreto, 1 m³', 'sesenta y ocho yardas cúbicas de concreto, un metro cúbico'],
  [
    'es',
    'le llamo a las 17:30, a las 13:00, a las 7:15',
    'le llamo a las cinco y media de la tarde, a la una de la tarde, a las siete y cuarto de la mañana',
  ],
  [
    'es',
    'Reporte del viernes, RL-2041-0187: 6 en obra.',
    'Reporte del viernes, RL dos mil cuarenta y uno, cero ciento ochenta y siete: seis en obra.',
  ],
  ['es', '4, todo el día', 'cuatro, todo el día'],
];
