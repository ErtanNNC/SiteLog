import {
  isTwoWaySmsKey,
  messageKeyHasLink,
  type RenderSmsOptions,
  type SmsKey,
  type SmsVars,
  type TwoWaySmsKey,
} from './copy/sms.ts';
import type { CountryPack } from './countries.ts';
import type { ConsentType, MessageChannel } from './enums.ts';
import type { E164 } from './format.ts';

/**
 * §4.5 Channel layer: every field interaction goes through these interfaces, so a channel is
 * added without touching the pipeline. Outbound messages go through the Notifier on each person's
 * channel order, which comes from the org's country pack (spec §4.6) and the person's preference.
 * Types and pure helpers only: the Notifier is `createNotifier` (`notify/notifier.ts`) and the SMS
 * drivers (Twilio, İletimerkezi, console) are `sms/transports.ts` (W1-08); the WhatsApp (Twilio)
 * and web push transports come with week 2 (M6), the calls with M8.
 *
 * Nothing here reads env: the provider, the sender id, two-way SMS, links in SMS and the voice
 * number are the pack's (GAP D47, D48); credentials stay global env in the transports.
 */

/**
 * How a report reached SiteLog (§4.5): `web`, `voice` or `sms`. It mirrors the Postgres enum
 * `field_channel` (§6.2, `enums.ts`), which also has `office` for reports typed in the panel (D13).
 */
export type { FieldChannel } from './enums.ts';

/**
 * How SiteLog reaches a person (§4.5, enum `message_channel`): `sms`, `whatsapp`, `push`. Push can
 * never be inbound, so it is a separate type from `FieldChannel`.
 */
export type { MessageChannel } from './enums.ts';

/** A message's copy key. WhatsApp templates and push texts reuse the SMS keys (week 2). */
export type MessageKey = SmsKey;

/**
 * The keys the Notifier sends: every key except the two-way replies (`help`, `stop_confirm`,
 * `unknown_number`, `pref_call_ok`, `pref_text_ok`), which sms-webhook sends in answer to an
 * inbound text (`smsReplyAllowed`).
 */
export type NotifierKey = Exclude<MessageKey, TwoWaySmsKey>;

/**
 * The message channels with a transport. Week 1 builds SMS only; WhatsApp (Twilio) and web push
 * join with the M6 reminders (week 2), each by registering its `MessageChannelSpec` and transport
 * with the Notifier (`NotifierDeps.channels`, W2-01) and adding itself here.
 */
export const IMPLEMENTED_MESSAGE_CHANNELS = ['sms'] as const satisfies readonly MessageChannel[];

/**
 * The consent each message channel needs (`consents.type`). null = no consent label yet
 * (WhatsApp and push wait for spec §19 Q25 and Q27), so the channel is never deliverable.
 */
export const CONSENT_FOR_CHANNEL: Readonly<Record<MessageChannel, ConsentType | null>> = {
  sms: 'sms',
  whatsapp: null,
  push: null,
};

/**
 * Keys the spec sends before the person has consented: the welcome at invite (F3 step 1, before
 * the consent screen of F4) and the device code (F4 step 2, before step 3's consent). Their SMS
 * skips the consent check only while the person has no consent of any type, given or revoked:
 * once they have answered a consent prompt, a missing SMS consent (declined, or revoked in the
 * field app's Settings, §9.3) blocks every SMS, so the office's "Re-send welcome" (§11 Team) does
 * not text them. The opt-out always applies. Every other key needs the channel's consent. Spec
 * §19 Q25 asks the owner to confirm this with the device code's channel.
 */
export const PRE_CONSENT_SMS_KEYS = [
  'welcome',
  'verify_code',
] as const satisfies readonly NotifierKey[];

/**
 * Keys that go by SMS on every pack, whatever its `message_channels` and the person's preference:
 * the device code, a one-time code by SMS (F4 step 2, §6.3 `field_devices.verified_at`; spec §19
 * Q25). Every pack has an SMS sender (`sms_provider`, `sms_sender_type`), even one that lists no
 * SMS for its messages.
 */
export const SMS_ONLY_KEYS = ['verify_code'] as const satisfies readonly NotifierKey[];

/**
 * A built message channel (§4.5; W2-01): what the Notifier needs to know about it besides its
 * transport. The registry is the Notifier's (`NotifierDeps.channels`): SMS is always registered
 * (`SMS_CHANNEL`); W2-14 (push) and W2-15 (WhatsApp) register theirs, tests a fake one.
 */
export interface MessageChannelSpec {
  readonly channel: MessageChannel;
  /** The consent the channel needs (`consents.type`). */
  readonly consent: ConsentType;
  /**
   * The pack's sender of this channel in this environment; null = none set here, so the channel
   * goes through `console` (§4.6, §19 Q29; WhatsApp Q39).
   */
  sender(pack: CountryPack): string | null;
  /** The pack's provider driver for this channel (`sms_provider`, `whatsapp_provider`, …). */
  provider(pack: CountryPack): string;
}

/** SMS: consent `sms`, the pack's `sms_sender_id` and `sms_provider`. */
export const SMS_CHANNEL: MessageChannelSpec = {
  channel: 'sms',
  consent: 'sms',
  sender: (pack) => pack.smsSenderId,
  provider: (pack) => pack.smsProvider,
};

/** The channels built in this repo, as specs (`pickMessageTransport`'s default registry). */
export const BUILT_CHANNEL_SPECS: readonly MessageChannelSpec[] = [SMS_CHANNEL];

/** What a channel's transport is asked to send: the §9.2 text and what it was rendered from. */
export interface OutboundMessage {
  /** The person's number (push, W2-14, adds its subscription beside it). */
  to: E164;
  /** The text in the person's language with the pack's variant. */
  body: string;
  key: MessageKey;
  /** The language the body is in (`en`, `es`, `tr`): a WhatsApp template's language (W2-15). */
  language: string;
  /** The key's variables, unmasked (a WhatsApp template's variables, W2-15). */
  vars: Readonly<Record<string, unknown>>;
}

/**
 * One driver of one message channel (§4.5; W2-01). SMS wraps its `SmsTransport`s; W2-14 / W2-15
 * implement this directly. A refusal throws `MessageSendError` (`SmsSendError` for SMS).
 */
export interface MessageTransport {
  readonly channel: MessageChannel;
  readonly driver: string;
  send(message: OutboundMessage, opts: SmsSendOptions): Promise<{ providerId: string }>;
}

/**
 * A send a channel's provider refused, or a network failure (§4.5; W2-01). `retryable`: the same
 * channel may pass later (HTTP 429 or 5xx, network), so the job retries it with backoff;
 * `undeliverable`: the channel cannot carry this message to this person, final for the channel,
 * so the Notifier falls back to the next channel of the order (§19 Q22). `SmsSendError` is the
 * SMS drivers' subclass.
 */
export class MessageSendError extends Error {
  constructor(
    message: string,
    readonly channel: MessageChannel,
    readonly opts: {
      driver: string;
      /** Try again later (rate limit, provider outage, network). */
      retryable: boolean;
      /** The channel cannot reach this person with this message (invalid, landline, refused). */
      undeliverable?: boolean;
      /** The provider's own opt-out list has the person (Twilio 21610 for SMS). */
      optedOut?: boolean;
      /** The provider's error code, e.g. Twilio 21211. */
      code?: string | null;
    },
  ) {
    super(message);
    this.name = 'MessageSendError';
  }
  get retryable(): boolean {
    return this.opts.retryable;
  }
  get undeliverable(): boolean {
    return this.opts.undeliverable === true;
  }
  get optedOut(): boolean {
    return this.opts.optedOut === true;
  }
}

/** Why SiteLog places an outbound call (§4.5, `calls.purpose`). */
export type CallPurpose = 'daily_report' | 'reminder' | 'callback';

/**
 * The site-day an outbound call is about. Week 2 (M8, outbound calls) owns the rest of this
 * shape; the spec names the type only.
 */
export interface CallContext {
  siteId: string;
  /** `YYYY-MM-DD` in the site's time zone. */
  date: string;
}

/**
 * Why a skip happened beyond its reason, for callers that answer differently: `disabled` (the
 * office disabled the reporter), `console_real_org` (a real org's pack has no sender id in this
 * environment, so the text would reach no phone), `phone_opted_out` (the phone sent STOP on the
 * pack, `sms_opt_outs`, though this reporter row is not opted out).
 */
export type NotifySkipDetail = 'disabled' | 'console_real_org' | 'phone_opted_out';

/** What `Notifier.send` did: the channel it used, or why nothing went out (audited). */
export type NotifyOutcome =
  | { channel: MessageChannel; messageId: string }
  | {
      channel: null;
      reason: 'no_channel' | 'no_consent' | 'opted_out';
      detail?: NotifySkipDetail;
    };

export interface Notifier {
  /**
   * Sends on the first channel of `deliverableChannels()` (the person's order from the pack),
   * in the reporter's language with the pack's variant (`smsRenderOptions(pack)`), through
   * `pickMessageTransport()`; writes `messages` (with `channel`) and the audit row. `channels`
   * narrows that order and never widens it (e.g. F16's "Send me today's link" by SMS);
   * `dedupeKey` is one per logical message (e.g. `notify:filed:{report_id}`). A channel that fails
   * for good (at send, or later by a status callback) hands the message to the next channel of the
   * order under the same key, one `messages` row per attempt (§19 Q22, W2-01). The two-way replies
   * are not Notifier keys (`smsReplyAllowed`).
   */
  send<K extends NotifierKey>(
    reporterId: string,
    key: K,
    vars: SmsVars<K>,
    opts?: { channels?: readonly MessageChannel[]; dedupeKey?: string },
  ): Promise<NotifyOutcome>;
  /** Places an outbound call if the reporter prefers calls, has auto-call consent and is inside the call window. */
  call(reporterId: string, purpose: CallPurpose, ctx: CallContext): Promise<void>;
}

/**
 * SMS drivers: a pack's `sms_provider` (`twilio` by default, `iletimerkezi` for the TR pack), or
 * `console` for demo orgs and packs with no sender id in this environment (`pickMessageTransport`).
 */
export const SMS_DRIVERS = ['twilio', 'iletimerkezi', 'console'] as const;
export type SmsDriver = (typeof SMS_DRIVERS)[number];

export interface SmsSendOptions {
  /** The pack's sender id (`countries.sms_sender_id`): TR `SITELOG`, US the toll-free number. */
  sender?: string;
  /** Delivery-status webhook (Twilio). */
  statusCallback?: string;
}

/**
 * One SMS driver. Whether replies reach SiteLog is the pack's `two_way_sms`, never the driver's:
 * `console` follows the pack too, so the Demo phone takes replies only on two-way packs.
 */
export interface SmsTransport {
  readonly driver: SmsDriver;
  send(to: E164, body: string, opts: SmsSendOptions): Promise<{ providerId: string }>;
}

/**
 * The Notifier's order for a person (§4.5): their preferred channel first when the pack offers it,
 * then the pack's `message_channels`. A preference the pack does not list is ignored (the pack is
 * the allow-list, spec §19 Q21).
 */
export function messageChannelOrder(
  pack: CountryPack,
  preferred: MessageChannel | null,
): MessageChannel[] {
  const order = [...pack.messageChannels];
  const ranked = preferred !== null && order.includes(preferred) ? [preferred, ...order] : order;
  return [...new Set(ranked)];
}

/**
 * The channels a Notifier message may go on, in order (§4.5). The order is computed here, so no
 * caller can step outside the pack's allow-list: `messageChannelOrder(pack, preferred)`, or
 * `['sms']` for `SMS_ONLY_KEYS`, kept to the channels in `narrow` when given. A channel then stays
 * only if it is built (`implemented`, default `IMPLEMENTED_MESSAGE_CHANNELS`); its consent label
 * exists and is held (`PRE_CONSENT_SMS_KEYS` skip the SMS consent while the person has none,
 * given or revoked); the person has not opted out of it; and, for SMS, the pack allows links when
 * the key carries one (spec §19 Q24). Throws on a two-way key: those replies are sms-webhook's
 * (`smsReplyAllowed`).
 */
export function deliverableChannels(input: {
  pack: CountryPack;
  key: NotifierKey;
  /** The person's preferred channel (`reporters.message_channel`); null = the pack's order. */
  preferred: MessageChannel | null;
  /** Keeps only these channels of the order (never adds one). */
  narrow?: readonly MessageChannel[];
  /** The person's unrevoked consent types. */
  consents: ReadonlySet<ConsentType>;
  /** Consent types the person gave and revoked, with no unrevoked consent of that type since. */
  revoked: ReadonlySet<ConsentType>;
  optedOut: ReadonlySet<MessageChannel>;
  implemented?: readonly MessageChannel[];
  /**
   * The consent of a channel the Notifier registered beyond `CONSENT_FOR_CHANNEL` (its
   * `MessageChannelSpec.consent`, W2-01); a channel with no consent label is never deliverable.
   */
  consentFor?: Partial<Record<MessageChannel, ConsentType>>;
}): MessageChannel[] {
  const key: MessageKey = input.key;
  if (isTwoWaySmsKey(key)) {
    throw new Error(`SMS "${key}" answers an inbound text: sms-webhook sends it, not the Notifier`);
  }
  const implemented: readonly MessageChannel[] = input.implemented ?? IMPLEMENTED_MESSAGE_CHANNELS;
  const base: MessageChannel[] = (SMS_ONLY_KEYS as readonly MessageKey[]).includes(key)
    ? ['sms']
    : messageChannelOrder(input.pack, input.preferred);
  const narrow = input.narrow;
  const order = narrow ? base.filter((c) => narrow.includes(c)) : base;
  const neverConsented = input.consents.size === 0 && input.revoked.size === 0;
  const preConsent =
    neverConsented && (PRE_CONSENT_SMS_KEYS as readonly MessageKey[]).includes(key);
  return order.filter((channel) => {
    if (!implemented.includes(channel)) return false;
    const consent = input.consentFor?.[channel] ?? CONSENT_FOR_CHANNEL[channel];
    if (consent === null) return false;
    if (input.optedOut.has(channel)) return false;
    if (channel !== 'sms') return input.consents.has(consent);
    if (!preConsent && !input.consents.has(consent)) return false;
    if (messageKeyHasLink(key) && !input.pack.smsLinksAllowed) return false;
    return true;
  });
}

/**
 * Whether sms-webhook may answer an inbound text with a two-way key (§9.5, F13, F15): HELP →
 * `help`, STOP → `stop_confirm`, CALL / TEXT → `pref_call_ok` / `pref_text_ok` (spec §19 Q46),
 * a sender who is not a reporter → `unknown_number`. These replies
 * never go through the Notifier: they answer a text the person just sent, by SMS, to a sender
 * who may have no reporter row, so neither the person's channel order nor their consent or
 * opt-out applies (HELP is answered before any consent, as the welcome invites it; `stop_confirm`
 * is the one text after STOP). Only the pack decides: it must have two-way SMS, and allow links in
 * SMS for a key that carries one (`help`). The webhook renders with `smsRenderOptions(pack)`,
 * sends through `pickMessageTransport()` with `smsSendOptionsFor(pack)` and audits the reply
 * (`SmsNotifier.reply`). Confirmed by the owner with `PRE_CONSENT_SMS_KEYS` (spec §19 Q25,
 * 2026-10-15).
 */
export function smsReplyAllowed(pack: CountryPack, key: TwoWaySmsKey): boolean {
  if (!pack.twoWaySms) return false;
  return !messageKeyHasLink(key) || pack.smsLinksAllowed;
}

/**
 * The driver of a message channel's transport (§4.5, §5.2), for any registered channel (`specs`,
 * default `BUILT_CHANNEL_SPECS`; the Notifier passes its registry). Per channel: demo orgs always
 * use `console` (they never message real people); so does a pack with no sender of that channel
 * in this environment (nothing goes out before a sender is approved and set,
 * `set_country_endpoints()`); otherwise the pack's provider for the channel. A channel with no
 * registration (WhatsApp, push until W2-15 / W2-14) throws.
 */
export function pickMessageTransport(
  org: { isDemo: boolean },
  pack: CountryPack,
  channel: 'sms',
): SmsDriver;
export function pickMessageTransport(
  org: { isDemo: boolean },
  pack: CountryPack,
  channel: MessageChannel,
  specs?: readonly MessageChannelSpec[],
): string;
export function pickMessageTransport(
  org: { isDemo: boolean },
  pack: CountryPack,
  channel: MessageChannel,
  specs: readonly MessageChannelSpec[] = BUILT_CHANNEL_SPECS,
): string {
  const spec = specs.find((s) => s.channel === channel);
  if (!spec) throw new Error(`Message channel "${channel}" is not built until week 2 (M6)`);
  if (org.isDemo) return 'console';
  if (spec.sender(pack) === null) return 'console';
  return spec.provider(pack);
}

/**
 * The SMS copy variant of a pack: the "or call {number}" clauses, the two-way texts and whether a
 * text may carry a link.
 */
export function smsRenderOptions(pack: CountryPack): RenderSmsOptions {
  return {
    hasVoiceNumber: pack.voiceNumber !== null,
    twoWay: pack.twoWaySms,
    linksAllowed: pack.smsLinksAllowed,
  };
}

/** The send options of a pack's SMS: its sender id, when set in this environment. */
export function smsSendOptionsFor(pack: CountryPack): SmsSendOptions {
  return pack.smsSenderId === null ? {} : { sender: pack.smsSenderId };
}
