import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../locale.ts';
import {
  renderVoice,
  VOICE_CATALOGS,
  VOICE_KEYS,
  voicePlaceholders,
  voiceSiteList,
} from './voice.ts';

describe('voice copy (W3-01)', () => {
  it('has unique keys and every key in every language, nothing more', () => {
    expect(new Set(VOICE_KEYS).size).toBe(VOICE_KEYS.length);
    for (const language of LANGUAGES) {
      expect(Object.keys(VOICE_CATALOGS[language]).sort(), language).toEqual(
        [...VOICE_KEYS].sort(),
      );
    }
  });

  it('has the same placeholders in every language', () => {
    for (const key of VOICE_KEYS) {
      const en = voicePlaceholders(VOICE_CATALOGS.en[key]).sort();
      for (const language of LANGUAGES) {
        expect(
          voicePlaceholders(VOICE_CATALOGS[language][key]).sort(),
          `${key} ${language}`,
        ).toEqual(en);
      }
    }
  });

  it('is spoken text: no empty line, no emoji, no stray braces, TR without exclamation marks', () => {
    for (const language of LANGUAGES) {
      for (const key of VOICE_KEYS) {
        const text = VOICE_CATALOGS[language][key];
        expect(text.trim(), `${key} ${language}`).not.toBe('');
        expect(text, `${key} ${language}`).not.toMatch(/\p{Extended_Pictographic}/u);
        // Only {name} placeholders: Python's str.format reads the same text.
        expect(text.replace(/\{[a-z0-9_]+\}/g, ''), `${key} ${language}`).not.toMatch(/[{}]/);
      }
      if (language === 'tr') {
        for (const key of VOICE_KEYS) expect(VOICE_CATALOGS.tr[key], key).not.toContain('!');
      }
    }
  });

  it('puts the recording notice into every opening', () => {
    for (const key of VOICE_KEYS.filter((k) => k.startsWith('opening_'))) {
      for (const language of LANGUAGES) {
        expect(voicePlaceholders(VOICE_CATALOGS[language][key]), `${key} ${language}`).toContain(
          'recording_notice',
        );
      }
    }
  });

  it('renders a line and refuses a missing value', () => {
    const notice = renderVoice('recording_notice', 'tr');
    expect(
      renderVoice('opening_outbound', 'tr', {
        first: 'Emre',
        company: 'Demir Yapı',
        site: 'Kartal',
        recording_notice: notice,
      }),
    ).toBe(
      'Merhaba Emre, ben Demir Yapı için SiteLog asistanı. Günlük raporunuz için bu görüşme kaydediliyor. Kartal için bugünün raporunu alabilir miyim?',
    );
    expect(() => renderVoice('goodbye_no_work', 'en')).toThrow(/needs \{site\}/);
    expect(() => renderVoice('goodbye_no_work', 'en', { site: ' ' })).toThrow(/needs \{site\}/);
  });

  it('joins up to three site names for the F14 question', () => {
    expect(voiceSiteList(['Riverside'], 'en')).toBe('Riverside');
    expect(voiceSiteList(['Riverside', 'Pier 9'], 'en')).toBe('Riverside or Pier 9');
    expect(voiceSiteList(['A', 'B', 'C'], 'es')).toBe('A, B o C');
    expect(voiceSiteList(['A', 'B'], 'tr')).toBe('A ya da B');
    expect(() => voiceSiteList(['A', 'B', 'C', 'D'], 'en')).toThrow();
    expect(() => voiceSiteList([], 'en')).toThrow();
    expect(
      renderVoice('pick_site', 'en', { sites: voiceSiteList(['Riverside', 'Pier 9'], 'en') }),
    ).toBe('Which site is this for — Riverside or Pier 9?');
  });
});
