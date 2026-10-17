import { describe, expect, it } from 'vitest';
import { countSmsSegments } from '../sms/segments.ts';
import {
  SMS_KEYS,
  SMS_WEATHER_PHRASES,
  isTwoWaySmsKey,
  renderSms,
  type SharedSmsKey,
  type SmsVars,
} from './sms.ts';

const TR_PHRASE = SMS_WEATHER_PHRASES.tr;

/**
 * W4-11 (spec §9.2 "≤ 1 segment where possible", §9.1, §19 Q15): the TR SMS budget. Every key the
 * TR pack can send by SMS (one-way: no two-way key, links allowed), rendered with typical values
 * (a long Turkish company and site name, a personal link, a TR number for the "or call" variant
 * W4-14 may bring), fits 2 segments with the Turkish single shift table, which keeps Turkish
 * letters in GSM-7; the table below says which keys are 1 segment. A text change that moves a key
 * fails here, so the new count is a decision, not an accident. `reminder_2` is UCS-2 whatever the
 * table, for the "â" of "hâlâ" (§19 Q15, kept as the spec's text). Without the table (a sender
 * that does not use it; whether İletimerkezi does is §19 Q15's open half) the counts are larger:
 * `default` lists them for the owner's check with the provider.
 */

const VARS = {
  first: 'Mehmet',
  company: 'Demir Yapı A.Ş.',
  site: 'Ataşehir Konutları',
  deadline: '17:30',
  number: '+90 850 123 45 67',
  link: 'https://sl.link/r/AB12CD34EF56',
  code: '482913',
  time: '18:30',
  // The longest heads-up phrase (as renderWeatherPhrase joins it): afternoon rain and gusts.
  weather_phrase:
    TR_PHRASE.rainAfternoon.replace('{amount}', '12,5 mm') +
    TR_PHRASE.and +
    TR_PHRASE.gustsAfterRain.replace('{speed}', '55 km/h'),
  report_no: 'DY-2041-0199',
  pdf_link: 'https://sl.link/r/AB12CD34EF56/report/1',
  weekday: 'Perşembe',
  change: 'Kalıpçı ekibi 6 kişi, 8 saat',
  v: 3,
} as const;

type Budget = { shift: 1 | 2; default: number; encoding: 'gsm7' | 'gsm7-turkish-shift' | 'ucs2' };

/** Per key and variant (no voice number / with one): segments with the shift table, and without. */
const TR_BUDGET: Record<SharedSmsKey, { withoutNumber: Budget; withNumber: Budget }> = {
  welcome: {
    withoutNumber: { shift: 2, default: 3, encoding: 'gsm7-turkish-shift' },
    withNumber: { shift: 2, default: 4, encoding: 'gsm7-turkish-shift' },
  },
  verify_code: same({ shift: 1, default: 1, encoding: 'gsm7-turkish-shift' }),
  daily_link: {
    withoutNumber: { shift: 1, default: 1, encoding: 'gsm7-turkish-shift' },
    withNumber: { shift: 1, default: 2, encoding: 'gsm7-turkish-shift' },
  },
  call_coming: same({ shift: 1, default: 2, encoding: 'gsm7-turkish-shift' }),
  weather_headsup: same({ shift: 2, default: 3, encoding: 'gsm7-turkish-shift' }),
  reminder_1: same({ shift: 1, default: 2, encoding: 'gsm7-turkish-shift' }),
  reminder_2: same({ shift: 2, default: 2, encoding: 'ucs2' }),
  missed_call: {
    withoutNumber: { shift: 1, default: 1, encoding: 'gsm7-turkish-shift' },
    withNumber: { shift: 1, default: 2, encoding: 'gsm7-turkish-shift' },
  },
  question_ready: same({ shift: 1, default: 1, encoding: 'gsm7' }),
  draft_ready: same({ shift: 1, default: 1, encoding: 'gsm7-turkish-shift' }),
  filed: same({ shift: 1, default: 1, encoding: 'gsm7' }),
  photos_link: same({ shift: 1, default: 1, encoding: 'gsm7-turkish-shift' }),
  edit_applied: same({ shift: 1, default: 2, encoding: 'gsm7-turkish-shift' }),
  finish_report: same({ shift: 1, default: 2, encoding: 'gsm7-turkish-shift' }),
  site_paused: same({ shift: 1, default: 2, encoding: 'gsm7-turkish-shift' }),
};

function same(b: Budget) {
  return { withoutNumber: b, withNumber: b };
}

const TR_ONE_WAY = { twoWay: false, linksAllowed: true } as const;

function render(key: SharedSmsKey, hasVoiceNumber: boolean): string {
  return renderSms(key, 'tr', VARS as unknown as SmsVars<typeof key>, {
    ...TR_ONE_WAY,
    hasVoiceNumber,
  });
}

describe('the TR SMS budget (W4-11, spec §9.2)', () => {
  const keys = SMS_KEYS.filter((k): k is SharedSmsKey => !isTwoWaySmsKey(k));

  it('covers every key the one-way TR pack can text', () => {
    expect(Object.keys(TR_BUDGET).sort()).toEqual([...keys].sort());
  });

  it.each(keys)('%s fits its budget with the Turkish shift table (≤ 2 segments)', (key) => {
    for (const hasVoiceNumber of [false, true]) {
      const text = render(key, hasVoiceNumber);
      const budget = TR_BUDGET[key][hasVoiceNumber ? 'withNumber' : 'withoutNumber'];
      const seg = countSmsSegments(text);
      expect(seg.turkishShift.segments, text).toBeLessThanOrEqual(2);
      expect(
        {
          shift: seg.turkishShift.segments,
          default: seg.default.segments,
          encoding: seg.turkishShift.encoding,
        },
        text,
      ).toEqual(budget);
    }
  });

  it('names the one-segment keys', () => {
    const one = keys.filter(
      (k) => TR_BUDGET[k].withoutNumber.shift === 1 && TR_BUDGET[k].withNumber.shift === 1,
    );
    expect(one).toEqual([
      'verify_code',
      'daily_link',
      'call_coming',
      'reminder_1',
      'missed_call',
      'question_ready',
      'draft_ready',
      'filed',
      'photos_link',
      'edit_applied',
      'finish_report',
      'site_paused',
    ]);
  });

  it('keeps every Turkish letter (the renderer never transliterates)', () => {
    const text = render('welcome', false);
    expect(text).toContain('Demir Yapı A.Ş.');
    expect(text).toContain('Ataşehir Konutları');
    expect(text).toContain('asistanıyım');
  });
});
