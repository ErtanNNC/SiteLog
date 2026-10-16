import { assertEquals, assertRejects } from '@std/assert';
import {
  MASKED_CODE,
  SmsSendError,
  toCountryPack,
  type ConsentType,
  type CountryRow,
  type ReporterRow,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { fakeMessaging } from '../_shared/fake_messaging.ts';
import type { VerifyCodeMessage } from './app.ts';
import { notifierCodeSender, notifierDailyLinkSender, recipientOf } from './code_sender.ts';

/** `device/send-code` through the Notifier (spec §4.5, §19 Q25; W1-08). */

const pack = (code: 'US' | 'TR', patch: Partial<CountryRow> = {}) =>
  toCountryPack({ ...DEMO_COUNTRIES.find((c) => c.code === code)!, ...patch });

function message(
  over: Partial<ReporterRow> = {},
  opts: {
    held?: ConsentType[];
    revoked?: ConsentType[];
    country?: 'US' | 'TR';
    isDemo?: boolean;
    sender?: string;
  } = {},
): VerifyCodeMessage {
  const country = opts.country ?? 'US';
  return {
    org: {
      id: 'o',
      name: 'Org',
      country,
      locale: 'en-US',
      timezone: 'America/Chicago',
      is_demo: opts.isDemo ?? true,
    },
    pack: pack(country, opts.sender ? { sms_sender_id: opts.sender } : {}),
    reporter: {
      id: 'r',
      org_id: 'o',
      name: 'Marco Ruiz',
      phone_e164: '+15550143378',
      role: 'site_manager',
      languages: ['en'],
      status: 'invited',
      invited_at: null,
      verified_at: null,
      last_invite_error: null,
      created_at: '2026-10-01T00:00:00Z',
      locale: 'en-US',
      contact_pref: 'link',
      activated_at: null,
      opted_out_at: null,
      message_channel: null,
      ...over,
    },
    consents: { held: new Set(opts.held ?? []), revoked: new Set(opts.revoked ?? []) },
    code: '042917',
  };
}

Deno.test(
  'verify_code goes by SMS before any consent answer, whatever the preferred channel',
  async () => {
    const m = fakeMessaging();
    const send = notifierCodeSender(m.notifier);
    assertEquals((await send(message())).channel, 'sms');
    assertEquals((await send(message({ message_channel: 'whatsapp' }))).channel, 'sms');
    assertEquals(
      m.rows.map((r) => [r.copy_key, r.provider, r.status]),
      [
        ['verify_code', 'console', 'delivered'],
        ['verify_code', 'console', 'delivered'],
      ],
    );
  },
);

Deno.test(
  'verify_code is not sent after an opt-out; a refused or revoked SMS consent does not stop it (Q25, W2-02)',
  async () => {
    const send = notifierCodeSender(fakeMessaging().notifier);
    assertEquals(await send(message({ status: 'opted_out' })), {
      channel: null,
      reason: 'opted_out',
    });
    // The person asks for the code on the recorder to prove the number: texts turned off in
    // Settings must not lock them out of a new phone.
    assertEquals(
      (await send(message({}, { held: ['recording', 'data_processing'] }))).channel,
      'sms',
    );
    assertEquals((await send(message({}, { held: ['recording', 'sms'] }))).channel, 'sms');
    assertEquals((await send(message({}, { revoked: ['sms'] }))).channel, 'sms');
  },
);

Deno.test('the text is the §9.2 verify_code in the reporter language', async () => {
  const m = fakeMessaging();
  const send = notifierCodeSender(m.notifier);
  await send(message());
  await send(message({ locale: 'tr-TR' }, { country: 'TR' }));
  assertEquals(
    m.sent.map((s) => s.body),
    [
      'SiteLog code: 042917. It expires in 10 minutes.',
      'SiteLog kodunuz: 042917. 10 dakika geçerlidir.',
    ],
  );
});

Deno.test(
  'console codes go to demo orgs only; a real provider stores the code masked',
  async () => {
    const real = fakeMessaging();
    assertEquals(await notifierCodeSender(real.notifier)(message({}, { isDemo: false })), {
      channel: null,
      reason: 'no_channel',
      detail: 'console_real_org',
    });
    assertEquals(real.rows, [], 'no messages row an office user could read the code from');

    const live = fakeMessaging();
    const sent = await notifierCodeSender(live.notifier)(
      message({}, { isDemo: false, sender: '+18885550142' }),
    );
    assertEquals(sent.channel, 'sms');
    assertEquals(live.sent[0]!.driver, 'twilio');
    assertEquals(live.sent[0]!.body, 'SiteLog code: 042917. It expires in 10 minutes.');
    assertEquals(live.rows[0]!.body, `SiteLog code: ${MASKED_CODE}. It expires in 10 minutes.`);
  },
);

Deno.test('an unreachable number is no_channel; other send failures are thrown', async () => {
  const undeliverable = fakeMessaging({
    fail: new SmsSendError('twilio 400 21614', {
      driver: 'twilio',
      retryable: false,
      undeliverable: true,
      code: '21614',
    }),
  });
  assertEquals(
    await notifierCodeSender(undeliverable.notifier)(
      message({}, { isDemo: false, sender: '+18885550142' }),
    ),
    { channel: null, reason: 'no_channel' },
  );
  assertEquals(undeliverable.rows[0]!.status, 'undeliverable');
  const outage = fakeMessaging({
    fail: new SmsSendError('twilio 503', { driver: 'twilio', retryable: true }),
  });
  await assertRejects(() =>
    notifierCodeSender(outage.notifier)(message({}, { isDemo: false, sender: '+18885550142' })),
  );
});

Deno.test(
  "F16's daily_link (W2-03): the reporter's order with consent, once per key, unreachable = no_channel",
  async () => {
    const m = fakeMessaging();
    const send = notifierDailyLinkSender(m.notifier);
    const daily = {
      reporterId: 'r',
      vars: { site: 'Riverside', link: 'https://go.sitelog.test/r/ABCDEF' },
      dedupeKey: 'expired_daily_link:l1:2026-10-09',
    };
    // No SMS consent: skipped by the Notifier (it audits the skip).
    m.recipients.set('r', recipientOf(message({ status: 'active' })));
    assertEquals(await send(daily), { channel: null, reason: 'no_consent' });
    m.recipients.set('r', recipientOf(message({ status: 'active' }, { held: ['sms'] })));
    assertEquals((await send(daily)).channel, 'sms');
    assertEquals((await send(daily)).channel, 'sms');
    assertEquals(
      m.sent.filter((x) => x.body.includes('/r/ABCDEF')).length,
      1,
      'one text per dedupe key',
    );
    const failing = fakeMessaging({
      fail: new SmsSendError('twilio 400 21614', {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        code: '21614',
      }),
    });
    failing.recipients.set(
      'r',
      recipientOf(
        message({ status: 'active' }, { held: ['sms'], isDemo: false, sender: '+18885550142' }),
      ),
    );
    assertEquals(await notifierDailyLinkSender(failing.notifier)(daily), {
      channel: null,
      reason: 'no_channel',
    });
  },
);
