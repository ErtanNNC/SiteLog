import { addDays, groupByEmailLanguage } from '@sitelog/shared';
import { weeklyDigestEmail } from '../email/templates';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §13 — Monday 07:00 org time: on-time %, weather hours by site, invoice gaps, unsigned reports
 * (admin + pm), each reader in their panel language (W4-09, §19 Q239: one email per language).
 */
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
  const groups = groupByEmailLanguage(
    members.map((m) => m.email),
    members.map((m) => ({ email: m.email, uiLocale: m.ui_locale })),
    org.locale,
  );
  for (const g of groups) {
    const rendered = weeklyDigestEmail({
      language: g.language,
      orgName: org.name,
      weekStart: payload.weekStart,
      weekEnd,
      stats,
      url: ctx.config.APP_URL,
    });
    await ctx.email.send({
      to: g.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: { kind: 'weekly_digest' },
      orgId: org.id,
    });
  }
  await ctx.db.logAudit({
    org_id: org.id,
    actor_type: 'system',
    action: 'digest.sent',
    entity: 'org',
    entity_id: org.id,
    diff: {
      week_start: payload.weekStart,
      recipients: members.length,
      languages: groups.map((g) => g.language),
    },
  });
};
