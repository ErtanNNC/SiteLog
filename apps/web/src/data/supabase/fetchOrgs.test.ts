import { describe, expect, it } from 'vitest';
import { buildDemirDemo, DEMIR_ORG_NAME, DEMIR_USERS } from '@sitelog/shared/demo/demir.ts';
import { DEMO_USERS, kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { memberDefaultLocale } from '@/i18n/useCopy';
import { fakeOrgsDb } from '@/test/fakeOrgsDb';
import { fetchOrgs } from './SupabaseSource';

function bothDemoOrgs() {
  const kestrel = kestrelDemo();
  const demir = buildDemirDemo();
  const siteOptions = [...kestrel.sites, ...demir.sites].map(({ id, org_id, status }) => ({
    id,
    org_id,
    status,
  }));
  // W1-06 found `orgs.locale` missing from the query: Elif's panel stayed English.
  return fakeOrgsDb({
    orgs: [kestrel.org, demir.org],
    org_members: [...kestrel.members, ...demir.members],
    site_options: siteOptions,
  });
}

/**
 * W1-06a: `country` (the org's country pack) is read too: the setup wizard locks it. W1-08:
 * `is_demo` too, for the Demo phone (§11.1).
 */
describe('fetchOrgs', () => {
  it('reads each org’s locale, so a tr-TR org opens the panel in Turkish (§6.3, §11.2)', async () => {
    const { db, selects } = bothDemoOrgs();
    const elif = DEMIR_USERS[0]!;
    expect(await fetchOrgs(db, elif.id)).toEqual([
      expect.objectContaining({
        name: DEMIR_ORG_NAME,
        timezone: 'Europe/Istanbul',
        role: 'admin',
        activeSites: 2,
        locale: 'tr-TR',
        country: 'TR',
        demoOrg: true,
      }),
    ]);
    expect(selects).toContain(
      'org_members: org_id, role, ui_locale, orgs(id, name, timezone, locale, country, is_demo)',
    );
  });

  it('gives Lena Kestrel Build Group only, in en-US', async () => {
    const { db } = bothDemoOrgs();
    const lena = DEMO_USERS.find((u) => u.email === 'lena@kestrelbuild.example')!;
    const orgs = await fetchOrgs(db, lena.id);
    expect(orgs.map((o) => [o.name, o.activeSites, o.locale, o.country, o.demoOrg])).toEqual([
      ['Kestrel Build Group', 6, 'en-US', 'US', true],
    ]);
  });

  it('reads the member’s own panel language (F24, W4-03): it wins over the org’s locale', async () => {
    const kestrel = kestrelDemo();
    const lena = DEMO_USERS.find((u) => u.email === 'lena@kestrelbuild.example')!;
    const members = kestrel.members.map((m) =>
      m.user_id === lena.id ? { ...m, ui_locale: 'tr-TR' } : m,
    );
    const { db } = fakeOrgsDb({
      orgs: [kestrel.org],
      org_members: members,
      site_options: kestrel.sites.map(({ id, org_id, status }) => ({ id, org_id, status })),
    });
    const [org] = await fetchOrgs(db, lena.id);
    expect([org!.locale, org!.uiLocale]).toEqual(['en-US', 'tr-TR']);
    expect(memberDefaultLocale(org)).toBe('tr-TR');
    const [elif] = await fetchOrgs(bothDemoOrgs().db, DEMIR_USERS[0]!.id);
    expect(elif!.uiLocale).toBeNull();
    expect(memberDefaultLocale(elif)).toBe('tr-TR');
  });
});
