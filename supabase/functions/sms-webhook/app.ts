import { z } from 'zod';
import {
  EMPTY_TWIML,
  applyLateStatus,
  chooseInboundPack,
  INBOUND_PACK_WINDOW_DAYS,
  assertE164,
  isTwilioWhatsappForm,
  parseTwilioWhatsappInbound,
  keywordOf,
  msgStatusFromTwilio,
  orderInboundReporters,
  parseTwilioInbound,
  parseTwilioStatus,
  processInboundSms,
  toCountryPack,
  twilioCallbackError,
  twilioLateFailureIsAccountFault,
  verifyTwilioSignature,
  type CountryPack,
  type CountryRow,
  type E164,
  type SmsNotifier,
} from '@sitelog/shared';
import { HttpError, json, parseWith, readJson, withHandler } from '../_shared/http.ts';
import { logError, logInfo, logWarn } from '../_shared/log.ts';
import type { SmsWebhookStore } from './store.ts';

/**
 * sms-webhook (W1-08; spec §4.4, §9.1, §9.5, F13, F15; verify_jwt = false). The Twilio inbound
 * endpoint is never named whatsapp-webhook (GAP D49).
 *
 *   POST /sms-webhook (or /inbound)  Twilio's messaging webhook (texts and, since W2-16, WhatsApp
 *                                    messages, `whatsapp:` addresses): X-Twilio-Signature, form fields,
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
 *                                    (spec §19 Q35), or on the WhatsApp thread where the pack lists
 *                                    WhatsApp (W2-16). JWT.
 *
 * The pack is found by the sender id that received the text (`To` = `countries.sms_sender_id`).
 * A sender may serve several packs (spec §19 Q370): `packFor` then picks one with
 * `chooseInboundPack` (the pack of the last message to that phone, its reporters', its country's,
 * the sender's own). A text is stored once per provider message id: a redelivery of a text
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
  /** W2-16: the Demo phone's WhatsApp thread (default the texts). */
  channel: z.enum(['sms', 'whatsapp']).default('sms'),
});

interface InboundText {
  providerId: string;
  from: E164;
  to: string;
  body: string;
  optOutType: string | null;
  /** W2-16: a WhatsApp message (default a text). */
  channel?: 'sms' | 'whatsapp';
  media?: Array<{ url: string; content_type: string | null }>;
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

/**
 * The status route's §13 notices (W1-08, W2-01) live in `@sitelog/shared` since W4-11
 * (`notify/late-status.ts`), shared with the worker's İletimerkezi report poll.
 */
export {
  inviteFailedNotification,
  messageAccountFaultNotification,
  providerFaultNotification,
  type LateStatusNotice as InviteNotice,
} from '@sitelog/shared';

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
   * §19 Q370: the pack of a message to a sender that may serve several packs, or null when it
   * serves none in this database.
   */
  async function packFor(
    rows: CountryRow[],
    from: E164,
    to: string,
    channel: 'sms' | 'whatsapp',
  ): Promise<CountryRow | null> {
    if (rows.length <= 1) return rows[0] ?? null;
    const since = new Date(now().getTime() - INBOUND_PACK_WINDOW_DAYS * 86_400_000).toISOString();
    const lastOutboundPack = await store.lastOutboundPack(from, channel, since);
    const reporterPacks = (
      await Promise.all(
        rows.map(async (row) =>
          (await store.reportersByPhone(from, row.code, { realOnly: true })).length > 0
            ? [row.code]
            : [],
        ),
      )
    ).flat();
    const code = chooseInboundPack({
      candidates: rows.map((r) => r.code),
      lastOutboundPack,
      reporterPacks,
      from,
      to,
    });
    return rows.find((r) => r.code === code) ?? null;
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
    const whatsapp = text.channel === 'whatsapp';
    // WhatsApp is two-way on every pack (spec §19 Q26); Twilio's OptOutType is SMS's.
    const keyword =
      whatsapp || pack.twoWaySms ? keywordOf(text.body, whatsapp ? null : text.optOutType) : null;
    const received = await store.receiveInbound({
      id: uuid(),
      ...(whatsapp ? { channel: 'whatsapp' as const } : {}),
      org_id: primary?.orgId ?? null,
      reporter_id: primary?.id ?? null,
      phone_e164: text.from,
      provider: opts.provider,
      provider_message_id: text.providerId,
      body: text.body,
      payload: {
        to: text.to,
        keyword,
        pack: pack.code,
        opt_out_type: whatsapp ? null : text.optOutType,
        ...(whatsapp ? { num_media: text.media?.length ?? 0, media: text.media ?? [] } : {}),
      },
    });
    return { ...received, keyword };
  }

  /**
   * W2-16 (spec §9.5, §19 Q26, Q85; GAP D49 (2)): a Twilio WhatsApp message, posted to this same
   * webhook with `whatsapp:` addresses. The pack is the one whose WhatsApp sender received it; the
   * row (`channel 'whatsapp'`) opens the person's 24-hour window, and the worker's `sms_inbound`
   * job runs the keywords (on every pack), the answers and the media reply.
   *
   * §19 Q372 (Meta's usernames, 2026): Twilio adds the person's business-scoped user id
   * (`ExternalUserId`) and puts it in `From` when WhatsApp hides the number. A message with both
   * records the id on the number's reporters (real orgs); a message with the id only is the
   * message of the number whose reporters have it, handled from then on exactly as if it had come
   * from that number (pack, window, STOP, keywords, answers). An id no reporter has is audited
   * (`whatsapp.inbound_unmatched`, without the id) and acknowledged: there is no number to store it
   * under, to reply to, or to make an unknown contact of. The id is never logged.
   */
  async function whatsappInbound(params: URLSearchParams): Promise<Response> {
    const message = parseTwilioWhatsappInbound(params);
    if (!message) {
      logWarn('whatsapp.inbound.unreadable');
      return twiml();
    }
    const rows = await store.packsByWhatsappSender(message.to);
    if (rows.length === 0) {
      logWarn('whatsapp.inbound.unknown_sender_id', { to: message.to });
      return twiml();
    }
    const from =
      message.from ?? (message.userId ? await store.phoneByWhatsappUserId(message.userId) : null);
    if (!from) {
      await store.audit({
        orgId: null,
        actorType: 'system',
        actorId: null,
        action: 'whatsapp.inbound_unmatched',
        entity: 'message',
        entityId: null,
        diff: {
          provider: 'twilio',
          provider_message_id: message.messageSid,
          packs: rows.map((r) => r.code),
          reason: 'unknown_user_id',
          num_media: message.numMedia,
        },
      });
      logWarn('whatsapp.inbound.unmatched_user_id', { packs: rows.map((r) => r.code) });
      return twiml();
    }
    const row = await packFor(rows, from, message.to, 'whatsapp');
    if (!row) {
      logWarn('whatsapp.inbound.unknown_sender_id', { to: message.to });
      return twiml();
    }
    const pack = toCountryPack(row);
    const stored = await storeInbound(
      {
        providerId: message.messageSid,
        from,
        to: message.to,
        body: message.body,
        optOutType: null,
        channel: 'whatsapp',
        media: message.media.map((m) => ({ url: m.url, content_type: m.contentType })),
      },
      pack,
      { provider: 'twilio', scope: { realOnly: true } },
    );
    // After the row and its job: a failure here loses no message (Twilio never retries a 5xx).
    let userIdRecorded: { set: number; cleared: number } | null = null;
    if (message.from && message.userId) {
      try {
        userIdRecorded = await store.recordWhatsappUserId(message.from, message.userId);
      } catch (err) {
        // The error's code only: a database message may quote the row (the number, the id).
        const code = (err as { code?: unknown } | null)?.code;
        logError('whatsapp.inbound.user_id_not_recorded', 'record_whatsapp_user_id failed', {
          messageId: stored.id,
          code: typeof code === 'string' ? code : null,
        });
      }
    }
    logInfo('whatsapp.inbound.queued', {
      messageId: stored.id,
      jobId: stored.jobId,
      keyword: stored.keyword,
      pack: pack.code,
      media: message.numMedia,
      redelivered: stored.duplicate,
      byUserId: message.from === null,
      ...(userIdRecorded && (userIdRecorded.set > 0 || userIdRecorded.cleared > 0)
        ? { userIdSet: userIdRecorded.set, userIdCleared: userIdRecorded.cleared }
        : {}),
    });
    return twiml();
  }

  async function inbound(req: Request): Promise<Response> {
    const params = await signedForm(req);
    if (isTwilioWhatsappForm(params)) return await whatsappInbound(params);
    const text = parseTwilioInbound(params);
    if (!text) {
      logWarn('sms.inbound.unreadable');
      return twiml();
    }
    const row = await packFor(await store.packsBySender(text.to), text.from, text.to, 'sms');
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
    // A text Twilio accepted and then could not deliver. Only a carrier refusing the number
    // (`undelivered` with 30003, 30004, 30005, 30006, or no code) is the reporter's: for a
    // welcome, F3 "Can't reach this number". `failed` (it never left the account) and every other
    // code (30032 unverified toll-free sender, 30034 unregistered 10DLC, 30002 suspended account,
    // 30007 filtered, …) is the account's fault, as in send_welcome: the reporter is left alone and
    // the office hears it once per org per hour, for a welcome or any other text. A WhatsApp
    // failure is neither (W2-15). Either way a Notifier message goes on to the person's next
    // channel (W2-01, `lateFallback`). The same code reads İletimerkezi's delivery reports in the
    // worker (W4-11, `applyLateStatus`).
    const failure = next === 'failed' || next === 'undeliverable';
    await applyLateStatus(
      { store, now, log: { info: logInfo, error: logError } },
      {
        message,
        incoming: next,
        error: twilioCallbackError(cb.errorCode),
        errorCode: cb.errorCode,
        accountFault:
          failure &&
          message.channel !== 'whatsapp' &&
          twilioLateFailureIsAccountFault(next, cb.errorCode),
        via: 'status_callback',
        reason: `twilio ${cb.status}`,
      },
    );
    return twiml();
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
    const whatsapp = body.channel === 'whatsapp';
    if (whatsapp && !pack.messageChannels.includes('whatsapp')) {
      throw new HttpError(
        409,
        'This country pack lists no WhatsApp: its replies cannot come by it',
      );
    }
    if (!whatsapp && !pack.twoWaySms) {
      throw new HttpError(409, 'This country pack has one-way SMS: replies cannot reach TalkOlog');
    }
    const from = assertE164(ctx.reporter.phone_e164);
    const scope = { orgId: ctx.org.id };
    const stored = await storeInbound(
      {
        providerId: `console:${uuid()}`,
        from,
        to: (whatsapp ? pack.whatsappSenderId : pack.smsSenderId) ?? 'console',
        body: body.body,
        optOutType: null,
        ...(whatsapp ? { channel: 'whatsapp' as const } : {}),
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
        ...(whatsapp ? { channel: 'whatsapp' as const } : {}),
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
