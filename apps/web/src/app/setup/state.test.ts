import { afterEach, describe, expect, it } from 'vitest';
import { toCountryPack } from '@sitelog/shared/countries.ts';
import { demoCountriesFor } from '@sitelog/shared/demo/countries.ts';

// The tests run with Turkish on (§19 Q378): the TR pack has its Turkish locales.
const demoPack = (code: 'US' | 'TR') =>
  toCountryPack(demoCountriesFor(true).find((c) => c.code === code)!);
import { storage } from '@/lib/utils';
import { siteDefaultsFor } from './countries';
import {
  DEFAULT_COUNTRY,
  DEFAULT_TZ,
  emptyCompany,
  emptySite,
  loadProgress,
  progressKey,
} from './state';

const USER = 'user-1';

afterEach(() => localStorage.clear());

describe('wizard state: the country (spec §4.6, §19 Q32)', () => {
  it('starts in the preselected country, US (create_org’s default), with its time zone', () => {
    expect(DEFAULT_COUNTRY).toBe('US');
    expect(loadProgress(USER, null).company).toEqual({
      name: '',
      address: '',
      licenseNo: '',
      country: 'US',
      timezone: DEFAULT_TZ,
      timezoneTouched: false,
    });
    expect(emptyCompany('TR', 'Europe/Istanbul')).toMatchObject({
      country: 'TR',
      timezone: 'Europe/Istanbul',
      timezoneTouched: false,
    });
  });

  it('reads progress saved before the country choice as US, keeping a time zone the user chose', () => {
    storage.set(progressKey(USER), {
      done: {},
      company: { name: 'Fresh Build Co', address: '', licenseNo: '', timezone: 'America/Denver' },
    });
    expect(loadProgress(USER, null).company).toMatchObject({
      name: 'Fresh Build Co',
      country: 'US',
      timezone: 'America/Denver',
      timezoneTouched: true,
    });
    // The default zone was never chosen: picking a country may still preset it.
    storage.set(progressKey(USER), { done: {}, company: { name: 'X', timezone: DEFAULT_TZ } });
    expect(loadProgress(USER, null).company.timezoneTouched).toBe(false);
  });

  it('keeps a saved country and its saved time zone choice', () => {
    storage.set(progressKey(USER), {
      done: {},
      company: {
        name: 'Demir',
        country: 'TR',
        timezone: 'Europe/Istanbul',
        timezoneTouched: false,
      },
    });
    expect(loadProgress(USER, null).company).toMatchObject({
      country: 'TR',
      timezone: 'Europe/Istanbul',
      timezoneTouched: false,
    });
  });

  it('starts a site manager in the org’s pack: TR number and Turkish for a TR org', () => {
    const tr = siteDefaultsFor(demoPack('TR'));
    expect(emptySite('Europe/Istanbul', tr)).toMatchObject({
      timezone: 'Europe/Istanbul',
      managerCountry: 'TR',
      backupCountry: 'TR',
      languages: ['tr'],
    });
    expect(emptySite()).toMatchObject({
      managerCountry: 'US',
      backupCountry: 'US',
      languages: ['en'],
    });
    const p = loadProgress(USER, 'org-tr', {
      country: 'TR',
      timezone: 'Europe/Istanbul',
      site: tr,
    });
    expect(p.company.country).toBe('TR');
    expect(p.site).toMatchObject({ managerCountry: 'TR', languages: ['tr'] });
  });
});
