import {
  deliverableChannels,
  pickMessageTransport,
  smsReplyAllowed,
  smsRenderOptions,
  smsSendOptionsFor,
  type MessageKey,
  type Notifier,
  type NotifierKey,
  type NotifyOutcome,
  type SmsDriver,
  type SmsTransport,
} from '../channels.ts';
import { renderSms, type SmsLocaleFor, type SmsVars, type TwoWaySmsKey } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import type { ConsentType, MessageChannel, MsgStatus, ReporterStatus } from '../enums.ts';
import { assertE164, type E164 } from '../format.ts';
import { MASKED_CODE, maskFieldLinkUrl } from '../links.ts';
import { languageOf } from '../locale.ts';
import { SmsSendError } from '../sms/transports.ts';

/**
 * The Notifier (spec §4.5; W1-08): the one send function for messages to field reporters. It picks
 * the channel (`deliverableChannels`: the person's order from the country pack, consent, opt-out,
 * links), renders the §9.2 text in the reporter's language with the pack's variant, sends it through
 * the pack's driver (`pickMessageTransport`), and writes the `messages` row and the audit row. It
 * never reads env: the store and the drivers are injected, so the worker (Postgres) and the edge
 * functions (supabase-js) run the same code.
 *
 * Rules (spec §4.5, §19 Q24, Q25, docs/AUDIT_BACKLOG.md):
 * - Nothing deliverable → nothing sent, `notify.skipped` audited with the reason.
 * - A disabled reporter gets nothing (`no_channel`).
 * - `console` on a real org (a pack without a sender id here) logs the text but reaches no phone;
 *   `verify_code` is then not written at all (`no_channel`): a code nobody receives is of no use,
 *   and the W1-07 rule keeps it out of the office's reach.
 * - `messages.body` holds the whole text only when `console` writes it for a demo org (the Demo
 *   phone needs working links). Otherwise link codes (`/r/••••••`) and the device code are masked,
 *   so no office user can open a reporter's link or verify a device as the reporter.
 * - `dedupeKey` makes a retry idempotent: a message already sent under the key is not sent again
 *   (`messages.payload.dedupe_key`). Falling back to the next channel waits for spec §19 Q22.
 * - A refused send (`SmsSendError`) marks the row `failed` or `undeliverable`, is audited and is
 *   thrown on, so a job retries what may pass later and records what never will.
 */

export interface NotifyOrg {
  id: string;
  isDemo: boolean;
}

/** Everything the Notifier needs to know about the person it texts. */
export interface NotifyRecipient {
  reporter: {
    id: string;
    org_id: string;
    phone_e164: string;
    /** `reporters.locale` (en-US, es-US, tr-TR): the text's language. */
    locale: string;
    status: ReporterStatus;
    message_channel: MessageChannel | null;
  };
  org: NotifyOrg;
  pack: CountryPack;
  /** Unrevoked consent types, and types given and revoked with none unrevoked since. */
  consents: { held: ReadonlySet<ConsentType>; revoked: ReadonlySet<ConsentType> };
}

/** A `messages` row the Notifier writes (channel 'sms' in week 1). */
export interface OutboundMessageRow {
  id: string;
  org_id: string | null;
  reporter_id: string | null;
  phone_e164: string;
  channel: MessageChannel;
  direction: 'out';
  provider: SmsDriver;
  provider_message_id: string | null;
  copy_key: MessageKey;
  body: string;
  status: MsgStatus;
  error: string | null;
  payload: { dedupe_key: string } | null;
}

export interface NotifierAuditEntry {
  orgId: string | null;
  action: string;
  entity: 'message' | 'reporter';
  entityId: string | null;
  diff: Record<string, unknown>;
}

export interface NotifierStore {
  loadRecipient(reporterId: string): Promise<NotifyRecipient | null>;
  /** The reporter's message written under this dedupe key, if any. */
  findByDedupeKey(
    reporterId: string,
    dedupeKey: string,
  ): Promise<{ id: string; channel: MessageChannel | null; status: MsgStatus } | null>;
  insertMessage(row: OutboundMessageRow): Promise<void>;
  updateMessage(
    id: string,
    patch: { status: MsgStatus; provider_message_id?: string | null; error?: string | null },
  ): Promise<void>;
  audit(entry: NotifierAuditEntry): Promise<void>;
}

export interface NotifierDeps {
  store: NotifierStore;
  /** The driver for a `pickMessageTransport()` answer (`createSmsTransports`). */
  transport: (driver: SmsDriver) => SmsTransport;
  /** sms-webhook's status route, for Twilio delivery callbacks; null = none requested. */
  statusCallbackUrl?: string | null;
  randomUUID: () => string;
}

/** Keys `console` writes only for demo orgs: their whole point is the secret (W1-07 rule). */
export const CONSOLE_DEMO_ONLY_KEYS: readonly MessageKey[] = ['verify_code'];

export interface ReplyInput<K extends TwoWaySmsKey> {
  pack: CountryPack;
  /** The org of the reporter the reply speaks for; null for an unknown number. */
  org: NotifyOrg | null;
  reporterId: string | null;
  phone: E164;
  /** The reporter's locale, or the pack's first field locale for an unknown number. */
  locale: string;
  key: K;
  vars: SmsVars<K>;
}

export interface SmsNotifier extends Notifier {
  /** `send` for a recipient the caller already loaded (field-api's device code). */
  deliver<K extends NotifierKey>(
    recipient: NotifyRecipient,
    key: K,
    vars: SmsVars<K>,
    opts?: { channels?: readonly MessageChannel[]; dedupeKey?: string },
  ): Promise<NotifyOutcome>;
  /** A two-way reply to an inbound text (`help`, `stop_confirm`, `unknown_number`), sms-webhook. */
  reply<K extends TwoWaySmsKey>(input: ReplyInput<K>): Promise<{ messageId: string }>;
}

/**
 * A reporter's consent rows → the types held (unrevoked) and the types given and revoked with no
 * unrevoked row since (`deliverableChannels`).
 */
export function consentSets(
  rows: ReadonlyArray<{ type: ConsentType; revoked_at: string | null }>,
): { held: Set<ConsentType>; revoked: Set<ConsentType> } {
  const held = new Set<ConsentType>();
  const given = new Set<ConsentType>();
  for (const r of rows) {
    given.add(r.type);
    if (r.revoked_at === null) held.add(r.type);
  }
  return { held, revoked: new Set([...given].filter((t) => !held.has(t))) };
}

/** Why nothing went out: the opt-out, a missing consent, or no channel at all. */
export function skipReason(
  recipient: NotifyRecipient,
  key: NotifierKey,
  narrow?: readonly MessageChannel[],
): 'no_channel' | 'no_consent' | 'opted_out' {
  if (recipient.reporter.status === 'disabled') return 'no_channel';
  if (recipient.reporter.status === 'opted_out') return 'opted_out';
  const withConsent = deliverableChannels({
    pack: recipient.pack,
    key,
    preferred: recipient.reporter.message_channel,
    narrow,
    consents: new Set<ConsentType>([...recipient.consents.held, 'sms']),
    revoked: new Set(),
    optedOut: new Set(),
  });
  return withConsent.length > 0 ? 'no_consent' : 'no_channel';
}

/** The variables with link codes and the device code masked (`messages.body` of real orgs). */
export function maskedVars<V extends object>(vars: V): V {
  const out: Record<string, unknown> = { ...(vars as Record<string, unknown>) };
  for (const [name, value] of Object.entries(out)) {
    if (name === 'code' && value !== undefined && value !== null) out[name] = MASKED_CODE;
    else if (typeof value === 'string') out[name] = maskFieldLinkUrl(value);
  }
  return out as V;
}

export function createNotifier(deps: NotifierDeps): SmsNotifier {
  const { store } = deps;

  async function skip(
    recipient: NotifyRecipient,
    key: NotifierKey,
    reason: 'no_channel' | 'no_consent' | 'opted_out',
    detail?: string,
  ): Promise<NotifyOutcome> {
    await store.audit({
      orgId: recipient.reporter.org_id,
      action: 'notify.skipped',
      entity: 'reporter',
      entityId: recipient.reporter.id,
      diff: { copy_key: key, reason, ...(detail ? { detail } : {}) },
    });
    return { channel: null, reason };
  }

  /** Writes the row, sends, records the outcome. Shared by `deliver` and `reply`. */
  async function transmit(input: {
    orgId: string | null;
    reporterId: string | null;
    phone: E164;
    pack: CountryPack;
    driver: SmsDriver;
    key: MessageKey;
    text: string;
    stored: string;
    dedupeKey?: string;
    existingId?: string;
  }): Promise<string> {
    const id = input.existingId ?? deps.randomUUID();
    if (!input.existingId) {
      await store.insertMessage({
        id,
        org_id: input.orgId,
        reporter_id: input.reporterId,
        phone_e164: input.phone,
        channel: 'sms',
        direction: 'out',
        provider: input.driver,
        provider_message_id: null,
        copy_key: input.key,
        body: input.stored,
        status: 'queued',
        error: null,
        payload: input.dedupeKey ? { dedupe_key: input.dedupeKey } : null,
      });
    }
    const transport = deps.transport(input.driver);
    try {
      const { providerId } = await transport.send(input.phone, input.text, {
        ...smsSendOptionsFor(input.pack),
        ...(input.driver === 'twilio' && deps.statusCallbackUrl
          ? { statusCallback: deps.statusCallbackUrl }
          : {}),
      });
      await store.updateMessage(id, {
        status: input.driver === 'console' ? 'delivered' : 'sent',
        provider_message_id: providerId,
        error: null,
      });
      await store.audit({
        orgId: input.orgId,
        action: 'sms.sent',
        entity: 'message',
        entityId: id,
        diff: { copy_key: input.key, provider: input.driver, channel: 'sms' },
      });
      return id;
    } catch (err) {
      const undeliverable = err instanceof SmsSendError && err.undeliverable;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await store.updateMessage(id, {
        status: undeliverable ? 'undeliverable' : 'failed',
        error: message,
      });
      await store.audit({
        orgId: input.orgId,
        action: undeliverable ? 'sms.undeliverable' : 'sms.failed',
        entity: 'message',
        entityId: id,
        diff: {
          copy_key: input.key,
          provider: input.driver,
          code: err instanceof SmsSendError ? (err.opts.code ?? null) : null,
          retryable: err instanceof SmsSendError ? err.retryable : false,
        },
      });
      throw err;
    }
  }

  async function deliver<K extends NotifierKey>(
    recipient: NotifyRecipient,
    key: K,
    vars: SmsVars<K>,
    opts: { channels?: readonly MessageChannel[]; dedupeKey?: string } = {},
  ): Promise<NotifyOutcome> {
    const { reporter, org, pack } = recipient;
    if (reporter.status === 'disabled') return skip(recipient, key, 'no_channel', 'disabled');
    const channels = deliverableChannels({
      pack,
      key,
      preferred: reporter.message_channel,
      narrow: opts.channels,
      consents: recipient.consents.held,
      revoked: recipient.consents.revoked,
      optedOut: new Set<MessageChannel>(reporter.status === 'opted_out' ? ['sms'] : []),
    });
    const channel = channels[0];
    if (!channel) return skip(recipient, key, skipReason(recipient, key, opts.channels));
    const driver = pickMessageTransport({ isDemo: org.isDemo }, pack, channel);
    if (driver === 'console' && !org.isDemo && CONSOLE_DEMO_ONLY_KEYS.includes(key)) {
      return skip(recipient, key, 'no_channel', 'console_real_org');
    }

    let existingId: string | undefined;
    if (opts.dedupeKey) {
      const prior = await store.findByDedupeKey(reporter.id, opts.dedupeKey);
      if (prior && prior.status !== 'queued' && prior.status !== 'failed') {
        return { channel: prior.channel ?? channel, messageId: prior.id };
      }
      // Written but not confirmed (a crash mid-send) or failed: send again on the same row.
      if (prior) existingId = prior.id;
    }

    const locale = languageOf(reporter.locale) as SmsLocaleFor<K>;
    const options = smsRenderOptions(pack);
    const text = renderSms(key, locale, vars, options);
    const stored =
      driver === 'console' && org.isDemo ? text : renderSms(key, locale, maskedVars(vars), options);
    const messageId = await transmit({
      orgId: reporter.org_id,
      reporterId: reporter.id,
      phone: assertE164(reporter.phone_e164),
      pack,
      driver,
      key,
      text,
      stored,
      dedupeKey: opts.dedupeKey,
      existingId,
    });
    return { channel, messageId };
  }

  return {
    deliver,
    async send(reporterId, key, vars, opts) {
      const recipient = await store.loadRecipient(reporterId);
      if (!recipient) throw new Error(`Notifier: reporter ${reporterId} not found`);
      return deliver(recipient, key, vars, opts);
    },
    call() {
      return Promise.reject(new Error('Outbound calls come with M8 (spec §4.5, §7.3)'));
    },
    async reply(input) {
      if (!smsReplyAllowed(input.pack, input.key)) {
        throw new Error(`SMS "${input.key}" is not a reply this pack can send (smsReplyAllowed)`);
      }
      const driver = pickMessageTransport(
        { isDemo: input.org?.isDemo ?? false },
        input.pack,
        'sms',
      );
      const locale = languageOf(input.locale) as SmsLocaleFor<typeof input.key>;
      const options = smsRenderOptions(input.pack);
      const text = renderSms(input.key, locale, input.vars, options);
      const stored =
        driver === 'console' && input.org?.isDemo
          ? text
          : renderSms(input.key, locale, maskedVars(input.vars), options);
      const messageId = await transmit({
        orgId: input.org?.id ?? null,
        reporterId: input.reporterId,
        phone: input.phone,
        pack: input.pack,
        driver,
        key: input.key,
        text,
        stored,
      });
      return { messageId };
    },
  };
}
