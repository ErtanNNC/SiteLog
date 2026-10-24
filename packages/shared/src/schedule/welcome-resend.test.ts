import { describe, expect, it } from 'vitest';
import {
  nextInsideWindow,
  welcomeResendDueAt,
  welcomeResendSkip,
  type WelcomeResendFacts,
} from './welcome-resend.ts';

const CHICAGO = 'America/Chicago';
const ISTANBUL = 'Europe/Istanbul';

describe('welcomeResendDueAt (§19 Q241: 48 h later, 09:00–18:00 site time)', () => {
  it('48 h later when that falls in the site’s daytime', () => {
    // Mon 10:15 CDT → Wed 10:15 CDT.
    expect(welcomeResendDueAt(new Date('2026-10-12T15:15:00Z'), CHICAGO).toISOString()).toBe(
      '2026-10-14T15:15:00.000Z',
    );
  });

  it('moves an evening due time to 09:00 the next morning, site time', () => {
    // Mon 19:40 CDT → Wed 19:40 → Thu 09:00 CDT.
    expect(welcomeResendDueAt(new Date('2026-10-13T00:40:00Z'), CHICAGO).toISOString()).toBe(
      '2026-10-15T14:00:00.000Z',
    );
  });

  it('moves an early due time to 09:00 the same day, and 18:00 itself is outside', () => {
    // Mon 06:30 Istanbul (UTC+3) → Wed 06:30 → Wed 09:00.
    expect(welcomeResendDueAt(new Date('2026-10-12T03:30:00Z'), ISTANBUL).toISOString()).toBe(
      '2026-10-14T06:00:00.000Z',
    );
    expect(
      nextInsideWindow(new Date('2026-10-14T15:00:00Z'), ISTANBUL).toISOString(), // 18:00
    ).toBe('2026-10-15T06:00:00.000Z');
    expect(
      nextInsideWindow(new Date('2026-10-14T06:00:00Z'), ISTANBUL).toISOString(), // 09:00
    ).toBe('2026-10-14T06:00:00.000Z');
  });

  it('keeps the wall clock across the DST change (Chicago, Nov 1 2026)', () => {
    // Fri Oct 30 20:00 CDT → Sun Nov 1 20:00 CST → Mon Nov 2 09:00 CST (UTC−6).
    expect(welcomeResendDueAt(new Date('2026-10-31T01:00:00Z'), CHICAGO).toISOString()).toBe(
      '2026-11-02T15:00:00.000Z',
    );
  });
});

describe('welcomeResendSkip', () => {
  const now = new Date('2026-10-14T15:15:00Z');
  const quiet: WelcomeResendFacts = {
    status: 'invited',
    invitedAt: '2026-10-12T15:15:00Z',
    consents: 0,
    linkOpened: false,
    phoneOptedOut: false,
  };

  it('sends when nothing happened since the welcome', () => {
    expect(welcomeResendSkip(quiet, now)).toBeNull();
  });

  it('never after a reaction, an opt-out or a newer welcome', () => {
    expect(welcomeResendSkip({ ...quiet, status: 'active' }, now)).toBe('not_invited');
    expect(welcomeResendSkip({ ...quiet, status: 'opted_out' }, now)).toBe('not_invited');
    expect(welcomeResendSkip({ ...quiet, consents: 1 }, now)).toBe('consent_answered');
    expect(welcomeResendSkip({ ...quiet, linkOpened: true }, now)).toBe('link_opened');
    expect(welcomeResendSkip({ ...quiet, phoneOptedOut: true }, now)).toBe('phone_opted_out');
    expect(welcomeResendSkip({ ...quiet, invitedAt: '2026-10-13T20:00:00Z' }, now)).toBe(
      'recent_welcome',
    );
  });
});
