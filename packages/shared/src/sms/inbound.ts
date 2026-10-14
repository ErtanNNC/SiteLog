import { smsReplyAllowed } from '../channels.ts';
import type { TwoWaySmsKey } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import type { ContactPref, ReporterStatus } from '../enums.ts';
import { formatPhone, type E164 } from '../format.ts';
import { ensurePersonalLink, fieldLinkUrl, type PersonalLinkStore } from '../links.ts';
import type { SmsNotifier } from '../notify/notifier.ts';
import {
  orderInboundReporters,
  planInboundSms,
  type InboundReporter,
  type ReporterChange,
  type SmsKeyword,
} from './keywords.ts';
import { SmsSendError } from './transports.ts';

/**
 * What SiteLog does with an inbound text once it is stored (§9.5, F13, F15; W1-08): the plan of
 * `planInboundSms` applied to the reporters, the phone's own opt-out (`sms_opt_outs`), the F13
 * unknown contact, the office notification of an opt-out (§13 "Message undeliverable / opted
 * out"), the one reply through the Notifier, and the row marked handled. One function for the two
 * callers: the worker's `sms_inbound` job (a Twilio text sms-webhook stored and enqueued, so the
 * handling survives whatever Twilio's retry policy does) and sms-webhook's `/demo-reply` route
 * (the Demo phone, inline, console only). A re-run after a crash finds the changes already made
 * (each reporter change, its audit row and its office notice are applied together where the store
 * can: `applyChange`), finds the unknown contact this same text created and still sends its
 * auto-reply, and marks the row handled (a message already handled is skipped by the caller); only
 * the reply is at-least-once, if the crash fell between it and the handled mark.
 */

/** A reporter whose phone sent the text, with what a reply and a notification need. */
export interface InboundReporterRow extends InboundReporter {
  name: string;
  phone: string;
  locale: string;
  orgName: string;
  orgIsDemo: boolean;
}

/**
 * Which orgs' reporters a text applies to: real orgs only on the Twilio route (a demo org is
 * reachable only through the Demo phone, never from a real sender), or one org on the Demo phone
 * (the caller's, so an admin of one demo org never acts as another org's reporter).
 */
export type InboundScope = { realOnly: true } | { orgId: string };

export interface InboundSmsAudit {
  orgId: string | null;
  actorType: 'reporter' | 'system';
  actorId?: string | null;
  action: string;
  entity: 'reporter' | 'message' | 'unknown_contact';
  entityId: string | null;
  diff: Record<string, unknown>;
}

export interface InboundSmsNotification {
  orgId: string;
  kind: 'reporter_opted_out';
  title: string;
  body: string;
  targetPath: string;
}

/** The rows the handling reads and writes; the worker (Postgres) and the edge function (supabase-js) each implement it. */
export interface InboundSmsStore {
  /** Reporters with this phone in orgs of this pack within the scope, every status, with their org. */
  reportersByPhone(
    phone: E164,
    country: string,
    scope: InboundScope,
  ): Promise<InboundReporterRow[]>;
  updateReporter(
    id: string,
    patch: {
      status?: ReporterStatus;
      opted_out_at?: string | null;
      contact_pref?: ContactPref;
    },
  ): Promise<void>;
  /**
   * A pending `unknown_contacts` row of this phone (channel 'sms') exists, other than the one the
   * text `excludeMessageId` created (a retry of that text still sends its F13 auto-reply).
   */
  hasPendingUnknown(phone: E164, opts?: { excludeMessageId?: string }): Promise<boolean>;
  /** The F13 row of this text: inserted once per `message_id`; a retry gets the existing row back. */
  insertUnknownContact(row: {
    phone_e164: E164;
    message_id: string;
    snippet: string;
  }): Promise<{ id: string; created: boolean }>;
  /** `sms_opt_outs` for the phone on the pack, method `sms_keyword`; a row already there stays. */
  recordPhoneOptOut(phone: E164, country: string): Promise<void>;
  clearPhoneOptOut(phone: E164, country: string): Promise<void>;
  /** `messages.payload.handled_at`: the text was handled to the end. */
  markHandled(messageId: string, at: string): Promise<void>;
  notifyOrg(n: InboundSmsNotification): Promise<void>;
  audit(entry: InboundSmsAudit): Promise<void>;
  /**
   * One reporter change with its audit row and its office notice, in one transaction: a failure
   * leaves none of them, so the retry finds the change still to make and writes all three. The
   * worker's store has it; without it (the Demo phone's) the three run one after another.
   */
  applyChange?(
    change: { reporterId: string; patch: ReporterChange['patch'] },
    audit: InboundSmsAudit,
    notification: InboundSmsNotification | null,
  ): Promise<void>;
  links: PersonalLinkStore;
}

export interface InboundSmsDeps {
  store: InboundSmsStore;
  notifier: SmsNotifier;
  /** LINK_SIGNING_SECRET: the personal link of the HELP reply. */
  linkSecret: () => string;
  /** FIELD_APP_URL: the host of that link. */
  fieldAppUrl: () => string;
  now: () => Date;
  randomUUID: () => string;
}

export interface InboundSmsText {
  /** The stored `messages` row. */
  messageId: string;
  from: E164;
  body: string;
  /** Twilio's `OptOutType` when its handling recognised a keyword. */
  optOutType: string | null;
}

export interface InboundSmsInput {
  text: InboundSmsText;
  pack: CountryPack;
  scope: InboundScope;
  /**
   * Record STOP and START in `sms_opt_outs` (the phone's own opt-out on the pack): the Twilio
   * route only. A Demo phone STOP is a demo org's and never stops a real number.
   */
  applyPhoneOptOut: boolean;
}

export interface InboundSmsResult {
  keyword: SmsKeyword | null;
  /**
   * The `messages` row of the reply that went; null when no reply went (none planned, or the
   * provider refused it for good: the Notifier recorded that refusal on its own row).
   */
  replyId: string | null;
  changes: ReporterChange[];
  unknownContact: boolean;
}

/** §13 "Message undeliverable / opted out": the office hears about a STOP, with what to do. */
export function optOutNotification(reporter: {
  orgId: string;
  name: string;
  phone: string;
}): InboundSmsNotification {
  return {
    orgId: reporter.orgId,
    kind: 'reporter_opted_out',
    title: `${reporter.name} opted out of texts (STOP)`,
    body: `${formatPhone(reporter.phone)} replied STOP, so SiteLog texts them nothing until they reply START. Call them if you need their reports.`,
    targetPath: '/team',
  };
}

export async function processInboundSms(
  deps: InboundSmsDeps,
  input: InboundSmsInput,
): Promise<InboundSmsResult> {
  const { store } = deps;
  const { text, pack } = input;
  const reporters = await store.reportersByPhone(text.from, pack.code, input.scope);
  const primary = orderInboundReporters(reporters)[0] ?? null;
  const plan = planInboundSms({
    pack,
    body: text.body,
    optOutType: text.optOutType,
    reporters,
    pendingUnknown: primary
      ? false
      : await store.hasPendingUnknown(text.from, { excludeMessageId: text.messageId }),
    now: deps.now(),
  });
  const byId = new Map(reporters.map((r) => [r.id, r]));

  if (input.applyPhoneOptOut && plan.phoneOptOut === 'record') {
    await store.recordPhoneOptOut(text.from, pack.code);
  }
  if (input.applyPhoneOptOut && plan.phoneOptOut === 'clear') {
    await store.clearPhoneOptOut(text.from, pack.code);
  }
  for (const change of plan.changes) {
    const reporter = byId.get(change.reporterId)!;
    const audit: InboundSmsAudit = {
      orgId: reporter.orgId,
      actorType: 'reporter',
      actorId: change.reporterId,
      action: change.action,
      entity: 'reporter',
      entityId: change.reporterId,
      diff: {
        ...change.patch,
        method: 'sms_keyword',
        keyword: plan.keyword,
        message_id: text.messageId,
      },
    };
    const notice = change.patch.status === 'opted_out' ? optOutNotification(reporter) : null;
    if (store.applyChange) {
      await store.applyChange(
        { reporterId: change.reporterId, patch: change.patch },
        audit,
        notice,
      );
    } else {
      await store.updateReporter(change.reporterId, change.patch);
      await store.audit(audit);
      if (notice) await store.notifyOrg(notice);
    }
  }
  if (plan.unknownContact) {
    const contact = await store.insertUnknownContact({
      phone_e164: text.from,
      message_id: text.messageId,
      snippet: text.body.slice(0, 200),
    });
    if (contact.created) {
      await store.audit({
        orgId: null,
        actorType: 'system',
        action: 'unknown_contact.created',
        entity: 'unknown_contact',
        entityId: contact.id,
        diff: { channel: 'sms', pack: pack.code, message_id: text.messageId },
      });
    }
  }

  let replyId: string | null = null;
  if (plan.reply) {
    const reporter = plan.reply.reporterId ? (byId.get(plan.reply.reporterId) ?? null) : null;
    try {
      const sent = await deps.notifier.reply({
        pack,
        org: reporter ? { id: reporter.orgId, isDemo: reporter.orgIsDemo } : null,
        reporterId: reporter?.id ?? null,
        phone: text.from,
        locale: reporter?.locale ?? pack.fieldLocales[0]!,
        key: plan.reply.key,
        vars: (await replyVars(deps, plan.reply.key, pack, reporter)) as never,
      });
      replyId = sent.messageId;
    } catch (err) {
      // A number the provider will not text (e.g. Twilio 21610 after its own STOP handling):
      // recorded on the reply's row by the Notifier, and the text counts as handled. Anything
      // else is thrown, so the job retries (its changes above are no-ops the second time).
      if (!(err instanceof SmsSendError) || err.retryable) throw err;
    }
  }
  await store.markHandled(text.messageId, deps.now().toISOString());
  return {
    keyword: plan.keyword,
    replyId,
    changes: plan.changes,
    unknownContact: plan.unknownContact,
  };
}

/** The reply's variables: the personal link and the org for HELP, nothing for the others. */
async function replyVars(
  deps: InboundSmsDeps,
  key: TwoWaySmsKey,
  pack: CountryPack,
  reporter: InboundReporterRow | null,
): Promise<Record<string, string>> {
  if (key !== 'help' || !reporter) return {};
  if (!smsReplyAllowed(pack, key)) return {};
  const link = await ensurePersonalLink(
    deps.store.links,
    deps.linkSecret(),
    reporter.id,
    deps.randomUUID,
  );
  if (link.created) {
    await deps.store.audit({
      orgId: reporter.orgId,
      actorType: 'system',
      action: 'field_link.created',
      entity: 'reporter',
      entityId: reporter.id,
      diff: { kind: 'personal', site_id: null, report_date: null, via: 'sms_help' },
    });
  }
  return {
    company: reporter.orgName,
    link: fieldLinkUrl(deps.fieldAppUrl(), link.code),
    ...(pack.voiceNumber ? { number: formatPhone(pack.voiceNumber) } : {}),
  };
}
