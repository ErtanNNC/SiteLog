import type {
  CountryRow,
  InboundSmsAudit,
  InboundSmsStore,
  MemberRole,
  MsgStatus,
  NoticeData,
  ReporterRow,
  SmsKeyword,
} from '@sitelog/shared';

/**
 * What sms-webhook reads and writes, behind one interface: `store_supabase.ts` with the service
 * role, `fake_store.ts` in the Deno tests. The inbound handling itself (`processInboundSms`, run
 * inline for the Demo phone) needs the shared `InboundSmsStore` part; the routes add the rest.
 */

/** The `messages` row of an inbound text (channel 'sms', direction 'in'). */
export interface InboundMessageRow {
  id: string;
  org_id: string | null;
  reporter_id: string | null;
  phone_e164: string;
  provider: 'twilio' | 'console';
  provider_message_id: string;
  body: string;
  /** What the worker's `sms_inbound` job needs besides the row: the pack and Twilio's keyword. */
  payload: { to: string; keyword: SmsKeyword | null; pack: string; opt_out_type: string | null };
}

/** An outbound row a Twilio status callback reports on. */
export interface OutboundMessageState {
  id: string;
  status: MsgStatus;
  org_id: string | null;
  reporter_id: string | null;
  copy_key: string | null;
}

/** A §13 "Message undeliverable / opted out" notification (`notify_org`). */
export interface OfficeNotification {
  orgId: string;
  kind: 'reporter_opted_out' | 'reporter_invite_failed';
  title: string;
  body: string;
  targetPath: string;
  /** What the panel renders in the reader's language; title and body are the English fallback. */
  data?: NoticeData | null;
}

export interface SmsWebhookStore extends InboundSmsStore {
  /** The pack whose `sms_sender_id` is this sender (unique across packs, 20261014000007). */
  packBySender(to: string): Promise<CountryRow | null>;
  /**
   * `receive_sms_inbound()`, one transaction: writes the inbound row and its `sms.received` audit
   * (actor: the reporter, or the system for an unknown number), and for a Twilio text not yet
   * handled the worker's `sms_inbound` job (dedupe key `sms_inbound:<provider id>`). A provider id
   * seen before is a redelivery: the existing row's id, whether it was handled to the end
   * (`markHandled`), and the job it joined (none once handled, none for a console row).
   */
  receiveInbound(
    row: InboundMessageRow,
  ): Promise<{ id: string; duplicate: boolean; handled: boolean; jobId: number | null }>;
  messageByProviderId(providerId: string): Promise<OutboundMessageState | null>;
  updateMessageStatus(id: string, status: MsgStatus, error: string | null): Promise<void>;
  /** The reporter a welcome text was for (the status route's "Can't reach this number"). */
  reporterForInvite(
    id: string,
  ): Promise<Pick<ReporterRow, 'id' | 'org_id' | 'name' | 'status'> | null>;
  setInviteError(id: string, error: string): Promise<void>;
  /**
   * The org was told about an SMS provider fault since `since` (an `sms.provider_fault` audit row
   * with `notified: true`, from this route or from send_welcome): the next fault in that hour is
   * audited but not notified again.
   */
  providerFaultNotifiedSince(orgId: string, since: string): Promise<boolean>;
  notifyOrg(n: OfficeNotification): Promise<void>;
  audit(entry: InboundSmsAudit): Promise<void>;
  /** The Demo phone's reply: the reporter, their org and its pack row. */
  reporterContext(reporterId: string): Promise<{
    reporter: Pick<ReporterRow, 'id' | 'org_id' | 'phone_e164' | 'status'>;
    org: { id: string; is_demo: boolean; country: string };
    country: CountryRow;
  } | null>;
  memberRole(userId: string, orgId: string): Promise<MemberRole | null>;
}
