import { assertEquals, assertRejects } from '@std/assert';
import {
  deriveLinkCode,
  linkCodeHash,
  toCountryPack,
  type ConsentType,
  type CountryRow,
  type MemberRole,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { fakeMessaging } from '../_shared/fake_messaging.ts';
import { HttpError } from '../_shared/http.ts';
import {
  pickReporter,
  textDailyLink,
  type TextLinkAudit,
  type TextLinkReporter,
  type TextLinkStore,
} from './app.ts';

/** "Text today's link" (F17, W1-16) on an in-memory store and the fake Notifier. */

const SECRET = 'test-link-signing-secret';
const SITE = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PRIYA = '33333333-3333-4333-8333-333333333333';
const LENA = '44444444-4444-4444-8444-444444444444';
const REQ = '55555555-5555-4555-8555-555555555555';
/** Fri Oct 9 2026, 19:05 in Chicago. */
const NOW = new Date('2026-10-10T00:05:00Z');

function setup(
  opts: {
    role?: MemberRole | null;
    reporters?: TextLinkReporter[];
    siteStatus?: string;
    held?: ConsentType[];
    isDemo?: boolean;
    voice?: string | null;
  } = {},
) {
  const messaging = fakeMessaging();
  const links: Array<{
    id: string;
    code_hash: string;
    reporter_id: string;
    site_id: string;
    report_date: string;
    expires_at: string;
  }> = [];
  const audits: TextLinkAudit[] = [];
  const voice = opts.voice === undefined ? '+15550142290' : opts.voice;
  // The pack's voice number picks the text's variant; the store reads the same pack.
  const country: CountryRow = {
    ...DEMO_COUNTRIES.find((c) => c.code === 'US')!,
    voice_number: voice,
  };
  messaging.recipients.set(PRIYA, {
    reporter: {
      id: PRIYA,
      org_id: ORG,
      phone_e164: '+15550147719',
      locale: 'en-US',
      status: 'active',
      message_channel: null,
    },
    org: { id: ORG, isDemo: opts.isDemo ?? true },
    pack: toCountryPack(country),
    consents: { held: new Set(opts.held ?? ['sms']), revoked: new Set() },
  });
  const store: TextLinkStore = {
    loadSite: (id) =>
      Promise.resolve(
        id === SITE
          ? {
              id: SITE,
              org_id: ORG,
              name: 'Elm St. Townhomes',
              timezone: 'America/Chicago',
              status: opts.siteStatus ?? 'active',
            }
          : null,
      ),
    memberRole: (userId, orgId) =>
      Promise.resolve(
        userId === LENA && orgId === ORG ? (opts.role === undefined ? 'admin' : opts.role) : null,
      ),
    siteReporters: () =>
      Promise.resolve(
        opts.reporters ?? [{ id: PRIYA, name: 'Priya Raman', status: 'active', is_primary: true }],
      ),
    voiceNumber: () => Promise.resolve(voice),
    listDailyLinks: (reporterId, siteId, date) =>
      Promise.resolve(
        links
          .filter(
            (l) => l.reporter_id === reporterId && l.site_id === siteId && l.report_date === date,
          )
          .reverse(),
      ),
    insertDailyLink: (row) => {
      links.push(row);
      return Promise.resolve(true);
    },
    audit: (entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let n = 0;
  const deps = {
    store,
    notifier: messaging.notifier,
    secret: SECRET,
    fieldAppUrl: 'https://field.sitelog.test/',
    now: () => NOW,
    newId: () => `66666666-6666-4666-8666-${String(++n).padStart(12, '0')}`,
  };
  return { deps, messaging, links, audits };
}

Deno.test(
  'texts today’s daily link to the site’s primary reporter, in the site’s day',
  async () => {
    const { deps, messaging, links, audits } = setup();
    const result = await textDailyLink(deps, LENA, { siteId: SITE, requestId: REQ });
    assertEquals(result, {
      sent: true,
      reporterId: PRIYA,
      channel: 'sms',
      reportDate: '2026-10-09',
    });
    assertEquals(links.length, 1);
    const link = links[0]!;
    assertEquals(link.report_date, '2026-10-09');
    assertEquals(link.expires_at, '2026-10-13T00:05:00.000Z');
    const code = await deriveLinkCode(SECRET, link.id);
    assertEquals(link.code_hash, linkCodeHash(code));
    assertEquals(messaging.sent.length, 1);
    assertEquals(
      messaging.sent[0]!.body,
      `Today's report for Elm St. Townhomes: https://field.sitelog.test/r/${code} - or just call +1 555 014 2290.`,
    );
    assertEquals(messaging.rows[0]!.copy_key, 'daily_link');
    assertEquals(
      audits.map((a) => [a.action, a.actorId, a.entityId]),
      [
        ['field_link.created', LENA, PRIYA],
        ['daily_link.texted', LENA, PRIYA],
      ],
    );
    assertEquals(audits[1]!.diff.channel, 'sms');
    assertEquals(audits[1]!.diff.request_id, REQ);
  },
);

Deno.test('a second tap texts the same link again; a retried request texts once', async () => {
  const { deps, messaging, links, audits } = setup({ voice: null });
  await textDailyLink(deps, LENA, { siteId: SITE, requestId: REQ });
  await textDailyLink(deps, LENA, { siteId: SITE, requestId: REQ });
  assertEquals(messaging.sent.length, 1);
  await textDailyLink(deps, LENA, {
    siteId: SITE,
    requestId: '77777777-7777-4777-8777-777777777777',
  });
  assertEquals(messaging.sent.length, 2);
  assertEquals(messaging.sent[0]!.body, messaging.sent[1]!.body);
  assertEquals(messaging.sent[0]!.body.includes('or just call'), false);
  assertEquals(links.length, 1);
  assertEquals(audits.filter((a) => a.action === 'field_link.created').length, 1);
});

Deno.test('admin, pm and ops may text the link; accounts and strangers may not', async () => {
  for (const role of ['admin', 'pm', 'ops'] as const) {
    const { deps } = setup({ role });
    assertEquals((await textDailyLink(deps, LENA, { siteId: SITE, requestId: REQ })).sent, true);
  }
  for (const role of ['accounts', null] as const) {
    const { deps, messaging } = setup({ role });
    const err = await assertRejects(
      () => textDailyLink(deps, LENA, { siteId: SITE, requestId: REQ }),
      HttpError,
    );
    assertEquals(err.status, 403);
    assertEquals(messaging.sent.length, 0);
  }
});

Deno.test('an unknown site is 404; a paused site or one with nobody linked is 409', async () => {
  const unknown = setup();
  const e404 = await assertRejects(
    () =>
      textDailyLink(unknown.deps, LENA, {
        siteId: '88888888-8888-4888-8888-888888888888',
        requestId: REQ,
      }),
    HttpError,
  );
  assertEquals(e404.status, 404);
  for (const opts of [{ siteStatus: 'paused' }, { reporters: [] }]) {
    const { deps, links } = setup(opts);
    const err = await assertRejects(
      () => textDailyLink(deps, LENA, { siteId: SITE, requestId: REQ }),
      HttpError,
    );
    assertEquals(err.status, 409);
    assertEquals(links.length, 0);
  }
});

Deno.test('without SMS consent nothing is sent, and the answer says why', async () => {
  const { deps, messaging, audits } = setup({ held: ['recording'] });
  const result = await textDailyLink(deps, LENA, { siteId: SITE, requestId: REQ });
  assertEquals(result, {
    sent: false,
    reporterId: PRIYA,
    reason: 'no_consent',
    detail: null,
    reportDate: '2026-10-09',
  });
  assertEquals(messaging.sent.length, 0);
  assertEquals(audits.at(-1)!.diff.reason, 'no_consent');
});

Deno.test('pickReporter: the primary reporter, else the first active one', () => {
  const r = (id: string, status: string, is_primary = false) => ({
    id,
    name: id,
    status,
    is_primary,
  });
  assertEquals(pickReporter([r('a', 'active'), r('b', 'invited', true)])?.id, 'b');
  assertEquals(pickReporter([r('a', 'invited'), r('b', 'active')])?.id, 'b');
  assertEquals(pickReporter([r('a', 'disabled')]), null);
  assertEquals(pickReporter([]), null);
});
