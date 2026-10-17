import { MessageSendError, replyAllowed, type ReplyChannel } from '../channels.ts';
import { legalPageUrl } from '../copy/legal/index.ts';
import type { TwoWaySmsKey } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import type { ContactPref, ReporterStatus } from '../enums.ts';
import { formatPhone, type E164 } from '../format.ts';
import { ensurePersonalLink, fieldLinkUrl, type PersonalLinkStore } from '../links.ts';
import { noticeData, type NoticeData } from '../notifications.ts';
import type { SmsNotifier } from '../notify/notifier.ts';
import {
  orderInboundReporters,
  planInboundSms,
  type InboundReporter,
  type ReporterChange,
  type SmsKeyword,
  type SmsReportKeyword,
} from './keywords.ts';
import { jobKeys } from '../schemas/jobs.ts';
import { localDate } from '../schedule/day.ts';

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
  /** What the panel renders in the reader's language; title and body are the English fallback. */
  data: NoticeData;
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
   * A pending `unknown_contacts` row of this phone on the message's channel (default 'sms') exists,
   * other than the one the text `excludeMessageId` created (a retry of that text still sends its
   * F13 auto-reply).
   */
  hasPendingUnknown(
    phone: E164,
    opts?: { excludeMessageId?: string; channel?: ReplyChannel },
  ): Promise<boolean>;
  /**
   * The F13 row of this text: inserted once per `message_id`; a retry gets the existing row back.
   * `org_id` is the guessed org (spec §19 Q44, `guessContactOrg`), else null.
   */
  insertUnknownContact(row: {
    phone_e164: E164;
    message_id: string;
    snippet: string;
    org_id: string | null;
    /** W2-16: the channel the message came in on (`field_channel`; default 'sms'). */
    channel?: ReplyChannel;
  }): Promise<{ id: string; created: boolean }>;
  /**
   * Orgs in scope of this pack that linked an earlier contact of this phone (spec §19 Q44: the
   * number has history there). Optional: without it only disabled reporters count.
   */
  linkedContactOrgs?(phone: E164, country: string, scope: InboundScope): Promise<string[]>;
  /** `sms_opt_outs` for the phone on the pack, method `sms_keyword`; a row already there stays. */
  recordPhoneOptOut(phone: E164, country: string): Promise<void>;
  clearPhoneOptOut(phone: E164, country: string): Promise<void>;
  /** `messages.payload.handled_at`: the text was handled to the end. */
  markHandled(messageId: string, at: string): Promise<void>;
  /**
   * W2-12: queue the worker's `sms_keyword` job for a report keyword (OK, NO WORK, WEATHER, EDIT)
   * of this text, keyed `jobKeys.smsKeyword(messageId)`, so a re-run queues nothing new.
   */
  enqueueSmsKeyword(messageId: string): Promise<void>;
  /**
   * W2-16: queue the worker's `whatsapp_answer` job for a WhatsApp text that may answer an open web
   * question (`jobKeys.whatsappAnswer(messageId)`).
   */
  enqueueWhatsappAnswer(messageId: string): Promise<void>;
  /**
   * W2-16: STOP (`grant` false) or START (`grant` true) on WhatsApp: the reporter's `whatsapp`
   * consent (`inbound_whatsapp_consent()`, audited as the reporter); `changed` false when nothing
   * was held, or nothing had been given before.
   */
  whatsappConsent(reporterId: string, grant: boolean, messageId: string): Promise<boolean>;
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
  /** W2-16: the channel the message came in on (default SMS); replies go back on it. */
  channel?: ReplyChannel;
  /** W2-16: the media of a WhatsApp message (voice notes, photos; §19 Q85). */
  numMedia?: number;
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
  /** W2-12: the report keyword handed to the worker's `sms_keyword` job, if any. */
  reportKeyword: SmsReportKeyword | null;
  /** W2-16: the WhatsApp consents STOP or START changed. */
  consentChanges: Array<{ reporterId: string; grant: boolean }>;
  /** W2-16: a WhatsApp text handed to the worker's `whatsapp_answer` job. */
  answer: boolean;
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
    data: noticeData('reporter_stop', { name: reporter.name, phone: formatPhone(reporter.phone) }),
  };
}

/**
 * Spec §19 Q44 (decided 2026-10-15): the org an unknown number's text is filed under. Its
 * history: the orgs of its reporters (here only disabled ones, or the text would not be unknown)
 * and the orgs that linked an earlier contact of it, all within the scope (real orgs of the pack
 * on the Twilio route). Exactly one → that org; none or several → null, and SiteLog support sees
 * it on /ops, never every org of the pack.
 */
export function guessContactOrg(
  reporterOrgIds: readonly string[],
  linkedOrgIds: readonly string[],
): string | null {
  const orgs = new Set([...reporterOrgIds, ...linkedOrgIds]);
  return orgs.size === 1 ? [...orgs][0]! : null;
}

export async function processInboundSms(
  deps: InboundSmsDeps,
  input: InboundSmsInput,
): Promise<InboundSmsResult> {
  const { store } = deps;
  const { text, pack } = input;
  const channel: ReplyChannel = input.channel ?? 'sms';
  const reporters = await store.reportersByPhone(text.from, pack.code, input.scope);
  const primary = orderInboundReporters(reporters)[0] ?? null;
  const plan = planInboundSms({
    pack,
    body: text.body,
    optOutType: text.optOutType,
    reporters,
    pendingUnknown: primary
      ? false
      : await store.hasPendingUnknown(text.from, {
          excludeMessageId: text.messageId,
          ...(channel === 'sms' ? {} : { channel }),
        }),
    now: deps.now(),
    channel,
    numMedia: input.numMedia ?? 0,
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
  // W2-16 (spec §19 Q40): STOP / START on WhatsApp change the whatsapp consent only.
  const consentChanges: Array<{ reporterId: string; grant: boolean }> = [];
  for (const change of plan.consentChanges) {
    if (await store.whatsappConsent(change.reporterId, change.grant, text.messageId))
      consentChanges.push(change);
  }
  if (plan.unknownContact) {
    // Spec §19 Q44: the org of the number's history (a disabled reporter here, an earlier
    // contact that org linked) when there is exactly one; else org-less, for SiteLog support.
    const orgId = guessContactOrg(
      reporters.map((r) => r.orgId),
      (await store.linkedContactOrgs?.(text.from, pack.code, input.scope)) ?? [],
    );
    const contact = await store.insertUnknownContact({
      phone_e164: text.from,
      message_id: text.messageId,
      snippet: text.body.slice(0, 200),
      org_id: orgId,
      ...(channel === 'sms' ? {} : { channel }),
    });
    if (contact.created) {
      await store.audit({
        orgId,
        actorType: 'system',
        action: 'unknown_contact.created',
        entity: 'unknown_contact',
        entityId: contact.id,
        diff: {
          channel,
          pack: pack.code,
          message_id: text.messageId,
          org_guessed: orgId !== null,
        },
      });
    }
  }

  let replyId: string | null = null;
  const sendReply = async (
    key: Parameters<typeof replyVars>[1],
    reporter: InboundReporterRow | null,
    dedupeKey?: string,
  ): Promise<string | null> => {
    try {
      const sent = await deps.notifier.reply({
        pack,
        org: reporter ? { id: reporter.orgId, isDemo: reporter.orgIsDemo } : null,
        reporterId: reporter?.id ?? null,
        phone: text.from,
        locale: reporter?.locale ?? pack.fieldLocales[0]!,
        key,
        vars: (await replyVars(deps, key, pack, reporter, channel)) as never,
        channel,
        ...(dedupeKey ? { dedupeKey } : {}),
      });
      return sent.messageId;
    } catch (err) {
      // A number the provider will not text (e.g. Twilio 21610 after its own STOP handling), or a
      // WhatsApp reply refused for good: recorded on the reply's row by the Notifier, and the
      // text counts as handled. Anything else is thrown, so the job retries (its changes above
      // are no-ops the second time).
      if (!(err instanceof MessageSendError) || err.retryable) throw err;
      return null;
    }
  };
  if (plan.reply) {
    const reporter = plan.reply.reporterId ? (byId.get(plan.reply.reporterId) ?? null) : null;
    replyId = await sendReply(plan.reply.key, reporter);
  }
  if (plan.mediaReply && primary) {
    // §19 Q85: once a day per reporter (the pack's default time zone), keyed by the Notifier.
    const day = localDate(deps.now(), pack.defaultTimezone);
    replyId = await sendReply(
      'whatsapp_use_link',
      primary,
      jobKeys.whatsappUseLink(primary.id, day),
    );
  }
  // W2-12: the report keywords are the worker's (EDIT needs the model); queued before the text
  // is marked handled, so a crash in between queues it again under the same key.
  if (plan.reportKeyword) await store.enqueueSmsKeyword(text.messageId);
  // W2-16 (spec §19 Q26): a WhatsApp text that may answer an open question, the worker's too.
  if (plan.answer) await store.enqueueWhatsappAnswer(text.messageId);
  await store.markHandled(text.messageId, deps.now().toISOString());
  return {
    keyword: plan.keyword,
    replyId,
    changes: plan.changes,
    unknownContact: plan.unknownContact,
    reportKeyword: plan.reportKeyword,
    consentChanges,
    answer: plan.answer,
  };
}

/**
 * The reply's variables: the personal link and the org for HELP (and the pack's privacy notice page
 * when it names one, W4-06), nothing for the others.
 */
async function replyVars(
  deps: InboundSmsDeps,
  key: TwoWaySmsKey,
  pack: CountryPack,
  reporter: InboundReporterRow | null,
  channel: ReplyChannel = 'sms',
): Promise<Record<string, string>> {
  if ((key !== 'help' && key !== 'whatsapp_use_link') || !reporter) return {};
  if (!replyAllowed(pack, key, channel)) return {};
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
      diff: {
        kind: 'personal',
        site_id: null,
        report_date: null,
        via: key === 'help' ? 'sms_help' : 'whatsapp_use_link',
      },
    });
  }
  if (key === 'whatsapp_use_link') return { link: fieldLinkUrl(deps.fieldAppUrl(), link.code) };
  const privacy = pack.legalKeys.privacyNotice;
  return {
    company: reporter.orgName,
    link: fieldLinkUrl(deps.fieldAppUrl(), link.code),
    ...(pack.voiceNumber ? { number: formatPhone(pack.voiceNumber) } : {}),
    // W4-06 (§9.1): the pack's privacy notice page, once the pack names one.
    ...(privacy ? { privacy_link: legalPageUrl(deps.fieldAppUrl(), privacy) } : {}),
  };
}
