import { randomUUID } from 'node:crypto';
import {
  SmsSendError,
  ensurePersonalLink,
  fieldLinkUrl,
  firstName,
  formatDeadline,
  formatPhone,
  isActiveReporterStatus,
  noticeData,
  type NoticeData,
  type NotifyOutcome,
} from '@sitelog/shared';
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
 * - the number cannot get texts (`SmsSendError.undeliverable`: invalid, landline, unroutable):
 *   `last_invite_error` (Team: "Can't reach this number", F3), audited `reporter.invite_failed`,
 *   no retry;
 * - the number is on the provider's own opt-out list (`optedOut`, Twilio 21610): the Notifier
 *   recorded the opt-out (`sms_opt_outs`, the reporter row); the office is told they opted out;
 * - any other refusal the provider will repeat (bad credentials, an unapproved sender, no credit:
 *   `retryable: false` but not the number's fault): the reporter is left untouched, the office is
 *   told texts are failing for the account, and the job dies (`PermanentJobError`: retried with
 *   backoff, then dead and in Sentry);
 * - nothing deliverable (an opt-out, a refused SMS consent, a pack whose channels cannot carry
 *   the link, a real org whose pack has no sender id in this environment): audited by the
 *   Notifier, the invite left unsent (no `invited_at`, so a re-send stays allowed) and the office
 *   told why; a reporter the office disabled meanwhile gets nothing and nobody is told;
 * - a provider outage (`retryable`): thrown, the queue retries.
 */

/** Why nothing went, with what the office can do (§13: reporter, channel, reason, action). */
const WELCOME_SKIPPED: Record<Exclude<NotifyOutcome, { channel: string }>['reason'], string> = {
  opted_out:
    'They opted out of texts, so SiteLog texts them nothing until they opt in again (START, on packs that take replies).',
  no_consent: 'They declined texts when asked for consent, so SiteLog texts them nothing.',
  no_channel:
    'No message channel of their country can carry the welcome and its link. Contact them another way.',
};

/** A real org whose pack has no SMS sender set in this environment (spec §4.6, §19 Q29). */
const CONSOLE_REAL_ORG =
  'Texts to this country are not live in this environment yet: no SMS sender is set for its country pack, so the reporter got nothing. Once the sender is set, re-send the welcome from Team & numbers.';

export const sendWelcome: JobHandler<'send_welcome'> = async (ctx, payload, job) => {
  const reporter = await ctx.db.getReporter(payload.reporterId);
  if (!reporter) throw new PermanentJobError(`reporter ${payload.reporterId} not found`);
  if (reporter.status === 'disabled') {
    // The office disabled them while the job waited: nothing to send and nothing to report.
    ctx.log.info('welcome not sent: reporter disabled', { reporter_id: reporter.id });
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
      { dedupeKey: `send_welcome:${job.id}` },
    );
  } catch (err) {
    if (!(err instanceof SmsSendError) || err.retryable) throw err;
    const error = err.message.slice(0, 300);
    if (err.optedOut) {
      // The provider's opt-out list (the Notifier recorded it): not a bad number.
      await ctx.db.notifyOrg(
        reporter.org_id,
        'reporter_opted_out',
        `${reporter.name} opted out of texts`,
        `${formatPhone(reporter.phone_e164)} is on the SMS provider's opt-out list (they replied STOP to this sender before), so SiteLog texts them nothing until they reply START. Call them if you need their reports.`,
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
        `Texts are failing for this account (${error}). SiteLog has been alerted; the reporter was not marked as invited. Re-send the welcome from Team & numbers once the provider is back.`,
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
  if (outcome.channel === null) {
    // §13 "Message undeliverable / opted out": the office learns why (the Notifier audited it).
    ctx.log.info('welcome not sent', {
      reporter_id: reporter.id,
      reason: outcome.reason,
      detail: outcome.detail ?? null,
    });
    if (outcome.detail === 'disabled') return;
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
    action: payload.reinvite ? 'reporter.reinvited' : 'reporter.invited',
    entity: 'reporter',
    entity_id: reporter.id,
    diff: { site_id: site.id, channel: outcome.channel, message_id: outcome.messageId },
  });
};
