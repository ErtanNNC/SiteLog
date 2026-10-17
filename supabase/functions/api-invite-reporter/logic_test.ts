import { assertEquals } from '@std/assert';
import { demoPack } from '@sitelog/shared/demo/countries.ts';
import type { E164 } from '@sitelog/shared';
import { canResend, invitePhone, inviteProfile, lineCheckRefusal, linkRows } from './logic.ts';

Deno.test('canResend: one re-send, 48 h after the first invite, only while still invited', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  assertEquals(canResend({ status: 'invited', invited_at: null }, 0, now), { ok: true });
  assertEquals(canResend({ status: 'invited', invited_at: '2026-10-09T12:00:00Z' }, 0, now), {
    ok: true,
  });
  assertEquals(canResend({ status: 'invited', invited_at: '2026-10-11T12:00:01Z' }, 0, now), {
    ok: false,
    reason: 'A re-send is allowed 48 h after the first invite.',
    retryAt: '2026-10-13T12:00:01.000Z',
  });
  assertEquals(
    canResend({ status: 'invited', invited_at: '2026-10-01T12:00:00Z' }, 1, now).ok,
    false,
  );
  assertEquals(
    canResend({ status: 'active', invited_at: '2026-10-01T12:00:00Z' }, 0, now).ok,
    false,
  );
  assertEquals(canResend({ status: 'disabled', invited_at: null }, 0, now).ok, false);
});

Deno.test('linkRows: primary only where the site has no primary yet, duplicates removed', () => {
  assertEquals(linkRows('r1', ['s1', 's2', 's1'], new Set(['s2'])), [
    { site_id: 's1', reporter_id: 'r1', is_primary: true },
    { site_id: 's2', reporter_id: 'r1', is_primary: false },
  ]);
});

Deno.test('invitePhone: the org country is the default region (spec §4.6)', () => {
  assertEquals(invitePhone('555 014 3378', 'US'), '+15550143378');
  assertEquals(invitePhone('(555) 014-3378', 'US'), '+15550143378');
  assertEquals(invitePhone('0532 123 45 67', 'TR'), '+905321234567');
  // A number with its country code is read as written, whatever the org.
  assertEquals(invitePhone('+90 532 123 45 67', 'US'), '+905321234567');
  assertEquals(invitePhone('+1 555 014 3378', 'TR'), '+15550143378');
  assertEquals(invitePhone('12', 'US'), null);
});

Deno.test(
  'inviteProfile: locale and preference default from the pack; the old contract works',
  () => {
    const us = demoPack('US');
    const tr = demoPack('TR');
    // The panel's request: no locale, no preference, the "Speaks" languages. The first pack
    // locale whose language was ticked wins (the pack's order, not the office's).
    assertEquals(inviteProfile(us, { languages: ['es', 'en'] }), {
      ok: true,
      locale: 'en-US',
      languages: ['es', 'en'],
      contactPref: 'link',
    });
    assertEquals(inviteProfile(us, { languages: ['es'] }), {
      ok: true,
      locale: 'es-US',
      languages: ['es'],
      contactPref: 'link',
    });
    // No field locale for the languages ticked: the pack's default, the languages kept.
    assertEquals(inviteProfile(us, { languages: ['pl'] }), {
      ok: true,
      locale: 'en-US',
      languages: ['pl'],
      contactPref: 'link',
    });
    assertEquals(inviteProfile(tr, { languages: ['es'] }), {
      ok: true,
      locale: 'tr-TR',
      languages: ['es'],
      contactPref: 'link',
    });
    // An explicit locale wins over the languages.
    assertEquals(inviteProfile(us, { locale: 'en-US', languages: ['es'] }), {
      ok: true,
      locale: 'en-US',
      languages: ['es'],
      contactPref: 'link',
    });
    assertEquals(inviteProfile(tr, {}), {
      ok: true,
      locale: 'tr-TR',
      languages: ['tr'],
      contactPref: 'link',
    });
    assertEquals(inviteProfile(us, { locale: 'es-US', contactPref: 'call' }), {
      ok: true,
      locale: 'es-US',
      languages: ['es'],
      contactPref: 'call',
    });
    assertEquals(inviteProfile(tr, { locale: 'es-US' }), {
      ok: false,
      reason: 'Locale es-US is not offered in TR (tr-TR, en-US)',
    });
  },
);

Deno.test('lineCheckRefusal: a landline per §19 Q229 (W4-02)', () => {
  const tr = demoPack('TR'); // no voice number, no outbound trunk
  const landline = '+902122223344' as E164;
  const mobile = '+905321234567' as E164;
  const real = { is_demo: false };
  assertEquals(lineCheckRefusal(mobile, 'link', real, tr), null);
  assertEquals(lineCheckRefusal(landline, 'link', real, tr)?.problem, 'landline_unreachable');
  assertEquals(lineCheckRefusal(landline, 'call', real, tr)?.problem, 'landline_unreachable');
  // With a number to call in, a landline may prefer a call, never a text link.
  const withNumber = { ...tr, voiceNumber: '+908501234567' as E164 };
  assertEquals(lineCheckRefusal(landline, 'call', real, withNumber), null);
  assertEquals(lineCheckRefusal(landline, 'link', real, withNumber)?.problem, 'landline_text');
  // A demo org places its calls on the console telephony.
  assertEquals(lineCheckRefusal(landline, 'call', { is_demo: true }, tr), null);
});
