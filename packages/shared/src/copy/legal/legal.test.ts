import { describe, expect, it } from 'vitest';
import { toCountryPack, packCopyGaps } from '../../countries.ts';
import { DEMO_COUNTRIES } from '../../demo/countries.ts';
import { LANGUAGES } from '../../locale.ts';
import { countSmsSegments } from '../../sms/segments.ts';
import { VOICE_RECORDING_NOTICE_VERSION } from '../../voice.ts';
import { renderSms, SMS_HELP_PRIVACY } from '../sms.ts';
import { VOICE_CATALOGS } from '../voice.ts';
import {
  fieldLanguagesOf,
  LEGAL_DOCS,
  legalDoc,
  legalKeyGaps,
  legalPagePath,
  legalPageUrl,
  legalText,
  parseLegalKey,
  recordingNoticeFor,
  recordingNoticeLines,
  type LegalDoc,
} from './index.ts';

describe('the legal catalogue (W4-06, §19 Q28, Q50)', () => {
  it('names every entry by a well-formed versioned key, with a date', () => {
    for (const [key, doc] of Object.entries(LEGAL_DOCS)) {
      expect(doc.key).toBe(key);
      expect(parseLegalKey(key), key).not.toBeNull();
      expect(doc.effective, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('has every text in EN, ES and TR, with a title, a body and (recording notice) a spoken line', () => {
    for (const [key, doc] of Object.entries(LEGAL_DOCS)) {
      const slot = parseLegalKey(key)!.slot;
      for (const lang of LANGUAGES) {
        const text = doc.texts[lang];
        expect(text, `${key} ${lang}`).toBeDefined();
        expect(text!.title.trim(), `${key} ${lang}`).not.toBe('');
        expect(text!.body.length, `${key} ${lang}`).toBeGreaterThan(0);
        if (slot === 'recording_notice')
          expect(text!.spoken?.trim(), `${key} ${lang}`).toBeTruthy();
        else expect(text!.spoken, `${key} ${lang}`).toBeUndefined();
      }
    }
  });

  it('holds only placeholders until counsel’s texts arrive, and each says so', () => {
    const words = { en: /placeholder/i, es: /provisional/i, tr: /yer tutucu/i } as const;
    for (const doc of Object.values(LEGAL_DOCS)) {
      expect(doc.status).toBe('placeholder');
      expect(parseLegalKey(doc.key)!.country).toBe('ZZ');
      for (const lang of LANGUAGES) {
        const text = doc.texts[lang]!;
        expect(text.title, `${doc.key} ${lang}`).toMatch(words[lang]);
        expect(text.body[0], `${doc.key} ${lang}`).toMatch(words[lang]);
      }
    }
  });

  it('parses keys: <CC>.<slot>.v<n> only', () => {
    expect(parseLegalKey('TR.privacy_notice.v2')).toEqual({
      country: 'TR',
      slot: 'privacy_notice',
      version: 2,
    });
    for (const bad of [
      'tr.consent.v1',
      'TR.terms.v1',
      'TR.consent.v0',
      'TR.consent',
      'TR.consent.v1 ',
    ])
      expect(parseLegalKey(bad), bad).toBeNull();
  });

  it('picks the asked language, then the fallbacks', () => {
    const doc: LegalDoc = {
      key: 'TR.privacy_notice.v1',
      effective: '2026-11-01',
      status: 'approved',
      texts: { tr: { title: 'T', body: ['b'] }, en: { title: 'E', body: ['b'] } },
    };
    const docs = { [doc.key]: doc };
    expect(legalKeyGaps({ privacyNotice: doc.key }, ['tr', 'en'], { country: 'TR', docs })).toEqual(
      [],
    );
    expect(legalText('ZZ.consent.v1', 'es')).toMatchObject({ language: 'es' });
    expect(legalText('XX.consent.v1', 'en')).toBeNull();
    expect(legalDoc('constructor')).toBeNull();
  });

  it('builds the page path and URL', () => {
    expect(legalPagePath('US.privacy_notice.v1')).toBe('/legal/US.privacy_notice.v1');
    expect(legalPageUrl('https://go.sitelog.app/', 'US.privacy_notice.v1')).toBe(
      'https://go.sitelog.app/legal/US.privacy_notice.v1',
    );
  });
});

describe('legalKeyGaps / packCopyGaps (the pack check)', () => {
  const approved = (key: string, langs: Array<'en' | 'es' | 'tr'>, spoken = true): LegalDoc => ({
    key,
    effective: '2026-11-01',
    status: 'approved',
    texts: Object.fromEntries(
      langs.map((l) => [l, { title: 'T', body: ['b'], ...(spoken ? { spoken: 's' } : {}) }]),
    ),
  });

  it('a pack naming a key without its text, or a text short of a field language, has gaps', () => {
    const docs = {
      'TR.privacy_notice.v1': approved('TR.privacy_notice.v1', ['tr']),
      'TR.recording_notice.v1': approved('TR.recording_notice.v1', ['tr', 'en'], false),
    };
    expect(
      legalKeyGaps(
        {
          privacyNotice: 'TR.privacy_notice.v1',
          recordingNotice: 'TR.recording_notice.v1',
          consent: 'TR.consent.v1',
        },
        ['tr', 'en'],
        { country: 'TR', docs },
      ),
    ).toEqual([
      'privacy_notice.en',
      'recording_notice.tr.spoken',
      'recording_notice.en.spoken',
      'consent.missing',
    ]);
  });

  it('refuses a key of another slot or country, and any placeholder', () => {
    expect(
      legalKeyGaps(
        { privacyNotice: 'ZZ.privacy_notice.v1', consent: 'ZZ.privacy_notice.v1' },
        ['en'],
        {
          country: 'US',
        },
      ),
    ).toEqual([
      'privacy_notice.key',
      'privacy_notice.placeholder',
      'consent.key',
      'consent.placeholder',
    ]);
  });

  it('runs inside packCopyGaps: the launch packs (legal_keys {}) are complete; a keyed pack is not', () => {
    for (const row of DEMO_COUNTRIES) {
      expect(row.legal_keys, row.code).toEqual({});
      expect(packCopyGaps(toCountryPack(row)), row.code).toEqual([]);
    }
    const tr = DEMO_COUNTRIES.find((c) => c.code === 'TR')!;
    expect(
      packCopyGaps(
        toCountryPack({ ...tr, legal_keys: { privacy_notice: 'TR.privacy_notice.v1' } }),
      ),
    ).toEqual(['legal.privacy_notice.missing']);
  });

  it('reads the field languages once each', () => {
    expect(fieldLanguagesOf(['en-US', 'es-US', 'en-US'])).toEqual(['en', 'es']);
  });
});

describe('the recording notice by key (§9.4 "Disclosure")', () => {
  it('says the keyed notice when it has the language, else the voice copy’s own', () => {
    expect(recordingNoticeFor('ZZ.recording_notice.v1', 'tr')).toEqual({
      text: LEGAL_DOCS['ZZ.recording_notice.v1']!.texts.tr!.spoken,
      version: 'ZZ.recording_notice.v1',
    });
    for (const key of [undefined, null, '', 'US.recording_notice.v9']) {
      expect(recordingNoticeFor(key, 'en')).toEqual({
        text: VOICE_CATALOGS.en.recording_notice,
        version: VOICE_RECORDING_NOTICE_VERSION,
      });
    }
  });

  it('exports the spoken lines by key for the agent', () => {
    expect(recordingNoticeLines()).toEqual({
      'ZZ.recording_notice.v1': {
        en: LEGAL_DOCS['ZZ.recording_notice.v1']!.texts.en!.spoken,
        es: LEGAL_DOCS['ZZ.recording_notice.v1']!.texts.es!.spoken,
        tr: LEGAL_DOCS['ZZ.recording_notice.v1']!.texts.tr!.spoken,
      },
    });
  });
});

describe('HELP with the privacy notice (§9.1, W4-06)', () => {
  const vars = {
    company: 'Kestrel Build Group',
    link: 'https://go.sitelog.app/r/AB12CD34EF56',
    number: '(555) 010-0199',
  };
  const privacy = legalPageUrl('https://go.sitelog.app', 'US.privacy_notice.v1');
  const opts = (hasVoiceNumber: boolean) => ({ hasVoiceNumber, twoWay: true, linksAllowed: true });

  it.each(LANGUAGES)('%s: the clause is appended only with a privacy link', (lang) => {
    for (const hasVoiceNumber of [true, false]) {
      const plain = renderSms('help', lang, vars, opts(hasVoiceNumber));
      const withLink = renderSms(
        'help',
        lang,
        { ...vars, privacy_link: privacy },
        opts(hasVoiceNumber),
      );
      expect(withLink).toBe(plain + SMS_HELP_PRIVACY[lang].replace('{privacy_link}', privacy));
      expect(renderSms('help', lang, { ...vars, privacy_link: '' }, opts(hasVoiceNumber))).toBe(
        plain,
      );
      // The segment budget (two-way SMS is EN and ES; Turkish HELP goes on WhatsApp only, W2-16):
      // English stays within 2 segments, and the clause adds at most one.
      if (lang === 'tr') continue;
      const before = countSmsSegments(plain).default.segments;
      const after = countSmsSegments(withLink).default.segments;
      expect(after - before, `${lang} ${hasVoiceNumber}`).toBeLessThanOrEqual(1);
      if (lang === 'en') expect(after).toBeLessThanOrEqual(2);
    }
  });

  it('never touches another key', () => {
    expect(
      renderSms(
        'draft_ready',
        'en',
        { link: vars.link, privacy_link: privacy } as never,
        opts(true),
      ),
    ).toBe(`Your report is ready to check: ${vars.link}`);
  });
});
