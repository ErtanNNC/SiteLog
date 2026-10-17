import { assertEquals } from '@std/assert';
import { checkLink } from './logic.ts';

const whatsapp = { status: 'pending', channel: null };

Deno.test('checkLink: a pending WhatsApp sender links; a new reporter is created active', () => {
  assertEquals(checkLink(whatsapp, null), { ok: true, activate: false });
});

Deno.test('checkLink: an existing reporter is activated unless already active', () => {
  assertEquals(checkLink(whatsapp, { status: 'active' }), { ok: true, activate: false });
  assertEquals(checkLink(whatsapp, { status: 'invited' }), { ok: true, activate: true });
  assertEquals(checkLink(whatsapp, { status: 'disabled' }), { ok: true, activate: true });
});

Deno.test('checkLink: a contact that is no longer pending is refused', () => {
  assertEquals(checkLink({ status: 'linked', channel: null }, null), {
    ok: false,
    reason: 'This contact was already linked',
  });
  assertEquals(checkLink({ status: 'ignored', channel: null }, null).ok, false);
});

Deno.test('checkLink: a text or a call is refused, whatever the reporter (consent, W1-16)', () => {
  for (const channel of ['sms', 'voice', 'web']) {
    for (const existing of [null, { status: 'active' }, { status: 'invited' }]) {
      const check = checkLink({ status: 'pending', channel }, existing);
      assertEquals(check.ok, false);
      if (!check.ok) assertEquals(check.reason.includes('api-link-unknown-contact'), true);
    }
  }
});

Deno.test('checkLink: a reporter who opted out is never reactivated by the office', () => {
  assertEquals(checkLink(whatsapp, { status: 'opted_out' }), {
    ok: false,
    reason: 'This number opted out (STOP). It is linked again only after it texts START',
  });
});
