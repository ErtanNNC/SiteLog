import { addDays } from '@sitelog/shared';
import { weeklyDigestEmail } from '../email/templates';
import { PermanentJobError, type JobHandler } from './types';

/** §13 — Monday 07:00 org time: on-time %, weather hours by site, invoice gaps, unsigned reports (admin + pm). */
export const weeklyDigest: JobHandler<'weekly_digest'> = async (ctx, payload) => {
  const org = await ctx.db.getOrg(payload.orgId);
  if (!org) throw new PermanentJobError(`org ${payload.orgId} not found`);
  const weekEnd = addDays(payload.weekStart, 6);
  const stats = await ctx.db.digestStats(org.id, payload.weekStart, weekEnd);
  const members = await ctx.db.listMemberEmails(org.id, ['admin', 'pm']);
  if (members.length === 0) {
    ctx.log.info('weekly digest skipped: no admin/pm emails', { org_id: org.id });
    return;
  }
  const rendered = weeklyDigestEmail({
    orgName: org.name,
    weekStart: payload.weekStart,
    weekEnd,
    stats,
    url: ctx.config.APP_URL,
  });
  await ctx.email.send({
    to: members.map((m) => m.email),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tags: { kind: 'weekly_digest' },
    orgId: org.id,
  });
  await ctx.db.logAudit({
    org_id: org.id,
    actor_type: 'system',
    action: 'digest.sent',
    entity: 'org',
    entity_id: org.id,
    diff: { week_start: payload.weekStart, recipients: members.length },
  });
};
