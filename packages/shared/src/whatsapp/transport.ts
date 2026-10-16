import {
  MessageSendError,
  WHATSAPP_CHANNEL,
  type MessageTransport,
  type SmsSendOptions,
  type WhatsappDriver,
} from '../channels.ts';
import type { E164 } from '../format.ts';
import { languageOf } from '../locale.ts';
import { isServiceWindowOpen } from '../messaging/window.ts';
import type { ChannelRegistration } from '../notify/notifier.ts';
import { TWILIO_API_BASE, type FetchLike, type TwilioCredentials } from '../sms/transports.ts';
import {
  isWhatsappKey,
  whatsappContentSid,
  whatsappContentVariables,
  whatsappRenderOptions,
  whatsappTemplate,
} from './templates.ts';

/**
 * The WhatsApp message channel through Twilio (W2-15; spec §4.4, §4.5, §19 Q25, Q39, Q84). Pure:
 * `fetch`, the credentials and the window lookup are injected, so the worker (Node) and the edge
 * functions (Deno: sms-webhook's replies, field-api, the panel's inline texts) register the same
 * channel with their Notifier (`createWhatsappRegistration`).
 *
 * - Twilio's Messages API with `whatsapp:` addresses: `From` the pack's `whatsapp_sender_id`.
 * - Inside the 24-hour window opened by the person's last inbound WhatsApp message (and for a reply
 *   to the message they just sent), free-form text: the §9.2 text in their language
 *   (`whatsapp_mode 'session'`). Outside it, the key's approved template for their language
 *   (`ContentSid` and `ContentVariables`, `whatsapp_mode 'template'`). A key with no approved
 *   template for the language cannot go: the channel is not reachable for it (`reachable`), so the
 *   Notifier tries the next channel before any attempt; at send time (a window that closed in
 *   between) it is an `undeliverable` refusal and the walk falls back (W2-01).
 * - Refusals: 429, 5xx and network errors are retried; 401 / 403 (credentials) are thrown as they
 *   are; any other refusal is `undeliverable` for this message, so SMS carries it (spec §19 Q22).
 * - Delivery callbacks (sent, delivered, read, failed, undelivered) go to sms-webhook's `/status`.
 * - `console` for demo orgs and for a pack with no WhatsApp sender here (§4.5): nothing is sent,
 *   the row shows in the Demo phone labelled WhatsApp. For a real org a pack with no WhatsApp
 *   sender leaves the order instead (§19 Q84, the Notifier).
 */

/** `messages.provider` of a Twilio WhatsApp message. */
export const WHATSAPP_PROVIDER = 'twilio';

/**
 * Twilio codes that mean this message cannot go on WhatsApp to this person at send time, with no
 * point retrying: 21211 / 21614 / 63003 / 63024 (not a WhatsApp user or invalid recipient), 63016
 * (free-form outside the window), 21655 / 21656 / 63027 / 63028 (the template or its variables).
 * Any other 4xx but 401 and 403 counts the same way (see above); the list names the known ones.
 */
export const TWILIO_WHATSAPP_UNDELIVERABLE_CODES: readonly string[] = [
  '21211',
  '21614',
  '21655',
  '21656',
  '63003',
  '63016',
  '63024',
  '63027',
  '63028',
];

/** `whatsapp:+15550100000`. */
export function whatsappAddress(e164: string): string {
  return `whatsapp:${e164}`;
}

/** The E.164 number of a `whatsapp:` address, or null. */
export function fromWhatsappAddress(address: string | null | undefined): E164 | null {
  const m = /^whatsapp:(\+[1-9]\d{6,14})$/.exec(address?.trim() ?? '');
  return m ? (m[1] as E164) : null;
}

export interface WhatsappTransportDeps {
  /** When the person last wrote to SiteLog on WhatsApp (`messages`, channel whatsapp, in). */
  lastInbound(phone: E164): Promise<string | null>;
  now?: () => Date;
}

function refusal(
  message: string,
  opts: { retryable: boolean; undeliverable?: boolean; code?: string | null },
): MessageSendError {
  return new MessageSendError(message, 'whatsapp', {
    driver: WHATSAPP_PROVIDER,
    retryable: opts.retryable,
    undeliverable: opts.undeliverable ?? false,
    code: opts.code ?? null,
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The Twilio WhatsApp transport. */
export function createTwilioWhatsappTransport(
  creds: TwilioCredentials,
  fetchImpl: FetchLike,
  deps: WhatsappTransportDeps,
  apiBase: string = TWILIO_API_BASE,
): MessageTransport {
  const now = deps.now ?? (() => new Date());
  return {
    channel: 'whatsapp',
    driver: WHATSAPP_PROVIDER,
    async send(message, opts: SmsSendOptions) {
      if (!opts.sender) throw refusal('twilio whatsapp: no sender', { retryable: false });
      const form = new URLSearchParams({
        To: whatsappAddress(message.to),
        From: whatsappAddress(opts.sender),
      });
      const open = isServiceWindowOpen(await deps.lastInbound(message.to), now());
      let meta: Record<string, string>;
      if (open) {
        form.set('Body', message.body);
        meta = { whatsapp_mode: 'session' };
      } else if (message.reply) {
        throw refusal('twilio whatsapp: a reply outside the 24-hour window', {
          retryable: false,
          undeliverable: true,
          code: 'outside_window',
        });
      } else {
        const sid =
          message.pack && isWhatsappKey(message.key)
            ? whatsappContentSid(message.pack, message.key, message.language)
            : null;
        if (!sid || !message.pack || !isWhatsappKey(message.key)) {
          throw refusal(
            `twilio whatsapp: no approved template for ${message.key} (${message.language})`,
            { retryable: false, undeliverable: true, code: 'no_template' },
          );
        }
        const template = whatsappTemplate(
          message.key,
          languageOf(message.language),
          whatsappRenderOptions(message.pack),
        );
        form.set('ContentSid', sid);
        form.set(
          'ContentVariables',
          JSON.stringify(whatsappContentVariables(template, message.vars)),
        );
        meta = { whatsapp_mode: 'template', content_sid: sid };
      }
      if (opts.statusCallback) form.set('StatusCallback', opts.statusCallback);
      let res: Response;
      try {
        res = await fetchImpl(
          `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${btoa(`${creds.accountSid}:${creds.authToken}`)}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: form.toString(),
          },
        );
      } catch (err) {
        throw refusal(`twilio whatsapp: ${errorText(err)}`, { retryable: true });
      }
      const json = (await res.json().catch(() => null)) as {
        sid?: unknown;
        code?: unknown;
        message?: unknown;
      } | null;
      if (res.ok && typeof json?.sid === 'string') return { providerId: json.sid, payload: meta };
      const code = json?.code === undefined || json?.code === null ? null : String(json.code);
      const text = typeof json?.message === 'string' ? json.message : res.statusText;
      const retryable = res.status === 429 || res.status >= 500;
      const credentials = res.status === 401 || res.status === 403;
      throw refusal(`twilio whatsapp ${res.status}${code ? ` ${code}` : ''}: ${text}`, {
        retryable,
        undeliverable:
          (code !== null && TWILIO_WHATSAPP_UNDELIVERABLE_CODES.includes(code)) ||
          (!retryable && !credentials),
        code,
      });
    },
  };
}

/** The `console` WhatsApp transport: nothing leaves; the Notifier writes the row (Demo phone). */
export function createConsoleWhatsappTransport(randomUUID: () => string): MessageTransport {
  return {
    channel: 'whatsapp',
    driver: 'console',
    send: () => Promise.resolve({ providerId: `console-whatsapp:${randomUUID()}` }),
  };
}

/** Twilio credentials missing in this environment for a pack whose WhatsApp sender is set. */
export class WhatsappConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`WhatsApp driver "twilio" needs ${missing.join(', ')}`);
    this.name = 'WhatsappConfigError';
  }
}

export interface WhatsappRegistrationDeps extends WhatsappTransportDeps {
  fetch: FetchLike;
  /** TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (the SMS account's, one account for both, §4.4). */
  twilio: () => Partial<TwilioCredentials>;
  /** sms-webhook's `/status` route (https only), or null. */
  statusCallbackUrl: string | null;
  randomUUID: () => string;
  /** Tests point the driver at a mock server. */
  apiBase?: string;
}

/**
 * The WhatsApp channel for a Notifier (`NotifierDeps.channels`). Reachable for a recipient and a
 * key when the org is a demo org (`console`, no template needed), or the pack has a WhatsApp sender
 * here and either the window is open or the key has an approved template in the reporter's
 * language.
 */
export function createWhatsappRegistration(deps: WhatsappRegistrationDeps): ChannelRegistration {
  return {
    spec: WHATSAPP_CHANNEL,
    transport(driver) {
      if ((driver as WhatsappDriver) === 'console')
        return createConsoleWhatsappTransport(deps.randomUUID);
      if (driver !== WHATSAPP_PROVIDER) throw new Error(`whatsapp: unknown driver ${driver}`);
      const creds = deps.twilio();
      const sid = creds.accountSid?.trim();
      const token = creds.authToken?.trim();
      const missing = [
        ...(sid ? [] : ['TWILIO_ACCOUNT_SID']),
        ...(token ? [] : ['TWILIO_AUTH_TOKEN']),
      ];
      if (!sid || !token) throw new WhatsappConfigError(missing);
      return createTwilioWhatsappTransport(
        { accountSid: sid, authToken: token },
        deps.fetch,
        deps,
        deps.apiBase,
      );
    },
    statusCallback: (driver) => (driver === WHATSAPP_PROVIDER ? deps.statusCallbackUrl : null),
    renderOptions: whatsappRenderOptions,
    async reachable(recipient, key) {
      if (recipient.org.isDemo) return true;
      if (recipient.pack.whatsappSenderId === null) return false;
      const phone = recipient.reporter.phone_e164 as E164;
      if (isServiceWindowOpen(await deps.lastInbound(phone), (deps.now ?? (() => new Date()))()))
        return true;
      return (
        key !== undefined &&
        whatsappContentSid(recipient.pack, key, languageOf(recipient.reporter.locale)) !== null
      );
    },
  };
}
