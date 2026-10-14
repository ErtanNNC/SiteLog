import type { CountryRow, MemberRole, MsgStatus, ReporterRow } from '@sitelog/shared';
import type { AuditEntry } from '../_shared/audit.ts';
import { fakeLinkStore } from '../_shared/fake_messaging.ts';
import type { InboundMessageRow, InboundReporterRow, SmsWebhookStore } from './store.ts';

interface FakeReporter extends InboundReporterRow {
  orgCountry: string;
}

/** sms-webhook's store in memory, for the Deno tests. */
export class FakeSmsStore implements SmsWebhookStore {
  countries: CountryRow[] = [];
  reporters: FakeReporter[] = [];
  inbound: Array<InboundMessageRow & { handled_at?: string; status: MsgStatus }> = [];
  /** Outbound rows the status route updates (provider id → row). */
  outbound: Array<{
    id: string;
    provider_message_id: string;
    status: MsgStatus;
    org_id: string | null;
    error: string | null;
  }> = [];
  unknown: Array<{
    id: string;
    phone_e164: string;
    message_id: string;
    snippet: string;
    status: 'pending';
  }> = [];
  audits: AuditEntry[] = [];
  members: Array<{ userId: string; orgId: string; role: MemberRole }> = [];
  links = fakeLinkStore();
  /** Makes markHandled throw once (a crash after the work, before the mark). */
  failMarkOnce = false;

  packBySender(to: string) {
    return Promise.resolve(this.countries.find((c) => c.sms_sender_id === to.trim()) ?? null);
  }

  reportersByPhone(phone: string, country: string, opts: { demoOnly: boolean }) {
    return Promise.resolve(
      this.reporters
        .filter(
          (r) => r.phone === phone && r.orgCountry === country && (!opts.demoOnly || r.orgIsDemo),
        )
        .map(({ orgCountry: _c, ...r }) => ({ ...r })),
    );
  }

  insertInbound(row: InboundMessageRow) {
    const existing = this.inbound.find((m) => m.provider_message_id === row.provider_message_id);
    if (existing) {
      return Promise.resolve({
        id: existing.id,
        duplicate: true,
        handled: Boolean(existing.handled_at),
      });
    }
    this.inbound.push({ ...row, status: 'received' });
    return Promise.resolve({ id: row.id, duplicate: false, handled: false });
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

  hasPendingUnknown(phone: string) {
    return Promise.resolve(
      this.unknown.some((u) => u.phone_e164 === phone && u.status === 'pending'),
    );
  }

  insertUnknownContact(row: { phone_e164: string; message_id: string; snippet: string }) {
    const id = `uc-${this.unknown.length + 1}`;
    this.unknown.push({ id, ...row, status: 'pending' });
    return Promise.resolve(id);
  }

  messageByProviderId(providerId: string) {
    const m = this.outbound.find((o) => o.provider_message_id === providerId);
    return Promise.resolve(m ? { id: m.id, status: m.status, org_id: m.org_id } : null);
  }

  updateMessageStatus(id: string, status: MsgStatus, error: string | null) {
    Object.assign(
      this.outbound.find((o) => o.id === id)!,
      { status, error },
    );
    return Promise.resolve();
  }

  audit(entry: AuditEntry) {
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
