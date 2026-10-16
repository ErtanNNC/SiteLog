import { describe, expect, it } from 'vitest';
import {
  confirmedBySiteManager,
  packClaimReady,
  packConfirmation,
  packSections,
  type PackConfirmationFacts,
} from './evidence-pack.ts';

const base: PackConfirmationFacts = {
  confirmed_at: '2026-10-09T22:31:00Z',
  confirmed_via: 'web',
  channel: 'web',
  kind: 'daily',
  reporter_id: 'rep-1',
  review_reasons: [],
};

describe('packConfirmation (spec §19 Q134)', () => {
  it('names the channel the site manager confirmed on', () => {
    expect(packConfirmation(base)).toBe('recorder');
    expect(packConfirmation({ ...base, confirmed_via: 'voice', channel: 'voice' })).toBe('call');
    expect(packConfirmation({ ...base, confirmed_via: 'sms', channel: 'sms' })).toBe('sms');
    expect(packConfirmation({ ...base, confirmed_via: 'whatsapp' })).toBe('whatsapp');
  });

  it('reads a v1.0 report (no channel, no confirm channel) as confirmed on WhatsApp', () => {
    expect(packConfirmation({ ...base, confirmed_via: null, channel: null })).toBe('whatsapp');
  });

  it('tells the office’s reports and filings from the site manager’s', () => {
    // Typed in the panel: no reporter, channel office (confirmed_at is set by the RPC).
    expect(packConfirmation({ ...base, reporter_id: null, confirmed_via: null })).toBe('office');
    expect(packConfirmation({ ...base, channel: 'office', confirmed_via: null })).toBe('office');
    // A v1.2 report confirmed with no confirm channel: the office filed it.
    expect(packConfirmation({ ...base, confirmed_via: null })).toBe('office');
  });

  it('says a timeout or auto filing was not confirmed', () => {
    expect(packConfirmation({ ...base, confirmed_at: null, confirmed_via: null })).toBe(
      'unconfirmed',
    );
    expect(packConfirmation({ ...base, review_reasons: ['unconfirmed'] })).toBe('unconfirmed');
  });

  it('keeps a weather day the site manager logged apart from an unconfirmed report', () => {
    expect(
      packConfirmation({ ...base, kind: 'weather_day', confirmed_at: null, confirmed_via: null }),
    ).toBe('weather_day');
  });
});

describe('packClaimReady (spec §19 Q134)', () => {
  it('needs the evidence, and the site manager’s confirmation or the sign-off', () => {
    expect(packClaimReady(true, 'recorder', false)).toBe(true);
    expect(packClaimReady(true, 'weather_day', false)).toBe(true);
    expect(packClaimReady(false, 'recorder', true)).toBe(false);
    for (const c of ['unconfirmed', 'office'] as const) {
      expect(packClaimReady(true, c, false), c).toBe(false);
      expect(packClaimReady(true, c, true), c).toBe(true);
      expect(confirmedBySiteManager(c)).toBe(false);
    }
  });
});

describe('packSections', () => {
  it('keeps the stored sections in pack order, all of them when none is stored', () => {
    expect(packSections(['weather', 'summary'])).toEqual(['summary', 'weather']);
    expect(packSections([])).toEqual(['summary', 'reports', 'transcripts', 'photos', 'weather']);
    expect(packSections(null)).toHaveLength(5);
    expect(packSections(['bogus'])).toHaveLength(5);
  });
});
