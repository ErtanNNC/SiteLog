import { describe, expect, it } from 'vitest';
import {
  OFFICE_EMAIL_LANGUAGE,
  groupByEmailLanguage,
  officeEmailLanguage,
} from './email-language.ts';

describe('office email language (§19 Q239)', () => {
  it('builds the recommended default: the reader’s panel language', () => {
    expect(OFFICE_EMAIL_LANGUAGE).toBe('reader');
  });

  it('reads ui_locale first, then the org’s locale; `org` and `en` override', () => {
    expect(officeEmailLanguage('tr-TR', 'en-US')).toBe('tr');
    expect(officeEmailLanguage('en-US', 'tr-TR')).toBe('en');
    expect(officeEmailLanguage(null, 'tr-TR')).toBe('tr');
    expect(officeEmailLanguage(null, null)).toBe('en');
    expect(officeEmailLanguage('tr-TR', 'en-US', 'org')).toBe('en');
    expect(officeEmailLanguage(null, 'tr-TR', 'en')).toBe('en');
  });

  it('splits recipients by language: members by their own, other addresses by the org’s', () => {
    const members = [
      { email: 'Elif@demir.example', uiLocale: null },
      { email: 'murat@demir.example', uiLocale: 'en-US' as const },
      { email: 'ayse@demir.example', uiLocale: 'tr-TR' as const },
    ];
    expect(
      groupByEmailLanguage(
        [
          'elif@demir.example',
          'murat@demir.example',
          'site@client.example',
          'ayse@demir.example',
          'ELIF@demir.example',
        ],
        members,
        'tr-TR',
      ),
    ).toEqual([
      { language: 'en', to: ['murat@demir.example'] },
      {
        language: 'tr',
        to: ['elif@demir.example', 'site@client.example', 'ayse@demir.example'],
      },
    ]);
    expect(groupByEmailLanguage([], members, 'tr-TR')).toEqual([]);
    expect(groupByEmailLanguage(['a@x.example'], [], null)).toEqual([
      { language: 'en', to: ['a@x.example'] },
    ]);
  });
});
