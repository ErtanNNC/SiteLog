import { waCopy } from '@sitelog/shared';
import type { Session } from '../session';
import { handleTestContent } from './test';

/**
 * §F3 steps 3–4: the first reply after the welcome template verifies the reporter and opens
 * test mode; "Wrong site" tells the office.
 */
export async function handleFirstReply(s: Session): Promise<void> {
  const { ctx } = s;
  const now = s.now;
  for (const r of s.reporters) {
    if (r.status === 'invited' || !r.verified_at) {
      await ctx.db.updateReporter(r.id, { status: 'verified', verified_at: now.toISOString() });
      await ctx.db.logAudit({
        org_id: r.org_id,
        actor_type: 'reporter',
        actor_id: r.id,
        action: 'reporter.verified',
        entity: 'reporter',
        entity_id: r.id,
        diff: { message_id: s.message.id },
      });
    }
  }
  if (!s.convo.reporter_id || !s.convo.org_id) {
    s.convo = await ctx.db.updateConversation(s.convo.id, {
      reporter_id: s.convo.reporter_id ?? s.reporter.id,
      org_id: s.convo.org_id ?? s.reporter.org_id,
    });
  }

  if (
    s.inbound.kind === 'button' &&
    s.inbound.parsed.kind === 'welcome' &&
    s.inbound.parsed.action === 'wrong_site'
  ) {
    await s.setState('idle', { site_disputed: true });
    await s.reply(waCopy.wrongSiteAck(), undefined, { kind: 'wrong_site' });
    for (const r of s.reporters) {
      await ctx.db.logAudit({
        org_id: r.org_id,
        actor_type: 'reporter',
        actor_id: r.id,
        action: 'reporter.wrong_site',
        entity: 'reporter',
        entity_id: r.id,
      });
      await ctx.db.notifyOrg(
        r.org_id,
        'reporter_wrong_site',
        `${r.name} says the site is wrong`,
        'Check the site assignment on the Team page.',
        '/team',
      );
    }
    return;
  }

  await s.setState('test_mode', {});
  await s.reply(waCopy.welcomeFollowup(), undefined, { kind: 'welcome_followup' });
  // A reporter who skips the buttons and sends content right away gets the test-note treatment.
  if (s.inbound.kind === 'audio' || (s.inbound.kind === 'text' && s.inbound.text.length > 0)) {
    await handleTestContent(s);
  }
}
