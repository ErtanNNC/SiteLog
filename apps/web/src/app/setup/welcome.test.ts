import { describe, expect, it } from 'vitest';
import { assertE164 } from '@sitelog/shared/format.ts';
import { demoPack } from '@sitelog/shared/demo/countries.ts';
import { SAMPLE_WELCOME_LINK, welcomePreview } from './welcome';

const vars = {
  first: 'Marco',
  company: 'Kestrel Build Group',
  site: 'Riverside Lofts',
  deadline: '17:30:00',
};

describe('welcomePreview (W4-02: the §9.2 welcome as sent, F2 preview)', () => {
  it('US in English: the reply clause (two-way) and "or call" with the pack’s number', () => {
    const us = { ...demoPack('US'), voiceNumber: assertE164('+15550142290') };
    expect(welcomePreview(us, 'en-US', vars)).toEqual({
      text: `Hi Marco, I'm SiteLog, the daily report assistant for Kestrel Build Group at Riverside Lofts. Each workday before 17:30, tap your link and talk for ~3 min, or call +1 555 014 2290: ${SAMPLE_WELCOME_LINK} - Reply STOP to opt out, HELP for help`,
      language: 'en',
      number: '+1 555 014 2290',
    });
  });

  it('US without a voice number: no "or call", the reply clause stays', () => {
    const preview = welcomePreview(demoPack('US'), 'en-US', vars)!;
    expect(preview.text).not.toContain('or call');
    expect(preview.text).toMatch(/ - Reply STOP to opt out, HELP for help$/);
    expect(preview.number).toBeNull();
  });

  it('US in Spanish (es-US): the Spanish text with the Spanish reply clause', () => {
    const preview = welcomePreview(demoPack('US'), 'es-US', vars)!;
    expect(preview.language).toBe('es');
    expect(preview.text).toMatch(/^Hola Marco, soy SiteLog/);
    expect(preview.text).toContain(SAMPLE_WELCOME_LINK);
  });

  it('TR in Turkish: neither a reply clause (one-way) nor "or call" (no number)', () => {
    const preview = welcomePreview(demoPack('TR'), 'tr-TR', {
      ...vars,
      first: 'Emre',
      company: 'Demir Yapı A.Ş.',
      site: 'Kartal',
    })!;
    expect(preview).toEqual({
      text: `Merhaba Emre, ben SiteLog, Demir Yapı A.Ş. için Kartal günlük rapor asistanıyım. Her iş günü 17:30 öncesi linke dokunup ~3 dk anlatın: ${SAMPLE_WELCOME_LINK}`,
      language: 'tr',
      number: null,
    });
    expect(preview.text).not.toMatch(/STOP|arayın/);
  });

  it('has no preview where the pack forbids links in SMS (§19 Q24)', () => {
    expect(welcomePreview({ ...demoPack('TR'), smsLinksAllowed: false }, 'tr-TR', vars)).toBeNull();
  });
});
