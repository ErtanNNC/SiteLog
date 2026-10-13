import type { SmsKey, SmsVars } from './copy/sms.ts';
import { assertE164, type E164 } from './format.ts';

/**
 * §4.5 Channel layer: every field interaction goes through these interfaces, so a channel can be
 * added later without touching the pipeline. Types and pure helpers only; the drivers (Twilio,
 * İletimerkezi, console) arrive with W1-08 and the calls with week 2.
 */

/**
 * How a report reached SiteLog (§4.5): `web`, `voice` or `sms`. It mirrors the Postgres enum
 * `field_channel` (§6.2, `enums.ts`), which also has `office` for reports typed in the panel (D13).
 */
export type { FieldChannel } from './enums.ts';

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

export interface Notifier {
  /** Picks the SMS text by the reporter's locale; respects opt-out, quiet hours and two-way capability. */
  text<K extends SmsKey>(reporterId: string, key: K, vars: SmsVars<K>): Promise<void>;
  /** Places an outbound call if the reporter prefers calls, has auto-call consent and is inside the call window. */
  call(reporterId: string, purpose: CallPurpose, ctx: CallContext): Promise<void>;
}

/** SMS drivers, picked per org country from env (`SMS_US_PROVIDER` / `SMS_TR_PROVIDER`). */
export const SMS_DRIVERS = ['twilio', 'iletimerkezi', 'console'] as const;
export type SmsDriver = (typeof SMS_DRIVERS)[number];

export interface SmsSendOptions {
  /** Alphanumeric sender title (TR: `SITELOG`) or the sending number. */
  sender?: string;
  /** Delivery-status webhook (Twilio). */
  statusCallback?: string;
}

export interface SmsTransport {
  send(to: E164, body: string, opts: SmsSendOptions): Promise<{ providerId: string }>;
  /** twilio: true · iletimerkezi: false · console: true (demo inbox). */
  twoWay: boolean;
}

/** §4.5: which drivers can receive replies. */
export const SMS_DRIVER_TWO_WAY: Readonly<Record<SmsDriver, boolean>> = {
  twilio: true,
  iletimerkezi: false,
  console: true,
};

/** Org countries (§6.3 `orgs.country`). */
export type OrgCountry = 'US' | 'TR';

/** Drivers each country may use (§5.1: US `twilio | console`, TR `iletimerkezi | console`). */
export const SMS_DRIVERS_BY_COUNTRY: Readonly<Record<OrgCountry, readonly SmsDriver[]>> = {
  US: ['twilio', 'console'],
  TR: ['iletimerkezi', 'console'],
};

/** The env values the channel helpers read (§5.1). Missing values mean "not set up". */
export interface ChannelEnv {
  SMS_US_PROVIDER?: string;
  SMS_TR_PROVIDER?: string;
  VOICE_NUMBER_US?: string;
  VOICE_NUMBER_TR?: string;
}

/**
 * §4.5 / §5.2: the SMS driver for an org. Demo orgs always use `console`, so they never text real
 * people; otherwise the country's env setting, `console` when unset. A driver that does not serve
 * the country (e.g. `SMS_TR_PROVIDER=twilio`) is a configuration error and throws.
 */
export function pickSmsDriver(
  org: { country: OrgCountry; isDemo: boolean },
  env: ChannelEnv,
): SmsDriver {
  if (org.isDemo) return 'console';
  const raw = (org.country === 'US' ? env.SMS_US_PROVIDER : env.SMS_TR_PROVIDER)?.trim() ?? '';
  if (raw === '') return 'console';
  const allowed = SMS_DRIVERS_BY_COUNTRY[org.country];
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `SMS_${org.country}_PROVIDER=${raw} is not a ${org.country} SMS driver (${allowed.join(' | ')})`,
    );
  }
  return raw as SmsDriver;
}

/**
 * The SiteLog voice number for an org's country, or null when there is none yet (§9.2 "No voice
 * number yet": `VOICE_NUMBER_TR` empty). Feeds `renderSms(..., { hasVoiceNumber })`.
 */
export function voiceNumberFor(country: OrgCountry, env: ChannelEnv): E164 | null {
  const raw = (country === 'US' ? env.VOICE_NUMBER_US : env.VOICE_NUMBER_TR)?.trim() ?? '';
  if (raw === '') return null;
  return assertE164(raw); // a malformed number is a configuration error: throw, do not drop it
}
