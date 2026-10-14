import { describe, expect, it } from 'vitest';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { emptyPhone, PHONE_COUNTRIES, phoneCountryFor, phoneValue } from './PhoneInput';

describe('PhoneInput countries', () => {
  it('lists every launch country pack, Türkiye with +90', () => {
    for (const { code } of DEMO_COUNTRIES)
      expect(PHONE_COUNTRIES.map((c) => c.code)).toContain(code);
    expect(PHONE_COUNTRIES.find((c) => c.code === 'TR')).toMatchObject({ dial: '90' });
    // The §18.2 demo range, typed as a Turkish site manager would.
    expect(phoneValue('TR', '0532 000 0512').e164).toBe('+905320000512');
  });

  it('starts in the org’s country when the picker lists it, otherwise US', () => {
    expect(phoneCountryFor('TR')).toBe('TR');
    expect(phoneCountryFor('US')).toBe('US');
    expect(phoneCountryFor('ZZ')).toBe('US');
    expect(phoneCountryFor(undefined)).toBe('US');
    expect(emptyPhone(phoneCountryFor('TR'))).toEqual({ country: 'TR', raw: '', e164: null });
  });
});
