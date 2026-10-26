import { assertEquals, assertRejects } from '@std/assert';
import {
  type ConsentType,
  type CountryRow,
  MASKED_CODE,
  MessageSendError,
  type ReporterRow,
  SmsSendError,
  toCountryPack,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { fakeMessaging } from '../_shared/fake_messaging.ts';
import type { VerifyCodeMessage } from './app.ts';
import {
  finalRefusal,
  notifierCodeSender,
  notifierDailyLinkSender,
  recipientOf,
} from './code_sender.ts';

/** `device/send-code` through the Notifier (spec §4.5, §19 Q25; W1-08). */

/**
 * The launch packs with SMS in their order, as before §19 Q374: the SMS paths stay built for the
 * forward migration that switches SMS back on. The last tests use the packs as migrated (no SMS).
 */
const SMS_ORDER: CountryRow['message_channels'] = ['push', 'whatsapp', 'sms'];
const pack = (code: 'US' | 'TR', patch: Partial<CountryRow> = {}) =>
  toCountryPack({
    ...DEMO_COUNTRIES.find((c) => c.code === code)!,
    message_channels: SMS_ORDER,
    ...patch,
  });
/** The pack's order as migrated (§19 Q374, 20261023000100). */
const NO_SMS = { message_channels: ['push', 'whatsapp'] } satisfies Partial<CountryRow>;

function message(
  over: Partial<ReporterRow> = {},
  opts: {
    held?: ConsentType[];
    revoked?: ConsentType[];
    country?: 'US' | 'TR';
    isDemo?: boolean;
    sender?: string;
    /** The pack's row values (WhatsApp sender, templates, order). */
    pack?: Partial<CountryRow>;
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
      units: 'imperial',
    },
    pack: pack(country, { ...(opts.sender ? { sms_sender_id: opts.sender } : {}), ...opts.pack }),
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
      no_calls_until: null,
      whatsapp_user_id: null,
      ...over,
    },
    consents: { held: new Set(opts.held ?? []), revoked: new Set(opts.revoked ?? []) },
    code: '042917',
  };
}

Deno.test(
  'verify_code follows the order kept to SMS and WhatsApp, the preferred channel first (§19 Q372)',
  async () => {
    const m = fakeMessaging();
    const send = notifierCodeSender(m.notifier);
    // The US order puts WhatsApp first (a demo org: console, the Demo phone).
    assertEquals((await send(message())).channel, 'whatsapp');
    assertEquals((await send(message({ message_channel: 'sms' }))).channel, 'sms');
    assertEquals((await send(message({ message_channel: 'whatsapp' }))).channel, 'whatsapp');
    assertEquals(
      m.rows.map((r) => [r.copy_key, r.channel, r.provider, r.status]),
      [
        ['verify_code', 'whatsapp', 'console', 'delivered'],
        ['verify_code', 'sms', 'console', 'delivered'],
        ['verify_code', 'whatsapp', 'console', 'delivered'],
      ],
    );
  },
);

Deno.test(
  'a real org: verify_code by the WhatsApp authentication template, consent-free; SMS without one',
  async () => {
    const SID = `HX${'c'.repeat(32)}`;
    const live = {
      isDemo: false,
      sender: '+18885550142',
      pack: {
        whatsapp_sender_id: '+17752628262',
        whatsapp_templates: { verify_code: { en: SID } },
      },
    };
    // Outside the 24-hour window: the approved template with the code as {{1}}.
    const m = fakeMessaging({ lastInbound: null });
    const send = notifierCodeSender(m.notifier);
    // Declined WhatsApp at F4 (never given): the code still goes there.
    assertEquals(
      (await send(message({}, { ...live, held: ['sms', 'recording'] }))).channel,
      'whatsapp',
    );
    assertEquals(m.waSent.length, 1);
    assertEquals(m.waSent[0]!.get('ContentSid'), SID);
    assertEquals(JSON.parse(m.waSent[0]!.get('ContentVariables')!), { '1': '042917' });
    assertEquals(m.waSent[0]!.get('From'), 'whatsapp:+17752628262');
    assertEquals(m.rows[0]!.body, `TalkOlog code: ${MASKED_CODE}. It expires in 10 minutes.`);
    assertEquals(m.sent, []);
    // WhatsApp's STOP (a revoked WhatsApp consent) stops it there: SMS.
    assertEquals((await send(message({}, { ...live, revoked: ['whatsapp'] }))).channel, 'sms');
    // No approved template in the reporter's language: SMS, nothing tried on WhatsApp.
    assertEquals((await send(message({ locale: 'es-US' }, live))).channel, 'sms');
    assertEquals(m.waSent.length, 1);
    assertEquals(m.sent.length, 2);
  },
);

Deno.test(
  'verify_code is not sent after an opt-out; a refused or revoked consent does not stop it (Q25, W2-02, Q372)',
  async () => {
    const send = notifierCodeSender(fakeMessaging().notifier);
    // SMS STOP stops texts only; the code goes on WhatsApp (US order, demo console).
    assertEquals((await send(message({ status: 'opted_out' }))).channel, 'whatsapp');
    assertEquals(
      await send(
        message(
          { status: 'opted_out', message_channel: 'sms' },
          {
            pack: { message_channels: ['push', 'sms'] },
          },
        ),
      ),
      {
        channel: null,
        reason: 'opted_out',
      },
    );
    // The person asks for the code on the recorder to prove the number: texts turned off in
    // Settings must not lock them out of a new phone.
    assertEquals(
      (await send(message({ message_channel: 'sms' }, { held: ['recording', 'data_processing'] })))
        .channel,
      'sms',
    );
    assertEquals(
      (await send(message({}, { held: ['recording', 'data_processing'] }))).channel,
      'whatsapp',
    );
    assertEquals((await send(message({}, { held: ['recording', 'sms'] }))).channel, 'whatsapp');
    assertEquals((await send(message({}, { revoked: ['sms'] }))).channel, 'whatsapp');
    assertEquals(
      (await send(message({ message_channel: 'sms' }, { revoked: ['sms'] }))).channel,
      'sms',
    );
    // An SMS opt-out leaves WhatsApp (§19 Q40); both opt-outs leave nothing.
    assertEquals(
      (await send(message({ status: 'opted_out' }, { revoked: ['whatsapp'] }))).channel,
      null,
    );
  },
);

Deno.test('the text is the §9.2 verify_code in the reporter language', async () => {
  const m = fakeMessaging();
  const send = notifierCodeSender(m.notifier);
  await send(message({ message_channel: 'sms' }));
  await send(message({ locale: 'tr-TR', message_channel: 'sms' }, { country: 'TR' }));
  assertEquals(
    m.sent.map((s) => s.body),
    [
      'TalkOlog code: 042917. It expires in 10 minutes.',
      'TalkOlog kodunuz: 042917. 10 dakika geçerlidir.',
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
    assertEquals(live.sent[0]!.body, 'TalkOlog code: 042917. It expires in 10 minutes.');
    assertEquals(live.rows[0]!.body, `TalkOlog code: ${MASKED_CODE}. It expires in 10 minutes.`);
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

Deno.test(
  'a WhatsApp refusal final on the last channel is no_channel, never a 500 (W2-15/16 review)',
  async () => {
    const whatsappRefused = new MessageSendError(
      'twilio whatsapp 63016: template refused',
      'whatsapp',
      {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        code: '63016',
      },
    );
    // The Notifier throws the last channel's refusal once no channel is left (the US order ends
    // with WhatsApp).
    const notifier = {
      send: () => Promise.reject(whatsappRefused),
      deliver: () => Promise.reject(whatsappRefused),
    };
    const daily = {
      reporterId: 'r',
      vars: { site: 'Riverside', link: 'https://go.sitelog.test/r/ABCDEF' },
      dedupeKey: 'expired_daily_link:l1:2026-10-09',
    };
    assertEquals(await notifierDailyLinkSender(notifier)(daily), {
      channel: null,
      reason: 'no_channel',
    });
    assertEquals(
      await notifierCodeSender(notifier as unknown as Parameters<typeof notifierCodeSender>[0])(
        message(),
      ),
      { channel: null, reason: 'no_channel' },
    );
    // A retryable refusal on any channel is still thrown (the client may try again).
    const busy = new MessageSendError('twilio whatsapp 503', 'whatsapp', {
      driver: 'twilio',
      retryable: true,
    });
    await assertRejects(() => notifierDailyLinkSender({ send: () => Promise.reject(busy) })(daily));
    assertEquals(finalRefusal(whatsappRefused), true);
    assertEquals(finalRefusal(busy), false);
    assertEquals(finalRefusal(new Error('boom')), false);
  },
);

Deno.test(
  '§19 Q374: no SMS in the pack: the device code by WhatsApp only, never by SMS',
  async () => {
    assertEquals(
      DEMO_COUNTRIES.map((c) => c.message_channels),
      [NO_SMS.message_channels, NO_SMS.message_channels],
    );
    const m = fakeMessaging({ lastInbound: null });
    const send = notifierCodeSender(m.notifier);
    // A demo org: WhatsApp on the console (the Demo phone), an SMS preference ignored.
    assertEquals((await send(message({}, { pack: NO_SMS }))).channel, 'whatsapp');
    assertEquals(
      (await send(message({ message_channel: 'sms' }, { pack: NO_SMS }))).channel,
      'whatsapp',
    );
    // WhatsApp's STOP (its revoked consent): nothing to fall back to.
    assertEquals(await send(message({}, { pack: NO_SMS, revoked: ['whatsapp'] })), {
      channel: null,
      reason: 'no_consent',
    });
    // A real org with an SMS sender but no WhatsApp sender here: nothing, and no row.
    const before = m.rows.length;
    assertEquals(await send(message({}, { pack: NO_SMS, isDemo: false, sender: '+18885550142' })), {
      channel: null,
      reason: 'no_channel',
      detail: 'console_real_org',
    });
    // With a WhatsApp sender but no approved template in the reporter's language: nothing either.
    const SID = `HX${'c'.repeat(32)}`;
    const live = {
      ...NO_SMS,
      whatsapp_sender_id: '+17752628262',
      whatsapp_templates: { verify_code: { en: SID } },
    };
    assertEquals(await send(message({ locale: 'es-US' }, { pack: live, isDemo: false })), {
      channel: null,
      reason: 'no_channel',
    });
    assertEquals(m.rows.length, before);
    assertEquals((await send(message({}, { pack: live, isDemo: false }))).channel, 'whatsapp');
    assertEquals(m.sent, []);
    assertEquals(m.waSent.length, 1);
  },
);
