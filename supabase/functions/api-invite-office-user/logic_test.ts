import { assertEquals } from '@std/assert';
import { adminCount, displayNameFromEmail, inviteMetadata, memberChangeRefusal } from './logic.ts';

Deno.test('the invite carries the UI language, the org’s when left to the company (F24)', () => {
  assertEquals(inviteMetadata('org', 'pm', 'tr-TR', 'en-US'), {
    invited_org_id: 'org',
    invited_role: 'pm',
    ui_locale: 'tr-TR',
  });
  assertEquals(inviteMetadata('org', 'ops', null, 'tr-TR').ui_locale, 'tr-TR');
});

const members = [
  { user_id: 'a1', role: 'admin' as const },
  { user_id: 'p1', role: 'pm' as const },
  { user_id: 'o1', role: 'ops' as const },
];

Deno.test('the last admin can neither be removed nor demoted', () => {
  assertEquals(adminCount(members), 1);
  assertEquals(
    memberChangeRefusal(members, 'a1', null, 'x'),
    'An organisation needs at least one admin; promote someone else first',
  );
  assertEquals(
    memberChangeRefusal(members, 'a1', 'pm', 'x'),
    'An organisation needs at least one admin; promote someone else first',
  );
  const two = [...members, { user_id: 'a2', role: 'admin' as const }];
  assertEquals(memberChangeRefusal(two, 'a1', 'pm', 'a2'), null);
  assertEquals(memberChangeRefusal(two, 'a1', null, 'a2'), null);
});

Deno.test('other refusals: unknown member, self-removal, no-op role change', () => {
  assertEquals(
    memberChangeRefusal(members, 'zz', 'pm', 'a1'),
    'This user is not a member of the organisation',
  );
  assertEquals(memberChangeRefusal(members, 'p1', null, 'p1'), 'You cannot remove yourself');
  assertEquals(memberChangeRefusal(members, 'p1', 'pm', 'a1'), 'The user already has this role');
  assertEquals(memberChangeRefusal(members, 'p1', 'accounts', 'a1'), null);
  assertEquals(memberChangeRefusal(members, 'o1', null, 'a1'), null);
});

Deno.test('displayNameFromEmail', () => {
  assertEquals(displayNameFromEmail('priya.n@kestrel.build'), 'priya.n');
});
