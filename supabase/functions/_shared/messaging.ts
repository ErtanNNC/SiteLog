import {
  attemptNumber,
  consentSets,
  createNotifier,
  createSmsTransports,
  createWhatsappRegistration,
  type ChannelRegistration,
  toCountryPack,
  type CountryRow,
  type Json,
  type LastWhatsappOutbound,
  type NotifierStore,
  type PersonalLinkStore,
  type SmsDriver,
  type SmsNotifier,
  type SmsTransport,
  smsApiBases,
} from '@sitelog/shared';
import { logAudit } from './audit.ts';
import { optionalEnv } from './env.ts';
import type { AppClient } from './supabase.ts';

/**
 * Messaging for the edge functions (W1-08; spec §4.5, §5.1): the Notifier over supabase-js with
 * the service role, the SMS drivers with their credentials from the function env, and the
 * personal-link store. field-api (device code), api-invite-reporter (the personal link) and
 * sms-webhook (keyword replies) build on it; the worker has its own store over Postgres.
 *
 * Env (read when a message goes out, never at import): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * ILETIMERKEZI_API_KEY, ILETIMERKEZI_API_HASH (only for packs whose sender id is set here),
 * ILETIMERKEZI_IYS (spec §19 Q49: `informational` by default, or `commercial`), and
 * SMS_WEBHOOK_URL (the public URL of sms-webhook, default `{SUPABASE_URL}/functions/v1/sms-webhook`).
 * Test only (W4-12): SMS_PROVIDER_STUB=true with TWILIO_API_BASE and ILETIMERKEZI_API_BASE sends
 * the texts to the local SMS stand-in instead of the providers (the local stack and CI; never a
 * hosted project).
 */

/** The local SMS stand-in's bases (W4-12), or none: read only when SMS_PROVIDER_STUB=true. */
export function smsApiBasesFromEnv(): { twilio?: string; iletimerkezi?: string } {
  return smsApiBases({
    SMS_PROVIDER_STUB: optionalEnv('SMS_PROVIDER_STUB'),
    TWILIO_API_BASE: optionalEnv('TWILIO_API_BASE'),
    ILETIMERKEZI_API_BASE: optionalEnv('ILETIMERKEZI_API_BASE'),
  });
}

/** The public URL of sms-webhook as Twilio calls it (status callbacks, signature checks). */
export function smsWebhookUrl(): string | null {
  const configured = optionalEnv('SMS_WEBHOOK_URL');
  if (configured) return configured.replace(/\/+$/, '');
  const base = optionalEnv('SUPABASE_URL');
  return base ? `${base.replace(/\/+$/, '')}/functions/v1/sms-webhook` : null;
}

/** Twilio's StatusCallback: sms-webhook's /status route, when it has a public (https) URL. */
export function statusCallbackUrl(webhookUrl: string | null = smsWebhookUrl()): string | null {
  return webhookUrl && webhookUrl.startsWith('https://') ? `${webhookUrl}/status` : null;
}

/** The SMS drivers with the env's credentials (a provider driver without them throws). */
export function smsTransportsFromEnv(
  fetchImpl: typeof fetch = fetch,
): (driver: SmsDriver) => SmsTransport {
  return (driver) =>
    createSmsTransports({
      fetch: (url, init) => fetchImpl(url, init),
      randomUUID: () => crypto.randomUUID(),
      twilio: {
        accountSid: optionalEnv('TWILIO_ACCOUNT_SID'),
        authToken: optionalEnv('TWILIO_AUTH_TOKEN'),
      },
      iletimerkezi: {
        apiKey: optionalEnv('ILETIMERKEZI_API_KEY'),
        apiHash: optionalEnv('ILETIMERKEZI_API_HASH'),
        // Spec §19 Q49 (W4-11): the TR texts' İYS type, `informational` when unset.
        iys: optionalEnv('ILETIMERKEZI_IYS'),
      },
      apiBase: smsApiBasesFromEnv(),
    })(driver);
}

/** `NotifierStore` over supabase-js (service role). */
export function supabaseNotifierStore(admin: AppClient): NotifierStore {
  return {
    async loadRecipient(reporterId) {
      const { data: reporter } = await admin
        .from('reporters')
        .select('id, org_id, phone_e164, locale, status, message_channel')
        .eq('id', reporterId)
        .maybeSingle()
        .throwOnError();
      if (!reporter) return null;
      const { data: org } = await admin
        .from('orgs')
        .select('id, country, is_demo')
        .eq('id', reporter.org_id)
        .single()
        .throwOnError();
      const [{ data: country }, { data: consents }] = await Promise.all([
        admin.from('countries').select('*').eq('code', org.country).single().throwOnError(),
        admin
          .from('consents')
          .select('type, revoked_at')
          .eq('reporter_id', reporterId)
          .throwOnError(),
      ]);
      return {
        reporter,
        org: { id: org.id, isDemo: org.is_demo },
        pack: toCountryPack(country as CountryRow),
        consents: consentSets(consents),
      };
    },
    async listByDedupeKey(reporterId, dedupeKey) {
      const { data } = await admin
        .from('messages')
        .select('id, channel, status, provider, provider_message_id, error, payload')
        .eq('reporter_id', reporterId)
        .eq('payload->>dedupe_key', dedupeKey)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .throwOnError();
      // Every attempt (W2-01), with the provider's code of a refused send, so a replay throws
      // the same refusal, and the attempt number.
      return data.map(({ payload, ...prior }) => {
        const code = (payload as { error_code?: unknown } | null)?.error_code;
        const tries = (payload as { tries?: unknown } | null)?.tries;
        return {
          ...prior,
          error_code: typeof code === 'string' ? code : null,
          attempt: attemptNumber(payload),
          tries: typeof tries === 'number' ? tries : null,
        };
      });
    },
    async insertMessage(row) {
      await admin
        .from('messages')
        .insert({ ...row, payload: row.payload as Json | null })
        .throwOnError();
    },
    async updateMessage(id, { payload, ...patch }) {
      await admin
        .from('messages')
        .update(payload === undefined ? patch : { ...patch, payload: payload as Json | null })
        .eq('id', id)
        .throwOnError();
    },
    isPhoneOptedOut: (phone, country) => phoneOptedOut(admin, phone, country),
    async recordPhoneOptOut(row) {
      await admin
        .from('sms_opt_outs')
        .upsert(row, { onConflict: 'phone_e164,country', ignoreDuplicates: true })
        .throwOnError();
    },
    optOutReporter: (reporterId, at) => optOutReporter(admin, reporterId, at),
    async audit(entry) {
      await logAudit(admin, {
        orgId: entry.orgId,
        actorType: 'system',
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        diff: entry.diff as Json,
      });
    },
  };
}

/** `sms_opt_outs`: the phone sent STOP on the pack's sender, or its provider refused it as unsubscribed. */
export async function phoneOptedOut(
  admin: AppClient,
  phone: string,
  country: string,
): Promise<boolean> {
  const { data } = await admin
    .from('sms_opt_outs')
    .select('phone_e164')
    .eq('phone_e164', phone)
    .eq('country', country)
    .maybeSingle()
    .throwOnError();
  return data !== null;
}

/**
 * The reporter row follows an opt-out: `opted_out` with `opted_out_at`, except a disabled reporter,
 * who keeps `disabled` and gets `opted_out_at` (a re-invite then lands opted out). An
 * `opted_out_at` already set is kept.
 */
export async function optOutReporter(admin: AppClient, reporterId: string, at: string) {
  const { data } = await admin
    .from('reporters')
    .select('status, opted_out_at')
    .eq('id', reporterId)
    .maybeSingle()
    .throwOnError();
  if (!data) return;
  await admin
    .from('reporters')
    .update({
      ...(data.status === 'disabled' ? {} : { status: 'opted_out' as const }),
      opted_out_at: data.opted_out_at ?? at,
    })
    .eq('id', reporterId)
    .throwOnError();
}

/** `PersonalLinkStore` over supabase-js: live personal links, newest first; unique hash → false. */
export function supabaseLinkStore(admin: AppClient): PersonalLinkStore {
  return {
    async listPersonalLinks(reporterId) {
      const { data } = await admin
        .from('field_links')
        .select('id, code_hash')
        .eq('reporter_id', reporterId)
        .eq('kind', 'personal')
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
        .throwOnError();
      return data;
    },
    async insertPersonalLink(row) {
      const { error } = await admin.from('field_links').insert({ ...row, kind: 'personal' });
      if (!error) return true;
      if (error.code === '23505') return false;
      throw error;
    },
  };
}

/**
 * When the phone last wrote to `sender` (the pack's WhatsApp sender) through Twilio (W2-15): the
 * start of its 24-hour window there, or null. A Demo phone (console) row or a message to another
 * sender never opens it (W2-15/16 review).
 */
export async function lastInboundWhatsapp(
  admin: AppClient,
  phone: string,
  sender: string,
): Promise<string | null> {
  const { data } = await admin
    .from('messages')
    .select('created_at')
    .eq('phone_e164', phone)
    .eq('channel', 'whatsapp')
    .eq('direction', 'in')
    .eq('provider', 'twilio')
    .eq('payload->>to', sender)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .throwOnError();
  return data?.created_at ?? null;
}

/**
 * §19 Q372: the latest outbound WhatsApp message Twilio took for the phone, or null
 * (`whatsappFailedSinceInbound`: a late failure since the person last wrote moves them to SMS).
 */
export async function lastOutboundWhatsapp(
  admin: AppClient,
  phone: string,
): Promise<LastWhatsappOutbound | null> {
  const { data } = await admin
    .from('messages')
    .select('status, provider_message_id, created_at')
    .eq('phone_e164', phone)
    .eq('channel', 'whatsapp')
    .eq('direction', 'out')
    .eq('provider', 'twilio')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .throwOnError();
  return data ?? null;
}

/**
 * The WhatsApp channel of an edge function (W2-15): Twilio with the env's account (the SMS one),
 * the window read with the service role. sms-webhook's replies on WhatsApp (W2-16), field-api's and
 * the panel's inline texts go through it.
 */
export function edgeWhatsappRegistration(
  admin: AppClient,
  fetchImpl: typeof fetch = fetch,
): ChannelRegistration {
  return createWhatsappRegistration({
    fetch: (url, init) => fetchImpl(url, init),
    twilio: () => ({
      accountSid: optionalEnv('TWILIO_ACCOUNT_SID'),
      authToken: optionalEnv('TWILIO_AUTH_TOKEN'),
    }),
    statusCallbackUrl: statusCallbackUrl(),
    lastInbound: (phone, sender) => lastInboundWhatsapp(admin, phone, sender),
    lastOutbound: (phone) => lastOutboundWhatsapp(admin, phone),
    randomUUID: () => crypto.randomUUID(),
    get apiBase() {
      return smsApiBasesFromEnv().twilio;
    },
  });
}

/**
 * The Notifier of an edge function: supabase-js store, env drivers, sms-webhook status URL, and
 * WhatsApp (W2-15). Push is the worker's only (W2-14).
 */
export function edgeNotifier(admin: AppClient): SmsNotifier {
  return createNotifier({
    store: supabaseNotifierStore(admin),
    transport: smsTransportsFromEnv(),
    channels: [edgeWhatsappRegistration(admin)],
    statusCallbackUrl: statusCallbackUrl(),
    randomUUID: () => crypto.randomUUID(),
  });
}
