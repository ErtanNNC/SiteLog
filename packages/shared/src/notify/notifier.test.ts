import { describe, expect, it } from 'vitest';
import type { SmsDriver, SmsTransport } from '../channels.ts';
import { toCountryPack, type CountryPack } from '../countries.ts';
import type { CountryRow } from '../db/types.ts';
import { DEMO_COUNTRIES, demoPack } from '../demo/countries.ts';
import type { ConsentType } from '../enums.ts';
import { assertE164 } from '../format.ts';
import { MASKED_CODE } from '../links.ts';
import { MessageSendError, pushChannelSpec, type OutboundMessage } from '../channels.ts';
import { SmsConfigError, SmsSendError } from '../sms/transports.ts';
import { createWhatsappRegistration } from '../whatsapp/transport.ts';
import {
  consoleRealOrgError,
  createNotifier,
  type ChannelRegistration,
  maskedVars,
  type NotifierAuditEntry,
  type NotifierStore,
  type NotifyRecipient,
  type OutboundMessageRow,
} from './notifier.ts';

/**
 * §19 Q374 (2026-10-23): the launch packs list no SMS (`{push, whatsapp}`; the last tests use them
 * as migrated, `demoPack`). The SMS paths stay built for the forward migration that switches SMS
 * back on, so these tests run on the launch packs with their order before Q374.
 */
const SMS_ORDER: CountryRow['message_channels'] = ['push', 'whatsapp', 'sms'];
const pack = (code: 'US' | 'TR', patch: Partial<CountryRow> = {}): CountryPack =>
  toCountryPack({
    ...DEMO_COUNTRIES.find((c) => c.code === code)!,
    message_channels: SMS_ORDER,
    ...patch,
  });
const US = pack('US');
const US_LIVE = pack('US', { sms_sender_id: '+18885550142' });
const TR_LIVE = pack('TR', {
  sms_provider: 'iletimerkezi',
  sms_sender_type: 'alphanumeric',
  sms_sender_id: 'TALKOLOG',
});

const WELCOME = {
  first: 'Marco',
  company: 'Kestrel Build Group',
  site: 'Riverside Lofts — Block B',
  deadline: '17:30',
  link: 'https://go.talkolog.com/r/K7Q2MX',
};

function recipient(
  over: {
    pack?: CountryPack;
    isDemo?: boolean;
    consents?: ConsentType[];
    revoked?: ConsentType[];
  } & Partial<NotifyRecipient['reporter']> = {},
): NotifyRecipient {
  const { pack: p = US, isDemo = true, consents = [], revoked = [], ...reporter } = over;
  return {
    reporter: {
      id: 'r-marco',
      org_id: 'org-1',
      phone_e164: '+15550143378',
      locale: 'en-US',
      status: 'invited',
      message_channel: null,
      ...reporter,
    },
    org: { id: 'org-1', isDemo },
    pack: p,
    consents: { held: new Set(consents), revoked: new Set(revoked) },
  };
}

/** Per-channel send faults the two-channel tests switch on and off. */
interface Faults {
  sms?: Error | null;
  whatsapp?: Error | null;
}

function harness(
  opts: {
    fail?: Error;
    noTransport?: Error;
    optOutFailsOnce?: Error;
    /** Registers a fake second channel as `whatsapp` (W2-01), consent `data_processing`. */
    second?: boolean;
    faults?: Faults;
    /** Other registrations (W2-14's push). */
    channels?: ChannelRegistration[];
  } = {},
) {
  const faults = opts.faults ?? {};
  let optOutFault = opts.optOutFailsOnce ?? null;
  const rows = new Map<string, OutboundMessageRow>();
  const audit: NotifierAuditEntry[] = [];
  const sent: Array<{
    driver: string;
    to: string;
    body: string;
    sender?: string;
    statusCallback?: string;
  }> = [];
  /** `opts.tries` of every send handed to a transport, failed ones included (W2-15/16 review). */
  const tries: Array<number | undefined> = [];
  const optOuts: Array<{ phone_e164: string; country: string; method: string }> = [];
  const reporterOptOuts: Array<{ reporterId: string; at: string }> = [];
  const store: NotifierStore = {
    loadRecipient: async (id) => (id === 'r-marco' ? recipient() : null),
    listByDedupeKey: async (reporterId, key) =>
      [...rows.values()]
        .filter((r) => r.reporter_id === reporterId && r.payload?.dedupe_key === key)
        .map((row) => ({
          id: row.id,
          channel: row.channel,
          status: row.status,
          provider: row.provider,
          provider_message_id: row.provider_message_id,
          error: row.error,
          error_code: row.payload?.error_code ?? null,
          attempt: row.payload?.attempt ?? null,
          tries: row.payload?.tries ?? null,
        })),
    insertMessage: async (row) => void rows.set(row.id, { ...row }),
    updateMessage: async (id, patch) => void Object.assign(rows.get(id)!, patch),
    isPhoneOptedOut: async (phone, country) =>
      optOuts.some((o) => o.phone_e164 === phone && o.country === country),
    recordPhoneOptOut: async (row) => {
      if (optOutFault) {
        const err = optOutFault;
        optOutFault = null;
        throw err;
      }
      optOuts.push(row);
    },
    optOutReporter: async (reporterId, at) => void reporterOptOuts.push({ reporterId, at }),
    audit: async (entry) => void audit.push(entry),
  };
  let n = 0;
  const transport = (driver: SmsDriver): SmsTransport => {
    if (opts.noTransport) throw opts.noTransport;
    return {
      driver,
      async send(to, body, o) {
        tries.push(o.tries);
        if (opts.fail) throw opts.fail;
        if (faults.sms) throw faults.sms;
        sent.push({ driver, to, body, sender: o.sender, statusCallback: o.statusCallback });
        return { providerId: `${driver}-${sent.length}` };
      },
    };
  };
  let secondSender: string | null | undefined;
  const second: ChannelRegistration = {
    spec: {
      channel: 'whatsapp',
      consent: 'data_processing',
      sender: (p) =>
        secondSender !== undefined ? secondSender : p.smsSenderId === null ? null : 'wa-sender',
      provider: () => 'fakewa',
    },
    transport: (driver) => ({
      channel: 'whatsapp',
      driver,
      async send(message, o) {
        if (faults.whatsapp) throw faults.whatsapp;
        sent.push({ driver, to: message.to, body: message.body, sender: o.sender });
        return { providerId: `${driver}-${sent.length}` };
      },
    }),
  };
  const notifier = createNotifier({
    store,
    transport,
    channels: [...(opts.second ? [second] : []), ...(opts.channels ?? [])],
    statusCallbackUrl: 'https://x.supabase.co/functions/v1/sms-webhook/status',
    randomUUID: () => `m-${++n}`,
    now: () => new Date('2026-10-09T23:00:00Z'),
  });
  const setSecondSender = (v: string | null | undefined) => {
    secondSender = v;
  };
  return {
    notifier,
    rows,
    audit,
    sent,
    tries,
    optOuts,
    reporterOptOuts,
    faults,
    setSecondSender,
  };
}

describe('Notifier (spec §4.5)', () => {
  it('a demo org: console, the whole text in messages (the Demo phone opens the link), delivered', async () => {
    const h = harness();
    const out = await h.notifier.deliver(recipient(), 'welcome', WELCOME);
    expect(out).toEqual({ channel: 'sms', messageId: 'm-1' });
    const row = h.rows.get('m-1')!;
    expect(row).toMatchObject({
      org_id: 'org-1',
      reporter_id: 'r-marco',
      phone_e164: '+15550143378',
      channel: 'sms',
      direction: 'out',
      provider: 'console',
      provider_message_id: 'console-1',
      copy_key: 'welcome',
      status: 'delivered',
      error: null,
    });
    expect(row.body).toContain('https://go.talkolog.com/r/K7Q2MX');
    expect(row.body).toContain('Reply STOP to opt out, HELP for help');
    expect(h.sent[0]!.body).toBe(row.body);
    expect(h.audit).toEqual([
      {
        orgId: 'org-1',
        action: 'sms.sent',
        entity: 'message',
        entityId: 'm-1',
        diff: { copy_key: 'welcome', provider: 'console', channel: 'sms' },
      },
    ]);
  });

  it("a real org with the pack's sender: its provider, the code masked in messages", async () => {
    const h = harness();
    await h.notifier.deliver(recipient({ isDemo: false, pack: US_LIVE }), 'welcome', WELCOME);
    expect(h.sent[0]).toMatchObject({
      driver: 'twilio',
      sender: '+18885550142',
      statusCallback: 'https://x.supabase.co/functions/v1/sms-webhook/status',
    });
    expect(h.sent[0]!.body).toContain('/r/K7Q2MX');
    const row = h.rows.get('m-1')!;
    expect(row).toMatchObject({
      provider: 'twilio',
      provider_message_id: 'twilio-1',
      status: 'sent',
    });
    expect(row.body).toContain(`/r/${MASKED_CODE}`);
    expect(row.body).not.toContain('K7Q2MX');
  });

  it('the TR pack goes through İletimerkezi from TALKOLOG, one-way (no reply clause)', async () => {
    const h = harness();
    await h.notifier.deliver(
      recipient({ isDemo: false, pack: TR_LIVE, locale: 'tr-TR', phone_e164: '+905321234567' }),
      'welcome',
      { ...WELCOME, first: 'Emre', company: 'Demir Yapı A.Ş.', site: 'Ataşehir Ofis Binası' },
    );
    expect(h.sent[0]).toMatchObject({ driver: 'iletimerkezi', sender: 'TALKOLOG' });
    expect(h.sent[0]!.statusCallback).toBeUndefined();
    expect(h.sent[0]!.body).toMatch(/^Merhaba Emre/);
    expect(h.sent[0]!.body).not.toMatch(/STOP/);
  });

  it('a real org whose pack has no sender id here: nothing reaches the phone, a failed masked row, and no device code at all', async () => {
    const h = harness();
    const out = await h.notifier.deliver(recipient({ isDemo: false }), 'welcome', WELCOME, {
      dedupeKey: 'job:1',
    });
    expect(out).toEqual({ channel: null, reason: 'no_channel', detail: 'console_real_org' });
    expect(h.sent).toEqual([]);
    expect(h.rows.get('m-1')).toMatchObject({
      provider: 'console',
      status: 'failed',
      error: consoleRealOrgError('US'),
      payload: { dedupe_key: 'job:1' },
    });
    expect(h.rows.get('m-1')!.body).not.toContain('K7Q2MX');
    expect(h.audit.at(-1)).toMatchObject({
      action: 'notify.skipped',
      entity: 'reporter',
      diff: {
        copy_key: 'welcome',
        reason: 'no_channel',
        detail: 'console_real_org',
        message_id: 'm-1',
      },
    });
    // A re-send under the same key reuses the failed row instead of adding one.
    await h.notifier.deliver(recipient({ isDemo: false }), 'welcome', WELCOME, {
      dedupeKey: 'job:1',
    });
    expect(h.rows.size).toBe(1);
    const code = await h.notifier.deliver(recipient({ isDemo: false }), 'verify_code', {
      code: '482913',
    });
    expect(code).toEqual({ channel: null, reason: 'no_channel', detail: 'console_real_org' });
    expect(h.rows.size).toBe(1);
    expect(h.audit.at(-1)).toMatchObject({
      action: 'notify.skipped',
      diff: { copy_key: 'verify_code', reason: 'no_channel', detail: 'console_real_org' },
    });
  });

  it('a pack with a sender id whose provider has no credentials here fails before any send', async () => {
    const h = harness({ noTransport: new SmsConfigError('twilio', ['TWILIO_AUTH_TOKEN']) });
    await expect(
      h.notifier.deliver(recipient({ isDemo: false, pack: US_LIVE }), 'welcome', WELCOME, {
        dedupeKey: 'job:2',
      }),
    ).rejects.toBeInstanceOf(SmsConfigError);
    // Never a row left `queued`: the Demo phone would show "Sending" for good.
    expect(h.rows.get('m-1')).toMatchObject({
      status: 'failed',
      error: 'SMS driver "twilio" needs TWILIO_AUTH_TOKEN',
      provider_message_id: null,
    });
    expect(h.audit).toEqual([
      expect.objectContaining({
        action: 'sms.failed',
        entityId: 'm-1',
        diff: {
          copy_key: 'welcome',
          provider: 'twilio',
          code: null,
          retryable: false,
          config: true,
        },
      }),
    ]);
  });

  it('a phone that sent STOP on the pack gets nothing, whichever reporter row it is now', async () => {
    const h = harness();
    h.optOuts.push({ phone_e164: '+15550143378', country: 'US', method: 'sms_keyword' });
    // The row is `invited` (a re-invite after the STOP, or another org of the pack).
    expect(
      await h.notifier.deliver(recipient({ isDemo: false, pack: US_LIVE }), 'welcome', WELCOME),
    ).toEqual({
      channel: null,
      reason: 'opted_out',
      detail: 'phone_opted_out',
    });
    expect(h.rows.size).toBe(0);
    expect(h.audit.at(-1)).toMatchObject({
      action: 'notify.skipped',
      diff: { copy_key: 'welcome', reason: 'opted_out', detail: 'phone_opted_out' },
    });
    // Another pack's sender: the opt-out is per pack.
    expect(
      (
        await h.notifier.deliver(
          recipient({ isDemo: false, pack: TR_LIVE, locale: 'tr-TR' }),
          'welcome',
          WELCOME,
        )
      ).channel,
    ).toBe('sms');
  });

  it('masks the device code a real provider sends', async () => {
    const h = harness();
    await h.notifier.deliver(recipient({ isDemo: false, pack: US_LIVE }), 'verify_code', {
      code: '482913',
    });
    expect(h.sent[0]!.body).toBe('TalkOlog code: 482913. It expires in 10 minutes.');
    expect(h.rows.get('m-1')!.body).toBe(
      `TalkOlog code: ${MASKED_CODE}. It expires in 10 minutes.`,
    );
  });

  it('consent, opt-out and disabled decide; nothing is sent and the skip is audited', async () => {
    const h = harness();
    // Before any consent answer, the welcome and the code skip the SMS consent (spec §19 Q25)...
    expect((await h.notifier.deliver(recipient(), 'welcome', WELCOME)).channel).toBe('sms');
    // ...other keys do not.
    expect(await h.notifier.deliver(recipient(), 'draft_ready', { link: WELCOME.link })).toEqual({
      channel: null,
      reason: 'no_consent',
    });
    // After the consent prompt was answered without texts, not even the welcome.
    expect(
      await h.notifier.deliver(
        recipient({ consents: ['recording', 'data_processing'] }),
        'welcome',
        WELCOME,
      ),
    ).toEqual({ channel: null, reason: 'no_consent' });
    expect(
      await h.notifier.deliver(
        recipient({ status: 'opted_out', consents: ['sms'] }),
        'welcome',
        WELCOME,
      ),
    ).toEqual({ channel: null, reason: 'opted_out' });
    expect(
      await h.notifier.deliver(
        recipient({ status: 'disabled', consents: ['sms'] }),
        'welcome',
        WELCOME,
      ),
    ).toEqual({ channel: null, reason: 'no_channel', detail: 'disabled' });
    expect(h.rows.size).toBe(1);
    expect(h.audit.filter((a) => a.action === 'notify.skipped').map((a) => a.diff.reason)).toEqual([
      'no_consent',
      'no_consent',
      'opted_out',
      'no_channel',
    ]);
  });

  it('a dedupe key makes a retry idempotent; a failed send is retried on the same row', async () => {
    const h = harness();
    const first = await h.notifier.deliver(recipient(), 'welcome', WELCOME, { dedupeKey: 'job:7' });
    const again = await h.notifier.deliver(recipient(), 'welcome', WELCOME, { dedupeKey: 'job:7' });
    expect(again).toEqual(first);
    expect(h.sent).toHaveLength(1);
    expect(h.rows.get('m-1')!.payload).toEqual({ dedupe_key: 'job:7', attempt: 1, tries: 1 });

    const failing = harness({
      fail: new SmsSendError('twilio 503: busy', { driver: 'twilio', retryable: true }),
    });
    const r = recipient({ isDemo: false, pack: US_LIVE });
    await expect(
      failing.notifier.deliver(r, 'welcome', WELCOME, { dedupeKey: 'job:8' }),
    ).rejects.toThrow(/busy/);
    expect(failing.rows.get('m-1')).toMatchObject({ status: 'failed', error: 'twilio 503: busy' });
    expect(failing.audit.at(-1)).toMatchObject({
      action: 'sms.failed',
      diff: { copy_key: 'welcome', provider: 'twilio', retryable: true },
    });
  });

  it('an undeliverable number is recorded as such, and a retry under the key is refused again', async () => {
    const h = harness({
      fail: new SmsSendError("twilio 400 21614: 'To' is not a mobile number", {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        code: '21614',
      }),
    });
    const r = recipient({ isDemo: false, pack: US_LIVE });
    await expect(
      h.notifier.deliver(r, 'welcome', WELCOME, { dedupeKey: 'job:9' }),
    ).rejects.toBeInstanceOf(SmsSendError);
    expect(h.rows.get('m-1')!.status).toBe('undeliverable');
    expect(h.audit.at(-1)).toMatchObject({ action: 'sms.undeliverable', diff: { code: '21614' } });
    expect(h.reporterOptOuts).toEqual([]);
    // The job retried after a crash in its own catch block: the same refusal, never a success
    // that would wipe the "Can't reach this number" state.
    const again = await h.notifier.deliver(r, 'welcome', WELCOME, { dedupeKey: 'job:9' }).then(
      () => null as never,
      (e: SmsSendError) => e,
    );
    expect(again).toBeInstanceOf(SmsSendError);
    expect([
      again.undeliverable,
      again.retryable,
      again.optedOut,
      again.opts.code,
      again.message,
      again.opts.driver,
    ]).toEqual([
      true,
      false,
      false,
      '21614',
      "twilio 400 21614: 'To' is not a mobile number",
      'twilio',
    ]);
    expect(h.rows.size).toBe(1);
    expect(h.rows.get('m-1')!.payload).toEqual({
      dedupe_key: 'job:9',
      attempt: 1,
      error_code: '21614',
      tries: 1,
    });
  });

  it("a number on the provider's own opt-out list (Twilio 21610) opts the phone and the reporter out", async () => {
    const h = harness({
      fail: new SmsSendError('twilio 400 21610: Attempt to send to unsubscribed recipient', {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        optedOut: true,
        code: '21610',
      }),
    });
    const err = await h.notifier
      .deliver(recipient({ isDemo: false, pack: US_LIVE }), 'welcome', WELCOME)
      .then(
        () => null as never,
        (e: SmsSendError) => e,
      );
    expect(err.optedOut).toBe(true);
    expect(h.rows.get('m-1')!.status).toBe('undeliverable');
    expect(h.optOuts).toEqual([
      { phone_e164: '+15550143378', country: 'US', method: 'provider_opt_out' },
    ]);
    expect(h.reporterOptOuts).toEqual([{ reporterId: 'r-marco', at: '2026-10-09T23:00:00.000Z' }]);
    expect(h.audit.map((a) => a.action)).toEqual(['sms.undeliverable', 'reporter.opted_out']);
    expect(h.audit[1]).toMatchObject({
      entity: 'reporter',
      entityId: 'r-marco',
      diff: { method: 'provider_opt_out', code: '21610', message_id: 'm-1' },
    });
  });

  it('a 21610 row replayed under its dedupe key is still an opt-out, and writes nothing again', async () => {
    const h = harness({
      fail: new SmsSendError('twilio 400 21610: Attempt to send to unsubscribed recipient', {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        optedOut: true,
        code: '21610',
      }),
      // The refusal is on the row; recording the opt-out then fails (a database blip).
      optOutFailsOnce: new Error('connection lost'),
    });
    const r = recipient({ isDemo: false, pack: US_LIVE });
    const refuse = () =>
      h.notifier.deliver(r, 'welcome', WELCOME, { dedupeKey: 'send_welcome:7' }).then(
        () => null as never,
        (e: Error) => e,
      );
    expect((await refuse()).message).toBe('connection lost');
    expect(h.rows.get('m-1')!).toMatchObject({
      status: 'undeliverable',
      payload: { dedupe_key: 'send_welcome:7', error_code: '21610' },
    });
    // The job's retry replays the row: the code comes back with it, so send_welcome takes its
    // opted-out branch, never "the number may be a landline". Nothing is sent or written again
    // (a START since must not be undone).
    const again = (await refuse()) as SmsSendError;
    expect(again).toBeInstanceOf(SmsSendError);
    expect([again.optedOut, again.undeliverable, again.retryable, again.opts.code]).toEqual([
      true,
      true,
      false,
      '21610',
    ]);
    expect(h.rows.size).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.optOuts).toEqual([]);
    expect(h.audit.map((a) => a.action)).toEqual(['sms.undeliverable']);
  });

  it('send() loads the recipient; call() is M8', async () => {
    const h = harness();
    expect(await h.notifier.send('r-marco', 'welcome', WELCOME)).toEqual({
      channel: 'sms',
      messageId: 'm-1',
    });
    await expect(h.notifier.send('nobody', 'welcome', WELCOME)).rejects.toThrow(/not found/);
    await expect(
      h.notifier.call('r-marco', 'daily_report', { siteId: 's', date: '2026-10-09' }),
    ).rejects.toThrow(/M8/);
  });
});

describe('Notifier replies (sms-webhook)', () => {
  it('answers an unknown number on a two-way pack, with no org', async () => {
    const h = harness();
    const out = await h.notifier.reply({
      pack: US_LIVE,
      org: null,
      reporterId: null,
      phone: assertE164('+15550194410'),
      locale: 'en-US',
      key: 'unknown_number',
      vars: {},
    });
    expect(h.rows.get(out.messageId)).toMatchObject({
      org_id: null,
      reporter_id: null,
      provider: 'twilio',
      copy_key: 'unknown_number',
      body: "This number isn't set up with TalkOlog. Ask your office to add you.",
    });
  });

  it('a demo reporter’s HELP keeps its link; a one-way pack refuses to reply', async () => {
    const h = harness();
    const { messageId } = await h.notifier.reply({
      pack: US,
      org: { id: 'org-1', isDemo: true },
      reporterId: 'r-marco',
      phone: assertE164('+15550143378'),
      locale: 'en-US',
      key: 'help',
      vars: { company: 'Kestrel Build Group', link: WELCOME.link },
    });
    expect(h.rows.get(messageId)!.body).toContain('/r/K7Q2MX');
    await expect(
      h.notifier.reply({
        pack: TR_LIVE,
        org: null,
        reporterId: null,
        phone: assertE164('+905321234567'),
        locale: 'tr-TR',
        key: 'unknown_number',
        vars: {},
      }),
    ).rejects.toThrow(/smsReplyAllowed/);
  });

  it('a reply with a dedupe key is sent once; a failed one goes again on its row (W2-12 review)', async () => {
    const h = harness({
      faults: { sms: new SmsSendError('twilio 503', { driver: 'twilio', retryable: true }) },
    });
    const input = {
      pack: US_LIVE,
      org: { id: 'org-1', isDemo: false },
      reporterId: 'r-marco',
      phone: assertE164('+15550143378'),
      locale: 'en-US',
      key: 'draft_ready' as const,
      vars: { link: WELCOME.link },
      dedupeKey: 'sms_reply:m-in:draft_ready:report-1',
    };
    await expect(h.notifier.reply(input)).rejects.toThrow(/503/);
    expect(h.rows.size).toBe(1);
    h.faults.sms = null;
    const first = await h.notifier.reply(input);
    expect(h.rows.size).toBe(1);
    expect(h.rows.get(first.messageId)).toMatchObject({
      status: 'sent',
      payload: { dedupe_key: input.dedupeKey },
    });
    expect(await h.notifier.reply(input)).toEqual(first);
    expect(h.sent).toHaveLength(1);
  });

  it("a real org's reply on console (its pack has no sender here) is failed and refused for good", async () => {
    const h = harness();
    const err = await h.notifier
      .reply({
        pack: pack('US'),
        org: { id: 'org-real', isDemo: false },
        reporterId: 'r-dana',
        phone: assertE164('+15550145521'),
        locale: 'en-US',
        key: 'stop_confirm',
        vars: {},
      })
      .then(
        () => null as never,
        (e: SmsSendError) => e,
      );
    expect(err).toBeInstanceOf(SmsSendError);
    expect([err.retryable, err.undeliverable, err.opts.driver, err.message]).toEqual([
      false,
      false,
      'console',
      consoleRealOrgError('US'),
    ]);
    expect(h.sent).toEqual([]);
    expect([...h.rows.values()]).toEqual([
      expect.objectContaining({
        org_id: 'org-real',
        reporter_id: 'r-dana',
        provider: 'console',
        copy_key: 'stop_confirm',
        status: 'failed',
        error: consoleRealOrgError('US'),
      }),
    ]);
    expect(h.audit).toEqual([
      expect.objectContaining({
        action: 'sms.failed',
        diff: expect.objectContaining({ provider: 'console', detail: 'console_real_org' }),
      }),
    ]);
  });

  it('masks links and codes only', () => {
    expect(maskedVars({ link: 'https://a/r/ABCDEF', site: 'Pier 9', code: '123456' })).toEqual({
      link: `https://a/r/${MASKED_CODE}`,
      site: 'Pier 9',
      code: MASKED_CODE,
    });
  });
});

describe('Notifier fallback between channels (§19 Q22, W2-01)', () => {
  /** US with its SMS sender here, ordering SMS then the fake second channel. */
  const TWO = pack('US', { sms_sender_id: '+18885550142', message_channels: ['sms', 'whatsapp'] });
  const FILED = {
    report_no: 'RL-2041-0187',
    pdf_link: 'https://go.talkolog.com/r/K7Q2MX/report/1',
  };
  const real = (over: Parameters<typeof recipient>[0] = {}) =>
    recipient({
      isDemo: false,
      pack: TWO,
      status: 'active',
      consents: ['sms', 'data_processing', 'recording'],
      ...over,
    });
  const notMobile = () =>
    new SmsSendError("twilio 400 21614: 'To' is not a mobile number", {
      driver: 'twilio',
      retryable: false,
      undeliverable: true,
      code: '21614',
    });
  const actions = (h: ReturnType<typeof harness>) => h.audit.map((a) => a.action);

  it('a first channel refused for good at send goes out once on the next, every attempt a row', async () => {
    const h = harness({ second: true, faults: { sms: notMobile() } });
    const out = await h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'notify:filed:1' });
    expect(out).toEqual({ channel: 'whatsapp', messageId: 'm-2' });
    expect(h.rows.get('m-1')).toMatchObject({
      channel: 'sms',
      provider: 'twilio',
      status: 'undeliverable',
      payload: { dedupe_key: 'notify:filed:1', attempt: 1, error_code: '21614' },
    });
    expect(h.rows.get('m-2')).toMatchObject({
      channel: 'whatsapp',
      provider: 'fakewa',
      provider_message_id: 'fakewa-1',
      copy_key: 'filed',
      status: 'sent',
      payload: { dedupe_key: 'notify:filed:1', attempt: 2 },
    });
    // The link is masked in the row of a real org, whole in what the channel was asked to send.
    expect(h.rows.get('m-2')!.body).not.toContain('K7Q2MX');
    expect(h.sent).toEqual([
      expect.objectContaining({ driver: 'fakewa', sender: 'wa-sender', to: '+15550143378' }),
    ]);
    expect(h.sent[0]!.body).toContain('K7Q2MX');
    expect(actions(h)).toEqual(['sms.undeliverable', 'notify.attempt_failed', 'whatsapp.sent']);
    expect(h.audit[1]).toEqual({
      orgId: 'org-1',
      action: 'notify.attempt_failed',
      entity: 'message',
      entityId: 'm-1',
      diff: {
        copy_key: 'filed',
        dedupe_key: 'notify:filed:1',
        channel: 'sms',
        attempt: 1,
        reason: 'undeliverable',
        error: "twilio 400 21614: 'To' is not a mobile number",
        code: '21614',
        next_channel: 'whatsapp',
      },
    });
    // A retry of the job: the dedupe hit is the attempt that went out, nothing is sent again.
    h.faults.sms = null;
    expect(
      await h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'notify:filed:1' }),
    ).toEqual(out);
    expect(h.sent).toHaveLength(1);
    expect(h.rows.size).toBe(2);
  });

  it('a retryable error retries the same channel first, on the same row', async () => {
    const h = harness({
      second: true,
      faults: { sms: new SmsSendError('twilio 503: busy', { driver: 'twilio', retryable: true }) },
    });
    const send = () => h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'k:busy' });
    await expect(send()).rejects.toThrow(/busy/);
    expect(h.rows.get('m-1')).toMatchObject({ channel: 'sms', status: 'failed' });
    expect(h.sent).toEqual([]);
    h.faults.sms = null;
    expect(await send()).toEqual({ channel: 'sms', messageId: 'm-1' });
    expect(h.rows.size).toBe(1);
    expect(h.rows.get('m-1')).toMatchObject({ status: 'sent', payload: { attempt: 1 } });
    expect(actions(h)).toEqual(['sms.failed', 'sms.sent']);
  });

  it('counts the sends of a row (payload.tries) and hands the count to the transport (W2-15/16 review)', async () => {
    const h = harness({
      second: true,
      faults: { sms: new SmsSendError('twilio 503: busy', { driver: 'twilio', retryable: true }) },
    });
    const send = () => h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'k:tries' });
    await expect(send()).rejects.toThrow(/busy/);
    expect(h.rows.get('m-1')!.payload).toMatchObject({ attempt: 1, tries: 1 });
    await expect(send()).rejects.toThrow(/busy/);
    expect(h.rows.get('m-1')!.payload).toMatchObject({ attempt: 1, tries: 2 });
    h.faults.sms = null;
    expect(await send()).toEqual({ channel: 'sms', messageId: 'm-1' });
    // One row, three sends: a channel bounding its own retries (push) counts these, not the job's.
    expect(h.tries).toEqual([1, 2, 3]);
    expect(h.rows.size).toBe(1);
    expect(h.rows.get('m-1')).toMatchObject({ status: 'sent', payload: { attempt: 1, tries: 3 } });
  });

  it('a late failed or undeliverable callback: the re-run sends on the next channel, once', async () => {
    for (const late of ['failed', 'undeliverable'] as const) {
      const h = harness({ second: true });
      const send = () => h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'k:late' });
      expect(await send()).toEqual({ channel: 'sms', messageId: 'm-1' });
      // sms-webhook's /status moves the row (never backwards), then the fallback job runs.
      Object.assign(h.rows.get('m-1')!, { status: late, error: 'twilio 30005' });
      expect(await send()).toEqual({ channel: 'whatsapp', messageId: 'm-2' });
      expect(await send()).toEqual({ channel: 'whatsapp', messageId: 'm-2' });
      expect(h.sent.map((x) => x.driver)).toEqual(['twilio', 'fakewa']);
      expect(h.audit.find((a) => a.action === 'notify.attempt_failed')).toMatchObject({
        entityId: 'm-1',
        diff: { reason: late, error: 'twilio 30005', next_channel: 'whatsapp', attempt: 1 },
      });
    }
  });

  it('every channel failed: the last refusal, at send and again on a replay', async () => {
    const waRefusal = new MessageSendError('fakewa: no template for es', 'whatsapp', {
      driver: 'fakewa',
      retryable: false,
      undeliverable: true,
      code: 'T1',
    });
    const h = harness({ second: true, faults: { sms: notMobile(), whatsapp: waRefusal } });
    const send = () =>
      h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'k:all' }).then(
        () => null as never,
        (e: MessageSendError) => e,
      );
    expect(await send()).toBe(waRefusal);
    expect(actions(h)).toEqual([
      'sms.undeliverable',
      'notify.attempt_failed',
      'whatsapp.undeliverable',
    ]);
    const again = await send();
    expect(again).toBeInstanceOf(MessageSendError);
    expect([again.channel, again.undeliverable, again.retryable, again.opts.code]).toEqual([
      'whatsapp',
      true,
      false,
      'T1',
    ]);
    expect(h.rows.size).toBe(2);
    expect(h.sent).toEqual([]);
  });

  it('Twilio 21610 records the SMS opt-out and falls back: STOP stops texts only (§19 Q40)', async () => {
    const h = harness({
      second: true,
      faults: {
        sms: new SmsSendError('twilio 400 21610: unsubscribed', {
          driver: 'twilio',
          retryable: false,
          undeliverable: true,
          optedOut: true,
          code: '21610',
        }),
      },
    });
    const out = await h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'k:stop' });
    expect(out).toEqual({ channel: 'whatsapp', messageId: 'm-2' });
    expect(h.optOuts).toHaveLength(1);
    expect(actions(h)).toEqual([
      'sms.undeliverable',
      'reporter.opted_out',
      'notify.attempt_failed',
      'whatsapp.sent',
    ]);
    // The next message: SMS is out of the order (opted out), the second channel carries it.
    expect(
      await h.notifier.deliver(real({ status: 'opted_out' }), 'filed', FILED, {
        dedupeKey: 'k:next',
      }),
    ).toEqual({ channel: 'whatsapp', messageId: 'm-3' });
    expect(
      await h.notifier.deliver(real({ status: 'opted_out', consents: ['sms'] }), 'filed', FILED),
    ).toEqual({ channel: null, reason: 'opted_out' });
  });

  it('a channel without its consent is never tried; a consent revoked between attempts is passed over', async () => {
    const h = harness({ second: true });
    const waFirst = pack('US', {
      sms_sender_id: '+18885550142',
      message_channels: ['whatsapp', 'sms'],
    });
    expect(
      await h.notifier.deliver(real({ pack: waFirst, consents: ['sms'] }), 'filed', FILED),
    ).toEqual({ channel: 'sms', messageId: 'm-1' });
    expect([...h.rows.values()].map((r) => r.channel)).toEqual(['sms']);

    h.faults.sms = new SmsSendError('twilio 503: busy', { driver: 'twilio', retryable: true });
    await expect(
      h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'k:revoked' }),
    ).rejects.toThrow(/busy/);
    // SMS consent revoked in Settings before the job's retry.
    const out = await h.notifier.deliver(
      real({ consents: ['data_processing', 'recording'], revoked: ['sms'] }),
      'filed',
      FILED,
      { dedupeKey: 'k:revoked' },
    );
    expect(out).toEqual({ channel: 'whatsapp', messageId: 'm-3' });
    expect(h.audit.find((a) => a.action === 'notify.attempt_failed')).toMatchObject({
      entityId: 'm-2',
      diff: { reason: 'no_consent', channel: 'sms', next_channel: 'whatsapp' },
    });
  });

  it('a demo org gets console on every channel; a real org keeps the W1-08 rule (no fallback)', async () => {
    const h = harness({ second: true, faults: { sms: notMobile() } });
    const demo = recipient({
      pack: pack('US', { message_channels: ['whatsapp', 'sms'] }),
      consents: ['sms', 'data_processing'],
    });
    expect(await h.notifier.deliver(demo, 'filed', FILED)).toEqual({
      channel: 'whatsapp',
      messageId: 'm-1',
    });
    expect(h.rows.get('m-1')).toMatchObject({ provider: 'console', status: 'delivered' });
    expect(h.rows.get('m-1')!.body).toContain('K7Q2MX');
    // A real org whose pack has no sender for any channel here: W1-08's skip, on SMS.
    const noSender = recipient({
      isDemo: false,
      pack: pack('US', { message_channels: ['whatsapp', 'sms'] }),
      consents: ['sms', 'data_processing'],
    });
    expect(await h.notifier.deliver(noSender, 'filed', FILED)).toEqual({
      channel: null,
      reason: 'no_channel',
      detail: 'console_real_org',
    });
    expect(h.rows.get('m-2')).toMatchObject({ channel: 'sms', status: 'failed' });
    expect([...h.rows.values()].some((r) => r.channel === 'whatsapp' && !r.org_id)).toBe(false);
  });

  it('§19 Q84 (W2-15): a channel with no sender here leaves a real org’s order; SMS carries it', async () => {
    const h = harness({ second: true });
    // The fake second channel has a sender only when SMS has one; this pack's WhatsApp has none.
    const smsOnly = recipient({
      isDemo: false,
      pack: pack('US', { sms_sender_id: '+18885550142', message_channels: ['whatsapp', 'sms'] }),
      consents: ['sms', 'data_processing'],
    });
    h.setSecondSender(null);
    expect(await h.notifier.deliver(smsOnly, 'filed', FILED, { dedupeKey: 'k1' })).toEqual({
      channel: 'sms',
      messageId: 'm-1',
    });
    expect([...h.rows.values()].map((r) => [r.channel, r.status])).toEqual([['sms', 'sent']]);
    expect(h.audit.some((a) => a.action === 'notify.attempt_failed')).toBe(false);
  });

  it('refuses a channel registered twice and names unregistered ones', () => {
    expect(() =>
      createNotifier({
        store: {} as NotifierStore,
        transport: () => {
          throw new Error('unused');
        },
        channels: [
          {
            spec: { channel: 'sms', consent: 'sms', sender: () => null, provider: () => 'x' },
            transport: () => {
              throw new Error('unused');
            },
          },
        ],
        randomUUID: () => 'x',
      }),
    ).toThrow(/registered twice/);
  });
});

describe('Notifier web push (W2-14, §19 Q27)', () => {
  const FILED = {
    report_no: 'RL-2041-0187',
    pdf_link: 'https://go.talkolog.com/r/K7Q2MX/report/1',
  };
  const real = (over: Parameters<typeof recipient>[0] = {}) =>
    recipient({
      isDemo: false,
      pack: US_LIVE,
      status: 'active',
      consents: ['sms', 'push', 'recording', 'data_processing'],
      ...over,
    });
  function push(opts: { live?: boolean; configured?: boolean; fault?: Error | null } = {}) {
    const pushed: OutboundMessage[] = [];
    const state = { live: opts.live ?? true, fault: opts.fault ?? null };
    const registration: ChannelRegistration = {
      spec: pushChannelSpec(opts.configured ?? true),
      transport: (driver) => ({
        channel: 'push',
        driver,
        async send(message) {
          if (state.fault) throw state.fault;
          pushed.push(message);
          return { providerId: `${driver}-p${pushed.length}` };
        },
      }),
      reachable: async (r) => state.live && (r.org.isDemo || (opts.configured ?? true)),
    };
    return { registration, pushed, state };
  }
  const gone = () =>
    new MessageSendError('push: subscription gone (410)', 'push', {
      driver: 'webpush',
      retryable: false,
      undeliverable: true,
      code: 'gone',
    });

  it('a subscribed reporter gets push first: a row with no phone, the link whole in the payload', async () => {
    const p = push();
    const h = harness({ channels: [p.registration] });
    const out = await h.notifier.deliver(real(), 'filed', FILED, { dedupeKey: 'notify:filed:1' });
    expect(out).toEqual({ channel: 'push', messageId: 'm-1' });
    expect(h.rows.get('m-1')).toMatchObject({
      channel: 'push',
      phone_e164: null,
      provider: 'webpush',
      status: 'sent',
      copy_key: 'filed',
    });
    expect(h.rows.get('m-1')!.body).not.toContain('K7Q2MX');
    expect(p.pushed[0]).toMatchObject({ reporterId: 'r-marco', key: 'filed', language: 'en' });
    expect(p.pushed[0]!.body).toContain('K7Q2MX');
    expect(h.sent).toEqual([]);
  });

  it('a gone subscription falls back to SMS under the same key (§19 Q22)', async () => {
    const p = push({ fault: gone() });
    const h = harness({ channels: [p.registration] });
    const out = await h.notifier.deliver(
      real(),
      'draft_ready',
      { link: 'https://go.talkolog.com/r/K7Q2MX' },
      {
        dedupeKey: 'notify:draft_ready:1',
      },
    );
    expect(out).toEqual({ channel: 'sms', messageId: 'm-2' });
    expect(h.rows.get('m-1')).toMatchObject({ channel: 'push', status: 'undeliverable' });
    expect(h.audit.map((a) => a.action)).toEqual([
      'push.undeliverable',
      'notify.attempt_failed',
      'sms.sent',
    ]);
  });

  it('no live subscription, no consent, a key push does not carry, or no key pair for a real org: SMS', async () => {
    for (const [label, p, r, key] of [
      ['no subscription', push({ live: false }), real(), 'filed'],
      ['no consent', push(), real({ consents: ['sms'] }), 'filed'],
      ['photos_link is not a push key', push(), real(), 'photos_link'],
      ['no VAPID pair here', push({ configured: false }), real(), 'filed'],
    ] as const) {
      const h = harness({ channels: [p.registration] });
      const vars = key === 'filed' ? FILED : { link: 'https://go.talkolog.com/r/K7Q2MX' };
      const out = await h.notifier.deliver(r, key, vars as never);
      expect(out.channel, label).toBe('sms');
      expect(p.pushed, label).toEqual([]);
    }
  });

  it('a demo org gets console push without a key pair; the Demo phone row is whole', async () => {
    const p = push({ configured: false });
    const h = harness({ channels: [p.registration] });
    const out = await h.notifier.deliver(real({ isDemo: true }), 'filed', FILED);
    expect(out.channel).toBe('push');
    expect(h.rows.get('m-1')).toMatchObject({
      provider: 'console',
      status: 'delivered',
      phone_e164: null,
    });
    expect(h.rows.get('m-1')!.body).toContain('K7Q2MX');
  });

  it('an SMS STOP stops texts only: push still goes (§19 Q40, first option)', async () => {
    const p = push();
    const h = harness({ channels: [p.registration] });
    const out = await h.notifier.deliver(real({ status: 'opted_out' }), 'filed', FILED);
    expect(out.channel).toBe('push');
  });
});

describe('Notifier WhatsApp (W2-15; §19 Q25, Q39, Q84)', () => {
  const SID = `HX${'a'.repeat(32)}`;
  const DAILY = { site: 'Riverside Lofts — Block B', link: 'https://go.talkolog.com/r/K7Q2MX' };
  const FILED = {
    report_no: 'RL-2041-0187',
    pdf_link: 'https://go.talkolog.com/r/K7Q2MX/report/1',
  };
  const order = { message_channels: ['push', 'whatsapp', 'sms'] as CountryRow['message_channels'] };

  function wa(reply: { status: number; json: unknown } = { status: 201, json: { sid: 'SMwa1' } }) {
    const forms: URLSearchParams[] = [];
    const registration = createWhatsappRegistration({
      fetch: async (_url, init) => {
        forms.push(new URLSearchParams(String(init.body)));
        return new Response(JSON.stringify(reply.json), { status: reply.status });
      },
      twilio: () => ({ accountSid: 'AC1', authToken: 'tok' }),
      statusCallbackUrl: 'https://x.supabase.co/functions/v1/sms-webhook/status',
      lastInbound: async () => null,
      randomUUID: () => 'wa-uuid',
      now: () => new Date('2026-10-09T23:00:00Z'),
    });
    return { registration, forms };
  }

  it('a demo reporter who opted in gets daily_link on WhatsApp (console, the Demo phone row)', async () => {
    const w = wa();
    const h = harness({ channels: [w.registration] });
    const r = recipient({ pack: pack('US', order), consents: ['sms', 'whatsapp'] });
    expect(await h.notifier.deliver(r, 'daily_link', DAILY, { dedupeKey: 'd1' })).toEqual({
      channel: 'whatsapp',
      messageId: 'm-1',
    });
    expect(h.rows.get('m-1')).toMatchObject({
      channel: 'whatsapp',
      provider: 'console',
      status: 'delivered',
      phone_e164: '+15550143378',
    });
    expect(h.rows.get('m-1')!.body).toContain('K7Q2MX');
    expect(w.forms).toHaveLength(0);
    // Without the opt-in: SMS.
    const noOptIn = recipient({ pack: pack('US', order), consents: ['sms'] });
    expect(
      (await h.notifier.deliver(noOptIn, 'daily_link', DAILY, { dedupeKey: 'd2' })).channel,
    ).toBe('sms');
  });

  it('a real org: the approved template outside the window, recorded with the report id', async () => {
    const w = wa();
    const h = harness({ channels: [w.registration] });
    const live = pack('US', {
      ...order,
      sms_sender_id: '+18885550142',
      whatsapp_sender_id: '+15550142299',
      whatsapp_templates: { daily_link: { en: SID } },
    });
    const r = recipient({ isDemo: false, pack: live, consents: ['sms', 'whatsapp'] });
    const out = await h.notifier.deliver(r, 'daily_link', DAILY, {
      dedupeKey: 'd1',
      reportId: 'rep-1',
    });
    expect(out).toEqual({ channel: 'whatsapp', messageId: 'm-1' });
    expect(h.rows.get('m-1')).toMatchObject({
      provider: 'twilio',
      status: 'sent',
      provider_message_id: 'SMwa1',
      payload: {
        dedupe_key: 'd1',
        attempt: 1,
        report_id: 'rep-1',
        whatsapp_mode: 'template',
        content_sid: SID,
      },
    });
    // The masked text is stored; the template went with its variables.
    expect(h.rows.get('m-1')!.body).not.toContain('K7Q2MX');
    expect(w.forms[0]!.get('ContentSid')).toBe(SID);
    expect(w.forms[0]!.get('StatusCallback')).toContain('/sms-webhook/status');
    expect(h.audit.find((a) => a.action === 'whatsapp.sent')).toMatchObject({
      diff: { copy_key: 'daily_link', provider: 'twilio', channel: 'whatsapp' },
    });
    // A key with no approved template leaves WhatsApp before any attempt: SMS.
    expect((await h.notifier.deliver(r, 'filed', FILED, { dedupeKey: 'f1' })).channel).toBe('sms');
  });

  it('a template Twilio refuses falls back to SMS under the same key, audited', async () => {
    const w = wa({ status: 400, json: { code: 63027, message: 'Template does not exist' } });
    const h = harness({ channels: [w.registration] });
    const live = pack('US', {
      ...order,
      sms_sender_id: '+18885550142',
      whatsapp_sender_id: '+15550142299',
      whatsapp_templates: { daily_link: { en: SID } },
    });
    const r = recipient({ isDemo: false, pack: live, consents: ['sms', 'whatsapp'] });
    expect(await h.notifier.deliver(r, 'daily_link', DAILY, { dedupeKey: 'd1' })).toEqual({
      channel: 'sms',
      messageId: 'm-2',
    });
    expect([...h.rows.values()].map((m) => [m.channel, m.status])).toEqual([
      ['whatsapp', 'undeliverable'],
      ['sms', 'sent'],
    ]);
    expect(h.audit.find((a) => a.action === 'notify.attempt_failed')).toMatchObject({
      diff: { channel: 'whatsapp', next_channel: 'sms', code: '63027' },
    });
  });

  it('§19 Q84: no WhatsApp sender here, a real org’s message goes by SMS with no WhatsApp row', async () => {
    const w = wa();
    const h = harness({ channels: [w.registration] });
    const r = recipient({
      isDemo: false,
      pack: pack('TR', {
        ...order,
        sms_provider: 'iletimerkezi',
        sms_sender_type: 'alphanumeric',
        sms_sender_id: 'TALKOLOG',
      }),
      locale: 'tr-TR',
      consents: ['sms', 'whatsapp'],
    });
    expect((await h.notifier.deliver(r, 'daily_link', DAILY, { dedupeKey: 'd1' })).channel).toBe(
      'sms',
    );
    expect([...h.rows.values()].map((m) => m.channel)).toEqual(['sms']);
  });

  it('WhatsApp opt-out is its consent revoked; an SMS STOP leaves WhatsApp (§19 Q40)', async () => {
    const w = wa();
    const h = harness({ channels: [w.registration] });
    const p = pack('US', order);
    const revoked = recipient({ pack: p, consents: ['sms'], revoked: ['whatsapp'] });
    expect((await h.notifier.deliver(revoked, 'daily_link', DAILY)).channel).toBe('sms');
    const stopped = recipient({ pack: p, status: 'opted_out', consents: ['sms', 'whatsapp'] });
    expect((await h.notifier.deliver(stopped, 'daily_link', DAILY)).channel).toBe('whatsapp');
    // §19 Q372: the welcome goes on WhatsApp with its consent, or before any consent answer;
    // a revoked WhatsApp consent is an answer, and the opt-out of both channels stops it.
    const optedIn = recipient({ pack: p, consents: ['whatsapp'] });
    expect((await h.notifier.deliver(optedIn, 'welcome', WELCOME)).channel).toBe('whatsapp');
    const fresh = recipient({ pack: p });
    expect((await h.notifier.deliver(fresh, 'welcome', WELCOME)).channel).toBe('whatsapp');
    const both = recipient({ pack: p, status: 'opted_out', revoked: ['whatsapp'] });
    expect((await h.notifier.deliver(both, 'welcome', WELCOME)).channel).toBe(null);
  });

  it('§19 Q372: a real org’s welcome goes by its WhatsApp template before any consent, else by SMS', async () => {
    const w = wa();
    const h = harness({ channels: [w.registration] });
    const live = (templates: CountryRow['whatsapp_templates']) =>
      pack('US', {
        ...order,
        sms_sender_id: '+18885550142',
        whatsapp_sender_id: '+15550142299',
        whatsapp_templates: templates,
      });
    const fresh = recipient({ isDemo: false, pack: live({ welcome: { en: SID } }) });
    expect((await h.notifier.deliver(fresh, 'welcome', WELCOME, { dedupeKey: 'w1' })).channel).toBe(
      'whatsapp',
    );
    expect(w.forms[0]!.get('ContentSid')).toBe(SID);
    const vars = JSON.parse(w.forms[0]!.get('ContentVariables')!) as Record<string, string>;
    expect(vars).toEqual({
      '1': 'Marco',
      '2': 'Kestrel Build Group',
      '3': 'Riverside Lofts — Block B',
      '4': '17:30',
      '5': 'https://go.talkolog.com/r/K7Q2MX',
    });
    // The stored text hides the link code, as on SMS.
    expect(h.rows.get('m-1')!.body).not.toContain('K7Q2MX');
    // No approved welcome template in the reporter's language: SMS, nothing tried on WhatsApp.
    const spanish = recipient({
      isDemo: false,
      pack: live({ welcome: { en: SID } }),
      locale: 'es-US',
    });
    expect(
      (await h.notifier.deliver(spanish, 'welcome', WELCOME, { dedupeKey: 'w2' })).channel,
    ).toBe('sms');
    expect(w.forms).toHaveLength(1);
  });

  it('§19 Q372: the device code goes by the authentication template, consent-free, the code unmasked only to Twilio', async () => {
    const w = wa();
    const h = harness({ channels: [w.registration] });
    const live = pack('US', {
      ...order,
      sms_sender_id: '+18885550142',
      whatsapp_sender_id: '+15550142299',
      whatsapp_templates: { verify_code: { en: SID } },
    });
    // Declined WhatsApp at F4 (never given): the code still goes there.
    const r = recipient({ isDemo: false, pack: live, consents: ['sms', 'recording'] });
    expect(await h.notifier.deliver(r, 'verify_code', { code: '042917' })).toEqual({
      channel: 'whatsapp',
      messageId: 'm-1',
    });
    expect(w.forms[0]!.get('ContentSid')).toBe(SID);
    expect(JSON.parse(w.forms[0]!.get('ContentVariables')!)).toEqual({ '1': '042917' });
    expect(h.rows.get('m-1')!.body).not.toContain('042917');
    // WhatsApp's STOP (a revoked consent): the code goes by SMS.
    const stopped = recipient({ isDemo: false, pack: live, revoked: ['whatsapp'] });
    expect((await h.notifier.deliver(stopped, 'verify_code', { code: '042917' })).channel).toBe(
      'sms',
    );
  });

  describe('§19 Q374: no SMS in the launch packs', () => {
    const LIVE_WA = {
      sms_sender_id: '+18885550142',
      whatsapp_sender_id: '+15550142299',
      whatsapp_templates: { welcome: { en: SID }, verify_code: { en: SID } },
    };

    it('a demo org: the welcome and the device code by WhatsApp (console), never by SMS', async () => {
      for (const code of ['US', 'TR'] as const) {
        const w = wa();
        const h = harness({ channels: [w.registration] });
        const r = recipient({ pack: demoPack(code) });
        expect((await h.notifier.deliver(r, 'welcome', WELCOME)).channel, code).toBe('whatsapp');
        expect((await h.notifier.deliver(r, 'verify_code', { code: '042917' })).channel).toBe(
          'whatsapp',
        );
        expect([...h.rows.values()].map((m) => [m.channel, m.provider])).toEqual([
          ['whatsapp', 'console'],
          ['whatsapp', 'console'],
        ]);
        // A reporter who agreed to texts only: nothing goes (no SMS to carry it).
        const textsOnly = recipient({ pack: demoPack(code), consents: ['sms', 'recording'] });
        expect(await h.notifier.deliver(textsOnly, 'daily_link', DAILY)).toEqual({
          channel: null,
          reason: 'no_consent',
        });
        expect(h.sent.every((s) => s.driver === 'console')).toBe(true);
        expect(h.rows.size).toBe(2);
      }
    });

    it('a real org with an SMS sender but no WhatsApp here: no text, W1-08 on WhatsApp (a masked failed row)', async () => {
      const w = wa();
      const h = harness({ channels: [w.registration] });
      const live = toCountryPack({
        ...DEMO_COUNTRIES.find((c) => c.code === 'US')!,
        sms_sender_id: '+18885550142',
      });
      const r = recipient({ isDemo: false, pack: live });
      expect(await h.notifier.deliver(r, 'welcome', WELCOME)).toEqual({
        channel: null,
        reason: 'no_channel',
        detail: 'console_real_org',
      });
      // The row records what would have gone out (the staging Demo phone), the link masked.
      expect([...h.rows.values()]).toEqual([
        expect.objectContaining({
          channel: 'whatsapp',
          provider: 'console',
          status: 'failed',
          copy_key: 'welcome',
          error: consoleRealOrgError('US', 'whatsapp'),
        }),
      ]);
      expect(h.rows.get('m-1')!.body).toContain(`/r/${MASKED_CODE}`);
      expect(consoleRealOrgError('US', 'whatsapp')).toBe(
        'console: no whatsapp sender set for pack US',
      );
      // The device code: no row at all (W1-07: a code nobody receives is of no use).
      expect(await h.notifier.deliver(r, 'verify_code', { code: '042917' })).toEqual({
        channel: null,
        reason: 'no_channel',
        detail: 'console_real_org',
      });
      expect([h.sent, w.forms, h.rows.size]).toEqual([[], [], 1]);
      // A reporter with push on and no key pair here: still the phone channel, never push.
      const pushOn = recipient({ isDemo: false, pack: live, consents: ['whatsapp', 'push'] });
      const out = await h.notifier.deliver(pushOn, 'filed', {
        report_no: 'RL-2041-0187',
        pdf_link: 'https://go.talkolog.com/r/K7Q2MX/report/1',
      });
      expect(out).toMatchObject({ channel: null, detail: 'console_real_org' });
      expect([...h.rows.values()].at(-1)).toMatchObject({ channel: 'whatsapp', copy_key: 'filed' });
    });

    it('a real org with WhatsApp: its templates; no template, a late failure or its STOP leave nothing', async () => {
      const w = wa();
      const h = harness({ channels: [w.registration] });
      const live = toCountryPack({ ...DEMO_COUNTRIES.find((c) => c.code === 'US')!, ...LIVE_WA });
      const r = recipient({ isDemo: false, pack: live });
      expect((await h.notifier.deliver(r, 'welcome', WELCOME, { dedupeKey: 'w1' })).channel).toBe(
        'whatsapp',
      );
      expect(w.forms).toHaveLength(1);
      // A late failure (63003): the walk has nowhere to go; the refusal is thrown again.
      Object.assign(h.rows.get('m-1')!, { status: 'failed', error: 'twilio failed 63003' });
      await expect(
        h.notifier.deliver(r, 'welcome', WELCOME, { dedupeKey: 'w1' }),
      ).rejects.toMatchObject({ channel: 'whatsapp', undeliverable: true });
      // No approved Spanish welcome: WhatsApp cannot carry it, and there is no SMS.
      const spanish = recipient({ isDemo: false, pack: live, locale: 'es-US' });
      expect(await h.notifier.deliver(spanish, 'welcome', WELCOME)).toEqual({
        channel: null,
        reason: 'no_channel',
      });
      // WhatsApp's STOP (its revoked consent): the device code has no SMS to fall back to.
      const stopped = recipient({ isDemo: false, pack: live, revoked: ['whatsapp'] });
      expect(await h.notifier.deliver(stopped, 'verify_code', { code: '042917' })).toEqual({
        channel: null,
        reason: 'no_consent',
      });
      expect(w.forms).toHaveLength(1);
      expect(h.sent).toEqual([]);
    });
  });
});
