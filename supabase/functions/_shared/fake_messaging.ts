import {
  createNotifier,
  createWhatsappRegistration,
  type NotifierAuditEntry,
  type NotifierStore,
  type NotifyRecipient,
  type OutboundMessageRow,
  type PersonalLinkStore,
  type SmsDriver,
  type SmsNotifier,
  type SmsTransport,
} from '@sitelog/shared';

/**
 * In-memory messaging for the Deno tests: a Notifier over a recording store, drivers that record
 * what they would send (no HTTP), and a personal-link store.
 */
export interface FakeMessaging {
  notifier: SmsNotifier;
  store: NotifierStore;
  rows: OutboundMessageRow[];
  audits: NotifierAuditEntry[];
  sent: Array<{ driver: SmsDriver; to: string; body: string; sender?: string }>;
  recipients: Map<string, NotifyRecipient>;
  /** `sms_opt_outs` as `phone:country`. */
  phoneOptOuts: Set<string>;
  reporterOptOuts: Array<{ reporterId: string; at: string }>;
  /** W2-15/16: WhatsApp messages the Twilio driver sent (the forms it posted). */
  waSent: URLSearchParams[];
}

export function fakeMessaging(
  opts: {
    fail?: Error;
    /** The person's last inbound WhatsApp message (the 24-hour window); default: just now. */
    lastInbound?: string | null;
  } = {},
): FakeMessaging {
  const rows: OutboundMessageRow[] = [];
  const audits: NotifierAuditEntry[] = [];
  const sent: FakeMessaging['sent'] = [];
  const recipients = new Map<string, NotifyRecipient>();
  const phoneOptOuts = new Set<string>();
  const reporterOptOuts: FakeMessaging['reporterOptOuts'] = [];
  const store: NotifierStore = {
    loadRecipient: (id) => Promise.resolve(recipients.get(id) ?? null),
    listByDedupeKey: (reporterId, key) =>
      Promise.resolve(
        rows
          .filter((r) => r.reporter_id === reporterId && r.payload?.dedupe_key === key)
          .map((row) => ({
            id: row.id,
            channel: row.channel,
            status: row.status,
            provider: row.provider,
            provider_message_id: row.provider_message_id,
            error: row.error,
            error_code: row.payload?.error_code ?? null,
            attempt: row.payload?.attempt ?? null,
            tries: row.payload?.tries ?? null,
          })),
      ),
    isPhoneOptedOut: (phone, country) => Promise.resolve(phoneOptOuts.has(`${phone}:${country}`)),
    recordPhoneOptOut: (row) => {
      phoneOptOuts.add(`${row.phone_e164}:${row.country}`);
      return Promise.resolve();
    },
    optOutReporter: (reporterId, at) => {
      reporterOptOuts.push({ reporterId, at });
      return Promise.resolve();
    },
    insertMessage: (row) => {
      rows.push({ ...row });
      return Promise.resolve();
    },
    updateMessage: (id, patch) => {
      Object.assign(
        rows.find((r) => r.id === id)!,
        patch,
      );
      return Promise.resolve();
    },
    audit: (entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let n = 0;
  const transport = (driver: SmsDriver): SmsTransport => ({
    driver,
    send(to, body, o) {
      if (opts.fail) return Promise.reject(opts.fail);
      sent.push({ driver, to, body, sender: o.sender });
      return Promise.resolve({ providerId: `${driver}:${sent.length}` });
    },
  });
  const waSent: URLSearchParams[] = [];
  // WhatsApp (W2-15): console for demo orgs; Twilio, recorded, for a pack with a WhatsApp sender.
  const whatsapp = createWhatsappRegistration({
    fetch: (_url, init) => {
      waSent.push(new URLSearchParams(String(init.body)));
      return Promise.resolve(
        new Response(JSON.stringify({ sid: `SMwa${waSent.length}` }), { status: 201 }),
      );
    },
    twilio: () => ({ accountSid: 'AC1', authToken: 'tok' }),
    statusCallbackUrl: null,
    // The message being answered opened the window, unless a test closes it.
    lastInbound: () =>
      Promise.resolve(opts.lastInbound === undefined ? new Date().toISOString() : opts.lastInbound),
    randomUUID: () => crypto.randomUUID(),
  });
  const notifier = createNotifier({
    store,
    transport,
    channels: [whatsapp],
    statusCallbackUrl: null,
    randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return {
    notifier,
    store,
    rows,
    audits,
    sent,
    recipients,
    phoneOptOuts,
    reporterOptOuts,
    waSent,
  };
}

/** Personal links in memory (`ensurePersonalLink`). */
export function fakeLinkStore(): PersonalLinkStore & {
  links: Array<{ id: string; code_hash: string; reporter_id: string }>;
} {
  const links: Array<{ id: string; code_hash: string; reporter_id: string }> = [];
  return {
    links,
    listPersonalLinks: (reporterId) =>
      Promise.resolve(links.filter((l) => l.reporter_id === reporterId).reverse()),
    insertPersonalLink: (row) => {
      if (links.some((l) => l.code_hash === row.code_hash)) return Promise.resolve(false);
      links.push(row);
      return Promise.resolve(true);
    },
  };
}
