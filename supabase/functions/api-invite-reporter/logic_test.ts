import { assertEquals } from '@std/assert';
import { canResend, linkRows } from './logic.ts';

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
