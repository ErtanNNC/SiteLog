import { randomUUID } from 'node:crypto';
import {
  MessageSendError,
  ensurePersonalLink,
  fieldLinkUrl,
  firstName,
  formatDeadline,
  formatPhone,
  isActiveReporterStatus,
  jobKeys,
  localDate,
  nextInsideWindow,
  noticeData,
  welcomeResendDueAt,
  welcomeResendSkip,
  WELCOME_RESEND_WINDOW,
  type NoticeData,
  type NotifyOutcome,
  type SiteRow,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import { loadOrgPack, workerLinkStore } from '../messaging';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §F3 step 1 (W1-08): the `welcome` text with the reporter's personal link, through the Notifier
 * (spec §4.5, §9.2): in the reporter's language with the pack's variant (the reply clause on
 * two-way packs, "or call {number}" when the pack has a voice number), on the pack's driver
 * (`console` for demo orgs). The link is the reporter's personal `field_links` row, the one
 * api-invite-reporter created, its code derived again under LINK_SIGNING_SECRET
 * (`ensurePersonalLink`). The Notifier's dedupe key is the job's, so a retry never texts twice.
 *
 * What the office hears (§13 "Message undeliverable / opted out", `reporter_invite_failed` /
 * `reporter_opted_out`), and what the reporter row records:
 * §19 Q372: the welcome may go by WhatsApp (its template) where the pack orders WhatsApp first, and
 * by SMS where WhatsApp cannot carry it (no sender here, no approved template in the reporter's
 * language) or refuses it for good (the Notifier falls back, §19 Q22). The refusal below is the
 * last channel's (`MessageSendError`; `SmsSendError` for SMS):
 * - the number cannot get messages (`undeliverable`: invalid, landline, unroutable):
 *   `last_invite_error` (Team: "Can't reach this number", F3), audited `reporter.invite_failed`,
 *   no retry;
 * - the number is on the provider's own opt-out list (`optedOut`, Twilio 21610): the Notifier
 *   recorded the opt-out (`sms_opt_outs`, the reporter row); the office is told they opted out;
 * - any other refusal the provider will repeat (bad credentials, an unapproved sender, no credit:
 *   `retryable: false` but not the number's fault): the reporter is left untouched, the office is
 *   told texts are failing for the account, and the job dies (`PermanentJobError`: retried with
 *   backoff, then dead and in Sentry);
 * - nothing deliverable (an opt-out, a refused consent, a pack whose channels cannot carry
 *   the link, a real org whose pack has no SMS or WhatsApp sender in this environment): audited by the
 *   Notifier, the invite left unsent (no `invited_at`, so a re-send stays allowed) and the office
 *   told why; a reporter the office disabled meanwhile gets nothing and nobody is told;
 * - a provider outage (`retryable`): thrown, the queue retries.
 *
 * W4-12 · F3's automatic re-send (spec §19 Q241, `WELCOME_RESEND`, default `auto`): the first
 * welcome that reaches the phone queues one `send_welcome` with `auto`, under the job key
 * `welcome_resend:<reporter>` (`jobKeys.welcomeAutoResend`; taken for good, so once per reporter
 * ever), due 48 h later in the site's daytime (09:00–18:00 site time, `welcomeResendDueAt`; the
 * delay on the database clock, as every delayed job). When it runs it sends only while nothing
 * happened since (`welcomeResendSkip`: still `invited`, no consent answer, no link opened, the
 * phone not opted out on the pack, no newer welcome from the office's Re-send): otherwise it
 * sends nothing and is audited `reporter.welcome_resend_skipped` with the reason. A job that runs
 * outside the daytime (a worker outage) moves to the next 09:00 once per site date
 * (`jobKeys.welcomeAutoResendDeferred`). The text's Notifier key is `welcome_resend:<reporter>`,
 * so a retry never texts twice and Team shows "Re-sent automatically" (W4-03); it is audited
 * `reporter.welcome_resent` (`auto`), not `reporter.reinvited`, so the office's one Re-send stays
 * for later (`canResend`). A re-send with nothing deliverable (an opt-out, no channel) tells the
 * office nothing new, only the audit: the first welcome's outcome was already theirs; a provider's
 * refusal is told as for any welcome (the number may have gone bad since).
 */

/**
 * §19 Q372: how long after a WhatsApp welcome its walk runs again (`send_welcome.recheck`), so a
 * late failure (63003, the number is not on WhatsApp) hands it to SMS. Twilio's failed status
 * comes within seconds to minutes; a later one leaves WhatsApp for the next message
 * (`whatsappFailedSinceInbound`), the automatic re-send included.
 */
export const WELCOME_WHATSAPP_RECHECK_MS = 10 * 60_000;

/** Why nothing went, with what the office can do (§13: reporter, channel, reason, action). */
const WELCOME_SKIPPED: Record<Exclude<NotifyOutcome, { channel: string }>['reason'], string> = {
  opted_out:
    'They opted out of texts, so TalkOlog texts them nothing until they opt in again (START, on packs that take replies).',
  no_consent:
    'They declined messages when asked for consent, so TalkOlog sends them nothing by text or WhatsApp.',
  no_channel:
    'No message channel of their country can carry the welcome and its link. Contact them another way.',
};

/** A real org whose pack has no SMS or WhatsApp sender set in this environment (§4.6, §19 Q29, Q84). */
const CONSOLE_REAL_ORG =
  'Messages to this country are not live in this environment yet: no SMS or WhatsApp sender is set for its country pack, so the reporter got nothing. Once a sender is set, re-send the welcome from Team & numbers.';

export const sendWelcome: JobHandler<'send_welcome'> = async (ctx, payload, job) => {
  const reporter = await ctx.db.getReporter(payload.reporterId);
  if (!reporter) throw new PermanentJobError(`reporter ${payload.reporterId} not found`);
  if (reporter.status === 'disabled') {
    // The office disabled them while the job waited: nothing to send and nothing to report.
    ctx.log.info('welcome not sent: reporter disabled', { reporter_id: reporter.id });
    return;
  }
  const recheck = payload.recheck ?? null;
  const auto = payload.auto === true && recheck === null;
  if (auto && ctx.config.WELCOME_RESEND === 'off') {
    ctx.log.info('automatic welcome re-send off (WELCOME_RESEND)', { reporter_id: reporter.id });
    return;
  }
  const sites = await ctx.db.listSitesForReporter(reporter.id);
  const site =
    (payload.siteId ? sites.find((s) => s.id === payload.siteId) : undefined) ?? sites[0] ?? null;
  if (!site) throw new PermanentJobError(`reporter ${reporter.id} has no site`);
  const org = await ctx.db.getOrg(reporter.org_id);
  const settings = await ctx.db.getOrgSettings(reporter.org_id);
  if (!org || !settings) throw new PermanentJobError(`org ${reporter.org_id} not found`);
  // Configuration, not data: retried with backoff, then dead and in Sentry.
  if (!ctx.config.LINK_SIGNING_SECRET) throw new Error('LINK_SIGNING_SECRET is not set');
  if (!ctx.config.FIELD_APP_URL) throw new Error('FIELD_APP_URL is not set');

  const pack = await loadOrgPack(ctx.db, org);
  if (auto) {
    const now = ctx.now();
    const skip = welcomeResendSkip(
      {
        status: reporter.status,
        invitedAt: reporter.invited_at,
        consents: (await ctx.db.listConsents(reporter.id)).length,
        linkOpened: await ctx.db.hasOpenedLink(reporter.id),
        phoneOptedOut: await ctx.db.isSmsOptedOut(reporter.phone_e164, pack.code),
      },
      now,
    );
    if (skip) {
      await ctx.db.logAudit({
        org_id: reporter.org_id,
        actor_type: 'system',
        action: 'reporter.welcome_resend_skipped',
        entity: 'reporter',
        entity_id: reporter.id,
        diff: { auto: true, reason: skip },
      });
      return;
    }
    const at = nextInsideWindow(now, site.timezone, WELCOME_RESEND_WINDOW);
    if (at.getTime() > now.getTime()) {
      // Ran outside the site's daytime (a worker outage, retries): the next 09:00, once a day.
      await ctx.db.enqueueJob(
        'send_welcome',
        { reporterId: reporter.id, siteId: site.id, reinvite: false, auto: true },
        {
          dedupeKey: jobKeys.welcomeAutoResendDeferred(reporter.id, localDate(now, site.timezone)),
          delayMs: at.getTime() - now.getTime(),
        },
      );
      return;
    }
  }
  const link = await ensurePersonalLink(
    workerLinkStore(ctx.db),
    ctx.config.LINK_SIGNING_SECRET,
    reporter.id,
    randomUUID,
  );
  if (link.created) {
    await ctx.db.logAudit({
      org_id: reporter.org_id,
      actor_type: 'system',
      action: 'field_link.created',
      entity: 'reporter',
      entity_id: reporter.id,
      diff: { kind: 'personal', site_id: null, report_date: null },
    });
  }

  const notify = (title: string, body: string, data: NoticeData) =>
    ctx.db.notifyOrg(
      reporter.org_id,
      'reporter_invite_failed',
      `${reporter.name}: ${title}`,
      body,
      '/team',
      null,
      data,
    );

  // The Notifier key: per job (a retry never texts twice); the automatic re-send's per reporter;
  // a recheck's the welcome's it checks (§19 Q372).
  const welcomeKey =
    recheck?.messageKey ??
    (auto ? jobKeys.welcomeAutoResend(reporter.id) : `send_welcome:${job.id}`);
  // A recheck reports only a message its own walk sent (a retry of it finds that one already there).
  const before = recheck
    ? new Set((await ctx.db.listMessagesByDedupeKey(reporter.id, welcomeKey)).map((m) => m.id))
    : null;
  let outcome: NotifyOutcome;
  try {
    outcome = await ctx.notifier.send(
      reporter.id,
      'welcome',
      {
        first: firstName(reporter.name),
        company: org.name,
        site: site.name,
        deadline: formatDeadline(site.deadline ?? settings.default_deadline),
        link: fieldLinkUrl(ctx.config.FIELD_APP_URL, link.code),
        ...(pack.voiceNumber ? { number: formatPhone(pack.voiceNumber) } : {}),
      },
      { dedupeKey: welcomeKey },
    );
  } catch (err) {
    if (!(err instanceof MessageSendError) || err.retryable) throw err;
    const error = err.message.slice(0, 300);
    if (err.optedOut) {
      // The provider's opt-out list (the Notifier recorded it): not a bad number.
      await ctx.db.notifyOrg(
        reporter.org_id,
        'reporter_opted_out',
        `${reporter.name} opted out of texts`,
        `${formatPhone(reporter.phone_e164)} is on the SMS provider's opt-out list (they replied STOP to this sender before), so TalkOlog texts them nothing until they reply START. Call them if you need their reports.`,
        '/team',
        null,
        noticeData('reporter_opted_out', {
          name: reporter.name,
          phone: formatPhone(reporter.phone_e164),
        }),
      );
      await ctx.db.logAudit({
        org_id: reporter.org_id,
        actor_type: 'system',
        action: 'reporter.invite_failed',
        entity: 'reporter',
        entity_id: reporter.id,
        diff: { error, undeliverable: true, opted_out: true },
      });
      return;
    }
    if (err.undeliverable) {
      // The provider refuses this number for good (invalid, landline, unroutable): no retry.
      await ctx.db.updateReporter(reporter.id, { last_invite_error: error });
      await notify(
        'the welcome text could not be delivered',
        error,
        noticeData('welcome_undeliverable', { name: reporter.name }),
      );
      await ctx.db.logAudit({
        org_id: reporter.org_id,
        actor_type: 'system',
        action: 'reporter.invite_failed',
        entity: 'reporter',
        entity_id: reporter.id,
        diff: { error, undeliverable: true },
      });
      return;
    }
    // A fault of the account or the sender, not of the number: the reporter stays reachable,
    // the office is told once, and the job dies into Sentry for the operator. `notified` lets
    // sms-webhook's status route skip its own account notice for the next hour.
    const notified = job.attempts <= 1;
    if (notified) {
      await notify(
        'the welcome text failed at the SMS provider',
        `Texts are failing for this account (${error}). TalkOlog has been alerted; the reporter was not marked as invited. Re-send the welcome from Team & numbers once the provider is back.`,
        noticeData('welcome_provider_fault', { name: reporter.name, error }),
      );
    }
    await ctx.db.logAudit({
      org_id: reporter.org_id,
      actor_type: 'system',
      action: 'sms.provider_fault',
      entity: 'reporter',
      entity_id: reporter.id,
      diff: {
        error,
        code: err.opts.code ?? null,
        driver: err.opts.driver,
        attempt: job.attempts,
        notified,
      },
    });
    throw new PermanentJobError(`welcome for reporter ${reporter.id}: ${error}`);
  }
  if (recheck) {
    // §19 Q372: the walk answered the WhatsApp welcome again (it went, or is still on its way), or
    // sent the welcome on the next channel after a late failure. Only the latter is news.
    if (outcome.channel !== null && !before?.has(outcome.messageId)) {
      await ctx.db.logAudit({
        org_id: reporter.org_id,
        actor_type: 'system',
        action: 'reporter.welcome_fallback',
        entity: 'reporter',
        entity_id: reporter.id,
        diff: {
          from_message_id: recheck.messageId,
          channel: outcome.channel,
          message_id: outcome.messageId,
        },
      });
    } else if (outcome.channel === null) {
      ctx.log.info('welcome recheck: nothing deliverable after WhatsApp', {
        reporter_id: reporter.id,
        reason: outcome.reason,
      });
    }
    return;
  }
  if (outcome.channel === null) {
    // §13 "Message undeliverable / opted out": the office learns why (the Notifier audited it).
    ctx.log.info('welcome not sent', {
      reporter_id: reporter.id,
      reason: outcome.reason,
      detail: outcome.detail ?? null,
    });
    if (outcome.detail === 'disabled') return;
    if (auto) {
      await ctx.db.logAudit({
        org_id: reporter.org_id,
        actor_type: 'system',
        action: 'reporter.welcome_resend_skipped',
        entity: 'reporter',
        entity_id: reporter.id,
        diff: { auto: true, reason: outcome.reason, detail: outcome.detail ?? null },
      });
      return;
    }
    const consoleRealOrg = outcome.detail === 'console_real_org';
    await notify(
      'the welcome text was not sent',
      consoleRealOrg ? CONSOLE_REAL_ORG : WELCOME_SKIPPED[outcome.reason],
      noticeData('welcome_not_sent', {
        name: reporter.name,
        reason: consoleRealOrg ? 'console_real_org' : outcome.reason,
      }),
    );
    return;
  }

  await ctx.db.updateReporter(reporter.id, {
    invited_at: ctx.now().toISOString(),
    last_invite_error: null,
    ...(isActiveReporterStatus(reporter.status) || reporter.status === 'opted_out'
      ? {}
      : { status: 'invited' as const }),
  });
  await ctx.db.logAudit({
    org_id: reporter.org_id,
    actor_type: 'system',
    action: auto
      ? 'reporter.welcome_resent'
      : payload.reinvite
        ? 'reporter.reinvited'
        : 'reporter.invited',
    entity: 'reporter',
    entity_id: reporter.id,
    diff: {
      site_id: site.id,
      channel: outcome.channel,
      message_id: outcome.messageId,
      ...(auto ? { auto: true } : {}),
    },
  });
  if (outcome.channel === 'whatsapp' && !org.is_demo) {
    // §19 Q372: the first contact goes by WhatsApp before anyone knows the number is on it.
    await ctx.db.enqueueJob(
      'send_welcome',
      {
        reporterId: reporter.id,
        siteId: site.id,
        reinvite: false,
        recheck: { messageKey: welcomeKey, messageId: outcome.messageId },
      },
      { dedupeKey: jobKeys.welcomeRecheck(welcomeKey), delayMs: WELCOME_WHATSAPP_RECHECK_MS },
    );
  }
  if (!auto) await queueAutoResend(ctx, reporter.id, site);
};

/**
 * §19 Q241: the one automatic re-send, queued by the welcome that went (the key is taken for good
 * by the first, so later welcomes queue nothing more), 48 h on in the site's daytime.
 */
async function queueAutoResend(
  ctx: Ctx,
  reporterId: string,
  site: Pick<SiteRow, 'id' | 'timezone'>,
): Promise<void> {
  if (ctx.config.WELCOME_RESEND !== 'auto') return;
  const now = ctx.now();
  const due = welcomeResendDueAt(now, site.timezone);
  await ctx.db.enqueueJob(
    'send_welcome',
    { reporterId, siteId: site.id, reinvite: false, auto: true },
    {
      dedupeKey: jobKeys.welcomeAutoResend(reporterId),
      delayMs: due.getTime() - now.getTime(),
    },
  );
}
