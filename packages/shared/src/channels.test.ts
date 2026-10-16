import { describe, expect, it } from 'vitest';
import {
  CONSENT_FOR_CHANNEL,
  CONSENT_FREE_SMS_KEYS,
  deliverableChannels,
  IMPLEMENTED_MESSAGE_CHANNELS,
  messageChannelOrder,
  pickMessageTransport,
  PRE_CONSENT_SMS_KEYS,
  settingsMessageChannels,
  SMS_DRIVERS,
  SMS_ONLY_KEYS,
  smsRenderOptions,
  smsReplyAllowed,
  smsSendOptionsFor,
  type Notifier,
  type NotifierKey,
  type SmsTransport,
} from './channels.ts';
import {
  isTwoWaySmsKey,
  MESSAGE_KEYS_WITH_LINK,
  renderSms,
  SMS_KEYS,
  TWO_WAY_SMS_KEYS,
} from './copy/sms.ts';
import { SMS_PROVIDERS, toCountryPack, type CountryPack } from './countries.ts';
import type { CountryRow } from './db/types.ts';
import { DEMO_COUNTRIES, demoPack } from './demo/countries.ts';
import { CONSENT_TYPES, MESSAGE_CHANNELS, type ConsentType, type MessageChannel } from './enums.ts';
import { assertE164 } from './format.ts';

const row = (code: 'US' | 'TR') => DEMO_COUNTRIES.find((c) => c.code === code)!;
/** A launch pack with changes (still a valid row: `toCountryPack` parses it). */
const pack = (code: 'US' | 'TR', patch: Partial<CountryRow> = {}): CountryPack =>
  toCountryPack({ ...row(code), ...patch });

const US = demoPack('US');
const TR = demoPack('TR');
/** US with its toll-free sender and TR with its title set in this environment. */
const US_LIVE = pack('US', { sms_sender_id: '+18885550142', voice_number: '+15550142290' });
const TR_LIVE = pack('TR', { sms_sender_id: 'SITELOG' });
/** A pack that forbids links in SMS (it must list WhatsApp or push, D47); two-way like US. */
const NO_LINKS = pack('US', { sms_links_allowed: false, message_channels: ['whatsapp', 'sms'] });
/** A valid pack that lists no SMS for its messages (its SMS sender still exists). */
const NO_SMS = pack('US', { sms_links_allowed: false, message_channels: ['whatsapp'] });

const SMS_CONSENT: ReadonlySet<ConsentType> = new Set(['sms', 'recording']);
const NONE = new Set<never>();
/** The Notifier keys: every key but the two-way replies. */
const NOTIFIER_KEYS = SMS_KEYS.filter((k): k is NotifierKey => !isTwoWaySmsKey(k));

const deliverable = (
  p: CountryPack,
  key: NotifierKey,
  opts: {
    consents?: ReadonlySet<ConsentType>;
    revoked?: ReadonlySet<ConsentType>;
    optedOut?: ReadonlySet<MessageChannel>;
    preferred?: MessageChannel | null;
    narrow?: readonly MessageChannel[];
    implemented?: readonly MessageChannel[];
  } = {},
) =>
  deliverableChannels({
    pack: p,
    key,
    preferred: opts.preferred ?? null,
    consents: opts.consents ?? SMS_CONSENT,
    revoked: opts.revoked ?? NONE,
    optedOut: opts.optedOut ?? NONE,
    ...(opts.narrow ? { narrow: opts.narrow } : {}),
    ...(opts.implemented ? { implemented: opts.implemented } : {}),
  });

describe('message channels (§4.5)', () => {
  it('builds SMS only in week 1; WhatsApp and push have no consent label yet', () => {
    expect([...IMPLEMENTED_MESSAGE_CHANNELS]).toEqual(['sms']);
    expect(Object.keys(CONSENT_FOR_CHANNEL).sort()).toEqual([...MESSAGE_CHANNELS].sort());
    expect(CONSENT_FOR_CHANNEL).toEqual({ sms: 'sms', whatsapp: null, push: null });
    for (const consent of Object.values(CONSENT_FOR_CHANNEL))
      if (consent !== null) expect(CONSENT_TYPES).toContain(consent);
  });

  it('orders by the person first when the pack offers it, then the pack', () => {
    const zz = pack('US', { message_channels: ['whatsapp', 'sms', 'push'] });
    expect(messageChannelOrder(zz, null)).toEqual(['whatsapp', 'sms', 'push']);
    expect(messageChannelOrder(zz, 'sms')).toEqual(['sms', 'whatsapp', 'push']);
    expect(messageChannelOrder(zz, 'push')).toEqual(['push', 'whatsapp', 'sms']);
    expect(messageChannelOrder(zz, 'whatsapp')).toEqual(['whatsapp', 'sms', 'push']);
    // The pack is the allow-list: a preference it does not offer is ignored.
    expect(messageChannelOrder(US, 'whatsapp')).toEqual(['sms']);
    expect(messageChannelOrder(TR, 'push')).toEqual(['sms']);
    expect(messageChannelOrder(US, null)).toEqual(['sms']);
  });
});

describe('deliverableChannels (§4.5)', () => {
  it('sends a reporter with SMS consent by SMS on both launch packs', () => {
    expect(deliverable(US, 'daily_link')).toEqual(['sms']);
    expect(deliverable(TR, 'daily_link')).toEqual(['sms']);
    expect(deliverable(TR, 'filed')).toEqual(['sms']);
  });

  it('needs the SMS consent, except for the welcome before any consent and the device code', () => {
    expect([...PRE_CONSENT_SMS_KEYS]).toEqual(['welcome', 'verify_code']);
    expect([...CONSENT_FREE_SMS_KEYS]).toEqual(['verify_code']);
    for (const key of NOTIFIER_KEYS) {
      const pre = (PRE_CONSENT_SMS_KEYS as readonly string[]).includes(key);
      const free = (CONSENT_FREE_SMS_KEYS as readonly string[]).includes(key);
      // Never asked yet (F3, F4): only the welcome and the device code go out.
      expect(deliverable(US, key, { consents: NONE }), key).toEqual(pre ? ['sms'] : []);
      // Past the consent step without SMS (declined at F4, or a call-only consent): only the
      // device code the person asks for (spec §19 Q25, W2-02).
      expect(deliverable(US, key, { consents: new Set(['auto_call', 'recording']) }), key).toEqual(
        free ? ['sms'] : [],
      );
    }
  });

  it('sends nothing by SMS once the SMS consent is revoked, not even the welcome; the device code still goes', () => {
    for (const key of NOTIFIER_KEYS) {
      const free = (CONSENT_FREE_SMS_KEYS as readonly string[]).includes(key);
      // Revoked in the field app's Settings (§9.3): the office's "Re-send welcome" stays silent.
      expect(deliverable(US, key, { consents: NONE, revoked: new Set(['sms']) }), key).toEqual(
        free ? ['sms'] : [],
      );
      expect(
        deliverable(US, key, { consents: new Set(['recording']), revoked: new Set(['sms']) }),
        key,
      ).toEqual(free ? ['sms'] : []);
      // The opt-out still applies to it.
      expect(
        deliverable(US, key, {
          consents: new Set(['recording']),
          revoked: new Set(['sms']),
          optedOut: new Set(['sms']),
        }),
        key,
      ).toEqual([]);
    }
    // Another revoked consent still means the person has answered the consent step.
    expect(deliverable(US, 'welcome', { consents: NONE, revoked: new Set(['auto_call']) })).toEqual(
      [],
    );
    // Consent given again after a revocation counts.
    expect(deliverable(US, 'daily_link', { revoked: new Set(['auto_call']) })).toEqual(['sms']);
  });

  it('sends nothing on a channel the person opted out of, not even the welcome', () => {
    for (const key of NOTIFIER_KEYS) {
      expect(deliverable(US, key, { optedOut: new Set(['sms']) }), key).toEqual([]);
      expect(deliverable(US, key, { consents: NONE, optedOut: new Set(['sms']) }), key).toEqual([]);
    }
    // Opting out of another channel leaves SMS.
    expect(deliverable(US, 'daily_link', { optedOut: new Set(['whatsapp']) })).toEqual(['sms']);
  });

  it('drops WhatsApp and push: not built, and no consent label even when built', () => {
    const all = new Set(CONSENT_TYPES);
    const wa = pack('US', { message_channels: ['whatsapp', 'push', 'sms'] });
    expect(deliverable(wa, 'filed', { preferred: 'push', consents: all })).toEqual(['sms']);
    expect(
      deliverable(wa, 'filed', {
        preferred: 'whatsapp',
        consents: all,
        implemented: MESSAGE_CHANNELS,
      }),
    ).toEqual(['sms']);
  });

  it('computes the order from the pack: a narrowing never adds a channel the pack lacks', () => {
    // US lists SMS only: a WhatsApp preference or narrowing finds nothing else.
    expect(deliverable(US, 'daily_link', { preferred: 'whatsapp' })).toEqual(['sms']);
    expect(deliverable(US, 'daily_link', { narrow: ['sms'] })).toEqual(['sms']);
    expect(deliverable(US, 'daily_link', { narrow: ['whatsapp'] })).toEqual([]);
    expect(deliverable(US, 'daily_link', { narrow: [] })).toEqual([]);
    // A pack without SMS in its list: no message goes by SMS, even narrowed to SMS.
    for (const key of NOTIFIER_KEYS) {
      if ((SMS_ONLY_KEYS as readonly string[]).includes(key)) continue;
      expect(deliverable(NO_SMS, key), key).toEqual([]);
      expect(deliverable(NO_SMS, key, { narrow: ['sms'] }), key).toEqual([]);
      expect(deliverable(NO_SMS, key, { implemented: MESSAGE_CHANNELS }), key).toEqual([]);
    }
  });

  it('sends the device code by SMS on every pack, even one that lists no SMS (§19 Q25)', () => {
    expect([...SMS_ONLY_KEYS]).toEqual(['verify_code']);
    for (const p of [US, TR, NO_LINKS, NO_SMS]) {
      expect(deliverable(p, 'verify_code'), p.code).toEqual(['sms']);
      expect(deliverable(p, 'verify_code', { preferred: 'whatsapp' }), p.code).toEqual(['sms']);
      expect(deliverable(p, 'verify_code', { consents: NONE }), p.code).toEqual(['sms']);
      expect(deliverable(p, 'verify_code', { optedOut: new Set(['sms']) }), p.code).toEqual([]);
    }
    expect(deliverable(NO_SMS, 'verify_code', { narrow: ['whatsapp'] })).toEqual([]);
  });

  it('keeps link keys off SMS on a pack without links in SMS (§19 Q24)', () => {
    for (const key of MESSAGE_KEYS_WITH_LINK) {
      if (isTwoWaySmsKey(key)) continue;
      expect(deliverable(NO_LINKS, key), key).toEqual([]);
      expect(deliverable(NO_LINKS, key, { consents: NONE }), key).toEqual([]);
    }
    expect(deliverable(NO_LINKS, 'verify_code')).toEqual(['sms']);
    expect(deliverable(NO_LINKS, 'edit_applied')).toEqual(['sms']);
    expect(deliverable(US, 'welcome')).toEqual(['sms']);
  });

  it('refuses the two-way replies: they are not Notifier keys', () => {
    for (const key of TWO_WAY_SMS_KEYS)
      expect(() => deliverable(US, key as never), key).toThrow(
        `SMS "${key}" answers an inbound text: sms-webhook sends it, not the Notifier`,
      );
  });
});

describe('smsReplyAllowed: the two-way replies (§9.5, F13, F15)', () => {
  it('answers HELP, STOP and an unknown sender on a two-way pack only, whatever the driver', () => {
    for (const key of TWO_WAY_SMS_KEYS) {
      expect(smsReplyAllowed(US, key), key).toBe(true);
      expect(smsReplyAllowed(US_LIVE, key), key).toBe(true);
      expect(smsReplyAllowed(TR, key), key).toBe(false);
      expect(smsReplyAllowed(TR_LIVE, key), key).toBe(false);
    }
  });

  it('answers HELP before any consent and confirms STOP after it: no consent or opt-out input', () => {
    // The person who got the pre-consent welcome texts HELP: the US pack answers, TR is one-way.
    expect(smsReplyAllowed(US, 'help')).toBe(true);
    expect(smsReplyAllowed(TR, 'help')).toBe(false);
    // STOP is recorded first (F15: opted_out_at), then the one confirmation goes out.
    expect(smsReplyAllowed(US, 'stop_confirm')).toBe(true);
    // A sender with no reporter row (F13): the Notifier cannot reach them, the webhook can.
    expect(smsReplyAllowed(US, 'unknown_number')).toBe(true);
    // The reply renders in the pack's variant.
    expect(renderSms('stop_confirm', 'en', {}, smsRenderOptions(US))).toBe(
      "You won't get more texts from SiteLog. Reply START to resume.",
    );
  });

  it("follows the pack's links rule: no HELP (it carries a link) where links are forbidden", () => {
    expect(smsReplyAllowed(NO_LINKS, 'help')).toBe(false);
    expect(smsReplyAllowed(NO_LINKS, 'stop_confirm')).toBe(true);
    expect(smsReplyAllowed(NO_LINKS, 'unknown_number')).toBe(true);
    expect(() =>
      renderSms('help', 'en', { company: 'x', link: 'y' }, smsRenderOptions(NO_LINKS)),
    ).toThrow('SMS "help" carries a link and the pack forbids links in SMS');
  });
});

describe('pickMessageTransport (§4.5, §5.2)', () => {
  it('uses console for demo orgs, even with a sender set', () => {
    for (const p of [US, TR, US_LIVE, TR_LIVE])
      expect(pickMessageTransport({ isDemo: true }, p, 'sms'), p.code).toBe('console');
  });

  it('uses console until the pack has a sender id in this environment (week 1)', () => {
    expect(pickMessageTransport({ isDemo: false }, US, 'sms')).toBe('console');
    expect(pickMessageTransport({ isDemo: false }, TR, 'sms')).toBe('console');
  });

  it("then the pack's provider: Twilio by default, İletimerkezi for TR (D48)", () => {
    expect(pickMessageTransport({ isDemo: false }, US_LIVE, 'sms')).toBe('twilio');
    expect(pickMessageTransport({ isDemo: false }, TR_LIVE, 'sms')).toBe('iletimerkezi');
    // An override is a pack value, not code: TR on Twilio is a row change (§19 Q20).
    const trTwilio = pack('TR', { sms_provider: 'twilio', sms_sender_id: 'SITELOG' });
    expect(pickMessageTransport({ isDemo: false }, trTwilio, 'sms')).toBe('twilio');
  });

  it('has no WhatsApp or push transport until week 2 (M6)', () => {
    for (const channel of ['whatsapp', 'push'] as const)
      for (const isDemo of [true, false])
        expect(() => pickMessageTransport({ isDemo }, US_LIVE, channel)).toThrow(
          `Message channel "${channel}" is not built until week 2 (M6)`,
        );
  });

  it('only ever names a driver (every pack provider has one)', () => {
    for (const provider of SMS_PROVIDERS) expect(SMS_DRIVERS).toContain(provider);
    expect([...SMS_DRIVERS]).toEqual(['twilio', 'iletimerkezi', 'console']);
  });
});

describe('the pack decides the SMS variant and sender, never the driver', () => {
  it('renders two-way copy for US and one-way copy for TR, links per pack', () => {
    expect(smsRenderOptions(US)).toEqual({
      hasVoiceNumber: false,
      twoWay: true,
      linksAllowed: true,
    });
    expect(smsRenderOptions(TR)).toEqual({
      hasVoiceNumber: false,
      twoWay: false,
      linksAllowed: true,
    });
    expect(smsRenderOptions(US_LIVE)).toEqual({
      hasVoiceNumber: true,
      twoWay: true,
      linksAllowed: true,
    });
    // A TR voice number brings the "or call" clauses, still one-way.
    expect(smsRenderOptions(pack('TR', { voice_number: '+908501234567' }))).toEqual({
      hasVoiceNumber: true,
      twoWay: false,
      linksAllowed: true,
    });
    expect(smsRenderOptions(NO_LINKS)).toEqual({
      hasVoiceNumber: false,
      twoWay: true,
      linksAllowed: false,
    });
  });

  it("sends from the pack's sender id, none while it is unset", () => {
    expect(smsSendOptionsFor(US)).toEqual({});
    expect(smsSendOptionsFor(TR)).toEqual({});
    expect(smsSendOptionsFor(US_LIVE)).toEqual({ sender: '+18885550142' });
    expect(smsSendOptionsFor(TR_LIVE)).toEqual({ sender: 'SITELOG' });
  });

  it('types a transport and a notifier that fakes can implement', async () => {
    const sent: Array<{ to: string; body: string; sender?: string }> = [];
    const transport: SmsTransport = {
      driver: pickMessageTransport({ isDemo: true }, US, 'sms'),
      async send(to, body, opts) {
        sent.push({ to, body, ...opts });
        return { providerId: `console-${sent.length}` };
      },
    };
    const calls: string[] = [];
    const notifier: Notifier = {
      async send(reporterId, key, _vars, opts) {
        calls.push(`${reporterId}:${key}:${opts?.dedupeKey ?? ''}`);
        return key === 'filed'
          ? { channel: 'sms', messageId: 'm1' }
          : { channel: null, reason: 'no_consent' };
      },
      async call() {},
    };
    expect(transport.driver).toBe('console');
    await expect(
      transport.send(assertE164('+15550143378'), 'hi', smsSendOptionsFor(US_LIVE)),
    ).resolves.toEqual({ providerId: 'console-1' });
    await expect(
      notifier.send(
        'r1',
        'filed',
        { report_no: 'RL-2041-0187', pdf_link: 'x' },
        { dedupeKey: 'notify:filed:rep1' },
      ),
    ).resolves.toEqual({ channel: 'sms', messageId: 'm1' });
    await expect(
      notifier.send('r1', 'reminder_1', { site: 's', link: 'l' }, { channels: ['sms'] }),
    ).resolves.toEqual({ channel: null, reason: 'no_consent' });
    await notifier.call('r1', 'reminder', { siteId: 's1', date: '2026-10-09' });
    const refused = () =>
      // @ts-expect-error the two-way replies are not Notifier keys: sms-webhook sends them
      notifier.send('r1', 'help', { company: 'Kestrel Build Group', link: 'l' });
    expect(typeof refused).toBe('function');
    expect(sent).toEqual([{ to: '+15550143378', body: 'hi', sender: '+18885550142' }]);
    expect(calls).toEqual(['r1:filed:notify:filed:rep1', 'r1:reminder_1:']);
  });
});

describe('settingsMessageChannels (F15, spec §19 Q21)', () => {
  it("offers the pack's built channels in its order", () => {
    expect(settingsMessageChannels({ messageChannels: ['sms'] })).toEqual(['sms']);
    // WhatsApp and push are not built yet: one channel, so Settings shows no choice.
    expect(settingsMessageChannels({ messageChannels: ['whatsapp', 'sms', 'push'] })).toEqual([
      'sms',
    ]);
    expect(
      settingsMessageChannels({ messageChannels: ['whatsapp', 'sms'] }, ['sms', 'whatsapp']),
    ).toEqual(['whatsapp', 'sms']);
  });
});
