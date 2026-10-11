import { ButtonSets, exampleDraftCard, localDate, waCopy, type MessageRow, type TranscriptRow } from '@sitelog/shared';
import { firstWords, isUnintelligible } from '../../ai/transcribe';
import type { Ctx } from '../../context';
import { sendFreeForm } from '../../wa/send';
import { ensureMediaStored } from '../media';
import { createSession, deadlineFor, type Session } from '../session';

/** §F4 — test note: transcription only, nothing filed. */

async function deadlineText(s: Session): Promise<string> {
  const site = s.activeSites[0] ?? s.sites[0];
  const settings = await s.ctx.db.getOrgSettings(site?.org_id ?? s.reporter.org_id);
  if (!settings) return '17:30';
  return deadlineFor(site ?? { deadline: null }, settings);
}

export async function handleTestContent(s: Session): Promise<void> {
  const { ctx, inbound, message } = s;
  if (inbound.kind === 'audio') {
    const site = s.activeSites[0] ?? s.sites[0];
    const loc = site ? { orgId: site.org_id, siteId: site.id, date: localDate(new Date(message.created_at), site.timezone) } : { custom: `${s.reporter.org_id}/_test` };
    await ensureMediaStored(ctx, message, loc);
    await ctx.db.enqueueJob('transcribe_audio', { messageId: message.id, testMode: true }, { dedupeKey: `transcribe:${message.id}` });
    return;
  }
  if (inbound.kind === 'text') {
    // "That works too, but voice is faster." → idle after one text (§F4 edge case).
    await s.setState('idle', {});
    await s.reply(waCopy.testTextInstead(), undefined, { kind: 'test_text' });
    return;
  }
  if (inbound.kind === 'image' || inbound.kind === 'document') {
    await s.reply(waCopy.testTextInstead(), undefined, { kind: 'test_text' });
    return;
  }
}

export async function handleTestButton(s: Session, action: 'example' | 'done'): Promise<void> {
  if (action === 'example') {
    await s.reply(exampleDraftCard(), undefined, { kind: 'test_example' });
    if (s.convo.state === 'test_mode') await s.setState('idle', {});
    return;
  }
  await s.setState('idle', {});
  await s.reply(waCopy.testDone(await deadlineText(s)), undefined, { kind: 'test_done' });
}

/** Called by the transcribe_audio job for testMode payloads. */
export async function onTestTranscript(ctx: Ctx, message: MessageRow, transcript: TranscriptRow): Promise<void> {
  const session = await createSession(ctx, message);
  const convo = session?.convo ?? (await ctx.db.getConversation(message.conversation_id));
  if (!convo) return;
  if (isUnintelligible(transcript.text)) {
    await sendFreeForm(ctx, convo, waCopy.unclearAudio(), undefined, { kind: 'test_unclear' });
    return;
  }
  const deadline = session ? await deadlineText(session) : '17:30';
  await sendFreeForm(ctx, convo, waCopy.testHeard(firstWords(transcript.text), deadline), ButtonSets.test(), { kind: 'test_heard' });
  if (session) await session.setState('idle', {});
  else await ctx.db.updateConversation(convo.id, { state: 'idle' });
  await ctx.db.logAudit({ org_id: session?.reporter.org_id ?? convo.org_id, actor_type: 'agent', action: 'reporter.test_note', entity: 'message', entity_id: message.id });
}
