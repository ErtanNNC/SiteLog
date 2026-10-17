import { getCountries } from 'libphonenumber-js/min';
import { describe, expect, it } from 'vitest';
import { DEMO_COUNTRIES } from './demo/countries.ts';
import {
  foreignNumberRegion,
  isPhoneRegion,
  numberRegion,
  parsePhoneIn,
  phoneRegion,
  phoneRegionFor,
  phoneRegionName,
  phoneRegions,
  searchPhoneRegions,
} from './phone-regions.ts';

describe('phone regions (spec §4.6, W4-01)', () => {
  it('lists every libphonenumber region once, with its calling code', () => {
    const en = phoneRegions('en');
    expect(en).toHaveLength(getCountries().length);
    expect(new Set(en.map((r) => r.code)).size).toBe(en.length);
    expect(en.find((r) => r.code === 'TR')).toMatchObject({ callingCode: '90' });
    expect(en.find((r) => r.code === 'MX')).toMatchObject({ callingCode: '52' });
  });

  it('lists every country pack', () => {
    const codes = phoneRegions('en').map((r) => r.code);
    for (const { code } of DEMO_COUNTRIES) expect(codes).toContain(code);
  });

  it('names regions in the panel language and sorts them in it', () => {
    expect(phoneRegionName('TR', 'tr')).toBe('Türkiye');
    expect(phoneRegionName('DE', 'tr')).toBe('Almanya');
    expect(phoneRegionName('DE', 'en')).toBe('Germany');
    const tr = phoneRegions('tr').map((r) => r.name);
    const collator = new Intl.Collator('tr');
    expect([...tr].sort(collator.compare)).toEqual(tr);
    // Turkish order: "Çin" after "Cezayir", before "Danimarka".
    expect(tr.indexOf('Çin')).toBeGreaterThan(tr.indexOf('Cezayir'));
    expect(tr.indexOf('Çin')).toBeLessThan(tr.indexOf('Danimarka'));
  });

  it('puts the org’s pack country first, and ignores a code libphonenumber does not know', () => {
    expect(phoneRegions('en', 'TR')[0]!.code).toBe('TR');
    expect(phoneRegions('en', 'TR')).toHaveLength(getCountries().length);
    expect(phoneRegions('en', 'XX')).toEqual(phoneRegions('en'));
  });

  it('gives each region a mobile example, or "+code …"', () => {
    expect(phoneRegion('TR', 'en')).toMatchObject({
      example: '+90 501 234 56 78',
      nationalExample: '0501 234 56 78',
    });
    for (const r of phoneRegions('en'))
      expect(r.example).toMatch(new RegExp(`^\\+${r.callingCode} `));
  });

  it('falls back to US for a region libphonenumber does not know', () => {
    expect(phoneRegionFor('TR')).toBe('TR');
    expect(phoneRegionFor('NL')).toBe('NL');
    expect(phoneRegionFor('XX')).toBe('US');
    expect(phoneRegionFor('ZZ')).toBe('US');
    expect(phoneRegionFor(undefined)).toBe('US');
    expect(phoneRegionFor('xx', 'TR')).toBe('TR');
    expect(isPhoneRegion('tr')).toBe(false);
    expect(phoneRegion('XX', 'en')).toBeNull();
  });

  it('parses national input for the picked region', () => {
    // The §18.2 demo range, typed as a Turkish site manager would.
    expect(parsePhoneIn('0532 000 0512', 'TR')).toBe('+905320000512');
    expect(parsePhoneIn('(555) 014-3378', 'US')).toBe('+15550143378');
    expect(parsePhoneIn('55 1234 5678', 'MX')).toBe('+525512345678');
    expect(parsePhoneIn('+90 532 000 0512', 'US')).toBe('+905320000512');
    expect(parsePhoneIn('555 014 3378', 'XX')).toBe('+15550143378');
    expect(parsePhoneIn('12', 'US')).toBeNull();
  });

  it('searches by name, ISO code and calling code', () => {
    const en = phoneRegions('en', 'US');
    expect(searchPhoneRegions(en, 'mex')[0]!.code).toBe('MX');
    expect(searchPhoneRegions(en, 'turk').map((r) => r.code)).toContain('TR');
    expect(searchPhoneRegions(en, '+52').map((r) => r.code)).toEqual(['MX']);
    expect(searchPhoneRegions(en, '90').map((r) => r.code)).toEqual(['TR']);
    expect(searchPhoneRegions(en, '+1').map((r) => r.code)).toEqual(
      expect.arrayContaining(['US', 'CA']),
    );
    expect(searchPhoneRegions(en, 'de')[0]!.code).toBe('DE');
    expect(searchPhoneRegions(en, '')).toEqual(en);
    expect(searchPhoneRegions(en, 'qqqq')).toEqual([]);
    const tr = phoneRegions('tr');
    expect(searchPhoneRegions(tr, 'alm')[0]!.code).toBe('DE');
    expect(searchPhoneRegions(tr, 'turkiye')[0]!.code).toBe('TR');
  });

  it('warns for a +52 number in a US org, not for the org’s own numbers (§19 Q23)', () => {
    expect(foreignNumberRegion('+525512345678', 'US', 'MX')).toBe('MX');
    expect(foreignNumberRegion('+525512345678', 'US', 'US')).toBe('MX');
    // The demo's fictional 555-01xx numbers: the calling code's main region, or the picked one.
    expect(foreignNumberRegion('+15550143378', 'US', 'US')).toBeNull();
    expect(foreignNumberRegion('+15550143378', 'US', 'CA')).toBe('CA');
    expect(foreignNumberRegion('+14165550134', 'US', 'US')).toBe('CA');
    expect(foreignNumberRegion('+905320000512', 'TR', 'TR')).toBeNull();
    expect(foreignNumberRegion('+15550143378', 'TR', 'US')).toBe('US');
    // A pack libphonenumber does not know has nothing to compare against.
    expect(foreignNumberRegion('+525512345678', 'XX', 'MX')).toBeNull();
    expect(numberRegion('not a number')).toBeNull();
    expect(numberRegion('+447700900123')).toBe('GB');
  });
});
