import {
  MessageSendError,
  type SmsDriver,
  type SmsSendOptions,
  type SmsTransport,
} from '../channels.ts';
import type { E164 } from '../format.ts';

/**
 * The SMS drivers (spec §4.5, §5.2; W1-08): `console`, `twilio` and `iletimerkezi`, behind the one
 * `SmsTransport` interface. Pure: `fetch` and the credentials are injected, so the worker (Node),
 * the edge functions (Deno) and the tests (mocked HTTP) share them. Which driver a message uses is
 * `pickMessageTransport()` (the org and its country pack), never the driver's own choice; whether
 * replies reach SiteLog is the pack's `two_way_sms`, never the driver's.
 *
 * A driver throws `SmsSendError` when the provider refuses a message: `retryable` for what may
 * pass later (HTTP 429 or 5xx, a network error), `undeliverable` for a number the provider cannot
 * reach (F3 "Can't reach this number"). The Notifier records both on the `messages` row.
 */

/**
 * A send the SMS provider refused, or a network failure: the SMS drivers' `MessageSendError`
 * (channel `sms`, driver one of `SMS_DRIVERS`).
 */
export class SmsSendError extends MessageSendError {
  declare readonly opts: MessageSendError['opts'] & { driver: SmsDriver };
  constructor(message: string, opts: MessageSendError['opts'] & { driver: SmsDriver }) {
    super(message, 'sms', opts);
    this.name = 'SmsSendError';
  }
}

/** A driver was picked whose credentials this environment does not have. */
export class SmsConfigError extends Error {
  constructor(
    readonly driver: SmsDriver,
    readonly missing: string[],
  ) {
    super(`SMS driver "${driver}" needs ${missing.join(', ')}`);
    this.name = 'SmsConfigError';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * `console`: sends nothing. The Notifier writes the `messages` row (status `delivered`), which the
 * panel's Demo phone shows (§11.1). Used by every demo org and by packs with no sender id here.
 */
export function createConsoleSmsTransport(randomUUID: () => string): SmsTransport {
  return {
    driver: 'console',
    send() {
      return Promise.resolve({ providerId: `console:${randomUUID()}` });
    },
  };
}

// ───────────────────────────── Twilio ─────────────────────────────

/**
 * Twilio error codes that mean the number cannot get this text (as opposed to a configuration or
 * account problem): 21211 invalid To, 21214 To cannot be reached, 21217 not a valid phone number,
 * 21610 the recipient replied STOP to this sender, 21612 cannot route to this number, 21614 To is
 * not a mobile number.
 */
export const TWILIO_UNDELIVERABLE_CODES: readonly string[] = [
  '21211',
  '21214',
  '21217',
  '21610',
  '21612',
  '21614',
];

/** Twilio 21610: the recipient replied STOP to this sender, so Twilio refuses the send. */
export const TWILIO_OPTED_OUT_CODE = '21610';

/**
 * Twilio error codes of a message accepted at send time that its delivery-status callback later
 * reports `undelivered` because of the number (F3 "Can't reach this number"): 30003 the handset
 * is unreachable, 30004 the number is blocked from getting this message, 30005 unknown or
 * inactive number, 30006 a landline or a carrier that cannot take texts. Every other late code is
 * not the number's fault and never flags the reporter: 30001 queue overflow, 30002 account
 * suspended, 30007 carrier filtering, 30008 unknown error, 30032 toll-free sender not verified,
 * 30034 unregistered 10DLC number, and the rest. A missing code counts as the number's.
 */
export const TWILIO_ASYNC_NUMBER_CODES: readonly string[] = ['30003', '30004', '30005', '30006'];

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export const TWILIO_API_BASE = 'https://api.twilio.com';

/**
 * Twilio Programmable Messaging (REST, `POST /2010-04-01/Accounts/{sid}/Messages.json`): the pack's
 * sender id is `From` (a toll-free, long or short code, or an alphanumeric title), the status
 * callback is sms-webhook's `/status` route. The message SID is the provider id.
 */
export function createTwilioSmsTransport(
  creds: TwilioCredentials,
  fetchImpl: FetchLike,
  apiBase: string = TWILIO_API_BASE,
): SmsTransport {
  return {
    driver: 'twilio',
    async send(to: E164, body: string, opts: SmsSendOptions) {
      if (!opts.sender) {
        throw new SmsSendError('twilio: no sender id', { driver: 'twilio', retryable: false });
      }
      const form = new URLSearchParams({ To: to, From: opts.sender, Body: body });
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
        throw new SmsSendError(`twilio: ${errorText(err)}`, { driver: 'twilio', retryable: true });
      }
      const json = (await res.json().catch(() => null)) as {
        sid?: unknown;
        code?: unknown;
        message?: unknown;
      } | null;
      if (res.ok && typeof json?.sid === 'string') return { providerId: json.sid };
      const code = json?.code === undefined || json?.code === null ? null : String(json.code);
      const message = typeof json?.message === 'string' ? json.message : res.statusText;
      throw new SmsSendError(`twilio ${res.status}${code ? ` ${code}` : ''}: ${message}`, {
        driver: 'twilio',
        retryable: res.status === 429 || res.status >= 500,
        undeliverable: code !== null && TWILIO_UNDELIVERABLE_CODES.includes(code),
        optedOut: code === TWILIO_OPTED_OUT_CODE,
        code,
      });
    },
  };
}

// ───────────────────────────── İletimerkezi ─────────────────────────────

export interface IletimerkeziCredentials {
  apiKey: string;
  apiHash: string;
}

export const ILETIMERKEZI_API_BASE = 'https://api.iletimerkezi.com';

/**
 * İletimerkezi status codes that mean the number cannot get this text, not that the account or
 * the sender is at fault: 450 "no valid recipient" (the number is not a mobile number the operator
 * routes). Every other refusal (401 credentials, 402 balance, 403 sender title, 400 request) is a
 * configuration or account fault and is never blamed on the number. Re-check against the
 * provider's current documentation before the first real send (spec §5.2).
 */
export const ILETIMERKEZI_UNDELIVERABLE_CODES: readonly string[] = ['450'];

/**
 * İletimerkezi (REST, `POST /v1/send-sms/json`), the TR pack's override (spec §19 Q20): one-way,
 * from the pack's approved alphanumeric title (`SITELOG`). The recipient goes without its `+`
 * (`905321234567`); the order id is the provider id. A response whose status code is not `200` is
 * a refusal, not retried; HTTP 429 and 5xx and network errors are retried. No İYS fields are sent:
 * these are operational texts to the customer's staff, and whether İYS applies is checked before
 * the first real send (spec §4.4, §9.1). Re-check the request against the provider's current
 * documentation then too: no real send has been made yet (spec §5.2).
 */
export function createIletimerkeziSmsTransport(
  creds: IletimerkeziCredentials,
  fetchImpl: FetchLike,
  apiBase: string = ILETIMERKEZI_API_BASE,
): SmsTransport {
  return {
    driver: 'iletimerkezi',
    async send(to: E164, body: string, opts: SmsSendOptions) {
      if (!opts.sender) {
        throw new SmsSendError('iletimerkezi: no sender title', {
          driver: 'iletimerkezi',
          retryable: false,
        });
      }
      const request = {
        request: {
          authentication: { key: creds.apiKey, hash: creds.apiHash },
          order: {
            sender: opts.sender,
            sendDateTime: [],
            message: { text: body, receipents: { number: [to.replace(/^\+/, '')] } },
          },
        },
      };
      let res: Response;
      try {
        res = await fetchImpl(`${apiBase}/v1/send-sms/json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(request),
        });
      } catch (err) {
        throw new SmsSendError(`iletimerkezi: ${errorText(err)}`, {
          driver: 'iletimerkezi',
          retryable: true,
        });
      }
      const json = (await res.json().catch(() => null)) as {
        response?: {
          status?: { code?: unknown; message?: unknown };
          order?: { id?: unknown };
        };
      } | null;
      const status = json?.response?.status;
      const code = status?.code === undefined || status?.code === null ? null : String(status.code);
      const orderId = json?.response?.order?.id;
      if (res.ok && code === '200' && (typeof orderId === 'string' || typeof orderId === 'number'))
        return { providerId: `iletimerkezi:${orderId}` };
      const message = typeof status?.message === 'string' ? status.message : res.statusText;
      throw new SmsSendError(`iletimerkezi ${res.status}${code ? ` ${code}` : ''}: ${message}`, {
        driver: 'iletimerkezi',
        retryable: res.status === 429 || res.status >= 500,
        undeliverable: code !== null && ILETIMERKEZI_UNDELIVERABLE_CODES.includes(code),
        code,
      });
    },
  };
}

// ───────────────────────────── The set ─────────────────────────────

export interface SmsTransportConfig {
  fetch: FetchLike;
  randomUUID: () => string;
  /** TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN; empty values count as missing. */
  twilio?: Partial<TwilioCredentials>;
  /** ILETIMERKEZI_API_KEY / ILETIMERKEZI_API_HASH. */
  iletimerkezi?: Partial<IletimerkeziCredentials>;
  /** Tests point the drivers at a mock server. */
  apiBase?: { twilio?: string; iletimerkezi?: string };
}

/**
 * The driver for a `pickMessageTransport()` answer. A provider driver without its credentials
 * throws `SmsConfigError` when it is asked for: a pack with a sender id in this database must have
 * its provider's credentials (spec §5.1), and nothing falls back to `console` silently.
 */
export function createSmsTransports(
  config: SmsTransportConfig,
): (driver: SmsDriver) => SmsTransport {
  const consoleDriver = createConsoleSmsTransport(config.randomUUID);
  return (driver) => {
    switch (driver) {
      case 'console':
        return consoleDriver;
      case 'twilio': {
        const sid = config.twilio?.accountSid?.trim();
        const token = config.twilio?.authToken?.trim();
        const missing = [
          ...(sid ? [] : ['TWILIO_ACCOUNT_SID']),
          ...(token ? [] : ['TWILIO_AUTH_TOKEN']),
        ];
        if (!sid || !token) throw new SmsConfigError('twilio', missing);
        return createTwilioSmsTransport(
          { accountSid: sid, authToken: token },
          config.fetch,
          config.apiBase?.twilio,
        );
      }
      case 'iletimerkezi': {
        const key = config.iletimerkezi?.apiKey?.trim();
        const hash = config.iletimerkezi?.apiHash?.trim();
        const missing = [
          ...(key ? [] : ['ILETIMERKEZI_API_KEY']),
          ...(hash ? [] : ['ILETIMERKEZI_API_HASH']),
        ];
        if (!key || !hash) throw new SmsConfigError('iletimerkezi', missing);
        return createIletimerkeziSmsTransport(
          { apiKey: key, apiHash: hash },
          config.fetch,
          config.apiBase?.iletimerkezi,
        );
      }
    }
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
