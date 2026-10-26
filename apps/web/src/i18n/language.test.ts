import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserLanguage,
  chosenLanguage,
  LANGUAGE_KEY,
  panelLanguageOf,
  panelLanguagesFor,
  rememberLanguage,
  resolveLanguage,
} from './language';

describe('panel language (§11.2, F1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps tags to the panel languages', () => {
    expect(panelLanguageOf('tr-TR')).toBe('tr');
    expect(panelLanguageOf('TR')).toBe('tr');
    expect(panelLanguageOf('en-GB')).toBe('en');
    expect(panelLanguageOf('es-US')).toBeNull();
    expect(panelLanguageOf(undefined)).toBeNull();
  });

  it('defaults (§6.3): the choice, else the org locale, else the browser before an org is known, else English', () => {
    expect(resolveLanguage({})).toBe('en');
    // No org yet (/login, /auth/callback): the browser's language when the panel speaks it.
    expect(resolveLanguage({ browser: 'de-DE' })).toBe('en');
    expect(resolveLanguage({ browser: 'tr-TR' })).toBe('tr');
    expect(resolveLanguage({ browser: 'en-GB' })).toBe('en');
    // The org is known: its locale, whatever the browser.
    expect(resolveLanguage({ browser: 'en-US', orgLocale: 'tr-TR' })).toBe('tr');
    expect(resolveLanguage({ browser: 'tr', orgLocale: 'en-US' })).toBe('en');
    expect(resolveLanguage({ browser: 'es-US', orgLocale: 'en-US' })).toBe('en');
    expect(resolveLanguage({ browser: 'tr-TR', orgLocale: null })).toBe('tr');
    // The viewer's choice wins over both.
    expect(resolveLanguage({ chosen: 'en', browser: 'tr-TR', orgLocale: 'tr-TR' })).toBe('en');
    expect(resolveLanguage({ chosen: 'tr', browser: 'en-US', orgLocale: 'en-US' })).toBe('tr');
  });

  it('reads the browser’s first preferred language', () => {
    vi.stubGlobal('navigator', { languages: ['tr-TR', 'en-US'], language: 'en-US' });
    expect(browserLanguage()).toBe('tr-TR');
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(browserLanguage()).toBe('en-US');
  });

  it('remembers the choice on this device and ignores junk in storage', () => {
    expect(chosenLanguage()).toBeNull();
    rememberLanguage('tr');
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('"tr"');
    expect(chosenLanguage()).toBe('tr');
    window.localStorage.setItem(LANGUAGE_KEY, '"de"');
    expect(chosenLanguage()).toBeNull();
    window.localStorage.setItem(LANGUAGE_KEY, '{not json');
    expect(chosenLanguage()).toBeNull();
  });

  it('works without storage (private mode, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => rememberLanguage('tr')).not.toThrow();
    expect(chosenLanguage()).toBeNull();
  });
});

describe('Turkish off (§19 Q378)', () => {
  const off = panelLanguagesFor(false);

  it('a deployed build offers English only; a build with VITE_TURKISH=true offers EN and TR', () => {
    expect(off).toEqual(['en']);
    expect(panelLanguagesFor(true)).toEqual(['en', 'tr']);
  });

  it('never resolves Turkish: a Turkish choice, org or browser falls back to English', () => {
    expect(panelLanguageOf('tr-TR', off)).toBeNull();
    expect(resolveLanguage({ chosen: 'tr' }, off)).toBe('en');
    expect(resolveLanguage({ orgLocale: 'tr-TR' }, off)).toBe('en');
    expect(resolveLanguage({ browser: 'tr-TR' }, off)).toBe('en');
  });
});
