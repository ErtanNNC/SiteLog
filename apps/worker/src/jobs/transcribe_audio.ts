import { buildTranscriptionPrompt, transcribeAudio } from '../ai/transcribe';
import { afterTranscription } from '../router/continue';
import { ensureMediaStored, loadStoredAudio } from '../router/media';
import { PermanentJobError, type JobHandler } from './types';

/** §10.2 — download/store (if not done at intake), convert, transcribe with segments, then continue. */
export const transcribeAudioJob: JobHandler<'transcribe_audio'> = async (ctx, payload) => {
  const message = await ctx.db.getMessage(payload.messageId);
  if (!message) throw new PermanentJobError(`message ${payload.messageId} not found`);
  if (message.type !== 'audio') throw new PermanentJobError(`message ${message.id} is not audio`);

  let transcript = await ctx.db.getTranscript(message.id);
  if (!transcript) {
    const report = payload.reportId ? await ctx.db.getReport(payload.reportId) : null;
    const site = report ? await ctx.db.siteContext(report.site_id) : null;
    const convo = await ctx.db.getConversation(message.conversation_id);
    if (!message.storage_path) {
      await ensureMediaStored(ctx, message, site ? { orgId: site.org.id, siteId: site.site.id, date: new Date(message.created_at).toISOString().slice(0, 10) } : { custom: `_pending/${convo?.id ?? 'unknown'}` });
    }
    const audio = await loadStoredAudio(ctx, message);
    if (!audio) throw new PermanentJobError(`message ${message.id} has no stored audio`);
    if (!ctx.ai.openai) throw new Error('OPENAI_API_KEY is required for transcription');
    const prompt = buildTranscriptionPrompt({
      siteName: site?.site.name ?? 'a construction site',
      companies: site?.companies ?? [],
      glossary: site?.glossary ?? [],
    });
    const result = await transcribeAudio(ctx.ai.openai, ctx.ffmpeg, { audio: audio.buffer, ext: audio.ext, model: ctx.config.TRANSCRIBE_MODEL, prompt, durationS: message.duration_s ?? undefined }, ctx.log);
    transcript = await ctx.db.upsertTranscript({ message_id: message.id, language: result.language, text: result.text, segments: result.segments, model: result.model });
    if (!message.duration_s && result.durationS) await ctx.db.updateMessage(message.id, { duration_s: result.durationS });
    ctx.metrics.add({ audioSeconds: result.durationS, estCostUsd: result.estCostUsd, transcriptionChunks: result.chunks });
    ctx.log.info('transcribed', { message_id: message.id, seconds: result.durationS, language: result.language, chunks: result.chunks });
  }
  await afterTranscription(ctx, message, transcript, payload);
};
