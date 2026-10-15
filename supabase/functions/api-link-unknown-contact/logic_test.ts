import { assertEquals } from '@std/assert';
import { checkContactLink } from './logic.ts';

const ORG = 'org-a';
const caller = { status: 'pending', channel: 'voice', org_id: ORG };
const texter = { status: 'pending', channel: 'sms', org_id: ORG };
const whatsapp = { status: 'pending', channel: null, org_id: ORG };

Deno.test('a caller or texter is linked with consent pending, new or existing', () => {
  for (const contact of [caller, texter]) {
    for (const existing of [null, { status: 'invited' }, { status: 'active' }]) {
      assertEquals(checkContactLink(contact, ORG, existing), { ok: true, mode: 'consent' });
    }
  }
});

Deno.test('a WhatsApp sender keeps the v1.0 rule: active, an existing reporter activated', () => {
  assertEquals(checkContactLink(whatsapp, ORG, null), {
    ok: true,
    mode: 'whatsapp',
    activate: false,
  });
  assertEquals(checkContactLink(whatsapp, ORG, { status: 'invited' }), {
    ok: true,
    mode: 'whatsapp',
    activate: true,
  });
  assertEquals(checkContactLink(whatsapp, ORG, { status: 'active' }), {
    ok: true,
    mode: 'whatsapp',
    activate: false,
  });
});

Deno.test('opted-out and disabled reporters are never linked by the office', () => {
  for (const contact of [caller, texter, whatsapp]) {
    const out = checkContactLink(contact, ORG, { status: 'opted_out' });
    assertEquals(out.ok, false);
    if (!out.ok) assertEquals([out.status, out.reason.includes('STOP')], [409, true]);
    const disabled = checkContactLink(contact, ORG, { status: 'disabled' });
    assertEquals(disabled.ok ? null : disabled.status, 409);
  }
});

Deno.test('a contact no longer pending, of another org or of no org is refused', () => {
  assertEquals(checkContactLink({ ...caller, status: 'linked' }, ORG, null), {
    ok: false,
    status: 409,
    reason: 'This contact was already linked',
  });
  assertEquals(checkContactLink(caller, 'org-b', null), {
    ok: false,
    status: 404,
    reason: 'Unknown contact not found',
  });
  const orphan = checkContactLink({ ...texter, org_id: null }, ORG, null);
  assertEquals(orphan.ok ? null : orphan.status, 409);
});
