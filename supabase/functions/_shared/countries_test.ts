import { assertEquals, assertThrows } from '@std/assert';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { packFromRow, senderKey } from './countries.ts';

const us = DEMO_COUNTRIES.find((c) => c.code === 'US')!;

Deno.test('packFromRow parses a countries row into the pack the Notifier reads', () => {
  const pack = packFromRow({ ...us, sms_sender_id: '+18885550142' }, 'US');
  assertEquals(pack.code, 'US');
  assertEquals(pack.smsProvider, 'twilio');
  assertEquals(pack.smsSenderId, '+18885550142');
  assertEquals(pack.twoWaySms, true);
});

Deno.test('a missing or invalid pack is an error, never a silent console', () => {
  assertThrows(() => packFromRow(null, 'org o'), Error, 'No country pack for org o');
  // An alphanumeric sender with two-way SMS breaks the table's own check.
  assertThrows(() =>
    packFromRow({ ...us, sms_sender_type: 'alphanumeric', sms_sender_id: 'SITELOG' }, 'US'),
  );
});

Deno.test('the receiving sender id is compared as stored (trimmed)', () => {
  assertEquals(senderKey(' +18885550142 '), '+18885550142');
  assertEquals(senderKey('SITELOG'), 'SITELOG');
});
