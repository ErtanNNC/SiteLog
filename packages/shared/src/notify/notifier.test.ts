import { describe, expect, it } from 'vitest';
import type { SmsDriver, SmsTransport } from '../channels.ts';
import { toCountryPack, type CountryPack } from '../countries.ts';
import type { CountryRow } from '../db/types.ts';
import { DEMO_COUNTRIES, demoPack } from '../demo/countries.ts';
import type { ConsentType } from '../enums.ts';
import { assertE164 } from '../format.ts';
import { MASKED_CODE } from '../links.ts';
import { SmsConfigError, SmsSendError } from '../sms/transports.ts';
import {
  consoleRealOrgError,
  createNotifier,
  maskedVars,
  type NotifierAuditEntry,
  type NotifierStore,
  type NotifyRecipient,
  type OutboundMessageRow,
} from './notifier.ts';

const pack = (code: 'US' | 'TR', patch: Partial<CountryRow> = {}): CountryPack =>
  toCountryPack({ ...DEMO_COUNTRIES.find((c) => c.code === code)!, ...patch });
const US = demoPack('US');
const US_LIVE = pack('US', { sms_sender_id: '+18885550142' });
const TR_LIVE = pack('TR', { sms_sender_id: 'SITELOG' });

const WELCOME = {
  first: 'Marco',
  company: 'Kestrel Build Group',
  site: 'Riverside Lofts — Block B',
  deadline: '17:30',
  link: 'https://go.sitelog.app/r/K7Q2MX',
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

function harness(opts: { fail?: Error; noTransport?: Error; optOutFailsOnce?: Error } = {}) {
  let optOutFault = opts.optOutFailsOnce ?? null;
  const rows = new Map<string, OutboundMessageRow>();
  const audit: NotifierAuditEntry[] = [];
  const sent: Array<{
    driver: SmsDriver;
    to: string;
    body: string;
    sender?: string;
    statusCallback?: string;
  }> = [];
  const optOuts: Array<{ phone_e164: string; country: string; method: string }> = [];
  const reporterOptOuts: Array<{ reporterId: string; at: string }> = [];
  const store: NotifierStore = {
    loadRecipient: async (id) => (id === 'r-marco' ? recipient() : null),
    findByDedupeKey: async (reporterId, key) => {
      const row = [...rows.values()].find(
        (r) => r.reporter_id === reporterId && r.payload?.dedupe_key === key,
      );
      return row
        ? {
            id: row.id,
            channel: row.channel,
            status: row.status,
            provider: row.provider,
            error: row.error,
            error_code: row.payload?.error_code ?? null,
          }
        : null;
    },
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
        if (opts.fail) throw opts.fail;
        sent.push({ driver, to, body, sender: o.sender, statusCallback: o.statusCallback });
        return { providerId: `${driver}-${sent.length}` };
      },
    };
  };
  const notifier = createNotifier({
    store,
    transport,
    statusCallbackUrl: 'https://x.supabase.co/functions/v1/sms-webhook/status',
    randomUUID: () => `m-${++n}`,
    now: () => new Date('2026-10-09T23:00:00Z'),
  });
  return { notifier, rows, audit, sent, optOuts, reporterOptOuts };
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
    expect(row.body).toContain('https://go.sitelog.app/r/K7Q2MX');
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

  it('the TR pack goes through İletimerkezi from SITELOG, one-way (no reply clause)', async () => {
    const h = harness();
    await h.notifier.deliver(
      recipient({ isDemo: false, pack: TR_LIVE, locale: 'tr-TR', phone_e164: '+905321234567' }),
      'welcome',
      { ...WELCOME, first: 'Emre', company: 'Demir Yapı A.Ş.', site: 'Ataşehir Ofis Binası' },
    );
    expect(h.sent[0]).toMatchObject({ driver: 'iletimerkezi', sender: 'SITELOG' });
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
    expect(h.sent[0]!.body).toBe('SiteLog code: 482913. It expires in 10 minutes.');
    expect(h.rows.get('m-1')!.body).toBe(`SiteLog code: ${MASKED_CODE}. It expires in 10 minutes.`);
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
    expect(h.rows.get('m-1')!.payload).toEqual({ dedupe_key: 'job:7' });

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
    expect(h.rows.get('m-1')!.payload).toEqual({ dedupe_key: 'job:9', error_code: '21614' });
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
      body: "This number isn't set up with SiteLog. Ask your office to add you.",
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
