import {
  consentSets,
  createNotifier,
  createSmsTransports,
  toCountryPack,
  type CountryRow,
  type Json,
  type NotifierStore,
  type PersonalLinkStore,
  type SmsDriver,
  type SmsNotifier,
  type SmsTransport,
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
 * ILETIMERKEZI_API_KEY, ILETIMERKEZI_API_HASH (only for packs whose sender id is set here), and
 * SMS_WEBHOOK_URL (the public URL of sms-webhook, default `{SUPABASE_URL}/functions/v1/sms-webhook`).
 */

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
      },
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
    async findByDedupeKey(reporterId, dedupeKey) {
      const { data } = await admin
        .from('messages')
        .select('id, channel, status')
        .eq('reporter_id', reporterId)
        .eq('payload->>dedupe_key', dedupeKey)
        .order('created_at', { ascending: false })
        .limit(1)
        .throwOnError();
      return data[0] ?? null;
    },
    async insertMessage(row) {
      await admin
        .from('messages')
        .insert({ ...row, payload: row.payload as Json | null })
        .throwOnError();
    },
    async updateMessage(id, patch) {
      await admin.from('messages').update(patch).eq('id', id).throwOnError();
    },
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

/** The Notifier of an edge function: supabase-js store, env drivers, sms-webhook status URL. */
export function edgeNotifier(admin: AppClient): SmsNotifier {
  return createNotifier({
    store: supabaseNotifierStore(admin),
    transport: smsTransportsFromEnv(),
    statusCallbackUrl: statusCallbackUrl(),
    randomUUID: () => crypto.randomUUID(),
  });
}
