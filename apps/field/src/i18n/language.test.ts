import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserLanguages,
  FIELD_LANGUAGES,
  fieldLanguageOf,
  resolveFieldLanguage,
} from './language';

describe('field language (§9.6, W1-04)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('speaks EN, ES and TR', () => {
    expect(FIELD_LANGUAGES).toEqual(['en', 'es', 'tr']);
  });

  it('maps tags to the field languages', () => {
    expect(fieldLanguageOf('es-US')).toBe('es');
    expect(fieldLanguageOf('es-419')).toBe('es');
    expect(fieldLanguageOf('TR')).toBe('tr');
    expect(fieldLanguageOf('tr_TR')).toBe('tr');
    expect(fieldLanguageOf(' en-GB ')).toBe('en');
    expect(fieldLanguageOf('de-DE')).toBeNull();
    expect(fieldLanguageOf('')).toBeNull();
    expect(fieldLanguageOf(null)).toBeNull();
    expect(fieldLanguageOf(undefined)).toBeNull();
  });

  it('takes the first preferred language the app speaks, else English', () => {
    expect(resolveFieldLanguage({})).toBe('en');
    expect(resolveFieldLanguage({ browser: [] })).toBe('en');
    expect(resolveFieldLanguage({ browser: ['es-US', 'en-US'] })).toBe('es');
    expect(resolveFieldLanguage({ browser: ['tr-TR'] })).toBe('tr');
    expect(resolveFieldLanguage({ browser: ['en-US', 'es-MX'] })).toBe('en');
    // A phone set to Portuguese, then Spanish: Spanish, not English.
    expect(resolveFieldLanguage({ browser: ['pt-BR', 'es-ES', 'en'] })).toBe('es');
    expect(resolveFieldLanguage({ browser: ['de-DE', 'fr-FR'] })).toBe('en');
    expect(resolveFieldLanguage({ browser: [null, undefined, '', 'tr'] })).toBe('tr');
  });

  it('lets the reporter’s locale win once the link names the reporter', () => {
    expect(resolveFieldLanguage({ reporterLocale: 'es-US', browser: ['en-US'] })).toBe('es');
    expect(resolveFieldLanguage({ reporterLocale: 'tr-TR', browser: ['es-US'] })).toBe('tr');
    expect(resolveFieldLanguage({ reporterLocale: null, browser: ['es-US'] })).toBe('es');
  });

  it('reads the phone’s preferred languages, most preferred first', () => {
    vi.stubGlobal('navigator', { languages: ['tr-TR', 'en-US'], language: 'tr-TR' });
    expect(browserLanguages()).toEqual(['tr-TR', 'en-US']);
    vi.stubGlobal('navigator', { languages: [], language: 'es-US' });
    expect(browserLanguages()).toEqual(['es-US']);
    vi.stubGlobal('navigator', { language: '' });
    expect(browserLanguages()).toEqual([]);
    vi.stubGlobal('navigator', undefined);
    expect(browserLanguages()).toEqual([]);
  });
});
