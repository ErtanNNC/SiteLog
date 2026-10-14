import type {
  CountryRow,
  InboundReporter,
  MemberRole,
  MsgStatus,
  PersonalLinkStore,
  ReporterRow,
} from '@sitelog/shared';
import type { AuditEntry } from '../_shared/audit.ts';

/**
 * What sms-webhook reads and writes, behind one interface: `store_supabase.ts` with the service
 * role, `fake_store.ts` in the Deno tests.
 */

/** A reporter whose phone sent the text, with what a reply needs. */
export interface InboundReporterRow extends InboundReporter {
  phone: string;
  locale: string;
  orgName: string;
  orgIsDemo: boolean;
}

/** The `messages` row of an inbound text (channel 'sms', direction 'in'). */
export interface InboundMessageRow {
  id: string;
  org_id: string | null;
  reporter_id: string | null;
  phone_e164: string;
  provider: 'twilio' | 'console';
  provider_message_id: string;
  body: string;
  payload: { to: string; keyword: string | null };
}

export interface SmsWebhookStore {
  /** The pack whose `sms_sender_id` is this sender (unique across packs, 20261014000007). */
  packBySender(to: string): Promise<CountryRow | null>;
  /**
   * Reporters with this phone in orgs of this pack, every status, with their org; `demoOnly`
   * keeps orgs with `is_demo` (the Demo phone never reaches a real org's reporter).
   */
  reportersByPhone(
    phone: string,
    country: string,
    opts: { demoOnly: boolean },
  ): Promise<InboundReporterRow[]>;
  /**
   * Writes the inbound row; a provider id seen before is a redelivery: the existing row's id, and
   * whether it was handled to the end (`markHandled`).
   */
  insertInbound(
    row: InboundMessageRow,
  ): Promise<{ id: string; duplicate: boolean; handled: boolean }>;
  markHandled(id: string, at: string): Promise<void>;
  updateReporter(
    id: string,
    patch: Partial<Pick<ReporterRow, 'status' | 'opted_out_at' | 'contact_pref'>>,
  ): Promise<void>;
  /** A pending `unknown_contacts` row of this phone (channel 'sms') exists. */
  hasPendingUnknown(phone: string): Promise<boolean>;
  insertUnknownContact(row: {
    phone_e164: string;
    message_id: string;
    snippet: string;
  }): Promise<string>;
  messageByProviderId(
    providerId: string,
  ): Promise<{ id: string; status: MsgStatus; org_id: string | null } | null>;
  updateMessageStatus(id: string, status: MsgStatus, error: string | null): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  /** The Demo phone's reply: the reporter, their org and its pack row. */
  reporterContext(reporterId: string): Promise<{
    reporter: Pick<ReporterRow, 'id' | 'org_id' | 'phone_e164' | 'status'>;
    org: { id: string; is_demo: boolean; country: string };
    country: CountryRow;
  } | null>;
  memberRole(userId: string, orgId: string): Promise<MemberRole | null>;
  links: PersonalLinkStore;
}
