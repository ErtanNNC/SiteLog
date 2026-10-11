import { firstName, formatDeadline } from '@sitelog/shared';
import { WaApiError } from '../wa/client';
import { sendBusinessInitiated } from '../wa/send';
import { PermanentJobError, type JobHandler } from './types';

/** §F3 step 1–2 — the `sitelog_welcome` (or `sitelog_reinvite`) template; conversation → welcome_sent. */
export const sendWelcome: JobHandler<'send_welcome'> = async (ctx, payload) => {
  const reporter = await ctx.db.getReporter(payload.reporterId);
  if (!reporter) throw new PermanentJobError(`reporter ${payload.reporterId} not found`);
  const sites = await ctx.db.listSitesForReporter(reporter.id);
  const site = (payload.siteId ? sites.find((s) => s.id === payload.siteId) : undefined) ?? sites[0] ?? null;
  const org = await ctx.db.getOrg(reporter.org_id);
  const settings = await ctx.db.getOrgSettings(reporter.org_id);
  if (!org || !settings) throw new PermanentJobError(`org ${reporter.org_id} not found`);
  const convo = await ctx.db.ensureConversation(reporter.phone_e164, { org_id: reporter.org_id, reporter_id: reporter.id });

  const deadline = formatDeadline(site?.deadline ?? settings.default_deadline);
  const vars = payload.reinvite ? [firstName(reporter.name), org.name] : [firstName(reporter.name), org.name, site?.name ?? 'your site', deadline];
  try {
    await sendBusinessInitiated(ctx, convo, payload.reinvite ? 'sitelog_reinvite' : 'sitelog_welcome', vars, null, { forceTemplate: true, meta: { kind: 'welcome' } });
  } catch (err) {
    if (err instanceof WaApiError && err.status >= 400 && err.status < 500) {
      // Number not on WhatsApp or otherwise undeliverable: surface on the Team page, do not retry.
      await ctx.db.updateReporter(reporter.id, { last_invite_error: err.message });
      await ctx.db.notifyOrg(reporter.org_id, 'reporter_invite_failed', `${reporter.name}: welcome could not be delivered`, err.message, '/team');
      await ctx.db.logAudit({ org_id: reporter.org_id, actor_type: 'system', action: 'reporter.invite_failed', entity: 'reporter', entity_id: reporter.id, diff: { error: err.message } });
      return;
    }
    throw err;
  }
  await ctx.db.updateReporter(reporter.id, { invited_at: ctx.now().toISOString(), last_invite_error: null, ...(reporter.status === 'verified' ? {} : { status: 'invited' as const }) });
  if (convo.state === 'new' || payload.reinvite) {
    await ctx.db.updateConversation(convo.id, { state: 'welcome_sent', org_id: reporter.org_id, reporter_id: reporter.id });
  }
  await ctx.db.logAudit({ org_id: reporter.org_id, actor_type: 'system', action: payload.reinvite ? 'reporter.reinvited' : 'reporter.invited', entity: 'reporter', entity_id: reporter.id, diff: { site_id: site?.id ?? null } });
};
