import { z } from 'zod';
import {
  EMPTY_TWIML,
  assertE164,
  keywordOf,
  lateFallback,
  messageDedupeKey,
  msgStatusFromTwilio,
  nextMessageStatus,
  noticeData,
  orderInboundReporters,
  parseTwilioInbound,
  parseTwilioStatus,
  processInboundSms,
  toCountryPack,
  twilioCallbackError,
  twilioLateFailureIsAccountFault,
  verifyTwilioSignature,
  type CountryPack,
  type E164,
  type NoticeData,
  type SmsNotifier,
} from '@sitelog/shared';
import { HttpError, json, parseWith, readJson, withHandler } from '../_shared/http.ts';
import { logError, logInfo, logWarn } from '../_shared/log.ts';
import type { SmsWebhookStore } from './store.ts';

/**
 * sms-webhook (W1-08; spec §4.4, §9.1, §9.5, F13, F15; verify_jwt = false). The Twilio inbound
 * endpoint is never named whatsapp-webhook (GAP D49).
 *
 *   POST /sms-webhook (or /inbound)  Twilio's messaging webhook: X-Twilio-Signature, form fields,
 *                                    store + enqueue `sms_inbound` in one transaction
 *                                    (`receive_sms_inbound()`) → empty TwiML. The worker runs
 *                                    the keywords and the reply (`processInboundSms`), so the
 *                                    handling survives whatever Twilio's retry policy does (its
 *                                    default retries connection failures only, never a 5xx).
 *   POST /sms-webhook/status         Twilio's StatusCallback (SMS and, since W2-15, WhatsApp, `read`
 *                                    included): messages.status (never backwards);
 *                                    a welcome the carrier could not deliver to the number flags
 *                                    the reporter for the office ("Can't reach this number", F3,
 *                                    §13); any text that failed for the account or the sender
 *                                    tells the office about the account, at most once an hour;
 *                                    a Notifier message queues its fallback (W2-01).
 *   POST /sms-webhook/demo-reply     The panel's Demo phone (§11.1): an admin of a demo org types a
 *                                    text as the reporter; the same handler, inline, console only,
 *                                    inside the caller's org, and only on packs with two-way SMS
 *                                    (spec §19 Q35). JWT.
 *
 * The pack is found by the sender id that received the text (`To` = `countries.sms_sender_id`,
 * unique across packs). A text is stored once per provider message id: a redelivery of a text
 * handled to the end is acknowledged and nothing runs twice; one not yet handled is enqueued again
 * under the same dedupe key (the job is idempotent). A real sender never reaches a demo org's
 * reporters (the worker handles real orgs only); the Demo phone never reaches a real org's.
 */

export interface SmsWebhookDeps {
  store: SmsWebhookStore;
  notifier: SmsNotifier;
  /** TWILIO_AUTH_TOKEN (throws EnvError when unset: 500, never an unchecked request). */
  authToken: () => string;
  /** The public URL Twilio calls (SMS_WEBHOOK_URL, else {SUPABASE_URL}/functions/v1/sms-webhook). */
  webhookUrl: () => string | null;
  /** LINK_SIGNING_SECRET: the personal link of the HELP reply (Demo phone). */
  linkSecret: () => string;
  /** FIELD_APP_URL: the host of that link. */
  fieldAppUrl: () => string;
  /** The signed-in office user of a Demo phone reply (401 otherwise). */
  authUser: (req: Request) => Promise<{ userId: string }>;
  now?: () => Date;
  randomUUID?: () => string;
}

const DemoReplySchema = z.object({
  reporterId: z.uuid(),
  body: z.string().trim().min(1).max(1600),
});

interface InboundText {
  providerId: string;
  from: E164;
  to: string;
  body: string;
  optOutType: string | null;
}

export interface InboundResult {
  messageId: string;
  duplicate: boolean;
  keyword: string | null;
  replyId: string | null;
}

/** The route of a request path: whatever comes after `/sms-webhook`. */
export function routeOf(pathname: string): 'inbound' | 'status' | 'demo-reply' | null {
  const rest = pathname.replace(/^.*\/sms-webhook/, '').replace(/\/+$/, '');
  if (rest === '' || rest === '/inbound') return 'inbound';
  if (rest === '/status') return 'status';
  if (rest === '/demo-reply') return 'demo-reply';
  return null;
}

/** The URLs a Twilio request may be signed for: the configured public one, and the one we saw. */
export function signedUrls(req: Request, base: string | null): string[] {
  const url = new URL(req.url);
  const suffix = url.pathname.replace(/^.*\/sms-webhook/, '');
  return [...(base ? [`${base}${suffix}${url.search}`] : []), req.url];
}

function twiml(): Response {
  return new Response(EMPTY_TWIML, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

/** A §13 notice of the status route (`reporter_invite_failed` / `message_failed`, admin and ops). */
export interface InviteNotice {
  orgId: string;
  kind: 'reporter_invite_failed' | 'message_failed';
  title: string;
  body: string;
  targetPath: string;
  /** What the panel renders in the reader's language; title and body are the English fallback. */
  data: NoticeData;
}

/** The office's notice of a welcome text the carrier could not deliver to the number. */
export function inviteFailedNotification(
  reporter: { org_id: string; name: string },
  error: string,
): InviteNotice {
  return {
    orgId: reporter.org_id,
    kind: 'reporter_invite_failed',
    title: `${reporter.name}: the welcome text could not be delivered`,
    body: `The carrier could not deliver the welcome text (${error}): the number may be a landline, blocked or out of service. Check it on Team & numbers, or contact them another way.`,
    targetPath: '/team',
    data: noticeData('welcome_carrier_undelivered', { name: reporter.name, error }),
  };
}

/**
 * The office's notice of a welcome text that failed for the account or the sender (Twilio
 * `failed`, or `undelivered` with a code that is not the number's: 30032 toll-free sender not
 * verified, 30034 unregistered 10DLC, 30002 account suspended, …). The wording follows
 * send_welcome's provider-fault notice; the reporter is never blamed.
 */
export function providerFaultNotification(
  orgId: string,
  reporterName: string | null,
  error: string,
): InviteNotice {
  return {
    orgId,
    kind: 'reporter_invite_failed',
    title: reporterName
      ? `${reporterName}: the welcome text failed at the SMS provider`
      : 'A welcome text failed at the SMS provider',
    body: `Texts are failing for this account (${error}). The SMS provider accepted the welcome text and then refused it for the account or the sender, not for the reporter's number. Re-send the welcome from Team & numbers once the provider account is fixed. Other texts that fail this way in the next hour are not notified again.`,
    targetPath: '/team',
    data: noticeData('welcome_account_fault', { name: reporterName, error }),
  };
}

/**
 * The same notice for any other text (a Notifier message, a device code, an inline text; W2-01
 * follow-up): the account is at fault, not the reporter's number. It stands for every text that
 * fails this way within the hour, so the `notify` job's fallback posts no per-message
 * `message_failed` for it (`attemptIsAccountFault`); the fallback still tries the person's next
 * channel, if any.
 */
export function messageAccountFaultNotification(
  orgId: string,
  reporterName: string | null,
  error: string,
): InviteNotice {
  return {
    orgId,
    kind: 'message_failed',
    title: reporterName
      ? `${reporterName}: a text to them failed at the SMS provider`
      : 'A text failed at the SMS provider',
    body: `Texts are failing for this account (${error}). The SMS provider accepted the text and then refused it for the account or the sender, not for the reporter's number. SiteLog tries their other message channels, if they have any. Other texts that fail this way in the next hour are not notified again.`,
    targetPath: '/team',
    data: noticeData('message_account_fault', { name: reporterName, error }),
  };
}

/** One account-fault notice per org per hour (status callbacks come one per failed text). */
const PROVIDER_FAULT_NOTICE_MS = 60 * 60 * 1000;

export function createSmsWebhook(deps: SmsWebhookDeps): (req: Request) => Promise<Response> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const uuid = deps.randomUUID ?? (() => crypto.randomUUID());

  async function signedForm(req: Request): Promise<URLSearchParams> {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const ok = await verifyTwilioSignature(
      signedUrls(req, deps.webhookUrl()),
      params,
      req.headers.get('x-twilio-signature'),
      deps.authToken(),
    );
    if (!ok) {
      logWarn('sms.webhook.bad_signature', { bytes: raw.length });
      throw new HttpError(403, 'Invalid signature');
    }
    return params;
  }

  /**
   * Stores the text once per provider id with its `sms.received` audit and, for a Twilio text
   * not yet handled, its `sms_inbound` job: one transaction (`receive_sms_inbound()`).
   */
  async function storeInbound(
    text: InboundText,
    pack: CountryPack,
    opts: { provider: 'twilio' | 'console'; scope: { realOnly: true } | { orgId: string } },
  ): Promise<{
    id: string;
    duplicate: boolean;
    handled: boolean;
    jobId: number | null;
    keyword: string | null;
  }> {
    const reporters = await store.reportersByPhone(text.from, pack.code, opts.scope);
    const primary = orderInboundReporters(reporters)[0] ?? null;
    const keyword = pack.twoWaySms ? keywordOf(text.body, text.optOutType) : null;
    const received = await store.receiveInbound({
      id: uuid(),
      org_id: primary?.orgId ?? null,
      reporter_id: primary?.id ?? null,
      phone_e164: text.from,
      provider: opts.provider,
      provider_message_id: text.providerId,
      body: text.body,
      payload: { to: text.to, keyword, pack: pack.code, opt_out_type: text.optOutType },
    });
    return { ...received, keyword };
  }

  async function inbound(req: Request): Promise<Response> {
    const params = await signedForm(req);
    const text = parseTwilioInbound(params);
    if (!text) {
      logWarn('sms.inbound.unreadable');
      return twiml();
    }
    const row = await store.packBySender(text.to);
    if (!row) {
      // A sender no pack has in this database (a number moved, a test number): nothing to do.
      logWarn('sms.inbound.unknown_sender_id', { to: text.to });
      return twiml();
    }
    const pack = toCountryPack(row);
    const stored = await storeInbound(
      {
        providerId: text.messageSid,
        from: text.from,
        to: text.to,
        body: text.body,
        optOutType: text.optOutType,
      },
      pack,
      { provider: 'twilio', scope: { realOnly: true } },
    );
    if (stored.duplicate && stored.handled) return twiml();
    // The worker takes it from here (sms_inbound); a redelivery before that joined the same job.
    logInfo('sms.inbound.queued', {
      messageId: stored.id,
      jobId: stored.jobId,
      keyword: stored.keyword,
      pack: pack.code,
      redelivered: stored.duplicate,
    });
    return twiml();
  }

  async function status(req: Request): Promise<Response> {
    const params = await signedForm(req);
    const cb = parseTwilioStatus(params);
    const next = cb ? msgStatusFromTwilio(cb.status) : null;
    if (!cb || !next) return twiml();
    const message = await store.messageByProviderId(cb.messageSid);
    if (!message) {
      logWarn('sms.status.unknown_message', { status: cb.status });
      return twiml();
    }
    const to = nextMessageStatus(message.status, next);
    if (!to) return twiml();
    const error = twilioCallbackError(cb.errorCode);
    const whatsapp = message.channel === 'whatsapp';
    await store.updateMessageStatus(message.id, to, error);
    await store.audit({
      orgId: message.org_id,
      actorType: 'system',
      action: whatsapp ? 'whatsapp.status' : 'sms.status',
      entity: 'message',
      entityId: message.id,
      diff: { from: message.status, to, error_code: cb.errorCode },
    });
    if (to !== 'undeliverable' && to !== 'failed') return twiml();
    if (whatsapp) {
      // W2-15: a WhatsApp message Twilio took and then could not deliver (63016 outside the
      // window, 63024 not on WhatsApp, a template Meta paused, …): never a texts-account notice
      // nor "Can't reach this number" (the welcome is never on WhatsApp); the message goes on the
      // person's next channel (W2-01), and the office hears only if every channel fails.
      await fallBack(message, to);
      return twiml();
    }
    // A text Twilio accepted and then could not deliver. Only a carrier refusing the number
    // (`undelivered` with 30003, 30004, 30005, 30006, or no code) is the reporter's: for a
    // welcome, F3 "Can't reach this number". `failed` (it never left the account) and every other
    // code (30032 unverified toll-free sender, 30034 unregistered 10DLC, 30002 suspended account,
    // 30007 filtered, …) is the account's fault, as in send_welcome: the reporter is left alone and
    // the office hears it once per org per hour, for a welcome or any other text.
    const reason = error ?? `twilio ${cb.status}`;
    const accountFault = twilioLateFailureIsAccountFault(to, cb.errorCode);
    if (accountFault) await providerFault(message, to, cb.errorCode, reason);
    else if (message.copy_key === 'welcome') await flagInviteFailure(message, reason);
    // Either way the message may still reach the person on their next channel (W2-01); an
    // account fault adds no per-message `message_failed` when none is left (notify.ts).
    await fallBack(message, to);
    return twiml();
  }

  /**
   * A late `failed` / `undeliverable` on a Notifier message hands it to the next channel of the
   * order (spec §19 Q22, W2-01): a `notify` job with the variables of the job that sent it,
   * keyed per failed attempt (`jobKeys.notifyAfter`), so a repeated callback queues one job. The
   * job runs the key's guard and the Notifier's walk; with no next channel it tells the office
   * (`message_failed`). A message no `notify` job sent (the welcome, the device code, inline
   * texts) has no late fallback.
   */
  async function fallBack(
    message: {
      id: string;
      org_id: string | null;
      reporter_id: string | null;
      copy_key: string | null;
      payload?: unknown;
    },
    to: 'undeliverable' | 'failed',
  ): Promise<void> {
    const messageKey = messageDedupeKey(message.payload ?? null);
    if (!messageKey || !message.reporter_id) return;
    const sentBy = await store.notifyJobByDedupeKey(messageKey);
    const fallback = lateFallback({ ...message, payload: message.payload ?? null }, to, sentBy);
    if (fallback.kind !== 'enqueue') {
      logInfo('sms.status.no_fallback', { messageId: message.id, reason: fallback.reason });
      return;
    }
    const jobId = await store.enqueueNotify(fallback.payload, fallback.dedupeKey);
    await store.audit({
      orgId: message.org_id,
      actorType: 'system',
      action: 'notify.fallback_queued',
      entity: 'message',
      entityId: message.id,
      diff: { copy_key: message.copy_key, dedupe_key: messageKey, status: to, job_id: jobId },
    });
  }

  async function flagInviteFailure(
    message: { id: string; reporter_id: string | null },
    error: string,
  ): Promise<void> {
    if (!message.reporter_id) return;
    const reporter = await store.reporterForInvite(message.reporter_id);
    // Nothing to flag once they replied (active), opted out, or the office disabled them.
    if (!reporter || reporter.status !== 'invited') return;
    await store.setInviteError(reporter.id, error.slice(0, 300));
    await store.notifyOrg(inviteFailedNotification(reporter, error));
    await store.audit({
      orgId: reporter.org_id,
      actorType: 'system',
      action: 'reporter.invite_failed',
      entity: 'reporter',
      entityId: reporter.id,
      diff: { error, status: 'undeliverable', message_id: message.id, via: 'status_callback' },
    });
    logInfo('sms.status.invite_failed', { reporterId: reporter.id });
  }

  async function providerFault(
    message: {
      id: string;
      org_id: string | null;
      reporter_id: string | null;
      copy_key: string | null;
    },
    to: 'undeliverable' | 'failed',
    code: string | null,
    error: string,
  ): Promise<void> {
    if (!message.org_id) return;
    const at = now();
    const since = new Date(at.getTime() - PROVIDER_FAULT_NOTICE_MS).toISOString();
    const notified = !(await store.providerFaultNotifiedSince(message.org_id, since));
    if (notified) {
      const reporter = message.reporter_id
        ? await store.reporterForInvite(message.reporter_id)
        : null;
      const name = reporter?.name ?? null;
      await store.notifyOrg(
        message.copy_key === 'welcome'
          ? providerFaultNotification(message.org_id, name, error)
          : messageAccountFaultNotification(message.org_id, name, error),
      );
    }
    await store.audit({
      orgId: message.org_id,
      actorType: 'system',
      action: 'sms.provider_fault',
      entity: 'message',
      entityId: message.id,
      diff: {
        error,
        code,
        status: to,
        reporter_id: message.reporter_id,
        copy_key: message.copy_key,
        via: 'status_callback',
        notified,
        at: at.toISOString(),
      },
    });
    logError('sms.status.provider_fault', new Error(error), {
      messageId: message.id,
      orgId: message.org_id,
      code,
      notified,
    });
  }

  async function demoReply(req: Request): Promise<Response> {
    const user = await deps.authUser(req);
    const body = parseWith(DemoReplySchema, await readJson(req));
    const ctx = await store.reporterContext(body.reporterId);
    if (!ctx) throw new HttpError(404, 'Reporter not found');
    if ((await store.memberRole(user.userId, ctx.org.id)) !== 'admin') {
      throw new HttpError(403, 'The Demo phone is for admins of this organisation');
    }
    if (!ctx.org.is_demo) {
      throw new HttpError(403, 'The Demo phone types replies for demo organisations only');
    }
    if (ctx.reporter.status === 'disabled') throw new HttpError(409, 'This reporter is disabled');
    const pack = toCountryPack(ctx.country);
    if (!pack.twoWaySms) {
      throw new HttpError(409, 'This country pack has one-way SMS: replies cannot reach SiteLog');
    }
    const from = assertE164(ctx.reporter.phone_e164);
    const scope = { orgId: ctx.org.id };
    const stored = await storeInbound(
      {
        providerId: `console:${uuid()}`,
        from,
        to: pack.smsSenderId ?? 'console',
        body: body.body,
        optOutType: null,
      },
      pack,
      { provider: 'console', scope },
    );
    // Inline, as the worker would: the typed reply answers at once in the Demo phone. A demo
    // org's STOP never records the phone itself (`applyPhoneOptOut`: a real number stays free).
    const handled = await processInboundSms(
      {
        store,
        notifier: deps.notifier,
        linkSecret: deps.linkSecret,
        fieldAppUrl: deps.fieldAppUrl,
        now,
        randomUUID: uuid,
      },
      {
        text: { messageId: stored.id, from, body: body.body, optOutType: null },
        pack,
        scope,
        applyPhoneOptOut: false,
      },
    );
    logInfo('sms.demo_reply.handled', {
      messageId: stored.id,
      keyword: handled.keyword,
      changes: handled.changes.length,
      reply: handled.replyId !== null,
      orgId: ctx.org.id,
    });
    const result: InboundResult = {
      messageId: stored.id,
      duplicate: stored.duplicate,
      keyword: handled.keyword,
      replyId: handled.replyId,
    };
    return json(req, result, { status: 201 });
  }

  return withHandler('sms-webhook', async (req) => {
    const route = routeOf(new URL(req.url).pathname);
    if (!route) throw new HttpError(404, 'Not found');
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed; use POST');
    if (route === 'inbound') return await inbound(req);
    if (route === 'status') return await status(req);
    return await demoReply(req);
  });
}
