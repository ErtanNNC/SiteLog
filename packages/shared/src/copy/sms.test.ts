import { describe, expect, it } from 'vitest';
import { countSmsSegments } from '../sms/segments.ts';
import { weatherPhrase, type SiteDayWeather } from '../weather/observed.ts';
import {
  isTwoWaySmsKey,
  MESSAGE_KEYS_WITH_LINK,
  messageKeyHasLink,
  renderSms,
  renderTestMessage,
  renderWeatherPhrase,
  SMS_CATALOGS,
  SMS_WEATHER_PHRASES,
  SMS_KEYS,
  SMS_REPLY_HINT,
  SMS_VARS,
  smsCopyGaps,
  smsTemplate,
  TWO_WAY_SMS_KEYS,
  KEYWORD_REPLY_SMS_KEYS,
  type RenderSmsOptions,
  type SmsCopySource,
  type SmsKey,
  type SmsLocale,
  type SmsWithCallOption,
} from './sms.ts';

/** The launch packs' variants with a voice number (US: two-way; TR: one-way; both allow links). */
const TWO_WAY: RenderSmsOptions = { hasVoiceNumber: true, twoWay: true, linksAllowed: true };
const TWO_WAY_NO_NUMBER: RenderSmsOptions = {
  hasVoiceNumber: false,
  twoWay: true,
  linksAllowed: true,
};
const ONE_WAY: RenderSmsOptions = { hasVoiceNumber: true, twoWay: false, linksAllowed: true };
const ONE_WAY_NO_NUMBER: RenderSmsOptions = {
  hasVoiceNumber: false,
  twoWay: false,
  linksAllowed: true,
};

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

/** Reply instructions in EN, ES and TR: the keywords (in capitals, as sent) and the verbs. */
const REPLY_WORDING = /\b(?:STOP|HELP|START)\b|\b[Rr]eply\b|\b[Rr]esponda\b|yanıt|cevap/;

/** Locale-aware lower case, so "Call …" / "Tap …" capitalisation does not matter. */
const lower = (locale: SmsLocale, s: string) =>
  s.toLocaleLowerCase(locale === 'tr' ? 'tr-TR' : locale === 'es' ? 'es-US' : 'en-US');

describe('SMS catalog (§9.2)', () => {
  it('has every key in EN, ES and TR (TR two-way texts since W2-16, for WhatsApp)', () => {
    expect(Object.keys(SMS_CATALOGS.en).sort()).toEqual([...SMS_KEYS].sort());
    expect(Object.keys(SMS_CATALOGS.es).sort()).toEqual([...SMS_KEYS].sort());
    expect(Object.keys(SMS_CATALOGS.tr).sort()).toEqual([...SMS_KEYS].sort());
    expect(KEYWORD_REPLY_SMS_KEYS.length).toBe(3);
    expect([...TWO_WAY_SMS_KEYS]).toEqual([
      'unknown_number',
      'help',
      'stop_confirm',
      'pref_call_ok',
      'pref_text_ok',
      'day_off_link',
      'edit_preview',
      'edit_unclear',
      'whatsapp_use_link',
      'whatsapp_stop_confirm',
    ]);
    // The reply hint is EN and ES only: the TR pack is one-way.
    expect(Object.keys(SMS_REPLY_HINT).sort()).toEqual(['en', 'es']);
  });

  it('keeps reply wording out of the catalogue: only the two-way keys and the hint have it', () => {
    for (const hint of Object.values(SMS_REPLY_HINT)) expect(hint).toMatch(REPLY_WORDING);
    for (const key of ['help', 'stop_confirm', 'pref_call_ok', 'pref_text_ok'] as const)
      for (const locale of ['en', 'es'] as const)
        expect(smsTemplate(key, locale, TWO_WAY), `${locale}.${key}`).toMatch(REPLY_WORDING);
    for (const [locale, key, t] of entries()) {
      if (isTwoWaySmsKey(key)) continue;
      const texts = typeof t === 'string' ? [t] : [t.withNumber, t.withoutNumber];
      for (const text of texts) expect(text, `${locale}.${key}`).not.toMatch(REPLY_WORDING);
    }
  });

  it('lists the 16 keys that carry a link (no SMS on a pack without links, §19 Q24)', () => {
    expect([...MESSAGE_KEYS_WITH_LINK].sort()).toEqual(
      [
        'welcome',
        'daily_link',
        'call_coming',
        'reminder_1',
        'reminder_2',
        'missed_call',
        'question_ready',
        'draft_ready',
        'filed',
        'photos_link',
        'finish_report',
        'help',
        'day_off_link',
        'edit_preview',
        'edit_unclear',
        'whatsapp_use_link',
      ].sort(),
    );
    for (const key of SMS_KEYS) {
      const texts = [smsTemplate(key, 'en', TWO_WAY), smsTemplate(key, 'en', TWO_WAY_NO_NUMBER)];
      for (const text of texts)
        expect(/\{(link|pdf_link)\}/.test(text), key).toBe(messageKeyHasLink(key));
    }
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
    // welcome, daily_link, reminder_2, missed_call and help in EN/ES/TR.
    expect(checked).toBe(15);
  });

  it('never asks for a reply in Turkish on a one-way sender (two-way texts go on WhatsApp)', () => {
    for (const [locale, key, t] of entries()) {
      if (locale !== 'tr' || isTwoWaySmsKey(key)) continue;
      const texts = typeof t === 'string' ? [t] : [t.withNumber, t.withoutNumber];
      for (const text of texts) {
        expect(text, key).not.toMatch(/STOP|HELP|START|yanıt|cevap|reply/i);
        expect(text, key).not.toMatch(/!/); // §9.7: no exclamation marks in TR
      }
    }
  });

  it('uses GSM-7 punctuation only: EN is all GSM-7, ES and TR leave only letters outside it (§19 Q15)', () => {
    for (const [locale, key, t] of entries()) {
      const texts = typeof t === 'string' ? [t] : [t.withNumber, t.withoutNumber];
      for (const text of texts) {
        const { nonGsm } = countSmsSegments(text);
        if (locale === 'en') expect(nonGsm, `${locale}.${key}`).toEqual([]);
        // Accented letters that belong to words (ES á í ó ú, TR ğ ş ı İ ç and the â of "hâlâ").
        for (const ch of nonGsm) expect(ch, `${locale}.${key}`).toMatch(/^\p{L}$/u);
      }
    }
    for (const [locale, hint] of Object.entries(SMS_REPLY_HINT))
      expect(countSmsSegments(hint).nonGsm, locale).toEqual([]);
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
        TWO_WAY,
      ),
    ).toBe(
      "Today's report for Riverside Lofts B: sl.link/r/Q7T2XD - or just call +1 (555) 014-2290.",
    );
    expect(
      renderSms(
        'daily_link',
        'en',
        { site: 'Riverside Lofts B', link: 'sl.link/r/Q7T2XD' },
        TWO_WAY_NO_NUMBER,
      ),
    ).toBe("Today's report for Riverside Lofts B: sl.link/r/Q7T2XD");
    expect(renderSms('welcome', 'en', welcomeVars, TWO_WAY)).toBe(
      "Hi Marco, I'm TalkOlog, the daily report assistant for Kestrel Build Group at Riverside Lofts — Block B. Each workday before 17:30, tap your link and talk for ~3 min, or call +1 (555) 014-2290: sl.link/r/MRZ4K7 - Reply STOP to opt out, HELP for help",
    );
    expect(renderSms('welcome', 'en', welcomeVars, TWO_WAY_NO_NUMBER)).toBe(
      "Hi Marco, I'm TalkOlog, the daily report assistant for Kestrel Build Group at Riverside Lofts — Block B. Each workday before 17:30, tap your link and talk for ~3 min: sl.link/r/MRZ4K7 - Reply STOP to opt out, HELP for help",
    );
    expect(
      renderSms(
        'filed',
        'en',
        { report_no: 'RL-2041-0187', pdf_link: 'sl.link/p/RL0187' },
        TWO_WAY,
      ),
    ).toBe('Filed: Daily Report RL-2041-0187. PDF: sl.link/p/RL0187');
    expect(
      renderSms(
        'edit_applied',
        'en',
        { weekday: 'Friday', change: 'Apex Concrete 7 workers, 56 h (was 6, 48 h)', v: 2 },
        TWO_WAY,
      ),
    ).toBe(
      'Updated Friday: Apex Concrete 7 workers, 56 h (was 6, 48 h). Version 2 sent to the office.',
    );
    expect(
      renderSms(
        'help',
        'en',
        { company: 'Kestrel Build Group', link: 'sl.link/r/Q7T2XD' },
        TWO_WAY_NO_NUMBER,
      ),
    ).toBe(
      'TalkOlog daily reports for Kestrel Build Group. Your link: sl.link/r/Q7T2XD - Text CALL or TEXT to switch - STOP to opt out. Msg & data rates may apply.',
    );
  });

  it('renders ES with and without a voice number', () => {
    expect(renderSms('welcome', 'es', welcomeVars, TWO_WAY)).toBe(
      'Hola Marco, soy TalkOlog, el asistente de reportes diarios de Kestrel Build Group en Riverside Lofts — Block B. Cada día de trabajo antes de las 17:30, toque su enlace y hable unos 3 min, o llame al +1 (555) 014-2290: sl.link/r/MRZ4K7 - Responda STOP para darse de baja, HELP para ayuda',
    );
    expect(renderSms('missed_call', 'es', { link: 'sl.link/r/Q7T2XD' }, TWO_WAY_NO_NUMBER)).toBe(
      'No pude comunicarme con usted para el reporte de hoy. Toque sl.link/r/Q7T2XD.',
    );
    expect(
      renderSms(
        'missed_call',
        'es',
        { link: 'sl.link/r/Q7T2XD', number: '+1 (555) 014-2290' },
        TWO_WAY,
      ),
    ).toBe(
      'No pude comunicarme con usted para el reporte de hoy. Llame al +1 (555) 014-2290 o toque sl.link/r/Q7T2XD.',
    );
    expect(renderSms('stop_confirm', 'es', {}, TWO_WAY)).toBe(
      'Ya no recibirá mensajes de TalkOlog. Responda START para reactivarlos.',
    );
    expect(renderSms('unknown_number', 'es', {}, TWO_WAY)).toBe(
      'Este número no está en TalkOlog. Pida a su oficina que lo agregue.',
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
          change: 'Apex Concrete 7 trabajadores, 56 h (antes 6, 48 h)',
          v: 2,
        },
        TWO_WAY,
      ),
    ).toBe(
      'Reporte del viernes actualizado: Apex Concrete 7 trabajadores, 56 h (antes 6, 48 h). Versión 2 enviada a la oficina.',
    );
  });

  it('keeps every ES text without variables to one segment (§9.2)', () => {
    let checked = 0;
    for (const key of SMS_KEYS) {
      if (SMS_VARS[key].length > 0) continue;
      const text = renderSms(key as 'stop_confirm', 'es', {}, TWO_WAY);
      expect(countSmsSegments(text).default.segments, `es.${key}: "${text}"`).toBe(1);
      checked += 1;
    }
    // unknown_number, stop_confirm, pref_call_ok, pref_text_ok, whatsapp_stop_confirm
    expect(checked).toBe(5);
  });

  it('renders TR with and without a voice number (no TR number yet: §18.2)', () => {
    const vars = {
      first: 'Mehmet',
      company: 'Demir Yapı A.Ş.',
      site: 'Ataşehir Ofis Binası',
      deadline: '17:30',
      link: 'go.talkolog.com/r/K4T9QZ',
    };
    expect(renderSms('welcome', 'tr', vars, ONE_WAY_NO_NUMBER)).toBe(
      'Merhaba Mehmet, ben TalkOlog, Demir Yapı A.Ş. için Ataşehir Ofis Binası günlük rapor asistanıyım. Her iş günü 17:30 öncesi linke dokunup ~3 dk anlatın: go.talkolog.com/r/K4T9QZ',
    );
    expect(renderSms('welcome', 'tr', { ...vars, number: '+90 850 123 4567' }, ONE_WAY)).toBe(
      'Merhaba Mehmet, ben TalkOlog, Demir Yapı A.Ş. için Ataşehir Ofis Binası günlük rapor asistanıyım. Her iş günü 17:30 öncesi linke dokunup ~3 dk anlatın ya da +90 850 123 4567 numarayı arayın: go.talkolog.com/r/K4T9QZ',
    );
    expect(
      renderSms(
        'reminder_2',
        'tr',
        { time: '19:00', link: 'go.talkolog.com/r/K4T9QZ' },
        ONE_WAY_NO_NUMBER,
      ),
    ).toBe(
      'Bugün için hâlâ rapor yok. Saat 19:00 itibarıyla ofise bilgi vereceğim. go.talkolog.com/r/K4T9QZ',
    );
    expect(
      renderSms('missed_call', 'tr', { link: 'go.talkolog.com/r/K4T9QZ' }, ONE_WAY_NO_NUMBER),
    ).toBe('Bugünkü rapor için ulaşamadım. go.talkolog.com/r/K4T9QZ');
  });

  it('adds nothing to a Turkish text', () => {
    for (const key of SMS_KEYS) {
      if (isTwoWaySmsKey(key)) continue;
      for (const opts of [ONE_WAY, ONE_WAY_NO_NUMBER]) {
        const template = smsTemplate(key, 'tr', opts);
        const vars = Object.fromEntries(SMS_VARS[key].map((v) => [v, `<${v}>`]));
        const out = renderSms(key as 'filed', 'tr', vars as never, opts);
        expect(out).toBe(template.replace(/\{([a-z0-9_]+)\}/g, '<$1>'));
      }
    }
  });

  it('fails loudly on a missing, null or empty variable', () => {
    expect(() =>
      renderSms('reminder_1', 'en', { site: 'Riverside Lofts B' } as never, TWO_WAY),
    ).toThrow('SMS "reminder_1" (en) needs {link}');
    expect(() => renderSms('reminder_1', 'tr', { site: '', link: 'x' }, ONE_WAY_NO_NUMBER)).toThrow(
      'needs {site}',
    );
    expect(() =>
      renderSms('filed', 'es', { report_no: null, pdf_link: 'x' } as never, TWO_WAY),
    ).toThrow('needs {report_no}');
  });

  it('needs {number} only when there is a voice number', () => {
    expect(() => renderSms('daily_link', 'tr', { site: 'Ataşehir', link: 'x' }, ONE_WAY)).toThrow(
      'SMS "daily_link" (tr) needs {number}',
    );
    expect(
      renderSms(
        'daily_link',
        'tr',
        { site: 'Ataşehir', link: 'x', number: '+90 850 123 4567' },
        ONE_WAY_NO_NUMBER,
      ),
    ).toBe('Ataşehir bugünkü rapor: x');
  });

  it('refuses two-way keys on a one-way pack, and unknown keys', () => {
    expect(() => renderSms('help', 'tr', { company: 'x', link: 'y' }, ONE_WAY)).toThrow(
      'SMS "help" exists only for packs with two-way SMS',
    );
    expect(() => smsTemplate('nope' as SmsKey, 'en', TWO_WAY)).toThrow('Unknown SMS key "nope"');
    expect(() => smsTemplate('constructor' as SmsKey, 'en', TWO_WAY)).toThrow('Unknown SMS key');
    expect(() => smsTemplate('filed', 'toString' as SmsLocale, TWO_WAY)).toThrow('No SMS copy');
    expect(() => smsTemplate('filed', 'de' as SmsLocale, TWO_WAY)).toThrow(
      'No SMS copy for locale "de"',
    );
  });

  it('inserts values literally (no second pass over braces in a value)', () => {
    expect(renderSms('question_ready', 'en', { link: '{link}' }, TWO_WAY)).toBe(
      "One quick question about today's report: {link}",
    );
  });
});

describe('the pack variant: two-way SMS (spec §4.6, §9.2)', () => {
  const vars = {
    first: 'Marco',
    company: 'Kestrel Build Group',
    site: 'Riverside Lofts — Block B',
    deadline: '17:30',
    number: '+1 (555) 014-2290',
    link: 'sl.link/r/MRZ4K7',
  };

  it('keeps the two-way welcome byte for byte: catalogue text + reply hint is the §9.2 text', () => {
    expect(renderSms('welcome', 'en', vars, TWO_WAY)).toBe(
      "Hi Marco, I'm TalkOlog, the daily report assistant for Kestrel Build Group at Riverside Lofts — Block B. Each workday before 17:30, tap your link and talk for ~3 min, or call +1 (555) 014-2290: sl.link/r/MRZ4K7 - Reply STOP to opt out, HELP for help",
    );
    expect(renderSms('welcome', 'en', vars, TWO_WAY_NO_NUMBER)).toBe(
      "Hi Marco, I'm TalkOlog, the daily report assistant for Kestrel Build Group at Riverside Lofts — Block B. Each workday before 17:30, tap your link and talk for ~3 min: sl.link/r/MRZ4K7 - Reply STOP to opt out, HELP for help",
    );
    expect(renderSms('welcome', 'es', vars, TWO_WAY)).toBe(
      'Hola Marco, soy TalkOlog, el asistente de reportes diarios de Kestrel Build Group en Riverside Lofts — Block B. Cada día de trabajo antes de las 17:30, toque su enlace y hable unos 3 min, o llame al +1 (555) 014-2290: sl.link/r/MRZ4K7 - Responda STOP para darse de baja, HELP para ayuda',
    );
    expect(renderSms('welcome', 'es', vars, TWO_WAY_NO_NUMBER)).toBe(
      'Hola Marco, soy TalkOlog, el asistente de reportes diarios de Kestrel Build Group en Riverside Lofts — Block B. Cada día de trabajo antes de las 17:30, toque su enlace y hable unos 3 min: sl.link/r/MRZ4K7 - Responda STOP para darse de baja, HELP para ayuda',
    );
  });

  it('sends the welcome without the reply clause on a one-way pack', () => {
    for (const locale of ['en', 'es'] as const) {
      for (const [twoWay, oneWay] of [
        [TWO_WAY, ONE_WAY],
        [TWO_WAY_NO_NUMBER, ONE_WAY_NO_NUMBER],
      ] as const) {
        const text = renderSms('welcome', locale, vars, oneWay);
        expect(text, locale).not.toMatch(REPLY_WORDING);
        expect(text + SMS_REPLY_HINT[locale], locale).toBe(
          renderSms('welcome', locale, vars, twoWay),
        );
      }
    }
  });

  it('never puts reply wording in a one-way render of any shared key, in EN, ES and TR', () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const key of SMS_KEYS) {
        if (isTwoWaySmsKey(key)) continue;
        for (const opts of [ONE_WAY, ONE_WAY_NO_NUMBER]) {
          const values = Object.fromEntries(SMS_VARS[key].map((v) => [v, `<${v}>`]));
          const text = renderSms(key as 'filed', locale, values as never, opts);
          expect(text, `${locale}.${key}`).not.toMatch(REPLY_WORDING);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(3 * 15 * 2);
  });

  it('refuses the two-way texts on a one-way pack, and a two-way welcome in Turkish', () => {
    for (const key of TWO_WAY_SMS_KEYS) {
      for (const locale of ['en', 'es'] as const) {
        expect(() => smsTemplate(key, locale, ONE_WAY), `${locale}.${key}`).toThrow(
          `SMS "${key}" exists only for packs with two-way SMS`,
        );
        expect(smsTemplate(key, locale, TWO_WAY).length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
    expect(() =>
      renderSms('welcome', 'tr', { ...vars, number: '+90 850 123 4567' }, TWO_WAY),
    ).toThrow('SMS "welcome" has no "tr" reply hint for a pack with two-way SMS');
  });

  it('lists the copy a language lacks for a pack (packCopyGaps reads it)', () => {
    expect(smsCopyGaps('en', { twoWay: true })).toEqual([]);
    expect(smsCopyGaps('es', { twoWay: true })).toEqual([]);
    expect(smsCopyGaps('tr', { twoWay: false })).toEqual([]);
    // W2-16: Turkish has the two-way texts (WhatsApp); a two-way TR SMS sender lacks the hint only.
    expect(smsCopyGaps('tr', { twoWay: true })).toEqual(['welcome.replyHint']);
    const shared = SMS_KEYS.filter((k) => !isTwoWaySmsKey(k));
    expect(smsCopyGaps('de', { twoWay: false })).toEqual(shared);
    expect(smsCopyGaps('constructor', { twoWay: true })).toEqual([
      ...SMS_KEYS,
      'welcome.replyHint',
    ]);
  });

  it('catches a partly translated language: a missing key, an empty text or variant, no hint', () => {
    const { daily_link: _dropped, ...esWithoutDailyLink } = SMS_CATALOGS.es;
    const source = (es: object, hints: SmsCopySource['hints'] = SMS_REPLY_HINT): SmsCopySource => ({
      catalogs: { es: es as SmsCopySource['catalogs'][string] },
      hints,
    });
    const es = SMS_CATALOGS.es;
    // The real Spanish catalogue through the same source is complete.
    expect(smsCopyGaps('es', { twoWay: true }, source(es))).toEqual([]);
    expect(smsCopyGaps('es', { twoWay: true }, source(esWithoutDailyLink))).toEqual(['daily_link']);
    expect(smsCopyGaps('es', { twoWay: false }, source({ ...es, filed: '' }))).toEqual(['filed']);
    expect(
      smsCopyGaps(
        'es',
        { twoWay: false },
        source({ ...es, welcome: { ...es.welcome, withoutNumber: '' } }),
      ),
    ).toEqual(['welcome.withoutNumber']);
    expect(
      smsCopyGaps('es', { twoWay: false }, source({ ...es, help: { ...es.help, withNumber: '' } })),
    ).toEqual([]); // a one-way pack never sends help
    expect(
      smsCopyGaps('es', { twoWay: true }, source({ ...es, help: { ...es.help, withNumber: '' } })),
    ).toEqual(['help.withNumber']);
    // The reply hint: empty or missing fails a two-way pack only.
    expect(smsCopyGaps('es', { twoWay: true }, source(es, { es: '' }))).toEqual([
      'welcome.replyHint',
    ]);
    expect(smsCopyGaps('es', { twoWay: true }, source(es, {}))).toEqual(['welcome.replyHint']);
    expect(smsCopyGaps('es', { twoWay: false }, source(es, {}))).toEqual([]);
  });
});

describe('the pack variant: links in SMS (spec §4.6, §19 Q24)', () => {
  const NO_LINKS: RenderSmsOptions = { hasVoiceNumber: false, twoWay: true, linksAllowed: false };

  it('refuses every key with a link, in every language, when the pack forbids links', () => {
    for (const key of MESSAGE_KEYS_WITH_LINK) {
      for (const locale of LOCALES) {
        if (locale === 'tr' && isTwoWaySmsKey(key)) continue;
        expect(() => smsTemplate(key, locale, NO_LINKS), `${locale}.${key}`).toThrow(
          `SMS "${key}" carries a link and the pack forbids links in SMS`,
        );
        expect(() => smsTemplate(key, locale, { ...NO_LINKS, twoWay: false })).toThrow(
          isTwoWaySmsKey(key) ? 'exists only for packs with two-way SMS' : 'carries a link',
        );
      }
    }
    expect(() =>
      renderSms('help', 'en', { company: 'Kestrel Build Group', link: 'x' }, NO_LINKS),
    ).toThrow('SMS "help" carries a link and the pack forbids links in SMS');
  });

  it('renders every key without a link as usual', () => {
    let checked = 0;
    for (const key of SMS_KEYS) {
      if (messageKeyHasLink(key)) continue;
      expect(smsTemplate(key, 'en', NO_LINKS), key).toBe(smsTemplate(key, 'en', TWO_WAY_NO_NUMBER));
      checked += 1;
    }
    // verify_code, weather_headsup, edit_applied, site_paused, unknown_number, stop_confirm,
    // pref_call_ok, pref_text_ok, whatsapp_stop_confirm.
    expect(checked).toBe(9);
    expect(renderSms('verify_code', 'tr', { code: '482913' }, { ...NO_LINKS, twoWay: false })).toBe(
      smsTemplate('verify_code', 'tr', ONE_WAY_NO_NUMBER).replace('{code}', '482913'),
    );
  });
});

describe('renderWeatherPhrase: the heads-up’s {weather_phrase} (W2-06)', () => {
  const day = (
    hours: Array<[string, number, number]>,
    precipWorkingHoursIn: number,
    maxGustWorkingHoursMph: number,
  ): SiteDayWeather => ({
    date: '2026-10-12',
    provider: 'Open-Meteo',
    fetchedAt: '2026-10-12T21:30:00.000Z',
    units: { precip: 'in', temp: 'F', wind: 'mph' },
    hours: hours.map(([time, precipIn, gustMph]) => ({
      time,
      precipIn,
      tempF: 60,
      windMph: 10,
      gustMph,
    })),
    summary: {
      precipIn: hours.reduce((a, [, p]) => a + p, 0),
      tempMinF: 55,
      tempMaxF: 65,
      windMph: 10,
      gustMph: Math.max(...hours.map(([, , g]) => g)),
      provider: 'Open-Meteo',
      precipWorkingHoursIn,
      maxGustWorkingHoursMph,
    },
  });
  const morning = day(
    [
      ['08:00', 0.2, 14],
      ['09:00', 0.2, 15],
    ],
    0.4,
    15,
  );
  const afternoon = day([['13:00', 0.3, 14]], 0.3, 14);
  const allDay = day(
    [
      ['09:00', 0.2, 31],
      ['14:00', 0.3, 31],
    ],
    0.5,
    31,
  );
  const windy = day([['10:00', 0, 34]], 0, 34);
  const calm = day([['10:00', 0, 5]], 0, 5);
  const all = [morning, afternoon, allDay, windy, calm];

  it('English imperial is the v1.0 phrase, word for word', () => {
    for (const w of all) expect(renderWeatherPhrase(w, 'en', 'imperial')).toBe(weatherPhrase(w));
  });

  it('Spanish and Turkish, in the org’s units', () => {
    expect(renderWeatherPhrase(morning, 'es', 'imperial')).toBe('Llovió esta mañana (0.4 in)');
    expect(renderWeatherPhrase(allDay, 'es', 'imperial')).toBe(
      'Llovió hoy (0.5 in) y rachas de hasta 31 mph',
    );
    expect(renderWeatherPhrase(afternoon, 'tr', 'metric')).toBe(
      'Öğleden sonra yağmur yağdı (7,6 mm)',
    );
    expect(renderWeatherPhrase(allDay, 'tr', 'metric')).toBe(
      'Bugün yağmur yağdı (12,7 mm) ve rüzgar hamleleri 50 km/h değerine ulaştı',
    );
    expect(renderWeatherPhrase(windy, 'tr', 'metric')).toBe(
      'Rüzgar hamleleri 55 km/h değerine ulaştı',
    );
    expect(renderWeatherPhrase(calm, 'tr', 'metric')).toBe('Bugün hava şantiyeyi etkiledi');
    expect(renderWeatherPhrase(calm, 'en', 'metric')).toBe('Weather hit the site today');
  });

  it('every language has every piece', () => {
    for (const locale of LOCALES) {
      for (const [piece, text] of Object.entries(SMS_WEATHER_PHRASES[locale])) {
        expect(text.length, `${locale}.${piece}`).toBeGreaterThan(0);
      }
    }
  });

  // ES is UCS-2 already (the §9.2 text's "qué", and "ó" is not GSM-7), so its longest heads-up
  // (rain and gusts) takes 3 segments; listed for the Q63 review.
  const MAX_SEGMENTS = { en: 2, es: 3, tr: 2 } as const;

  it('the rendered heads-up: EN GSM-7, TR GSM-7 with the Turkish shift table, within its segments', () => {
    const opts = { hasVoiceNumber: false, twoWay: false, linksAllowed: true };
    for (const w of all) {
      for (const locale of LOCALES) {
        const text = renderSms(
          'weather_headsup',
          locale,
          {
            deadline: '17:30',
            weather_phrase: renderWeatherPhrase(w, locale, locale === 'tr' ? 'metric' : 'imperial'),
          },
          opts,
        );
        const seg = countSmsSegments(text);
        if (locale === 'en') expect(seg.default.encoding, text).toBe('gsm7');
        if (locale === 'tr') expect(seg.turkishShift.encoding, text).not.toBe('ucs2');
        const segments = locale === 'tr' ? seg.turkishShift.segments : seg.default.segments;
        expect(segments, text).toBeLessThanOrEqual(MAX_SEGMENTS[locale]);
        expect(text).toContain('17:30');
      }
    }
  });
});

describe('test_message (W4-05, spec §19 Q232)', () => {
  it('names the company in EN, ES and TR, GSM-7 in EN and ES, at most two segments', () => {
    const company = 'Kestrel Build Group LLC';
    expect(renderTestMessage('en', company)).toBe(
      'TalkOlog test message for Kestrel Build Group LLC. Your site managers get their texts from this sender. No reply needed.',
    );
    expect(renderTestMessage('tr', 'Demir Yapı A.Ş.')).toBe(
      'Demir Yapı A.Ş. için TalkOlog deneme mesajı. Şantiye şefleriniz mesajlarını bu göndericiden alır. Yanıt gerekmez.',
    );
    expect(renderTestMessage('es', company)).toContain('Kestrel Build Group LLC');
    for (const lang of ['en', 'es'] as const) {
      const seg = countSmsSegments(renderTestMessage(lang, company));
      expect(seg.default.encoding, lang).toBe('gsm7');
    }
    for (const lang of ['en', 'es', 'tr'] as const) {
      expect(
        countSmsSegments(renderTestMessage(lang, company)).turkishShift.segments,
      ).toBeLessThanOrEqual(2);
    }
    expect(renderTestMessage('en', '  ')).toContain('for TalkOlog.');
  });
});
