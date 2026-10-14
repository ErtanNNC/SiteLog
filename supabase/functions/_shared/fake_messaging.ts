import {
  createNotifier,
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
}

export function fakeMessaging(opts: { fail?: Error } = {}): FakeMessaging {
  const rows: OutboundMessageRow[] = [];
  const audits: NotifierAuditEntry[] = [];
  const sent: FakeMessaging['sent'] = [];
  const recipients = new Map<string, NotifyRecipient>();
  const store: NotifierStore = {
    loadRecipient: (id) => Promise.resolve(recipients.get(id) ?? null),
    findByDedupeKey: (reporterId, key) => {
      const row = rows.find((r) => r.reporter_id === reporterId && r.payload?.dedupe_key === key);
      return Promise.resolve(row ? { id: row.id, channel: row.channel, status: row.status } : null);
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
  const notifier = createNotifier({
    store,
    transport,
    statusCallbackUrl: null,
    randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { notifier, store, rows, audits, sent, recipients };
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
