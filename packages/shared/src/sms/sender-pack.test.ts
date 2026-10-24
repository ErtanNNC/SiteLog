import { describe, expect, it } from 'vitest';
import { chooseInboundPack, phoneRegion } from './sender-pack.ts';

const SHARED = '+17752628262';
const TR_PHONE = '+905321234567';
const US_PHONE = '+12025550143';
const GR_PHONE = '+306912345678';

const base = {
  candidates: ['US', 'TR'],
  lastOutboundPack: null,
  reporterPacks: [],
  from: TR_PHONE,
  to: SHARED,
};

describe('chooseInboundPack (spec §19 Q370)', () => {
  it('keeps a sender of one pack on that pack, whatever the phone', () => {
    expect(chooseInboundPack({ ...base, candidates: ['US'], lastOutboundPack: 'TR' })).toBe('US');
    expect(chooseInboundPack({ ...base, candidates: [] })).toBeNull();
  });

  it('answers a reply in the pack of the last message sent to that phone', () => {
    expect(
      chooseInboundPack({ ...base, from: US_PHONE, lastOutboundPack: 'TR', reporterPacks: ['US'] }),
    ).toBe('TR');
  });

  it('ignores a last message on a pack the sender does not serve', () => {
    expect(chooseInboundPack({ ...base, lastOutboundPack: 'GR', reporterPacks: ['US'] })).toBe(
      'US',
    );
  });

  it("takes the reporters' one pack, else the phone's country", () => {
    expect(chooseInboundPack({ ...base, reporterPacks: ['US', 'US'] })).toBe('US');
    // Reporters on both packs say nothing: the phone's own country decides.
    expect(chooseInboundPack({ ...base, reporterPacks: ['US', 'TR'], from: TR_PHONE })).toBe('TR');
    expect(chooseInboundPack({ ...base, from: US_PHONE })).toBe('US');
  });

  it("falls back to the sender's country, then the first pack by code", () => {
    // A Greek number with no history: the shared US number's own pack.
    expect(chooseInboundPack({ ...base, from: GR_PHONE })).toBe('US');
    // A sender whose country is not one of its packs: the first by code.
    expect(chooseInboundPack({ ...base, from: GR_PHONE, to: '+306900000000' })).toBe('TR');
    expect(chooseInboundPack({ ...base, from: GR_PHONE, to: 'TALKOLOG' })).toBe('TR');
  });
});

describe('phoneRegion', () => {
  it('reads the country of an E.164 number, null for anything else', () => {
    expect(phoneRegion(TR_PHONE)).toBe('TR');
    expect(phoneRegion(GR_PHONE)).toBe('GR');
    expect(phoneRegion(SHARED)).toBe('US');
    expect(phoneRegion('TALKOLOG')).toBeNull();
  });
});
