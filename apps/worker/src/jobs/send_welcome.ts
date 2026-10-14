import { randomUUID } from 'node:crypto';
import {
  SmsSendError,
  ensurePersonalLink,
  fieldLinkUrl,
  firstName,
  formatDeadline,
  formatPhone,
  isActiveReporterStatus,
} from '@sitelog/shared';
import { loadOrgPack, workerLinkStore } from '../messaging';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §F3 step 1 (W1-08): the `welcome` text with the reporter's personal link, through the Notifier
 * (spec §4.5, §9.2): in the reporter's language with the pack's variant (the reply clause on
 * two-way packs, "or call {number}" when the pack has a voice number), on the pack's driver
 * (`console` for demo orgs and senders not set here). The link is the reporter's personal
 * `field_links` row, the one api-invite-reporter created, its code derived again under
 * LINK_SIGNING_SECRET (`ensurePersonalLink`). The Notifier's dedupe key is the job's, so a retry
 * never texts twice. A number the provider refuses for good marks the reporter (Team: "Can't
 * reach this number", F3) and tells the office; nothing deliverable (an opt-out, a refused SMS
 * consent, a pack whose channels cannot carry the link) is audited by the Notifier, leaves the
 * invite unsent and tells the office why (§13).
 */
/** Why nothing went, with what the office can do (§13: reporter, channel, reason, action). */
const WELCOME_SKIPPED: Record<'no_channel' | 'no_consent' | 'opted_out', string> = {
  opted_out:
    'They opted out of texts, so SiteLog texts them nothing until they opt in again (START, on packs that take replies).',
  no_consent: 'They declined texts when asked for consent, so SiteLog texts them nothing.',
  no_channel:
    'No message channel of their country can carry the welcome and its link. Contact them another way.',
};

export const sendWelcome: JobHandler<'send_welcome'> = async (ctx, payload, job) => {
  const reporter = await ctx.db.getReporter(payload.reporterId);
  if (!reporter) throw new PermanentJobError(`reporter ${payload.reporterId} not found`);
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

  let outcome;
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
    // The provider refuses this number for good (invalid, landline, unsubscribed): no retry.
    await ctx.db.updateReporter(reporter.id, { last_invite_error: err.message.slice(0, 300) });
    await ctx.db.notifyOrg(
      reporter.org_id,
      'reporter_invite_failed',
      `${reporter.name}: the welcome text could not be delivered`,
      err.message.slice(0, 300),
      '/team',
    );
    await ctx.db.logAudit({
      org_id: reporter.org_id,
      actor_type: 'system',
      action: 'reporter.invite_failed',
      entity: 'reporter',
      entity_id: reporter.id,
      diff: { error: err.message.slice(0, 300), undeliverable: err.undeliverable },
    });
    return;
  }
  if (outcome.channel === null) {
    // §13 "Message undeliverable / opted out": the office learns why (the Notifier audited it).
    ctx.log.info('welcome not sent', { reporter_id: reporter.id, reason: outcome.reason });
    await ctx.db.notifyOrg(
      reporter.org_id,
      'reporter_invite_failed',
      `${reporter.name}: the welcome text was not sent`,
      WELCOME_SKIPPED[outcome.reason],
      '/team',
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
