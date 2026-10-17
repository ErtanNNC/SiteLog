import {
  consentSets,
  jobKeys,
  createIletimerkeziReportSource,
  createNotifier,
  ILETIMERKEZI_REPORT_ENDPOINT,
  type IletimerkeziReportEndpoint,
  type IletimerkeziReportSource,
  createSmsTransports,
  smsApiBases,
  createWhatsappRegistration,
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
import { createPushRegistration } from './push';
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
      db.hasPendingUnknownContact(phone, opts?.channel ?? 'sms', opts?.excludeMessageId ?? null),
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
    // W2-16 (§19 Q26): a WhatsApp text that may answer an open web question.
    async enqueueWhatsappAnswer(messageId) {
      await db.enqueueJob(
        'whatsapp_answer',
        { messageId },
        { dedupeKey: jobKeys.whatsappAnswer(messageId) },
      );
    },
    // W2-16 (§19 Q40, Q112): STOP / START on WhatsApp.
    whatsappConsent: (reporterId, grant, messageId) =>
      db.inboundWhatsappConsent(reporterId, grant, messageId),
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

/** The local SMS stand-in's settings (W4-12; test only, `SMS_PROVIDER_STUB`). */
type StandInConfig = Partial<
  Pick<Config, 'SMS_PROVIDER_STUB' | 'TWILIO_API_BASE' | 'ILETIMERKEZI_API_BASE'>
>;

/** The SMS drivers with the worker env's credentials (and the stand-in's bases, W4-12). */
export function workerTransports(
  config: Pick<
    Config,
    | 'TWILIO_ACCOUNT_SID'
    | 'TWILIO_AUTH_TOKEN'
    | 'ILETIMERKEZI_API_KEY'
    | 'ILETIMERKEZI_API_HASH'
    | 'ILETIMERKEZI_IYS'
  > &
    StandInConfig,
  fetchImpl: typeof fetch = abortableFetch(),
): (driver: SmsDriver) => SmsTransport {
  return createSmsTransports({
    fetch: (url, init) => fetchImpl(url, init),
    randomUUID: () => crypto.randomUUID(),
    twilio: { accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN },
    iletimerkezi: {
      apiKey: config.ILETIMERKEZI_API_KEY,
      apiHash: config.ILETIMERKEZI_API_HASH,
      iys: config.ILETIMERKEZI_IYS,
    },
    apiBase: smsApiBases(config),
  });
}

/**
 * The İletimerkezi delivery reports (W4-11, spec §19 Q237) with the worker env's credentials, or
 * null when there is nothing to read them with: `ILETIMERKEZI_STATUS=off`, no credentials, or the
 * report endpoint not confirmed yet (`ILETIMERKEZI_REPORT_ENDPOINT`, §19 Q280). Tests pass the
 * fixture endpoint and a mock server.
 */
export function workerIletimerkeziReports(
  config: Pick<Config, 'ILETIMERKEZI_API_KEY' | 'ILETIMERKEZI_API_HASH' | 'ILETIMERKEZI_STATUS'> &
    StandInConfig,
  fetchImpl: typeof fetch = abortableFetch(),
  endpoint: IletimerkeziReportEndpoint | null = ILETIMERKEZI_REPORT_ENDPOINT,
  apiBase: string | undefined = smsApiBases(config).iletimerkezi,
): IletimerkeziReportSource | null {
  const apiKey = config.ILETIMERKEZI_API_KEY.trim();
  const apiHash = config.ILETIMERKEZI_API_HASH.trim();
  if (config.ILETIMERKEZI_STATUS !== 'poll' || !endpoint || !apiKey || !apiHash) return null;
  return createIletimerkeziReportSource(
    { apiKey, apiHash },
    (url, init) => fetchImpl(url, init),
    endpoint,
    apiBase,
  );
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
  /** Message channels besides SMS (W2-01): push (W2-14) and WhatsApp (W2-15) by default. */
  channels: readonly ChannelRegistration[] = [
    workerPushRegistration(config, db),
    workerWhatsappRegistration(config, db),
  ],
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
 * The WhatsApp channel (W2-15) through Twilio, with the worker env's Twilio account (the SMS one,
 * spec §4.4) and the 24-hour window read from its Db.
 */
export function workerWhatsappRegistration(
  config: Pick<
    Config,
    'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'SMS_WEBHOOK_URL' | 'SUPABASE_URL'
  > &
    StandInConfig,
  db: Pick<Db, 'lastInboundWhatsapp'>,
  fetchImpl: typeof fetch = abortableFetch(),
  now: () => Date = () => new Date(),
): ChannelRegistration {
  const apiBase = smsApiBases(config).twilio;
  return createWhatsappRegistration({
    fetch: (url, init) => fetchImpl(url, init),
    twilio: () => ({ accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN }),
    statusCallbackUrl: statusCallbackUrl(config),
    lastInbound: (phone, sender) => db.lastInboundWhatsapp(phone, sender),
    randomUUID: () => crypto.randomUUID(),
    now,
    ...(apiBase ? { apiBase } : {}),
  });
}

/** The push channel (W2-14) with the worker env's VAPID key pair and its Db. */
export function workerPushRegistration(
  config: Config,
  db: Db,
  fetchImpl: typeof fetch = abortableFetch(),
): ChannelRegistration {
  return createPushRegistration({
    config,
    store: db,
    fetch: (url, init) => fetchImpl(url, init),
    randomUUID: () => crypto.randomUUID(),
  });
}

/**
 * One line per pack for the worker's start log: which SMS (and, W2-15, WhatsApp) transport a real
 * org of the pack gets in this database. Demo orgs always get `console`.
 */
export function describePackTransports(rows: readonly CountryRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => {
      const sms = row.sms_sender_id
        ? `${row.sms_provider} (${row.sms_sender_id})`
        : 'console: no sender id';
      const wa = row.whatsapp_sender_id
        ? `whatsapp ${row.whatsapp_provider} (${row.whatsapp_sender_id})`
        : 'whatsapp: no sender id';
      return [row.code, `${sms}; ${wa}`];
    }),
  );
}
