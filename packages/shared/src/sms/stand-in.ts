/**
 * W4-12 · the local SMS stand-in (`pnpm sms:stand-in`, scripts/src/sms-stand-in.ts): a tiny HTTP
 * server that answers Twilio's and İletimerkezi's send APIs and keeps what it was sent, so a
 * **real** (non-demo) org's welcome, device code and texts go out and are read back in tests
 * without a phone or a provider account. The worker and the edge functions reach it through
 * `TWILIO_API_BASE` and `ILETIMERKEZI_API_BASE`, read **only** when `SMS_PROVIDER_STUB=true`,
 * which only the local stack and CI set (as `SCHEDULER_CLOCK_OVERRIDE`; never a hosted project,
 * RUNBOOK; the worker refuses it in production). Unset, the drivers call the real providers.
 */

export interface SmsStandInEnv {
  SMS_PROVIDER_STUB?: string | boolean | null;
  TWILIO_API_BASE?: string | null;
  ILETIMERKEZI_API_BASE?: string | null;
}

/** The drivers' API bases (`SmsTransportConfig.apiBase`), or none: the real providers. */
export interface SmsApiBases {
  twilio?: string;
  iletimerkezi?: string;
}

/** SMS_PROVIDER_STUB set without both bases, or with a base that is not an http(s) URL. */
export class SmsStandInConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsStandInConfigError';
  }
}

function stubOn(value: SmsStandInEnv['SMS_PROVIDER_STUB']): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function base(name: string, value: string | null | undefined): string {
  const v = (value ?? '').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new SmsStandInConfigError(`SMS_PROVIDER_STUB=true needs ${name} (an http(s) URL)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new SmsStandInConfigError(`${name} must be an http(s) URL`);
  return v;
}

/**
 * The stand-in's bases when `SMS_PROVIDER_STUB=true` (both required: a stub for one provider and
 * the real API for the other would text real phones from a test), else `{}`.
 */
export function smsApiBases(env: SmsStandInEnv): SmsApiBases {
  if (!stubOn(env.SMS_PROVIDER_STUB)) return {};
  return {
    twilio: base('TWILIO_API_BASE', env.TWILIO_API_BASE),
    iletimerkezi: base('ILETIMERKEZI_API_BASE', env.ILETIMERKEZI_API_BASE),
  };
}

/** One text the stand-in received, as `GET /__stand-in/messages` lists it. */
export interface StandInMessage {
  /** `SM…` for Twilio, `iletimerkezi:<order>` for İletimerkezi: the provider id the driver stores. */
  id: string;
  provider: 'twilio' | 'iletimerkezi';
  /** `sms` or `whatsapp` (Twilio's `whatsapp:` addresses). */
  channel: 'sms' | 'whatsapp';
  /** E.164, without a `whatsapp:` prefix. */
  to: string;
  from: string;
  body: string;
  at: string;
}

/** The stand-in's own routes (not a provider's): the received texts, reset, health. */
export const SMS_STAND_IN_ROUTES = {
  messages: '/__stand-in/messages',
  health: '/__stand-in/health',
} as const;
