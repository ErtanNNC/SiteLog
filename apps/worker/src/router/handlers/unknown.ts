import { openAiTranscribeModel } from '../../config';
import { waCopy, type ConversationRow, type MessageRow } from '@sitelog/shared';
import { guessSite } from '../../ai/site-guess';
import { buildTranscriptionPrompt, transcribeAudio } from '../../ai/transcribe';
import type { Ctx } from '../../context';
import { sendFreeForm } from '../../wa/send';
import { ensureMediaStored } from '../media';
import { parseInbound } from '../inbound';

/**
 * §F11 — a phone that is not a reporter in any org: hold the message, transcribe audio for the
 * snippet, guess the site from the content, reply once, alert the office.
 */
export async function handleUnknownSender(
  ctx: Ctx,
  convo: ConversationRow,
  message: MessageRow,
): Promise<void> {
  const inbound = parseInbound(message);
  const existing = await ctx.db.findPendingUnknownContact(convo.phone_e164);
  let snippet: string | null = null;

  if (inbound.kind === 'text') snippet = inbound.text;
  if (inbound.kind === 'image' || inbound.kind === 'document') snippet = inbound.caption;
  if (inbound.kind === 'audio' || inbound.kind === 'image') {
    try {
      await ensureMediaStored(ctx, message, { custom: `_unknown/${convo.id}` });
    } catch (err) {
      ctx.log.warn('unknown sender media not stored', { err, message_id: message.id });
    }
  }
  if (inbound.kind === 'audio' && ctx.ai.openai && message.storage_path) {
    try {
      const buffer = await ctx.storage.download('audio', message.storage_path);
      const t = await transcribeAudio(
        ctx.ai.openai,
        ctx.ffmpeg,
        {
          audio: buffer,
          ext: message.storage_path.split('.').pop() ?? 'ogg',
          model: openAiTranscribeModel(ctx.config),
          prompt: buildTranscriptionPrompt({
            siteName: 'a construction site',
            companies: [],
            glossary: [],
          }),
          durationS: message.duration_s ?? undefined,
        },
        ctx.log,
      );
      await ctx.db.upsertTranscript({
        message_id: message.id,
        language: t.language,
        text: t.text,
        segments: t.segments,
        model: t.model,
      });
      ctx.metrics.add({ audioSeconds: t.durationS, estCostUsd: t.estCostUsd });
      snippet = t.text;
    } catch (err) {
      ctx.log.warn('unknown sender transcription failed', { err, message_id: message.id });
    }
  }
  snippet = snippet ? snippet.trim().slice(0, 140) : null;

  // Guess the org/site from the content (site names, project codes).
  let guessedSiteId: string | null = null;
  let guessedOrgId: string | null = null;
  if (snippet) {
    const sites = await ctx.db.listActiveSites();
    const guess = await guessSite(
      ctx.ai.claude,
      ctx.config.CLAUDE_MODEL_FAST,
      snippet,
      sites.map((s) => ({
        id: s.id,
        name: s.name,
        projectCode: s.project_code,
        address: s.address,
        orgId: s.org_id,
      })),
      ctx.log,
    );
    if (guess.siteId && guess.confidence >= 0.85) {
      guessedSiteId = guess.siteId;
      guessedOrgId = sites.find((s) => s.id === guess.siteId)?.org_id ?? null;
    }
  }

  if (existing) {
    await ctx.db.updateUnknownContact(existing.id, {
      snippet: existing.snippet ?? snippet,
      org_id: existing.org_id ?? guessedOrgId,
      guessed_site_id: existing.guessed_site_id ?? guessedSiteId,
    });
    // Reply only once per pending sender (§F11 step 3).
    return;
  }
  // A WhatsApp sender has no field_channel (D13): channel stays null until step 22 retires this.
  const row = await ctx.db.insertUnknownContact({
    org_id: guessedOrgId,
    phone_e164: convo.phone_e164,
    channel: null,
    message_id: message.id,
    snippet,
    guessed_site_id: guessedSiteId,
  });
  if (guessedOrgId) {
    await ctx.db.updateConversation(convo.id, { org_id: guessedOrgId });
    await ctx.db.notifyOrg(
      guessedOrgId,
      'unknown_contact',
      'Unknown number tried to report',
      snippet,
      '/team',
    );
    await ctx.db.logAudit({
      org_id: guessedOrgId,
      actor_type: 'system',
      action: 'unknown_contact.recorded',
      entity: 'unknown_contact',
      entity_id: row.id,
      diff: { guessed_site_id: guessedSiteId },
    });
  }
  await sendFreeForm(
    ctx,
    convo,
    guessedOrgId ? waCopy.unknownNumber() : waCopy.unknownNumberNoOrg(),
    undefined,
    { kind: 'unknown_number' },
  );
}
