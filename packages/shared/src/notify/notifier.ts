import {
  deliverableChannels,
  MessageSendError,
  pickMessageTransport,
  SMS_CHANNEL,
  smsReplyAllowed,
  smsRenderOptions,
  smsSendOptionsFor,
  type MessageChannelSpec,
  type MessageKey,
  type MessageTransport,
  type Notifier,
  type NotifierKey,
  type NotifyOutcome,
  type NotifySkipDetail,
  type SmsDriver,
  type SmsTransport,
} from '../channels.ts';
import {
  renderSms,
  type RenderSmsOptions,
  type SmsLocaleFor,
  type SmsVars,
  type TwoWaySmsKey,
} from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import type { ConsentType, MessageChannel, MsgStatus, ReporterStatus } from '../enums.ts';
import { assertE164, type E164 } from '../format.ts';
import { MASKED_CODE, maskFieldLinkUrl } from '../links.ts';
import { languageOf } from '../locale.ts';
import { SmsSendError, TWILIO_OPTED_OUT_CODE } from '../sms/transports.ts';
import { attemptIsFinal, attemptNumber, planAttempt, type MessageAttempt } from './walk.ts';

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
 *   on any channel (`messages.payload.dedupe_key`); one refused for good on every channel of the
 *   order throws the last refusal again, with the provider's code the row kept
 *   (`payload.error_code`), so the caller takes the same path again (Twilio 21610 is still an
 *   opt-out) instead of reading a success.
 * - Fallback (spec §19 Q22, W2-01; `walk.ts`): a channel that fails for good (an `undeliverable`
 *   refusal at send, or a later `failed` / `undeliverable` status callback, which re-runs the
 *   message through a `notify` job) hands the message to the next deliverable channel, under the
 *   same dedupe key. Each attempt is its own row (`payload.attempt`), and the attempt the walk
 *   moves past is audited `notify.attempt_failed` with its reason before the next goes out. A
 *   retryable error retries the same channel (the job's backoff). `console` on a real org
 *   (`console_real_org`) stays W1-08's skip, with no fallback, until W2-15 builds spec §19 Q84
 *   (decided 2026-10-16: a channel with no sender here leaves a real org's order; SMS carries it).
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

/** The `messages.payload` of an outbound row the Notifier writes. */
export type OutboundMessagePayload = {
  /** The logical message's key (one per message, across its channels). */
  dedupe_key?: string;
  /** The attempt this row is: 1 for the first channel tried, 2 for the next (W2-01). */
  attempt?: number;
  /** The provider's code of a refused send. */
  error_code?: string;
};

/** A `messages` row the Notifier writes: one per attempt (SMS, or a registered channel). */
export interface OutboundMessageRow {
  id: string;
  org_id: string | null;
  reporter_id: string | null;
  phone_e164: string;
  channel: MessageChannel;
  direction: 'out';
  /** The driver: an `SmsDriver` for SMS, the registered channel's driver otherwise. */
  provider: string;
  provider_message_id: string | null;
  copy_key: MessageKey;
  body: string;
  status: MsgStatus;
  error: string | null;
  payload: OutboundMessagePayload | null;
}

export interface NotifierAuditEntry {
  orgId: string | null;
  action: string;
  entity: 'message' | 'reporter';
  entityId: string | null;
  diff: Record<string, unknown>;
}

/** What `listByDedupeKey` reports about an earlier row (attempt) under the key. */
export interface PriorMessage {
  id: string;
  channel: MessageChannel | null;
  status: MsgStatus;
  provider: string | null;
  /** Set once the provider took the message (a later `failed` came from a status callback). */
  provider_message_id?: string | null;
  error: string | null;
  /** `payload.error_code`: the provider's code of a refused send. */
  error_code?: string | null;
  /** `payload.attempt` (absent on rows before W2-01: the first attempt). */
  attempt?: number | null;
}

/** A `PriorMessage` as the walk reads it. */
export function attemptOf(prior: PriorMessage): MessageAttempt {
  return {
    id: prior.id,
    channel: prior.channel,
    status: prior.status,
    provider: prior.provider,
    provider_message_id: prior.provider_message_id ?? null,
    error: prior.error,
    error_code: prior.error_code ?? null,
    attempt: attemptNumber({ attempt: prior.attempt }),
  };
}

export interface NotifierStore {
  loadRecipient(reporterId: string): Promise<NotifyRecipient | null>;
  /** The reporter's messages written under this dedupe key: every attempt, on every channel. */
  listByDedupeKey(reporterId: string, dedupeKey: string): Promise<PriorMessage[]>;
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

/**
 * A message channel registered with the Notifier besides SMS (W2-01): its spec and its drivers.
 * W2-14 registers push, W2-15 WhatsApp; the tests register a fake one.
 */
export interface ChannelRegistration {
  spec: MessageChannelSpec;
  /** The transport for a `pickMessageTransport()` answer on this channel (`console` included). */
  transport(driver: string): MessageTransport;
  /** The delivery-status callback URL a driver asks the provider for; none by default. */
  statusCallback?(driver: string): string | null;
  /**
   * The copy variant of the channel. Default: the pack's SMS variant with links allowed (the
   * links-in-SMS rule is SMS's, spec §19 Q24).
   */
  renderOptions?(pack: CountryPack): RenderSmsOptions;
}

export interface NotifierDeps {
  store: NotifierStore;
  /** The SMS driver for a `pickMessageTransport()` answer (`createSmsTransports`). */
  transport: (driver: SmsDriver) => SmsTransport;
  /** The other channels' registrations (W2-01); SMS is always registered. */
  channels?: readonly ChannelRegistration[];
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
  /** A two-way reply to an inbound text (`TWO_WAY_SMS_KEYS`: HELP, STOP, CALL, TEXT, unknown), sms-webhook. */
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
  specs: readonly MessageChannelSpec[] = [SMS_CHANNEL],
): 'no_channel' | 'no_consent' | 'opted_out' {
  if (recipient.reporter.status === 'disabled') return 'no_channel';
  if (recipient.reporter.status === 'opted_out') return 'opted_out';
  const withConsent = deliverableChannels({
    pack: recipient.pack,
    key,
    preferred: recipient.reporter.message_channel,
    narrow,
    consents: new Set<ConsentType>([...recipient.consents.held, ...specs.map((s) => s.consent)]),
    revoked: new Set(),
    optedOut: new Set(),
    implemented: specs.map((s) => s.channel),
    consentFor: consentMap(specs),
  });
  return withConsent.length > 0 ? 'no_consent' : 'no_channel';
}

function consentMap(
  specs: readonly MessageChannelSpec[],
): Partial<Record<MessageChannel, ConsentType>> {
  return Object.fromEntries(specs.map((s) => [s.channel, s.consent]));
}

/**
 * The refusal an attempt recorded, thrown again when every channel has failed for the message: an
 * `SmsSendError` for SMS (with its code, so Twilio 21610 stays an opt-out), a `MessageSendError`
 * for another channel. A `failed` attempt (its status callback) counts as undeliverable here: the
 * provider took it and could not deliver it.
 */
export function refusalOf(a: MessageAttempt): MessageSendError {
  const driver = a.provider ?? 'console';
  const code = a.error_code;
  const message = a.error ?? a.status;
  if (a.channel === 'sms' || a.channel === null) {
    return new SmsSendError(message, {
      driver: driver as SmsDriver,
      retryable: false,
      undeliverable: true,
      optedOut: driver === 'twilio' && code === TWILIO_OPTED_OUT_CODE,
      code,
    });
  }
  return new MessageSendError(message, a.channel, {
    driver,
    retryable: false,
    undeliverable: true,
    code,
  });
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

  const smsRegistration: ChannelRegistration = {
    spec: SMS_CHANNEL,
    transport(driver) {
      const sms = deps.transport(driver as SmsDriver);
      return {
        channel: 'sms',
        driver: sms.driver,
        send: (message, opts) => sms.send(message.to, message.body, opts),
      };
    },
    statusCallback: (driver) =>
      driver === 'twilio' && deps.statusCallbackUrl ? deps.statusCallbackUrl : null,
    renderOptions: smsRenderOptions,
  };
  const registry: ChannelRegistration[] = [smsRegistration];
  for (const r of deps.channels ?? []) {
    if (registry.some((x) => x.spec.channel === r.spec.channel)) {
      throw new Error(`Notifier: message channel "${r.spec.channel}" registered twice`);
    }
    registry.push(r);
  }
  const specs = registry.map((r) => r.spec);
  const implemented = specs.map((s) => s.channel);
  const consentFor = consentMap(specs);
  const registrationOf = (channel: MessageChannel): ChannelRegistration =>
    registry.find((r) => r.spec.channel === channel)!;

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
    channel: MessageChannel;
    driver: string;
    key: MessageKey;
    language: string;
    vars: Readonly<Record<string, unknown>>;
    text: string;
    stored: string;
    dedupeKey?: string;
    /** The attempt number of a Notifier message (none for a two-way reply). */
    attempt?: number;
    /** The row of an earlier attempt to send again on. */
    existingId?: string;
    /** The id of a new row (default: a new UUID). */
    newId?: string;
  }

  function payloadOf(input: TransmitInput, code?: string | null): OutboundMessageRow['payload'] {
    if (input.dedupeKey === undefined && input.attempt === undefined && !code) return null;
    return {
      ...(input.dedupeKey !== undefined ? { dedupe_key: input.dedupeKey } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(code ? { error_code: code } : {}),
    };
  }

  function rowOf(
    input: TransmitInput,
    id: string,
    status: MsgStatus,
    error: string | null,
  ): OutboundMessageRow {
    return {
      id,
      org_id: input.orgId,
      reporter_id: input.reporterId,
      phone_e164: input.phone,
      channel: input.channel,
      direction: 'out',
      provider: input.driver,
      provider_message_id: null,
      copy_key: input.key,
      body: input.stored,
      status,
      error,
      payload: payloadOf(input),
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
    const id = input.existingId ?? input.newId ?? deps.randomUUID();
    const registration = registrationOf(input.channel);
    const prefix = input.channel;
    // The driver first: a pack whose provider has no credentials here never leaves a row queued.
    let transport: MessageTransport;
    try {
      transport = registration.transport(input.driver);
    } catch (err) {
      const message = errorText(err);
      await writeRow(input, id, 'failed', message);
      await store.audit({
        orgId: input.orgId,
        action: `${prefix}.failed`,
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
    const statusCallback = registration.statusCallback?.(input.driver) ?? null;
    const sender = registration.spec.sender(input.pack);
    try {
      const { providerId } = await transport.send(
        {
          to: input.phone,
          body: input.text,
          key: input.key,
          language: input.language,
          vars: input.vars,
        },
        {
          ...(input.channel === 'sms'
            ? smsSendOptionsFor(input.pack)
            : sender === null
              ? {}
              : { sender }),
          ...(statusCallback ? { statusCallback } : {}),
        },
      );
      await store.updateMessage(id, {
        status: input.driver === 'console' ? 'delivered' : 'sent',
        provider_message_id: providerId,
        error: null,
      });
      await store.audit({
        orgId: input.orgId,
        action: `${prefix}.sent`,
        entity: 'message',
        entityId: id,
        diff: { copy_key: input.key, provider: input.driver, channel: input.channel },
      });
      return id;
    } catch (err) {
      const refused = err instanceof MessageSendError ? err : null;
      const undeliverable = refused?.undeliverable === true;
      const message = errorText(err);
      const code = refused?.opts.code ?? null;
      await store.updateMessage(id, {
        status: undeliverable ? 'undeliverable' : 'failed',
        error: message,
        // The code goes with the row, so a replay under the dedupe key throws the same refusal.
        ...(code ? { payload: payloadOf(input, code) } : {}),
      });
      await store.audit({
        orgId: input.orgId,
        action: undeliverable ? `${prefix}.undeliverable` : `${prefix}.failed`,
        entity: 'message',
        entityId: id,
        diff: {
          copy_key: input.key,
          provider: input.driver,
          code,
          retryable: refused?.retryable ?? false,
          ...(refused?.optedOut ? { opted_out: true } : {}),
        },
      });
      if (refused?.optedOut && input.channel === 'sms') {
        // The provider's own opt-out list (a STOP SiteLog never saw, or one before this sender):
        // SiteLog's state catches up, for the number and for the reporter. Another channel's
        // opt-out is a revoked consent of its type (spec §19 Q40), its own ticket's.
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

  /** Why the walk moves past an attempt (`notify.attempt_failed`). */
  function attemptFailedReason(recipient: NotifyRecipient, a: MessageAttempt): string {
    if (attemptIsFinal(a)) return a.status;
    // A pending attempt whose channel left the order since it was written.
    const consent = a.channel ? consentFor[a.channel] : undefined;
    return consent && !recipient.consents.held.has(consent) ? 'no_consent' : 'not_deliverable';
  }

  async function deliver<K extends NotifierKey>(
    recipient: NotifyRecipient,
    key: K,
    vars: SmsVars<K>,
    opts: { channels?: readonly MessageChannel[]; dedupeKey?: string } = {},
  ): Promise<NotifyOutcome> {
    const { reporter, org, pack } = recipient;
    if (reporter.status === 'disabled') return skip(recipient, key, 'no_channel', 'disabled');
    let order = deliverableChannels({
      pack,
      key,
      preferred: reporter.message_channel,
      narrow: opts.channels,
      consents: recipient.consents.held,
      revoked: recipient.consents.revoked,
      // `opted_out` is SMS STOP: it stops texts only (spec §19 Q40).
      optedOut: new Set<MessageChannel>(reporter.status === 'opted_out' ? ['sms'] : []),
      implemented,
      consentFor,
    });
    if (order.length === 0) {
      return skip(recipient, key, skipReason(recipient, key, opts.channels, specs));
    }
    const phone = assertE164(reporter.phone_e164);
    if (order.includes('sms') && (await store.isPhoneOptedOut(phone, pack.code))) {
      order = order.filter((c) => c !== 'sms');
      if (order.length === 0) return skip(recipient, key, 'opted_out', 'phone_opted_out');
    }

    const attempts: MessageAttempt[] = opts.dedupeKey
      ? (await store.listByDedupeKey(reporter.id, opts.dedupeKey)).map(attemptOf)
      : [];
    const language = languageOf(reporter.locale);
    for (;;) {
      const plan = planAttempt(order, attempts);
      if (plan.kind === 'done') {
        return { channel: plan.attempt.channel ?? 'sms', messageId: plan.attempt.id };
      }
      // The same refusal as the first time, code and all: a provider opt-out (Twilio 21610)
      // stays an opt-out, never a bad number. Its opt-out was recorded then; a START since must
      // not be undone here, so nothing is written again.
      if (plan.kind === 'exhausted') throw refusalOf(plan.last);
      if (plan.kind === 'none') return skip(recipient, key, 'no_channel');

      const { channel } = plan;
      const driver = pickMessageTransport({ isDemo: org.isDemo }, pack, channel, specs);
      if (driver === 'console' && !org.isDemo && CONSOLE_DEMO_ONLY_KEYS.includes(key)) {
        return skip(recipient, key, 'no_channel', 'console_real_org');
      }
      if (plan.after) {
        // The attempt the walk moves past, before the next goes out (spec §19 Q22).
        const after = plan.after;
        await store.audit({
          orgId: reporter.org_id,
          action: 'notify.attempt_failed',
          entity: 'message',
          entityId: after.id,
          diff: {
            copy_key: key,
            dedupe_key: opts.dedupeKey ?? null,
            channel: after.channel,
            attempt: after.attempt,
            reason: attemptFailedReason(recipient, after),
            error: after.error,
            code: after.error_code,
            next_channel: channel,
          },
        });
      }

      const registration = registrationOf(channel);
      const options = registration.renderOptions?.(pack) ?? {
        ...smsRenderOptions(pack),
        linksAllowed: true,
      };
      const locale = language as SmsLocaleFor<K>;
      const text = renderSms(key, locale, vars, options);
      const stored =
        driver === 'console' && org.isDemo
          ? text
          : renderSms(key, locale, maskedVars(vars), options);
      const input: TransmitInput = {
        orgId: reporter.org_id,
        reporterId: reporter.id,
        phone,
        pack,
        channel,
        driver,
        key,
        language,
        vars: vars as Readonly<Record<string, unknown>>,
        text,
        stored,
        dedupeKey: opts.dedupeKey,
        attempt: plan.attempt,
        existingId: plan.retry?.id,
      };
      if (driver === 'console' && !org.isDemo) {
        // Nothing reaches the phone: the masked row records what would have gone out (the
        // staging Demo phone shows it), and the caller tells the office. No fallback: W1-08's
        // rule stands until W2-15 builds spec §19 Q84 (decided 2026-10-16).
        const id = plan.retry?.id ?? deps.randomUUID();
        await writeRow(input, id, 'failed', consoleRealOrgError(pack.code));
        return skip(recipient, key, 'no_channel', 'console_real_org', { message_id: id });
      }
      const id = plan.retry?.id ?? deps.randomUUID();
      try {
        await transmit({ ...input, newId: id });
        return { channel, messageId: id };
      } catch (err) {
        // Only a refusal that is final for this channel falls back; anything else (a retryable
        // error, a missing credential) is thrown for the job to retry the same channel.
        if (!(err instanceof MessageSendError) || err.retryable || !err.undeliverable) throw err;
        attempts.push({
          id,
          channel,
          status: 'undeliverable',
          provider: driver,
          provider_message_id: null,
          error: errorText(err),
          error_code: err.opts.code ?? null,
          attempt: plan.attempt,
        });
        if (planAttempt(order, attempts).kind !== 'send') throw err;
      }
    }
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
      const language = languageOf(input.locale);
      const locale = language as SmsLocaleFor<typeof input.key>;
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
        channel: 'sms',
        driver,
        key: input.key,
        language,
        vars: input.vars as Readonly<Record<string, unknown>>,
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
