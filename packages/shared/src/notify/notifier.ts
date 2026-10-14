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
  type NotifySkipDetail,
  type SmsDriver,
  type SmsTransport,
} from '../channels.ts';
import { renderSms, type SmsLocaleFor, type SmsVars, type TwoWaySmsKey } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import type { ConsentType, MessageChannel, MsgStatus, ReporterStatus } from '../enums.ts';
import { assertE164, type E164 } from '../format.ts';
import { MASKED_CODE, maskFieldLinkUrl } from '../links.ts';
import { languageOf } from '../locale.ts';
import { SmsSendError, TWILIO_OPTED_OUT_CODE } from '../sms/transports.ts';

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
 * - A disabled reporter gets nothing (`no_channel`, detail `disabled`).
 * - A phone that sent STOP on the pack's sender (`sms_opt_outs`, whoever it belonged to then) gets
 *   nothing by SMS (`opted_out`, detail `phone_opted_out`), even when this reporter row is not
 *   opted out: the opt-out follows the number, not the row.
 * - `console` on a real org (a pack without a sender id here) reaches no phone: the row is written
 *   `failed` with the reason, masked, so the staging Demo phone shows what would have gone out, and
 *   the caller gets `no_channel` with detail `console_real_org` (the office is told by the sending
 *   job). `verify_code` is then not written at all: a code nobody receives is of no use, and the
 *   W1-07 rule keeps it out of the office's reach (spec §19 Q48). A reply to an inbound text
 *   (`reply`) on `console` for a real org (its pack's sender cleared after the text came in) is
 *   written `failed` the same way and thrown as a refusal for good, never recorded as delivered.
 * - `messages.body` holds the whole text only when `console` writes it for a demo org (the Demo
 *   phone needs working links). Otherwise link codes (`/r/••••••`) and the device code are masked,
 *   so no office user can open a reporter's link or verify a device as the reporter.
 * - `dedupeKey` makes a retry idempotent: a message already sent under the key is not sent again
 *   (`messages.payload.dedupe_key`); one refused for good under the key (`undeliverable`) throws
 *   that refusal again, with the provider's code the row kept (`payload.error_code`), so the
 *   caller takes the same path again (Twilio 21610 is still an opt-out) instead of reading a
 *   success. Falling back to the next channel waits for spec §19 Q22.
 * - A refused send (`SmsSendError`) marks the row `failed` or `undeliverable`, is audited and is
 *   thrown on, so a job retries what may pass later and records what never will. A provider that
 *   refuses because the number is on its own opt-out list (Twilio 21610, `optedOut`) also records
 *   the opt-out here: `sms_opt_outs` (method `provider_opt_out`) and the reporter row, audited.
 * - A driver whose credentials this environment lacks (`SmsConfigError`) fails before anything is
 *   sent: the row is written `failed` with the configuration error, audited `sms.failed`, and the
 *   error is thrown (the job retries with backoff and dies into Sentry).
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
  /** The Notifier's dedupe key, and the provider's code of a refused send. */
  payload: { dedupe_key?: string; error_code?: string } | null;
}

export interface NotifierAuditEntry {
  orgId: string | null;
  action: string;
  entity: 'message' | 'reporter';
  entityId: string | null;
  diff: Record<string, unknown>;
}

/** What `findByDedupeKey` reports about an earlier row under the key. */
export interface PriorMessage {
  id: string;
  channel: MessageChannel | null;
  status: MsgStatus;
  provider: string | null;
  error: string | null;
  /** `payload.error_code`: the provider's code of a refused send. */
  error_code?: string | null;
}

export interface NotifierStore {
  loadRecipient(reporterId: string): Promise<NotifyRecipient | null>;
  /** The reporter's message written under this dedupe key, if any. */
  findByDedupeKey(reporterId: string, dedupeKey: string): Promise<PriorMessage | null>;
  insertMessage(row: OutboundMessageRow): Promise<void>;
  updateMessage(
    id: string,
    patch: {
      status: MsgStatus;
      provider_message_id?: string | null;
      error?: string | null;
      /** The whole payload (the row's dedupe key kept), when a refused send has a code. */
      payload?: OutboundMessageRow['payload'];
    },
  ): Promise<void>;
  /** `sms_opt_outs`: the phone sent STOP on this pack's sender, or its provider refused it as unsubscribed. */
  isPhoneOptedOut(phone: string, country: string): Promise<boolean>;
  /** Records a provider's refusal (Twilio 21610) in `sms_opt_outs`; a row already there stays. */
  recordPhoneOptOut(row: {
    phone_e164: string;
    country: string;
    method: 'provider_opt_out';
  }): Promise<void>;
  /**
   * The reporter row follows the provider's opt-out list: `opted_out` with `opted_out_at`, except a
   * disabled reporter, who keeps `disabled` and gets `opted_out_at` (so a re-invite lands opted
   * out). An `opted_out_at` already set is kept.
   */
  optOutReporter(reporterId: string, at: string): Promise<void>;
  audit(entry: NotifierAuditEntry): Promise<void>;
}

export interface NotifierDeps {
  store: NotifierStore;
  /** The driver for a `pickMessageTransport()` answer (`createSmsTransports`). */
  transport: (driver: SmsDriver) => SmsTransport;
  /** sms-webhook's status route, for Twilio delivery callbacks; null = none requested. */
  statusCallbackUrl?: string | null;
  randomUUID: () => string;
  now?: () => Date;
}

/** Keys `console` writes only for demo orgs: their whole point is the secret (W1-07 rule). */
export const CONSOLE_DEMO_ONLY_KEYS: readonly MessageKey[] = ['verify_code'];

/** The `messages.error` of a text a real org's pack could not send (no sender id here). */
export function consoleRealOrgError(packCode: string): string {
  return `console: no SMS sender set for pack ${packCode}`;
}

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

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export function createNotifier(deps: NotifierDeps): SmsNotifier {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  async function skip(
    recipient: NotifyRecipient,
    key: NotifierKey,
    reason: 'no_channel' | 'no_consent' | 'opted_out',
    detail?: NotifySkipDetail,
    extra: Record<string, unknown> = {},
  ): Promise<NotifyOutcome> {
    await store.audit({
      orgId: recipient.reporter.org_id,
      action: 'notify.skipped',
      entity: 'reporter',
      entityId: recipient.reporter.id,
      diff: { copy_key: key, reason, ...(detail ? { detail } : {}), ...extra },
    });
    return detail ? { channel: null, reason, detail } : { channel: null, reason };
  }

  interface TransmitInput {
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
  }

  function rowOf(input: TransmitInput, id: string, status: MsgStatus, error: string | null) {
    return {
      id,
      org_id: input.orgId,
      reporter_id: input.reporterId,
      phone_e164: input.phone,
      channel: 'sms' as const,
      direction: 'out' as const,
      provider: input.driver,
      provider_message_id: null,
      copy_key: input.key,
      body: input.stored,
      status,
      error,
      payload: input.dedupeKey ? { dedupe_key: input.dedupeKey } : null,
    };
  }

  /** Writes the row as the outcome says: a new row, or the earlier row of the dedupe key. */
  async function writeRow(
    input: TransmitInput,
    id: string,
    status: MsgStatus,
    error: string | null,
  ): Promise<void> {
    if (input.existingId) await store.updateMessage(id, { status, error });
    else await store.insertMessage(rowOf(input, id, status, error));
  }

  /** Writes the row, sends, records the outcome. Shared by `deliver` and `reply`. */
  async function transmit(input: TransmitInput): Promise<string> {
    const id = input.existingId ?? deps.randomUUID();
    // The driver first: a pack whose provider has no credentials here never leaves a row queued.
    let transport: SmsTransport;
    try {
      transport = deps.transport(input.driver);
    } catch (err) {
      const message = errorText(err);
      await writeRow(input, id, 'failed', message);
      await store.audit({
        orgId: input.orgId,
        action: 'sms.failed',
        entity: 'message',
        entityId: id,
        diff: {
          copy_key: input.key,
          provider: input.driver,
          code: null,
          retryable: false,
          config: true,
        },
      });
      throw err;
    }
    await writeRow(input, id, 'queued', null);
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
      const refused = err instanceof SmsSendError ? err : null;
      const undeliverable = refused?.undeliverable === true;
      const message = errorText(err);
      const code = refused?.opts.code ?? null;
      await store.updateMessage(id, {
        status: undeliverable ? 'undeliverable' : 'failed',
        error: message,
        // The code goes with the row, so a replay under the dedupe key throws the same refusal.
        ...(code
          ? {
              payload: {
                ...(input.dedupeKey ? { dedupe_key: input.dedupeKey } : {}),
                error_code: code,
              },
            }
          : {}),
      });
      await store.audit({
        orgId: input.orgId,
        action: undeliverable ? 'sms.undeliverable' : 'sms.failed',
        entity: 'message',
        entityId: id,
        diff: {
          copy_key: input.key,
          provider: input.driver,
          code: refused?.opts.code ?? null,
          retryable: refused?.retryable ?? false,
          ...(refused?.optedOut ? { opted_out: true } : {}),
        },
      });
      if (refused?.optedOut) {
        // The provider's own opt-out list (a STOP SiteLog never saw, or one before this sender):
        // SiteLog's state catches up, for the number and for the reporter.
        const at = now().toISOString();
        await store.recordPhoneOptOut({
          phone_e164: input.phone,
          country: input.pack.code,
          method: 'provider_opt_out',
        });
        if (input.reporterId) {
          await store.optOutReporter(input.reporterId, at);
          await store.audit({
            orgId: input.orgId,
            action: 'reporter.opted_out',
            entity: 'reporter',
            entityId: input.reporterId,
            diff: {
              method: 'provider_opt_out',
              provider: input.driver,
              code: refused.opts.code ?? null,
              message_id: id,
              opted_out_at: at,
            },
          });
        }
      }
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
    const phone = assertE164(reporter.phone_e164);
    if (channel === 'sms' && (await store.isPhoneOptedOut(phone, pack.code))) {
      return skip(recipient, key, 'opted_out', 'phone_opted_out');
    }
    const driver = pickMessageTransport({ isDemo: org.isDemo }, pack, channel);
    if (driver === 'console' && !org.isDemo && CONSOLE_DEMO_ONLY_KEYS.includes(key)) {
      return skip(recipient, key, 'no_channel', 'console_real_org');
    }

    let existingId: string | undefined;
    if (opts.dedupeKey) {
      const prior = await store.findByDedupeKey(reporter.id, opts.dedupeKey);
      if (prior?.status === 'undeliverable') {
        // The same refusal as the first time, code and all: a provider opt-out (Twilio 21610)
        // stays an opt-out, never a bad number. Its opt-out was recorded then; a START since
        // must not be undone here, so nothing is written again.
        const priorDriver = (prior.provider as SmsDriver | null) ?? driver;
        const code = prior.error_code ?? null;
        throw new SmsSendError(prior.error ?? 'undeliverable', {
          driver: priorDriver,
          retryable: false,
          undeliverable: true,
          optedOut: priorDriver === 'twilio' && code === TWILIO_OPTED_OUT_CODE,
          code,
        });
      }
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
    const input: TransmitInput = {
      orgId: reporter.org_id,
      reporterId: reporter.id,
      phone,
      pack,
      driver,
      key,
      text,
      stored,
      dedupeKey: opts.dedupeKey,
      existingId,
    };
    if (driver === 'console' && !org.isDemo) {
      // Nothing reaches the phone: the masked row records what would have gone out (the staging
      // Demo phone shows it), and the caller tells the office.
      const id = existingId ?? deps.randomUUID();
      await writeRow(input, id, 'failed', consoleRealOrgError(pack.code));
      return skip(recipient, key, 'no_channel', 'console_real_org', { message_id: id });
    }
    const messageId = await transmit(input);
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
      const transmitInput: TransmitInput = {
        orgId: input.org?.id ?? null,
        reporterId: input.reporterId,
        phone: input.phone,
        pack: input.pack,
        driver,
        key: input.key,
        text,
        stored,
      };
      if (driver === 'console' && !input.org?.isDemo) {
        // A real org's (or an unknown number's) reply with no sender for the pack here, e.g. one
        // cleared after the text came in: nothing reaches the phone, so the row says `failed`,
        // and the refusal is for good (the caller marks the text handled, with no reply).
        const id = deps.randomUUID();
        const error = consoleRealOrgError(input.pack.code);
        await writeRow(transmitInput, id, 'failed', error);
        await store.audit({
          orgId: transmitInput.orgId,
          action: 'sms.failed',
          entity: 'message',
          entityId: id,
          diff: {
            copy_key: input.key,
            provider: 'console',
            code: null,
            retryable: false,
            detail: 'console_real_org',
          },
        });
        throw new SmsSendError(error, { driver: 'console', retryable: false });
      }
      const messageId = await transmit(transmitInput);
      return { messageId };
    },
  };
}
