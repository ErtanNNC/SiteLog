import { describe, expect, it } from 'vitest';
import { countSmsSegments } from '../sms/segments.ts';
import {
  renderSms,
  SMS_CATALOGS,
  SMS_KEYS,
  SMS_VARS,
  smsTemplate,
  US_ONLY_SMS_KEYS,
  type SmsKey,
  type SmsLocale,
  type SmsWithCallOption,
} from './sms.ts';

const LOCALES: SmsLocale[] = ['en', 'es', 'tr'];
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!).sort();
}

function entries(): Array<[SmsLocale, SmsKey, string | SmsWithCallOption]> {
  const out: Array<[SmsLocale, SmsKey, string | SmsWithCallOption]> = [];
  for (const locale of LOCALES) {
    const catalog = SMS_CATALOGS[locale] as Partial<Record<SmsKey, string | SmsWithCallOption>>;
    for (const key of SMS_KEYS) {
      const t = catalog[key];
      if (t !== undefined) out.push([locale, key, t]);
    }
  }
  return out;
}

/** Locale-aware lower case, so "Call …" / "Tap …" capitalisation does not matter. */
const lower = (locale: SmsLocale, s: string) =>
  s.toLocaleLowerCase(locale === 'tr' ? 'tr-TR' : locale === 'es' ? 'es-US' : 'en-US');

describe('SMS catalog (§9.2)', () => {
  it('has every key in EN and ES, and every key except the US-only ones in TR', () => {
    expect(Object.keys(SMS_CATALOGS.en).sort()).toEqual([...SMS_KEYS].sort());
    expect(Object.keys(SMS_CATALOGS.es).sort()).toEqual([...SMS_KEYS].sort());
    const shared = SMS_KEYS.filter((k) => !(US_ONLY_SMS_KEYS as readonly string[]).includes(k));
    expect(Object.keys(SMS_CATALOGS.tr).sort()).toEqual([...shared].sort());
  });

  it('uses exactly the declared variables in every text', () => {
    for (const [locale, key, t] of entries()) {
      const vars = [...SMS_VARS[key]].sort();
      if (typeof t === 'string') {
        expect(vars, `${locale}.${key}`).not.toContain('number');
        expect(placeholders(t), `${locale}.${key}`).toEqual(vars);
      } else {
        expect(vars, `${locale}.${key}`).toContain('number');
        expect(placeholders(t.withNumber), `${locale}.${key}`).toEqual(vars);
        expect(placeholders(t.withoutNumber), `${locale}.${key}`).toEqual(
          vars.filter((v) => v !== 'number'),
        );
      }
    }
  });

  it('drops exactly one "or call {number}" clause, and nothing else, without a voice number', () => {
    const callWords: Record<SmsLocale, RegExp> = {
      en: /\bor (just )?call\b|\bcall \{/i,
      es: /llame/i,
      tr: /arayın/i,
    };
    let checked = 0;
    for (const [locale, key, t] of entries()) {
      if (typeof t === 'string') continue;
      const full = lower(locale, t.withNumber);
      const short = lower(locale, t.withoutNumber);
      // withNumber = head + clause + tail and withoutNumber = head + tail, for some split point,
      // where the clause holds {number}. (A split can shift when the clause borders a brace.)
      const clauses: string[] = [];
      for (let i = 0; i <= short.length; i += 1) {
        const head = short.slice(0, i);
        const tail = short.slice(i);
        if (full.startsWith(head) && full.endsWith(tail) && full.length > short.length) {
          clauses.push(full.slice(i, full.length - tail.length));
        }
      }
      expect(
        clauses.some((c) => c.includes('{number}')),
        `${locale}.${key}: the short text is the long one minus one clause with {number}`,
      ).toBe(true);
      expect(t.withoutNumber, `${locale}.${key}`).not.toMatch(callWords[locale]);
      checked += 1;
    }
    // welcome, daily_link, reminder_2, missed_call in EN/ES/TR, help in EN/ES.
    expect(checked).toBe(14);
  });

  it('never asks for a reply in Turkish (one-way sender)', () => {
    for (const [locale, key, t] of entries()) {
      if (locale !== 'tr') continue;
      const texts = typeof t === 'string' ? [t] : [t.withNumber, t.withoutNumber];
      for (const text of texts) {
        expect(text, key).not.toMatch(/STOP|HELP|START|yanıt|cevap|reply/i);
        expect(text, key).not.toMatch(/!/); // §9.7: no exclamation marks in TR
      }
    }
  });

  it('uses no emoji in any language', () => {
    for (const [, key, t] of entries()) {
      const texts = typeof t === 'string' ? [t] : [t.withNumber, t.withoutNumber];
      for (const text of texts) expect(text, key).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('renderSms', () => {
  const welcomeVars = {
    first: 'Marco',
    company: 'Kestrel Build Group',
    site: 'Riverside Lofts — Block B',
    deadline: '17:30',
    number: '+1 (555) 014-2290',
    link: 'sl.link/r/MRZ4K7',
  };

  it('renders EN with and without a voice number (Field-01 thread)', () => {
    expect(
      renderSms(
        'daily_link',
        'en',
        { site: 'Riverside Lofts B', link: 'sl.link/r/Q7T2XD', number: '+1 (555) 014-2290' },
        { hasVoiceNumber: true },
      ),
    ).toBe(
      "Today's report for Riverside Lofts B: sl.link/r/Q7T2XD — or just call +1 (555) 014-2290.",
    );
    expect(
      renderSms(
        'daily_link',
        'en',
        { site: 'Riverside Lofts B', link: 'sl.link/r/Q7T2XD' },
        { hasVoiceNumber: false },
      ),
    ).toBe("Today's report for Riverside Lofts B: sl.link/r/Q7T2XD");
    expect(renderSms('welcome', 'en', welcomeVars, { hasVoiceNumber: true })).toBe(
      "Hi Marco, I'm SiteLog, the daily report assistant for Kestrel Build Group at Riverside Lofts — Block B. Each workday before 17:30, tap your link and talk for ~3 min, or call +1 (555) 014-2290: sl.link/r/MRZ4K7 · Reply STOP to opt out, HELP for help",
    );
    expect(renderSms('welcome', 'en', welcomeVars, { hasVoiceNumber: false })).toBe(
      "Hi Marco, I'm SiteLog, the daily report assistant for Kestrel Build Group at Riverside Lofts — Block B. Each workday before 17:30, tap your link and talk for ~3 min: sl.link/r/MRZ4K7 · Reply STOP to opt out, HELP for help",
    );
    expect(
      renderSms(
        'filed',
        'en',
        { report_no: 'RL-2041-0187', pdf_link: 'sl.link/p/RL0187' },
        { hasVoiceNumber: true },
      ),
    ).toBe('Filed: Daily Report RL-2041-0187. PDF: sl.link/p/RL0187');
    expect(
      renderSms(
        'edit_applied',
        'en',
        { weekday: 'Friday', change: 'Apex Concrete 7 workers · 56 h (was 6 · 48 h)', v: 2 },
        { hasVoiceNumber: true },
      ),
    ).toBe(
      'Updated Friday: Apex Concrete 7 workers · 56 h (was 6 · 48 h). Version 2 sent to the office.',
    );
    expect(
      renderSms(
        'help',
        'en',
        { company: 'Kestrel Build Group', link: 'sl.link/r/Q7T2XD' },
        {
          hasVoiceNumber: false,
        },
      ),
    ).toBe(
      'SiteLog daily reports for Kestrel Build Group. Your link: sl.link/r/Q7T2XD · Text CALL or TEXT to switch · STOP to opt out. Msg & data rates may apply.',
    );
  });

  it('renders ES with and without a voice number', () => {
    expect(renderSms('welcome', 'es', welcomeVars, { hasVoiceNumber: true })).toBe(
      'Hola Marco, soy SiteLog, el asistente de reportes diarios de Kestrel Build Group en Riverside Lofts — Block B. Cada día de trabajo antes de las 17:30, toque su enlace y hable unos 3 min, o llame al +1 (555) 014-2290: sl.link/r/MRZ4K7 · Responda STOP para darse de baja, HELP para ayuda',
    );
    expect(
      renderSms('missed_call', 'es', { link: 'sl.link/r/Q7T2XD' }, { hasVoiceNumber: false }),
    ).toBe('No pude comunicarme con usted para el reporte de hoy. Toque sl.link/r/Q7T2XD.');
    expect(
      renderSms(
        'missed_call',
        'es',
        { link: 'sl.link/r/Q7T2XD', number: '+1 (555) 014-2290' },
        { hasVoiceNumber: true },
      ),
    ).toBe(
      'No pude comunicarme con usted para el reporte de hoy. Llame al +1 (555) 014-2290 o toque sl.link/r/Q7T2XD.',
    );
    expect(renderSms('stop_confirm', 'es', {}, { hasVoiceNumber: true })).toBe(
      'Ya no recibirá mensajes de SiteLog. Responda START para reactivarlos.',
    );
    expect(renderSms('unknown_number', 'es', {}, { hasVoiceNumber: true })).toBe(
      'Este número no está en SiteLog. Pida a su oficina que lo agregue.',
    );
  });

  it("names the edited day's report in ES edit_applied (not the day of the edit)", () => {
    // `formatDate(d, 'weekday', 'es')` gives the lower-case weekday for mid-sentence use.
    expect(
      renderSms(
        'edit_applied',
        'es',
        {
          weekday: 'viernes',
          change: 'Apex Concrete 7 trabajadores · 56 h (antes 6 · 48 h)',
          v: 2,
        },
        { hasVoiceNumber: true },
      ),
    ).toBe(
      'Reporte del viernes actualizado: Apex Concrete 7 trabajadores · 56 h (antes 6 · 48 h). Versión 2 enviada a la oficina.',
    );
  });

  it('keeps every ES text without variables to one segment (§9.2)', () => {
    let checked = 0;
    for (const key of SMS_KEYS) {
      if (SMS_VARS[key].length > 0) continue;
      const text = renderSms(key as 'stop_confirm', 'es', {}, { hasVoiceNumber: true });
      expect(countSmsSegments(text).default.segments, `es.${key}: "${text}"`).toBe(1);
      checked += 1;
    }
    expect(checked).toBe(2); // unknown_number, stop_confirm
  });

  it('renders TR with and without a voice number (no TR number yet: §18.2)', () => {
    const vars = {
      first: 'Mehmet',
      company: 'Demir Yapı A.Ş.',
      site: 'Ataşehir Ofis Binası',
      deadline: '17:30',
      link: 'go.sitelog.app/r/K4T9QZ',
    };
    expect(renderSms('welcome', 'tr', vars, { hasVoiceNumber: false })).toBe(
      'Merhaba Mehmet, ben SiteLog, Demir Yapı A.Ş. için Ataşehir Ofis Binası günlük rapor asistanıyım. Her iş günü 17:30 öncesi linke dokunup ~3 dk anlatın: go.sitelog.app/r/K4T9QZ',
    );
    expect(
      renderSms('welcome', 'tr', { ...vars, number: '+90 850 123 4567' }, { hasVoiceNumber: true }),
    ).toBe(
      'Merhaba Mehmet, ben SiteLog, Demir Yapı A.Ş. için Ataşehir Ofis Binası günlük rapor asistanıyım. Her iş günü 17:30 öncesi linke dokunup ~3 dk anlatın ya da +90 850 123 4567 numarayı arayın: go.sitelog.app/r/K4T9QZ',
    );
    expect(
      renderSms(
        'reminder_2',
        'tr',
        { time: '19:00', link: 'go.sitelog.app/r/K4T9QZ' },
        {
          hasVoiceNumber: false,
        },
      ),
    ).toBe(
      'Bugün için hâlâ rapor yok. Saat 19:00 itibarıyla ofise bilgi vereceğim. go.sitelog.app/r/K4T9QZ',
    );
    expect(
      renderSms(
        'missed_call',
        'tr',
        { link: 'go.sitelog.app/r/K4T9QZ' },
        { hasVoiceNumber: false },
      ),
    ).toBe('Bugünkü rapor için ulaşamadım. go.sitelog.app/r/K4T9QZ');
  });

  it('adds nothing to a Turkish text', () => {
    for (const key of SMS_KEYS) {
      if ((US_ONLY_SMS_KEYS as readonly string[]).includes(key)) continue;
      for (const hasVoiceNumber of [true, false]) {
        const template = smsTemplate(key, 'tr', hasVoiceNumber);
        const vars = Object.fromEntries(SMS_VARS[key].map((v) => [v, `<${v}>`]));
        const out = renderSms(key as 'filed', 'tr', vars as never, { hasVoiceNumber });
        expect(out).toBe(template.replace(/\{([a-z0-9_]+)\}/g, '<$1>'));
      }
    }
  });

  it('fails loudly on a missing, null or empty variable', () => {
    expect(() =>
      renderSms('reminder_1', 'en', { site: 'Riverside Lofts B' } as never, {
        hasVoiceNumber: true,
      }),
    ).toThrow('SMS "reminder_1" (en) needs {link}');
    expect(() =>
      renderSms('reminder_1', 'tr', { site: '', link: 'x' }, { hasVoiceNumber: false }),
    ).toThrow('needs {site}');
    expect(() =>
      renderSms('filed', 'es', { report_no: null, pdf_link: 'x' } as never, {
        hasVoiceNumber: true,
      }),
    ).toThrow('needs {report_no}');
  });

  it('needs {number} only when there is a voice number', () => {
    expect(() =>
      renderSms('daily_link', 'tr', { site: 'Ataşehir', link: 'x' }, { hasVoiceNumber: true }),
    ).toThrow('SMS "daily_link" (tr) needs {number}');
    expect(
      renderSms(
        'daily_link',
        'tr',
        { site: 'Ataşehir', link: 'x', number: '+90 850 123 4567' },
        {
          hasVoiceNumber: false,
        },
      ),
    ).toBe('Ataşehir bugünkü rapor: x');
  });

  it('refuses US-only keys in Turkish and unknown keys', () => {
    expect(() =>
      renderSms('help', 'tr' as 'en', { company: 'x', link: 'y' }, { hasVoiceNumber: true }),
    ).toThrow('SMS "help" is US-only and has no "tr" text');
    expect(() => smsTemplate('nope' as SmsKey, 'en', true)).toThrow('Unknown SMS key "nope"');
    expect(() => smsTemplate('constructor' as SmsKey, 'en', true)).toThrow('Unknown SMS key');
    expect(() => smsTemplate('filed', 'toString' as SmsLocale, true)).toThrow('No SMS copy');
    expect(() => smsTemplate('filed', 'de' as SmsLocale, true)).toThrow(
      'No SMS copy for locale "de"',
    );
  });

  it('inserts values literally (no second pass over braces in a value)', () => {
    expect(renderSms('question_ready', 'en', { link: '{link}' }, { hasVoiceNumber: true })).toBe(
      "One quick question about today's report: {link}",
    );
  });
});
