import { describe, expect, it } from 'vitest';
import { inviteLineCheck, isFixedLine, reachableByPhone } from './line-check.ts';

const ISTANBUL_LANDLINE = '+902122223344';
const TR_MOBILE = '+905321234567';
const NYC = '+12125550123'; // "fixed line or mobile": every US number reads so
const DEMO_US = '+15550148001'; // the fictional 555-01xx range: libphonenumber cannot type it

describe('isFixedLine (W4-02, §19 Q229)', () => {
  it('is true only for a number libphonenumber knows to be a fixed line', () => {
    expect(isFixedLine(ISTANBUL_LANDLINE)).toBe(true);
    expect(isFixedLine(TR_MOBILE)).toBe(false);
    expect(isFixedLine(NYC)).toBe(false);
    expect(isFixedLine(DEMO_US)).toBe(false);
    expect(isFixedLine('not a number')).toBe(false);
  });
});

describe('reachableByPhone', () => {
  const none = { voiceNumber: null, outboundTrunkId: null };
  it('needs a voice number, an outbound trunk or a demo org', () => {
    expect(reachableByPhone({ isDemo: false }, none)).toBe(false);
    expect(reachableByPhone({ isDemo: true }, none)).toBe(true);
    expect(
      reachableByPhone({ isDemo: false }, { ...none, voiceNumber: '+15550142290' as never }),
    ).toBe(true);
    expect(reachableByPhone({ isDemo: false }, { ...none, outboundTrunkId: 'ST_abcd1234' })).toBe(
      true,
    );
  });
});

describe('inviteLineCheck', () => {
  it('lets a mobile or an untyped number through, whatever the preference', () => {
    for (const phone of [TR_MOBILE, NYC, DEMO_US]) {
      for (const pref of ['link', 'call'] as const) {
        expect(inviteLineCheck(phone, pref, { reachable: false })).toEqual({ ok: true });
      }
    }
  });

  it('refuses a landline for a text link, and allows a call only where SiteLog can reach it', () => {
    expect(inviteLineCheck(ISTANBUL_LANDLINE, 'link', { reachable: true })).toEqual({
      ok: false,
      problem: 'landline_text',
    });
    expect(inviteLineCheck(ISTANBUL_LANDLINE, 'call', { reachable: true })).toEqual({ ok: true });
    for (const pref of ['link', 'call'] as const) {
      expect(inviteLineCheck(ISTANBUL_LANDLINE, pref, { reachable: false })).toEqual({
        ok: false,
        problem: 'landline_unreachable',
      });
    }
  });
});
