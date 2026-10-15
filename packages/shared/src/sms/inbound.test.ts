import { describe, expect, it } from 'vitest';
import type { SmsDriver, SmsTransport } from '../channels.ts';
import { toCountryPack, type CountryPack } from '../countries.ts';
import type { CountryRow } from '../db/types.ts';
import { DEMO_COUNTRIES, demoPack } from '../demo/countries.ts';
import { assertE164, type E164 } from '../format.ts';
import { deriveLinkCode, linkCodeHash, MASKED_CODE } from '../links.ts';
import {
  createNotifier,
  type NotifierAuditEntry,
  type NotifierStore,
  type OutboundMessageRow,
} from '../notify/notifier.ts';
import {
  optOutNotification,
  guessContactOrg,
  processInboundSms,
  type InboundReporterRow,
  type InboundSmsAudit,
  type InboundSmsDeps,
  type InboundSmsNotification,
  type InboundSmsStore,
} from './inbound.ts';
import { SmsSendError } from './transports.ts';

/**
 * `processInboundSms` (W1-08): the plan applied to the rows, the phone opt-out, the office
 * notification, the reply and the handled mark, on an in-memory store. The worker's `sms_inbound`
 * job and sms-webhook's Demo phone route run exactly this.
 */

const pack = (code: 'US' | 'TR', patch: Partial<CountryRow> = {}): CountryPack =>
  toCountryPack({ ...DEMO_COUNTRIES.find((c) => c.code === code)!, ...patch });
const US_LIVE = pack('US', { sms_sender_id: '+18885550142' });
const US_DEMO = demoPack('US');
const TR_LIVE = pack('TR', { sms_sender_id: 'SITELOG' });
const T0 = new Date('2026-10-09T23:00:00Z');
const SECRET = 'link-signing-secret';
const DANA = '00000000-0000-4000-8000-0000000000c2';
const DANA_PHONE = assertE164('+15550145521');
const UNKNOWN = assertE164('+15550194410');

function reporter(patch: Partial<InboundReporterRow> = {}): InboundReporterRow {
  return {
    id: DANA,
    orgId: 'org-real',
    status: 'active',
    contactPref: 'link',
    activatedAt: '2026-03-02T15:40:00Z',
    createdAt: '2026-03-02T15:05:00Z',
    optedOutAt: null,
    name: 'Dana Whitfield',
    phone: DANA_PHONE,
    locale: 'en-US',
    orgName: 'Real Builders',
    orgIsDemo: false,
    ...patch,
  };
}

interface FakeReporter extends InboundReporterRow {
  orgCountry: string;
}

function harness(
  opts: {
    reporters?: FakeReporter[];
    fail?: Error;
    /** A store with `applyChange` (the worker's: one transaction per change). */
    atomic?: boolean;
    /** Orgs that linked an earlier contact of the phone (spec §19 Q44). */
    linked?: string[];
  } = {},
) {
  const reporters = opts.reporters ?? [{ ...reporter(), orgCountry: 'US' }];
  /** Read on each send and each notice, so a test can end an outage between two runs. */
  const faults: { send: Error | null; notifyOnce: Error | null } = {
    send: opts.fail ?? null,
    notifyOnce: null,
  };
  const audits: InboundSmsAudit[] = [];
  const notifications: InboundSmsNotification[] = [];
  const optOuts = new Set<string>();
  const unknown: Array<{
    id: string;
    phone_e164: string;
    message_id: string;
    snippet: string;
    org_id: string | null;
  }> = [];
  const handled: Array<{ messageId: string; at: string }> = [];
  const links: Array<{ id: string; code_hash: string; reporter_id: string }> = [];
  const rows = new Map<string, OutboundMessageRow>();
  const notifierAudit: NotifierAuditEntry[] = [];
  const sent: Array<{ driver: SmsDriver; to: string; body: string }> = [];
  let n = 0;
  const uuid = () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

  const store: InboundSmsStore = {
    reportersByPhone: async (phone, country, scope) =>
      reporters
        .filter(
          (r) =>
            r.phone === phone &&
            r.orgCountry === country &&
            ('realOnly' in scope ? !r.orgIsDemo : r.orgId === scope.orgId),
        )
        .map(({ orgCountry: _c, ...r }) => ({ ...r })),
    updateReporter: async (id, patch) => {
      const r = reporters.find((x) => x.id === id)!;
      if (patch.status) r.status = patch.status;
      if (patch.contact_pref) r.contactPref = patch.contact_pref;
      if ('opted_out_at' in patch) r.optedOutAt = patch.opted_out_at ?? null;
    },
    hasPendingUnknown: async (phone, o) =>
      unknown.some((u) => u.phone_e164 === phone && u.message_id !== o?.excludeMessageId),
    insertUnknownContact: async (row) => {
      const existing = unknown.find((u) => u.message_id === row.message_id);
      if (existing) return { id: existing.id, created: false };
      const id = `uc-${unknown.length + 1}`;
      unknown.push({ id, ...row });
      return { id, created: true };
    },
    linkedContactOrgs: async () => opts.linked ?? [],
    recordPhoneOptOut: async (phone, country) => void optOuts.add(`${phone}:${country}`),
    clearPhoneOptOut: async (phone, country) => void optOuts.delete(`${phone}:${country}`),
    markHandled: async (messageId, at) => void handled.push({ messageId, at }),
    notifyOrg: async (nf) => {
      if (faults.notifyOnce) {
        const err = faults.notifyOnce;
        faults.notifyOnce = null;
        throw err;
      }
      notifications.push(nf);
    },
    audit: async (entry) => void audits.push(entry),
    links: {
      listPersonalLinks: async (reporterId) =>
        links.filter((l) => l.reporter_id === reporterId).reverse(),
      insertPersonalLink: async (row) => {
        if (links.some((l) => l.code_hash === row.code_hash)) return false;
        links.push(row);
        return true;
      },
    },
  };
  if (opts.atomic) {
    // One transaction: the update, the audit row and the notice, or none of them.
    store.applyChange = async (change, entry, notice) => {
      const r = reporters.find((x) => x.id === change.reporterId)!;
      const before = { ...r };
      const audited = audits.length;
      try {
        await store.updateReporter(change.reporterId, change.patch);
        await store.audit(entry);
        if (notice) await store.notifyOrg(notice);
      } catch (err) {
        Object.assign(r, before);
        audits.length = audited;
        throw err;
      }
    };
  }
  const notifierStore: NotifierStore = {
    loadRecipient: async () => null,
    findByDedupeKey: async () => null,
    insertMessage: async (row) => void rows.set(row.id, { ...row }),
    updateMessage: async (id, patch) => void Object.assign(rows.get(id)!, patch),
    isPhoneOptedOut: async () => false,
    recordPhoneOptOut: async () => undefined,
    optOutReporter: async () => undefined,
    audit: async (entry) => void notifierAudit.push(entry),
  };
  const transport = (driver: SmsDriver): SmsTransport => ({
    driver,
    async send(to, body) {
      if (faults.send) throw faults.send;
      sent.push({ driver, to, body });
      return { providerId: `${driver}-${sent.length}` };
    },
  });
  const deps: InboundSmsDeps = {
    store,
    notifier: createNotifier({ store: notifierStore, transport, randomUUID: uuid }),
    linkSecret: () => SECRET,
    fieldAppUrl: () => 'https://go.sitelog.app',
    now: () => T0,
    randomUUID: uuid,
  };
  const run = (
    body: string,
    over: {
      from?: E164;
      pack?: CountryPack;
      scope?: { realOnly: true } | { orgId: string };
      applyPhoneOptOut?: boolean;
      optOutType?: string | null;
      messageId?: string;
    } = {},
  ) =>
    processInboundSms(deps, {
      text: {
        messageId: over.messageId ?? 'm-in-1',
        from: over.from ?? DANA_PHONE,
        body,
        optOutType: over.optOutType ?? null,
      },
      pack: over.pack ?? US_LIVE,
      scope: over.scope ?? { realOnly: true },
      applyPhoneOptOut: over.applyPhoneOptOut ?? true,
    });
  return {
    run,
    faults,
    reporters,
    audits,
    notifications,
    optOuts,
    unknown,
    handled,
    links,
    rows,
    sent,
    notifierAudit,
  };
}

describe('processInboundSms (W1-08)', () => {
  it('STOP: opts the reporter out, records the phone, tells the office, confirms once, marks handled', async () => {
    const h = harness();
    const out = await h.run(' stop. ');
    expect(out.keyword).toBe('stop');
    expect(h.reporters[0]!.status).toBe('opted_out');
    expect(h.reporters[0]!.optedOutAt).toBe(T0.toISOString());
    expect([...h.optOuts]).toEqual([`${DANA_PHONE}:US`]);
    expect(h.audits).toEqual([
      expect.objectContaining({
        orgId: 'org-real',
        actorType: 'reporter',
        actorId: DANA,
        action: 'reporter.opted_out',
        entity: 'reporter',
        entityId: DANA,
        diff: {
          status: 'opted_out',
          opted_out_at: T0.toISOString(),
          method: 'sms_keyword',
          keyword: 'stop',
          message_id: 'm-in-1',
        },
      }),
    ]);
    // §13 "Message undeliverable / opted out": reporter, channel, reason, suggested action.
    expect(h.notifications).toEqual([optOutNotification(reporter())]);
    expect(h.notifications[0]).toMatchObject({
      orgId: 'org-real',
      kind: 'reporter_opted_out',
      title: 'Dana Whitfield opted out of texts (STOP)',
      targetPath: '/team',
    });
    expect(h.notifications[0]!.body).toContain('+1 555 014 5521');
    expect(h.notifications[0]!.body).toContain('Call them');
    expect(h.sent).toEqual([
      {
        driver: 'twilio',
        to: DANA_PHONE,
        body: "You won't get more texts from SiteLog. Reply START to resume.",
      },
    ]);
    expect(out.replyId).toBe('10000000-0000-4000-8000-000000000001');
    expect(h.rows.get(out.replyId!)).toMatchObject({ copy_key: 'stop_confirm', status: 'sent' });
    expect(h.handled).toEqual([{ messageId: 'm-in-1', at: T0.toISOString() }]);
    // Already opted out: a second STOP changes nothing, tells nobody, confirms again.
    const again = await h.run('STOP', { messageId: 'm-in-2' });
    expect(again.changes).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
  });

  it('a Demo phone STOP never records the phone (the org is a demo)', async () => {
    const h = harness({
      reporters: [{ ...reporter({ orgId: 'org-demo', orgIsDemo: true }), orgCountry: 'US' }],
    });
    await h.run('STOP', { pack: US_DEMO, scope: { orgId: 'org-demo' }, applyPhoneOptOut: false });
    expect(h.reporters[0]!.status).toBe('opted_out');
    expect(h.optOuts.size).toBe(0);
    expect(h.notifications).toHaveLength(1);
    expect(h.sent[0]!.driver).toBe('console');
  });

  it('START clears the phone and the rows, silently; CALL and TEXT switch the mode and confirm it', async () => {
    const h = harness();
    await h.run('STOP');
    await h.run('Start', { messageId: 'm-in-2' });
    expect(h.reporters[0]!.status).toBe('active');
    expect(h.reporters[0]!.optedOutAt).toBeNull();
    expect(h.optOuts.size).toBe(0);
    await h.run('CALL', { messageId: 'm-in-3' });
    expect(h.reporters[0]!.contactPref).toBe('call');
    await h.run('text', { messageId: 'm-in-4' });
    expect(h.reporters[0]!.contactPref).toBe('link');
    // Spec §19 Q46: CALL and TEXT are confirmed; START is not (Twilio confirms it, Q45).
    expect(h.sent.map((s) => s.body)).toEqual([
      "You won't get more texts from SiteLog. Reply START to resume.",
      'OK, your daily report is now set to a call. Reply TEXT to switch to a link.',
      'OK, your daily report is now set to a link by text. Reply CALL to switch to a call.',
    ]);
    expect(h.audits.map((a) => a.action)).toEqual([
      'reporter.opted_out',
      'reporter.opted_in',
      'reporter.preferences_changed',
      'reporter.preferences_changed',
    ]);
    expect(h.notifications).toHaveLength(1);
    expect(h.handled.map((x) => x.messageId)).toEqual(['m-in-1', 'm-in-2', 'm-in-3', 'm-in-4']);
  });

  it("HELP: the help text with the reporter's personal link, masked in a real org's row", async () => {
    const h = harness();
    await h.run('HELP');
    const link = h.links[0]!;
    const code = await deriveLinkCode(SECRET, link.id);
    expect(link.code_hash).toBe(linkCodeHash(code));
    expect(h.audits[0]).toMatchObject({
      action: 'field_link.created',
      actorType: 'system',
      diff: { kind: 'personal', via: 'sms_help' },
    });
    expect(h.sent[0]!.body).toBe(
      `SiteLog daily reports for Real Builders. Your link: https://go.sitelog.app/r/${code} - Text CALL or TEXT to switch - STOP to opt out. Msg & data rates may apply.`,
    );
    expect([...h.rows.values()][0]!.body).toContain(`/r/${MASKED_CODE} `);
    // The same link the next time.
    await h.run('help', { messageId: 'm-in-2' });
    expect(h.links).toHaveLength(1);
    expect(h.sent[1]!.body).toBe(h.sent[0]!.body);
  });

  it('F13: an unknown number gets the auto-reply and an unknown contact, once; never for STOP', async () => {
    const h = harness();
    const out = await h.run('Hi, this is Carlos from Apex', { from: UNKNOWN });
    expect(out.unknownContact).toBe(true);
    expect(h.unknown).toEqual([
      {
        id: 'uc-1',
        phone_e164: UNKNOWN,
        message_id: 'm-in-1',
        snippet: 'Hi, this is Carlos from Apex',
        org_id: null,
      },
    ]);
    expect(h.audits[0]).toMatchObject({
      orgId: null,
      action: 'unknown_contact.created',
      entity: 'unknown_contact',
      entityId: 'uc-1',
    });
    expect(h.rows.get(out.replyId!)).toMatchObject({ copy_key: 'unknown_number', org_id: null });
    await h.run('hello?', { from: UNKNOWN, messageId: 'm-in-2' });
    expect(h.unknown).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    // A STOP from a number with no reporter sticks to the phone and gets no reply.
    const stop = await h.run('STOP', { from: assertE164('+15550194411'), messageId: 'm-in-3' });
    expect([stop.keyword, stop.replyId, stop.unknownContact]).toEqual(['stop', null, false]);
    expect(h.optOuts.has('+15550194411:US')).toBe(true);
    expect(h.handled).toHaveLength(3);
  });

  it('spec §19 Q44: an unknown number is filed under the one org of its history, else none', async () => {
    // A disabled reporter of one real org: that org.
    const disabled = harness({
      reporters: [
        { ...reporter({ phone: UNKNOWN, status: 'disabled', orgId: 'org-a' }), orgCountry: 'US' },
      ],
    });
    await disabled.run('Hi, back on site', { from: UNKNOWN });
    expect(disabled.unknown[0]!.org_id).toBe('org-a');
    expect(disabled.audits.find((a) => a.action === 'unknown_contact.created')).toMatchObject({
      orgId: 'org-a',
      diff: expect.objectContaining({ org_guessed: true }),
    });
    // An earlier contact that one org linked: that org.
    const linked = harness({ linked: ['org-b'] });
    await linked.run('Hi', { from: UNKNOWN });
    expect(linked.unknown[0]!.org_id).toBe('org-b');
    // Two orgs (a disabled reporter here, a link there): nobody's; support sees it.
    const two = harness({
      linked: ['org-b'],
      reporters: [
        { ...reporter({ phone: UNKNOWN, status: 'disabled', orgId: 'org-a' }), orgCountry: 'US' },
      ],
    });
    await two.run('Hi', { from: UNKNOWN });
    expect(two.unknown[0]!.org_id).toBeNull();
    // A demo org's disabled reporter is out of a real sender's scope.
    const demo = harness({
      reporters: [
        {
          ...reporter({ phone: UNKNOWN, status: 'disabled', orgId: 'org-demo', orgIsDemo: true }),
          orgCountry: 'US',
        },
      ],
    });
    await demo.run('Hi', { from: UNKNOWN });
    expect(demo.unknown[0]!.org_id).toBeNull();
    expect(guessContactOrg(['a', 'a'], ['a'])).toBe('a');
    expect(guessContactOrg([], [])).toBeNull();
  });

  it('the scope keeps a real sender away from demo orgs and the Demo phone inside its org', async () => {
    const h = harness({
      reporters: [
        { ...reporter({ id: 'r-demo', orgId: 'org-demo', orgIsDemo: true }), orgCountry: 'US' },
        { ...reporter(), orgCountry: 'US' },
        {
          ...reporter({ id: 'r-demo-2', orgId: 'org-demo-2', orgIsDemo: true }),
          orgCountry: 'US',
        },
      ],
    });
    await h.run('STOP');
    expect(h.reporters.map((r) => r.status)).toEqual(['active', 'opted_out', 'active']);
    await h.run('STOP', {
      pack: US_DEMO,
      scope: { orgId: 'org-demo' },
      applyPhoneOptOut: false,
      messageId: 'm-in-2',
    });
    expect(h.reporters.map((r) => r.status)).toEqual(['opted_out', 'opted_out', 'active']);
  });

  it('a one-way pack stores the text and runs no keyword', async () => {
    const h = harness({
      reporters: [
        {
          ...reporter({ phone: '+905321234567', locale: 'tr-TR', orgName: 'Demir' }),
          orgCountry: 'TR',
        },
      ],
    });
    const out = await h.run('STOP', { from: assertE164('+905321234567'), pack: TR_LIVE });
    expect(out).toEqual({ keyword: null, replyId: null, changes: [], unknownContact: false });
    expect(h.reporters[0]!.status).toBe('active');
    expect(h.optOuts.size).toBe(0);
    expect(h.handled).toHaveLength(1);
  });

  it('a reply refused for good is recorded and the text still counts as handled; an outage is retried', async () => {
    const refused = harness({
      fail: new SmsSendError('twilio 400 21610', {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        optedOut: true,
        code: '21610',
      }),
    });
    const out = await refused.run('STOP');
    expect(out.replyId).toBeNull();
    expect([...refused.rows.values()][0]!.status).toBe('undeliverable');
    expect(refused.handled).toHaveLength(1);

    const outage = harness({
      fail: new SmsSendError('twilio 503', { driver: 'twilio', retryable: true }),
    });
    await expect(outage.run('HELP')).rejects.toThrow(/503/);
    expect(outage.handled).toEqual([]);
    expect(outage.links).toHaveLength(1);
    // The provider is back: the job's retry finds the same link and sends the help text once.
    outage.faults.send = null;
    const retried = await outage.run('HELP');
    expect(retried.replyId).not.toBeNull();
    expect(outage.links).toHaveLength(1);
    expect(outage.sent).toHaveLength(1);
    expect(outage.handled).toHaveLength(1);
    expect(outage.audits.filter((a) => a.action === 'field_link.created')).toHaveLength(1);
  });

  it('F13: an outage on the auto-reply is retried to the end: one contact, one reply, one mark', async () => {
    const h = harness({
      fail: new SmsSendError('twilio 503', { driver: 'twilio', retryable: true }),
    });
    await expect(h.run('Hi, this is Carlos from Apex', { from: UNKNOWN })).rejects.toThrow(/503/);
    expect(h.unknown).toHaveLength(1);
    h.faults.send = null;
    const out = await h.run('Hi, this is Carlos from Apex', { from: UNKNOWN });
    expect(out.unknownContact).toBe(true);
    expect(h.unknown).toHaveLength(1);
    expect(h.sent.map((x) => x.to)).toEqual([UNKNOWN]);
    expect(h.rows.get(out.replyId!)).toMatchObject({ copy_key: 'unknown_number', status: 'sent' });
    expect(h.audits.filter((a) => a.action === 'unknown_contact.created')).toHaveLength(1);
    expect(h.handled).toHaveLength(1);
    // A later text from the number, while the contact is pending: no second reply.
    await h.run('hello?', { from: UNKNOWN, messageId: 'm-in-2' });
    expect(h.unknown).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('a change, its audit row and its notice go together: a failed notice is retried with all three', async () => {
    const h = harness({ atomic: true });
    h.faults.notifyOnce = new Error('connection lost');
    await expect(h.run('STOP')).rejects.toThrow(/connection lost/);
    // Rolled back: the reporter is as before, with no audit row and no notice.
    expect(h.reporters[0]!.status).toBe('active');
    expect(h.audits).toEqual([]);
    expect(h.notifications).toEqual([]);
    expect(h.handled).toEqual([]);
    await h.run('STOP');
    expect(h.reporters[0]!.status).toBe('opted_out');
    expect(h.audits.map((a) => a.action)).toEqual(['reporter.opted_out']);
    expect(h.notifications).toEqual([optOutNotification(reporter())]);
    expect(h.sent).toHaveLength(1);
    expect(h.handled).toHaveLength(1);
  });

  it("a reply on console for a real org (its pack's sender cleared) is failed, never delivered", async () => {
    const h = harness();
    // The US pack lost its sender between the webhook and the job: the driver is console.
    const out = await h.run('HELP', { pack: pack('US', { sms_sender_id: null }) });
    expect(out.replyId).toBeNull();
    expect(h.sent).toEqual([]);
    const [row] = [...h.rows.values()];
    expect(row).toMatchObject({
      provider: 'console',
      status: 'failed',
      error: 'console: no SMS sender set for pack US',
    });
    expect(h.notifierAudit.map((a) => a.action)).toEqual(['sms.failed']);
    expect(h.handled).toHaveLength(1);
  });
});
