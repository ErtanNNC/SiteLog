import { describe, expect, it } from 'vitest';
import { LANGUAGES } from './locale.ts';
import {
  SPOKEN_FORM,
  SPOKEN_FORM_CASES,
  SPOKEN_PRONUNCIATIONS,
  speakable,
  speakableVoiceAnswer,
  spokenInteger,
  spokenTime,
} from './spoken.ts';
import { VOICE_CATALOGS, VOICE_KEYS } from './copy/voice.ts';
import { emptyReportData, type DailyReportData } from './schemas/report.ts';
import { readBack } from './voice-tools.ts';

describe('speakable tables (W4-07, §19 Q245 SPOKEN_FORM)', () => {
  for (const language of LANGUAGES) {
    describe(language.toUpperCase(), () => {
      for (const [lang, written, spoken] of SPOKEN_FORM_CASES.filter(([l]) => l === language)) {
        it(written, () => {
          expect(speakable(written, lang)).toBe(spoken);
        });
      }
    });
  }

  it('the recommended default is code (§19 Q245); `tts` leaves the line as written', () => {
    expect(SPOKEN_FORM).toBe('code');
    expect(speakable('184 saat', 'tr', { policy: 'tts' })).toBe('184 saat');
  });

  it('is idempotent: a spoken line has nothing left to change', () => {
    for (const [lang, , spoken] of SPOKEN_FORM_CASES) expect(speakable(spoken, lang)).toBe(spoken);
  });

  it('leaves no digit in any case but inside a name such as "B2"', () => {
    for (const [lang, written] of SPOKEN_FORM_CASES) {
      const said = speakable(written, lang).replace(/\bB2\b/g, '');
      expect(said, written).not.toMatch(/\d/);
    }
  });

  it('every fixed voice line without a placeholder is already in words', () => {
    for (const language of LANGUAGES) {
      for (const key of VOICE_KEYS) {
        const line = VOICE_CATALOGS[language][key];
        expect(speakable(line, language), `${language}.${key}`).toBe(line);
      }
    }
  });

  it('the pronunciation list is empty until the listening test (W4-14)', () => {
    for (const language of LANGUAGES) expect(SPOKEN_PRONUNCIATIONS[language]).toEqual({});
  });
});

describe('spokenInteger', () => {
  it.each([
    [0, 'sıfır', 'zero', 'cero'],
    [7, 'yedi', 'seven', 'siete'],
    [16, 'on altı', 'sixteen', 'dieciséis'],
    [41, 'kırk bir', 'forty-one', 'cuarenta y uno'],
    [100, 'yüz', 'one hundred', 'cien'],
    [184, 'yüz seksen dört', 'one hundred eighty-four', 'ciento ochenta y cuatro'],
    [1000, 'bin', 'one thousand', 'mil'],
    [1203, 'bin iki yüz üç', 'one thousand two hundred three', 'mil doscientos tres'],
    [2041, 'iki bin kırk bir', 'two thousand forty-one', 'dos mil cuarenta y uno'],
    [21000, 'yirmi bir bin', 'twenty-one thousand', 'veintiún mil'],
    [
      2_500_000,
      'iki milyon beş yüz bin',
      'two million five hundred thousand',
      'dos millones quinientos mil',
    ],
  ])('%d', (n, tr, en, es) => {
    expect(spokenInteger(n, 'tr')).toBe(tr);
    expect(spokenInteger(n, 'en')).toBe(en);
    expect(spokenInteger(n, 'es')).toBe(es);
  });
});

describe('spokenTime', () => {
  it.each([
    [17, 30, 'on yedi otuz', 'five thirty p.m.', 'cinco y media de la tarde'],
    [7, 0, 'yedi', 'seven a.m.', 'siete de la mañana'],
    [8, 5, 'sekiz sıfır beş', 'eight oh five a.m.', 'ocho y cinco de la mañana'],
    [13, 15, 'on üç on beş', 'one fifteen p.m.', 'una y cuarto de la tarde'],
    [21, 45, 'yirmi bir kırk beş', 'nine forty-five p.m.', 'nueve y cuarenta y cinco de la noche'],
  ])('%d:%d', (h, m, tr, en, es) => {
    expect(spokenTime(h, m, 'tr')).toBe(tr);
    expect(spokenTime(h, m, 'en')).toBe(en);
    expect(spokenTime(h, m, 'es')).toBe(es);
  });
});

/** The Kartal call's draft (fixtures/expected/call-kartal-2026-10-09-tr.json, in brief). */
function kartal(): DailyReportData {
  const data: DailyReportData = {
    ...emptyReportData('2026-10-09', { reportLanguage: 'tr', units: 'metric' }),
  };
  const crew = (companyName: string, workers: number, each: number) => ({
    companyId: companyName,
    companyNameHeard: companyName,
    companyName,
    workers,
    hoursPerWorker: each,
    totalHours: workers * each,
    hoursBasis: 'stated' as const,
    confidence: 0.95,
    source: [],
  });
  data.manpower = [
    crew('Usta Beton', 5, 8),
    crew('Volt Elektrik', 3, 8),
    crew('Demir Yapı öz ekip', 4, 6.5),
  ];
  data.weather.periods = [
    { start: '10:00', end: '11:30', condition: 'Yağmur', lostHours: 1.5, source: [] },
  ];
  data.workPerformed = [
    { area: '3. Kat', activity: 'Döşeme betonu dökümü', status: 'complete', source: [] },
  ];
  data.deliveries = [{ item: 'beton', quantity: '45 m³', supplier: 'Usta Beton', source: [] }];
  data.safety.toolboxTalk = 'İskele güvenliği';
  data.safety.noIncidentsStated = true;
  return data;
}

describe('read-back goldens TR (W4-07): the numbers said as words', () => {
  it('the Kartal read-back as field-api hands it to the agent', () => {
    const written = readBack(kartal(), 'tr');
    expect(written).toBe(
      'Elimdeki bilgiler: 3 firmadan sahada 12 kişi, toplam 90 saat. ' +
        'Hava nedeniyle 1,5 saat çalışılamadı. Yapılanlar: 3. Kat döşeme betonu dökümü tamamlandı. ' +
        'Teslimatlar: Usta Beton firmasından 45 m³ beton. İş güvenliği konuşması yapıldı. Kaza ya da olay yok. Kaydedeyim mi?',
    );
    expect(speakable(written, 'tr')).toBe(
      'Elimdeki bilgiler: üç firmadan sahada on iki kişi, toplam doksan saat. ' +
        'Hava nedeniyle bir buçuk saat çalışılamadı. Yapılanlar: üçüncü Kat döşeme betonu dökümü tamamlandı. ' +
        'Teslimatlar: Usta Beton firmasından kırk beş metreküp beton. İş güvenliği konuşması yapıldı. Kaza ya da olay yok. Kaydedeyim mi?',
    );
  });
});

describe('speakableVoiceAnswer (field-api: every line it hands the agent)', () => {
  it('speaks the read-back, the question and its choices, lines, confirmations and summaries', () => {
    const answer = {
      status: 'applied',
      confirmation: 'Usta Beton: 6 kişi, kişi başı 8 saat — toplam 48 saat.',
      lines: ['Usta Beton: 6 kişi.'],
      readBack: 'Toplam 98 saat. Kaydedeyim mi?',
      draft: {
        reportId: 'r-1',
        draftRev: 3,
        missing: ['manpower.workers:Donatı ekibi'],
        question: { id: 'q-1', text: '4. katta kaç kişiydi?', choices: ['6, tam gün'] },
        readBack: null,
      },
    };
    expect(speakableVoiceAnswer(answer, 'tr')).toEqual({
      status: 'applied',
      confirmation: 'Usta Beton: altı kişi, kişi başı sekiz saat — toplam kırk sekiz saat.',
      lines: ['Usta Beton: altı kişi.'],
      readBack: 'Toplam doksan sekiz saat. Kaydedeyim mi?',
      draft: {
        reportId: 'r-1',
        draftRev: 3,
        missing: ['manpower.workers:Donatı ekibi'],
        question: { id: 'q-1', text: 'dördüncü katta kaç kişiydi?', choices: ['altı, tam gün'] },
        readBack: null,
      },
    });
  });

  it('leaves data alone: report numbers, names, site lists, deadlines', () => {
    const filed = { status: 'filed', reportNo: 'KK-1203-0001', pdf: 'pending' };
    expect(speakableVoiceAnswer(filed, 'tr')).toEqual(filed);
    const found = {
      status: 'found',
      reportId: 'r',
      date: '2026-10-09',
      reportNo: 'KK-1203-0001',
      summary: 'Cuma raporu, KK-1203-0001: sahada 12 kişi, 90 saat.',
    };
    expect(speakableVoiceAnswer(found, 'tr')).toEqual({
      ...found,
      summary:
        'Cuma raporu, KK bin iki yüz üç, sıfır sıfır sıfır bir: sahada on iki kişi, doksan saat.',
    });
    const ctx = { sites: [{ id: 's', name: 'Blok 2', deadline: '17:30' }], keyterms: ['C30'] };
    expect(speakableVoiceAnswer(ctx, 'tr')).toEqual(ctx);
  });

  it('hands a line as written rather than cut it past the contract (a choice ≤ 80)', () => {
    const choice = `${'9'.repeat(9)} ${'9'.repeat(9)}`;
    const answer = { question: { id: 'q', text: 'Kaç?', choices: [choice] } };
    expect(speakableVoiceAnswer(answer, 'tr').question.choices[0]).toBe(choice);
  });
});
