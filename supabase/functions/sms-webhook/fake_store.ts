import type {
  CountryRow,
  InboundReporterRow,
  InboundSmsAudit,
  InboundScope,
  JobPayloads,
  MemberRole,
  MsgStatus,
  ReporterRow,
} from '@sitelog/shared';
import { fakeLinkStore } from '../_shared/fake_messaging.ts';
import type {
  InboundMessageRow,
  OfficeNotification,
  OutboundMessageState,
  SmsWebhookStore,
} from './store.ts';

interface FakeReporter extends InboundReporterRow {
  orgCountry: string;
  lastInviteError?: string | null;
}

/** sms-webhook's store in memory, for the Deno tests. */
export class FakeSmsStore implements SmsWebhookStore {
  countries: CountryRow[] = [];
  reporters: FakeReporter[] = [];
  inbound: Array<InboundMessageRow & { handled_at?: string; status: MsgStatus }> = [];
  /** The worker's jobs the inbound route enqueued (`sms_inbound`), with their dedupe keys. */
  jobs: Array<{ id: number; messageId: string; dedupeKey: string }> = [];
  /** The `notify` jobs in the queue: those that sent messages, and the fallbacks queued (W2-01). */
  notifyJobs: Array<{ id: number; payload: JobPayloads['notify']; dedupeKey: string }> = [];
  /** Outbound rows the status route updates (provider id → row). */
  outbound: Array<OutboundMessageState & { provider_message_id: string; error: string | null }> =
    [];
  unknown: Array<{
    id: string;
    phone_e164: string;
    message_id: string;
    snippet: string;
    org_id: string | null;
    status: 'pending';
    channel?: 'sms' | 'whatsapp';
  }> = [];
  /** `sms_opt_outs` as `phone:country`. */
  phoneOptOuts = new Set<string>();
  notifications: OfficeNotification[] = [];
  audits: InboundSmsAudit[] = [];
  members: Array<{ userId: string; orgId: string; role: MemberRole }> = [];
  links = fakeLinkStore();
  /** Makes markHandled throw once (a crash after the work, before the mark). */
  failMarkOnce = false;
  /** `sms.provider_fault` audit rows with `notified: true` written before the test (org → at). */
  priorFaultNotices: Array<{ orgId: string; at: string }> = [];

  packBySender(to: string) {
    return Promise.resolve(this.countries.find((c) => c.sms_sender_id === to.trim()) ?? null);
  }

  packByWhatsappSender(to: string) {
    return Promise.resolve(this.countries.find((c) => c.whatsapp_sender_id === to.trim()) ?? null);
  }

  /** W2-16: the `whatsapp_answer` jobs queued, by message id. */
  answerJobs: string[] = [];
  /** W2-16: reporters' whatsapp consents (`held` / `revoked`). */
  waConsent = new Map<string, 'held' | 'revoked'>();

  enqueueWhatsappAnswer(messageId: string) {
    if (!this.answerJobs.includes(messageId)) this.answerJobs.push(messageId);
    return Promise.resolve();
  }

  whatsappConsent(reporterId: string, grant: boolean) {
    const now = this.waConsent.get(reporterId);
    if (!grant && now === 'held') {
      this.waConsent.set(reporterId, 'revoked');
      return Promise.resolve(true);
    }
    if (grant && now === 'revoked') {
      this.waConsent.set(reporterId, 'held');
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  reportersByPhone(phone: string, country: string, scope: InboundScope) {
    return Promise.resolve(
      this.reporters
        .filter(
          (r) =>
            r.phone === phone &&
            r.orgCountry === country &&
            ('realOnly' in scope ? !r.orgIsDemo : r.orgId === scope.orgId),
        )
        .map(({ orgCountry: _c, lastInviteError: _e, ...r }) => ({ ...r })),
    );
  }

  /** receive_sms_inbound(): the row, its `sms.received` audit and (Twilio) its job together. */
  receiveInbound(row: InboundMessageRow) {
    let message = this.inbound.find((m) => m.provider_message_id === row.provider_message_id);
    const duplicate = Boolean(message);
    if (!message) {
      message = { ...row, status: 'received' };
      this.inbound.push(message);
      this.audits.push({
        orgId: row.org_id,
        actorType: row.reporter_id ? 'reporter' : 'system',
        actorId: row.reporter_id,
        action: `${row.channel ?? 'sms'}.received`,
        entity: 'message',
        entityId: row.id,
        diff: { provider: row.provider, keyword: row.payload.keyword, pack: row.payload.pack },
      });
    }
    const handled = Boolean(message.handled_at);
    let jobId: number | null = null;
    if (row.provider === 'twilio' && !handled) {
      const dedupeKey = `sms_inbound:${row.provider_message_id}`;
      const existing = this.jobs.find((j) => j.dedupeKey === dedupeKey);
      jobId = existing?.id ?? this.jobs.length + 1;
      if (!existing) this.jobs.push({ id: jobId, messageId: message.id, dedupeKey });
    }
    return Promise.resolve({ id: message.id, duplicate, handled, jobId });
  }

  markHandled(id: string, at: string) {
    if (this.failMarkOnce) {
      this.failMarkOnce = false;
      return Promise.reject(new Error('connection lost'));
    }
    this.inbound.find((m) => m.id === id)!.handled_at = at;
    return Promise.resolve();
  }

  updateReporter(
    id: string,
    patch: Partial<Pick<ReporterRow, 'status' | 'opted_out_at' | 'contact_pref'>>,
  ) {
    const r = this.reporters.find((x) => x.id === id)!;
    if (patch.status) r.status = patch.status;
    if (patch.contact_pref) r.contactPref = patch.contact_pref;
    if ('opted_out_at' in patch) r.optedOutAt = patch.opted_out_at ?? null;
    return Promise.resolve();
  }

  hasPendingUnknown(phone: string, opts?: { excludeMessageId?: string; channel?: string }) {
    return Promise.resolve(
      this.unknown.some(
        (u) =>
          u.phone_e164 === phone &&
          u.status === 'pending' &&
          (u.channel ?? 'sms') === (opts?.channel ?? 'sms') &&
          u.message_id !== opts?.excludeMessageId,
      ),
    );
  }

  insertUnknownContact(row: {
    phone_e164: string;
    message_id: string;
    snippet: string;
    org_id: string | null;
    channel?: 'sms' | 'whatsapp';
  }) {
    const existing = this.unknown.find((u) => u.message_id === row.message_id);
    if (existing) return Promise.resolve({ id: existing.id, created: false });
    const id = `uc-${this.unknown.length + 1}`;
    this.unknown.push({ id, ...row, status: 'pending' });
    return Promise.resolve({ id, created: true });
  }

  recordPhoneOptOut(phone: string, country: string) {
    this.phoneOptOuts.add(`${phone}:${country}`);
    return Promise.resolve();
  }

  clearPhoneOptOut(phone: string, country: string) {
    this.phoneOptOuts.delete(`${phone}:${country}`);
    return Promise.resolve();
  }

  messageByProviderId(providerId: string) {
    const m = this.outbound.find((o) => o.provider_message_id === providerId);
    return Promise.resolve(
      m
        ? {
            id: m.id,
            status: m.status,
            org_id: m.org_id,
            reporter_id: m.reporter_id,
            copy_key: m.copy_key,
            payload: m.payload ?? null,
            channel: m.channel ?? 'sms',
          }
        : null,
    );
  }

  notifyJobByDedupeKey(dedupeKey: string) {
    const job = this.notifyJobs.find((j) => j.payload.dedupeKey === dedupeKey);
    return Promise.resolve(job?.payload ?? null);
  }

  /** W2-12: the `sms_keyword` jobs queued, by message id (one per text: its job key). */
  keywordJobs: string[] = [];

  enqueueSmsKeyword(messageId: string) {
    if (!this.keywordJobs.includes(messageId)) this.keywordJobs.push(messageId);
    return Promise.resolve();
  }

  enqueueNotify(payload: JobPayloads['notify'], dedupeKey: string) {
    const existing = this.notifyJobs.find((j) => j.dedupeKey === dedupeKey);
    if (existing) return Promise.resolve(existing.id);
    const id = 100 + this.notifyJobs.length;
    this.notifyJobs.push({ id, payload, dedupeKey });
    return Promise.resolve(id);
  }

  updateMessageStatus(id: string, status: MsgStatus, error: string | null) {
    Object.assign(
      this.outbound.find((o) => o.id === id)!,
      { status, error },
    );
    return Promise.resolve();
  }

  reporterForInvite(id: string) {
    const r = this.reporters.find((x) => x.id === id);
    return Promise.resolve(
      r ? { id: r.id, org_id: r.orgId, name: r.name, status: r.status } : null,
    );
  }

  setInviteError(id: string, error: string) {
    this.reporters.find((x) => x.id === id)!.lastInviteError = error;
    return Promise.resolve();
  }

  providerFaultNotifiedSince(orgId: string, since: string) {
    const notified = [
      ...this.priorFaultNotices,
      ...this.audits
        .filter((a) => a.action === 'sms.provider_fault' && a.diff.notified === true)
        .map((a) => ({ orgId: a.orgId, at: String(a.diff.at) })),
    ];
    return Promise.resolve(notified.some((n) => n.orgId === orgId && n.at >= since));
  }

  notifyOrg(n: OfficeNotification) {
    this.notifications.push(n);
    return Promise.resolve();
  }

  audit(entry: InboundSmsAudit) {
    this.audits.push(entry);
    return Promise.resolve();
  }

  reporterContext(reporterId: string) {
    const r = this.reporters.find((x) => x.id === reporterId);
    if (!r) return Promise.resolve(null);
    return Promise.resolve({
      reporter: { id: r.id, org_id: r.orgId, phone_e164: r.phone, status: r.status },
      org: { id: r.orgId, is_demo: r.orgIsDemo, country: r.orgCountry },
      country: this.countries.find((c) => c.code === r.orgCountry)!,
    });
  }

  memberRole(userId: string, orgId: string) {
    return Promise.resolve(
      this.members.find((m) => m.userId === userId && m.orgId === orgId)?.role ?? null,
    );
  }
}
