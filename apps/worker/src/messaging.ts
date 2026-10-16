import {
  consentSets,
  jobKeys,
  createNotifier,
  createSmsTransports,
  toCountryPack,
  type CountryPack,
  type ChannelRegistration,
  type CountryRow,
  type InboundSmsStore,
  type NotifierStore,
  type PersonalLinkStore,
  type SmsDriver,
  type SmsNotifier,
  type SmsTransport,
} from '@sitelog/shared';
import { abortableFetch } from './abort';
import type { Config } from './config';
import type { Db } from './db';

/**
 * The worker's messaging (W1-08; spec §4.5, §4.6): the Notifier over the worker's Postgres store,
 * the SMS drivers with the credentials from the worker env, the org's country pack, and the
 * personal-link store. The edge functions build the same Notifier over supabase-js
 * (`supabase/functions/_shared/messaging.ts`).
 */

/** An org's country pack (`orgs.country` → `countries`), read fresh each time. */
export async function loadOrgPack(db: Db, org: { country: string }): Promise<CountryPack> {
  const row = await db.getCountry(org.country);
  if (!row) throw new Error(`No country pack ${org.country}`);
  return toCountryPack(row);
}

/** The Notifier's store over the worker Db. */
export function workerNotifierStore(db: Db): NotifierStore {
  return {
    async loadRecipient(reporterId) {
      const reporter = await db.getReporter(reporterId);
      if (!reporter) return null;
      const org = await db.getOrg(reporter.org_id);
      if (!org) return null;
      return {
        reporter,
        org: { id: org.id, isDemo: org.is_demo },
        pack: await loadOrgPack(db, org),
        consents: consentSets(await db.listConsents(reporterId)),
      };
    },
    listByDedupeKey: (reporterId, key) => db.listMessagesByDedupeKey(reporterId, key),
    insertMessage: (row) => db.insertSmsMessage(row),
    updateMessage: (id, patch) => db.updateSmsMessage(id, patch),
    isPhoneOptedOut: (phone, country) => db.isSmsOptedOut(phone, country),
    recordPhoneOptOut: (row) => db.recordSmsOptOut(row),
    optOutReporter: (reporterId, at) => db.optOutReporter(reporterId, at),
    audit: (entry) =>
      db.logAudit({
        org_id: entry.orgId,
        actor_type: 'system',
        action: entry.action,
        entity: entry.entity,
        entity_id: entry.entityId,
        diff: entry.diff,
      }),
  };
}

/** The inbound handler's store (`processInboundSms`, the sms_inbound job) over the worker Db. */
export function workerInboundStore(db: Db): InboundSmsStore {
  return {
    reportersByPhone: (phone, country, scope) => db.listInboundReporters(phone, country, scope),
    updateReporter: (id, patch) => db.updateReporter(id, patch),
    hasPendingUnknown: (phone, opts) =>
      db.hasPendingUnknownContact(phone, 'sms', opts?.excludeMessageId ?? null),
    insertUnknownContact: (row) => db.insertSmsUnknownContact(row),
    // The worker handles Twilio texts only (realOnly): real orgs of the pack.
    linkedContactOrgs: (phone, country) => db.linkedContactOrgs(phone, country),
    recordPhoneOptOut: (phone, country) =>
      db.recordSmsOptOut({ phone_e164: phone, country, method: 'sms_keyword' }),
    clearPhoneOptOut: (phone, country) => db.clearSmsOptOut(phone, country),
    markHandled: (messageId, at) => db.markSmsHandled(messageId, at),
    // W2-12: OK, NO WORK, WEATHER and EDIT are answered by the sms_keyword job.
    async enqueueSmsKeyword(messageId) {
      await db.enqueueJob(
        'sms_keyword',
        { messageId },
        { dedupeKey: jobKeys.smsKeyword(messageId) },
      );
    },
    async notifyOrg(n) {
      await db.notifyOrg(n.orgId, n.kind, n.title, n.body, n.targetPath, null, n.data);
    },
    audit: (entry) =>
      db.logAudit({
        org_id: entry.orgId,
        actor_type: entry.actorType,
        actor_id: entry.actorId ?? null,
        action: entry.action,
        entity: entry.entity,
        entity_id: entry.entityId,
        diff: entry.diff,
      }),
    // The change, its audit row and the office's notice in one transaction (sql.begin).
    applyChange: (change, entry, notification) =>
      db.applyInboundChange({
        reporterId: change.reporterId,
        patch: change.patch,
        audit: {
          org_id: entry.orgId,
          actor_type: entry.actorType,
          actor_id: entry.actorId ?? null,
          action: entry.action,
          entity: entry.entity,
          entity_id: entry.entityId,
          diff: entry.diff,
        },
        notification,
      }),
    links: workerLinkStore(db),
  };
}

export function workerLinkStore(db: Db): PersonalLinkStore {
  return {
    listPersonalLinks: (reporterId) => db.listPersonalLinks(reporterId),
    insertPersonalLink: (row) => db.insertPersonalLink(row),
  };
}

/** The SMS drivers with the worker env's credentials. */
export function workerTransports(
  config: Pick<
    Config,
    'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'ILETIMERKEZI_API_KEY' | 'ILETIMERKEZI_API_HASH'
  >,
  fetchImpl: typeof fetch = abortableFetch(),
): (driver: SmsDriver) => SmsTransport {
  return createSmsTransports({
    fetch: (url, init) => fetchImpl(url, init),
    randomUUID: () => crypto.randomUUID(),
    twilio: { accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN },
    iletimerkezi: { apiKey: config.ILETIMERKEZI_API_KEY, apiHash: config.ILETIMERKEZI_API_HASH },
  });
}

/** Twilio's delivery callbacks go to sms-webhook's /status route when it has a public URL. */
export function statusCallbackUrl(
  config: Pick<Config, 'SMS_WEBHOOK_URL' | 'SUPABASE_URL'>,
): string | null {
  const base =
    config.SMS_WEBHOOK_URL.trim().replace(/\/+$/, '') ||
    (config.SUPABASE_URL
      ? `${config.SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/sms-webhook`
      : '');
  return base.startsWith('https://') ? `${base}/status` : null;
}

export function createWorkerNotifier(
  config: Config,
  db: Db,
  transport: (driver: SmsDriver) => SmsTransport = workerTransports(config),
  now: () => Date = () => new Date(),
  /** Message channels besides SMS (W2-01): push (W2-14) and WhatsApp (W2-15) register here. */
  channels: readonly ChannelRegistration[] = [],
): SmsNotifier {
  return createNotifier({
    store: workerNotifierStore(db),
    transport,
    channels,
    statusCallbackUrl: statusCallbackUrl(config),
    randomUUID: () => crypto.randomUUID(),
    now,
  });
}

/**
 * One line per pack for the worker's start log: which SMS transport a real org of the pack gets
 * in this database. Demo orgs always get `console`.
 */
export function describePackTransports(rows: readonly CountryRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => [
      row.code,
      row.sms_sender_id ? `${row.sms_provider} (${row.sms_sender_id})` : 'console: no sender id',
    ]),
  );
}
