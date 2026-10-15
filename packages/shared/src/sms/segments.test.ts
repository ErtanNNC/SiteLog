import { describe, expect, it } from 'vitest';
import { isTwoWaySmsKey, renderSms, SMS_KEYS, SMS_VARS, type SharedSmsKey } from '../copy/sms.ts';
import { countSmsSegments, SMS_SEGMENT_SIZES } from './segments.ts';

const GSM_BASIC_PRINTED =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

describe('countSmsSegments: GSM-7', () => {
  it('counts the 127 basic characters as one septet each', () => {
    expect(Array.from(GSM_BASIC_PRINTED)).toHaveLength(127);
    const c = countSmsSegments(GSM_BASIC_PRINTED);
    expect(c.default).toEqual({ encoding: 'gsm7', units: 127, segments: 1, perSegment: 160 });
    expect(c.turkishShift).toEqual(c.default);
    expect(c.nonGsm).toEqual([]);
  });

  it('counts extension characters as two septets', () => {
    const c = countSmsSegments('\f^{}\\[~]|€');
    expect(c.default).toMatchObject({ encoding: 'gsm7', units: 20, segments: 1 });
    expect(countSmsSegments('€'.repeat(80)).default.segments).toBe(1);
    expect(countSmsSegments('€'.repeat(81)).default).toMatchObject({ units: 162, segments: 2 });
  });

  it('uses 160 for one segment and 153 per concatenated segment', () => {
    expect(countSmsSegments('a'.repeat(160)).default).toMatchObject({
      segments: 1,
      perSegment: 160,
    });
    expect(countSmsSegments('a'.repeat(161)).default).toMatchObject({
      segments: 2,
      perSegment: 153,
    });
    expect(countSmsSegments('a'.repeat(306)).default.segments).toBe(2);
    expect(countSmsSegments('a'.repeat(307)).default.segments).toBe(3);
  });

  it('never splits an escape pair across segments', () => {
    // 306 septets would fit 2 × 153, but the € pair cannot straddle the boundary.
    const text = `${'a'.repeat(152)}€${'a'.repeat(152)}`;
    expect(countSmsSegments(text).default).toMatchObject({ units: 306, segments: 3 });
  });

  it('counts nothing for an empty text', () => {
    expect(countSmsSegments('').default).toMatchObject({ units: 0, segments: 0 });
  });
});

describe('countSmsSegments: UCS-2', () => {
  it('falls back to UCS-2 for any character outside GSM-7 (70 / 67)', () => {
    const c = countSmsSegments(`${'a'.repeat(69)}·`);
    expect(c.default).toEqual({ encoding: 'ucs2', units: 70, segments: 1, perSegment: 70 });
    expect(c.nonGsm).toEqual(['·']);
    expect(countSmsSegments(`${'a'.repeat(70)}—`).default).toMatchObject({
      segments: 2,
      perSegment: 67,
    });
    expect(countSmsSegments(`${'a'.repeat(133)}—`).default.segments).toBe(2);
    expect(countSmsSegments(`${'a'.repeat(134)}—`).default.segments).toBe(3);
  });

  it('counts a character outside the BMP as two code units and keeps the pair together', () => {
    const astral = '\u{1D400}'; // MATHEMATICAL BOLD CAPITAL A
    expect(countSmsSegments(astral).default).toMatchObject({ encoding: 'ucs2', units: 2 });
    // 66 + 2 = 68 > 67: the pair moves to the second segment.
    const c = countSmsSegments(`${'a'.repeat(66)}${astral}${'a'.repeat(3)}`);
    expect(c.default).toMatchObject({ units: 71, segments: 2 });
  });
});

describe('countSmsSegments: Turkish', () => {
  it('needs UCS-2 for ğ ş ı İ ç by default, and the shift table keeps them GSM-7 (2 septets)', () => {
    const c = countSmsSegments('ğşıİçĞŞ');
    expect(c.default).toEqual({ encoding: 'ucs2', units: 7, segments: 1, perSegment: 70 });
    expect(c.turkishShift).toEqual({
      encoding: 'gsm7-turkish-shift',
      units: 14,
      segments: 1,
      perSegment: 155,
    });
    expect(c.nonGsm.sort()).toEqual(['ç', 'ğ', 'ı', 'İ', 'Ğ', 'ş', 'Ş'].sort());
  });

  it('keeps ö, ü, Ö, Ü and Ç in the basic table (no shift needed)', () => {
    const c = countSmsSegments('Kaydedildi: Günlük Rapor. Ölçü? Çok Üst');
    // "ç" in "Ölçü" is lowercase: only the uppercase Ç is basic GSM.
    expect(c.default.encoding).toBe('ucs2');
    const basicOnly = countSmsSegments('Günlük Rapor ÖÜ Ç öü');
    expect(basicOnly.default).toMatchObject({ encoding: 'gsm7', units: 20 });
    expect(basicOnly.turkishShift).toEqual(basicOnly.default);
  });

  it('uses 155 / 149 septets per segment with the shift table', () => {
    expect(SMS_SEGMENT_SIZES['gsm7-turkish-shift']).toEqual({ single: 155, concatenated: 149 });
    expect(countSmsSegments(`ş${'a'.repeat(153)}`).turkishShift).toMatchObject({
      units: 155,
      segments: 1,
    });
    expect(countSmsSegments(`ş${'a'.repeat(154)}`).turkishShift).toMatchObject({
      units: 156,
      segments: 2,
      perSegment: 149,
    });
  });

  it('counts the TR welcome text: 3 segments by default, 2 with the shift table', () => {
    const text = renderSms(
      'welcome',
      'tr',
      {
        first: 'Mehmet',
        company: 'Demir Yapı A.Ş.',
        site: 'Ataşehir Ofis Binası',
        deadline: '17:30',
        link: 'go.sitelog.app/r/K4T9QZ',
      },
      { hasVoiceNumber: false, twoWay: false, linksAllowed: true },
    );
    expect(text).toHaveLength(174);
    const c = countSmsSegments(text);
    // UCS-2: 174 code units, 67 per concatenated segment.
    expect(c.default).toEqual({ encoding: 'ucs2', units: 174, segments: 3, perSegment: 67 });
    // Shift: 174 + 9 Turkish letters (ı×5, ş×2, Ş, ç) + 1 for "~" (extension) = 184 septets.
    expect(c.turkishShift).toEqual({
      encoding: 'gsm7-turkish-shift',
      units: 184,
      segments: 2,
      perSegment: 149,
    });
  });

  it('cannot use the shift table when the text holds other non-GSM characters', () => {
    const text = renderSms(
      'reminder_2',
      'tr',
      { time: '19:00', link: 'go.sitelog.app/r/K4T9QZ' },
      { hasVoiceNumber: false, twoWay: false, linksAllowed: true },
    );
    const c = countSmsSegments(text);
    expect(c.nonGsm).toContain('â'); // "hâlâ"
    expect(c.turkishShift).toEqual(c.default);
    expect(c.default.encoding).toBe('ucs2');
  });

  it('keeps short Turkish texts to one segment either way', () => {
    const text = renderSms(
      'filed',
      'tr',
      { report_no: 'AY-0412-0031', pdf_link: 'go.sitelog.app/p/AY0031' },
      { hasVoiceNumber: false, twoWay: false, linksAllowed: true },
    );
    expect(countSmsSegments(text).default).toMatchObject({ encoding: 'gsm7', segments: 1 });
    const draft = renderSms(
      'draft_ready',
      'tr',
      { link: 'go.sitelog.app/r/K4T9QZ' },
      { hasVoiceNumber: false, twoWay: false, linksAllowed: true },
    );
    const d = countSmsSegments(draft);
    expect(d.default).toMatchObject({ encoding: 'ucs2', segments: 1 });
    expect(d.turkishShift).toMatchObject({ encoding: 'gsm7-turkish-shift', segments: 1 });
  });
});

describe('countSmsSegments: every Turkish text (spec §19 Q15)', () => {
  // §18.2 demo values: the Ataşehir site and its reporter, and a TR voice number as
  // `formatPhone('+908501234567')` prints it. {change} and {weather_phrase} are free text (the
  // correction step and the weather phrase), so those two rows hold for this sample only.
  const vars: Record<string, string | number> = {
    first: 'Selin',
    company: 'Demir Yapı A.Ş.',
    site: 'Ataşehir Ofis Binası',
    deadline: '17:30',
    link: 'go.sitelog.app/r/K4T9QZ',
    number: '+90 850 123 4567',
    code: '482913',
    time: '17:00',
    weather_phrase: 'Bu sabah yağmur yağdı (6 mm)',
    report_no: 'AO-0512-0031',
    pdf_link: 'go.sitelog.app/p/AO0031',
    weekday: 'Cuma',
    change: 'Usta Beton 7 işçi, 56 saat (önceden 6 işçi, 48 saat)',
    v: 2,
  };

  /** [segments with the Turkish single shift table, segments in plain UCS-2]. */
  const expected: Record<string, [number, number]> = {
    'welcome +number': [2, 4],
    'welcome -number': [2, 3],
    verify_code: [1, 1],
    'daily_link +number': [1, 2],
    'daily_link -number': [1, 1],
    call_coming: [1, 2],
    weather_headsup: [1, 2],
    reminder_1: [1, 2],
    'reminder_2 +number': [2, 2], // "â"
    'reminder_2 -number': [2, 2], // "â"
    'missed_call +number': [1, 2],
    'missed_call -number': [1, 1],
    question_ready: [1, 1],
    draft_ready: [1, 1],
    filed: [1, 1],
    photos_link: [1, 1],
    edit_applied: [1, 2],
    finish_report: [1, 2],
    site_paused: [1, 2],
  };

  it('matches the per-key counts recorded in §19 Q15', () => {
    const actual: Record<string, [number, number]> = {};
    for (const key of SMS_KEYS) {
      if (isTwoWaySmsKey(key)) continue;
      const withCall = (SMS_VARS[key] as readonly string[]).includes('number');
      for (const hasVoiceNumber of withCall ? [true, false] : [true]) {
        const label = withCall ? `${key} ${hasVoiceNumber ? '+' : '-'}number` : key;
        const text = renderSms(key as SharedSmsKey, 'tr', vars as never, {
          hasVoiceNumber,
          twoWay: false,
          linksAllowed: true,
        });
        const c = countSmsSegments(text);
        actual[label] = [c.turkishShift.segments, c.default.segments];
      }
    }
    expect(actual).toEqual(expected);
  });
});
