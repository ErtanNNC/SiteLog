import { z } from 'zod';
import {
  EMPTY_TWIML,
  SmsSendError,
  assertE164,
  ensurePersonalLink,
  fieldLinkUrl,
  formatPhone,
  keywordOf,
  msgStatusFromTwilio,
  nextMessageStatus,
  orderInboundReporters,
  parseTwilioInbound,
  parseTwilioStatus,
  planInboundSms,
  toCountryPack,
  verifyTwilioSignature,
  type CountryPack,
  type E164,
  type SmsNotifier,
  type TwoWaySmsKey,
} from '@sitelog/shared';
import { HttpError, json, parseWith, readJson, withHandler } from '../_shared/http.ts';
import { logInfo, logWarn } from '../_shared/log.ts';
import type { InboundReporterRow, SmsWebhookStore } from './store.ts';

/**
 * sms-webhook (W1-08; spec §4.4, §9.1, §9.5, F13, F15; verify_jwt = false). The Twilio inbound
 * endpoint is never named whatsapp-webhook (GAP D49).
 *
 *   POST /sms-webhook (or /inbound)  Twilio's messaging webhook: X-Twilio-Signature, form fields,
 *                                    store → keywords → reply → empty TwiML.
 *   POST /sms-webhook/status         Twilio's StatusCallback: messages.status (never backwards).
 *   POST /sms-webhook/demo-reply     The panel's Demo phone (§11.1): an admin of a demo org types a
 *                                    text as the reporter; the same handler logic, console only,
 *                                    and only on packs with two-way SMS (spec §19 Q35). JWT.
 *
 * The pack is found by the sender id that received the text (`To` = `countries.sms_sender_id`,
 * unique across packs). The keywords and the F13 auto-reply run only on packs with two-way SMS;
 * every other text is stored for the M6 ladder. Handling is idempotent per provider message id:
 * a redelivery of a text handled to the end is acknowledged and nothing runs twice; one that
 * failed halfway runs again (its changes are no-ops the second time, the reply may repeat).
 * Replies go through the Notifier's `reply` (the pack's driver, console for demo orgs and senders
 * not set), outside the person's channel order and consent (`smsReplyAllowed`).
 */

export interface SmsWebhookDeps {
  store: SmsWebhookStore;
  notifier: SmsNotifier;
  /** TWILIO_AUTH_TOKEN (throws EnvError when unset: 500, never an unchecked request). */
  authToken: () => string;
  /** The public URL Twilio calls (SMS_WEBHOOK_URL, else {SUPABASE_URL}/functions/v1/sms-webhook). */
  webhookUrl: () => string | null;
  /** LINK_SIGNING_SECRET: the personal link of the HELP reply. */
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

  /** The reply's variables: the personal link and the org for HELP, nothing for the others. */
  async function replyVars(
    key: TwoWaySmsKey,
    pack: CountryPack,
    reporter: InboundReporterRow | null,
  ): Promise<Record<string, string>> {
    if (key !== 'help' || !reporter) return {};
    const link = await ensurePersonalLink(store.links, deps.linkSecret(), reporter.id, uuid);
    if (link.created) {
      await store.audit({
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

  async function handleInbound(
    text: InboundText,
    pack: CountryPack,
    opts: { provider: 'twilio' | 'console'; demoOnly: boolean },
  ): Promise<InboundResult> {
    const reporters = await store.reportersByPhone(text.from, pack.code, {
      demoOnly: opts.demoOnly,
    });
    const primary = orderInboundReporters(reporters)[0] ?? null;
    const keyword = pack.twoWaySms ? keywordOf(text.body, text.optOutType) : null;
    const inserted = await store.insertInbound({
      id: uuid(),
      org_id: primary?.orgId ?? null,
      reporter_id: primary?.id ?? null,
      phone_e164: text.from,
      provider: opts.provider,
      provider_message_id: text.providerId,
      body: text.body,
      payload: { to: text.to, keyword },
    });
    if (inserted.duplicate && inserted.handled) {
      return { messageId: inserted.id, duplicate: true, keyword, replyId: null };
    }
    if (!inserted.duplicate) {
      await store.audit({
        orgId: primary?.orgId ?? null,
        actorType: primary ? 'reporter' : 'system',
        actorId: primary?.id ?? null,
        action: 'sms.received',
        entity: 'message',
        entityId: inserted.id,
        diff: { provider: opts.provider, keyword, pack: pack.code },
      });
    }

    const plan = planInboundSms({
      pack,
      body: text.body,
      optOutType: text.optOutType,
      reporters,
      pendingUnknown: primary ? false : await store.hasPendingUnknown(text.from),
      now: now(),
    });
    const byId = new Map(reporters.map((r) => [r.id, r]));
    for (const change of plan.changes) {
      const reporter = byId.get(change.reporterId)!;
      await store.updateReporter(change.reporterId, change.patch);
      await store.audit({
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
          message_id: inserted.id,
        },
      });
    }
    if (plan.unknownContact) {
      const contactId = await store.insertUnknownContact({
        phone_e164: text.from,
        message_id: inserted.id,
        snippet: text.body.slice(0, 200),
      });
      await store.audit({
        orgId: null,
        actorType: 'system',
        action: 'unknown_contact.created',
        entity: 'unknown_contact',
        entityId: contactId,
        diff: { channel: 'sms', pack: pack.code, message_id: inserted.id },
      });
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
          vars: (await replyVars(plan.reply.key, pack, reporter)) as never,
        });
        replyId = sent.messageId;
      } catch (err) {
        // A number the provider will not text (e.g. Twilio 21610 after its own STOP handling):
        // recorded on the reply's row, and the text counts as handled. Anything else is retried.
        if (!(err instanceof SmsSendError) || err.retryable) throw err;
      }
    }
    await store.markHandled(inserted.id, now().toISOString());
    logInfo('sms.inbound.handled', {
      messageId: inserted.id,
      keyword: plan.keyword,
      changes: plan.changes.length,
      unknown: plan.unknownContact,
      reply: plan.reply?.key ?? null,
      pack: pack.code,
    });
    return {
      messageId: inserted.id,
      duplicate: inserted.duplicate,
      keyword: plan.keyword,
      replyId,
    };
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
    await handleInbound(
      {
        providerId: text.messageSid,
        from: text.from,
        to: text.to,
        body: text.body,
        optOutType: text.optOutType,
      },
      toCountryPack(row),
      { provider: 'twilio', demoOnly: false },
    );
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
    await store.updateMessageStatus(message.id, to, cb.errorCode ? `twilio ${cb.errorCode}` : null);
    await store.audit({
      orgId: message.org_id,
      actorType: 'system',
      action: 'sms.status',
      entity: 'message',
      entityId: message.id,
      diff: { from: message.status, to, error_code: cb.errorCode },
    });
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
    if (!pack.twoWaySms) {
      throw new HttpError(409, 'This country pack has one-way SMS: replies cannot reach SiteLog');
    }
    const result = await handleInbound(
      {
        providerId: `console:${uuid()}`,
        from: assertE164(ctx.reporter.phone_e164),
        to: pack.smsSenderId ?? 'console',
        body: body.body,
        optOutType: null,
      },
      pack,
      { provider: 'console', demoOnly: true },
    );
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
