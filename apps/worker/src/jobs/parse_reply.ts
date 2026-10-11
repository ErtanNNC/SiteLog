import { handleReplyText } from '../router/handlers/reply';
import { createSession } from '../router/session';
import { PermanentJobError, type JobHandler } from './types';

/** A voice (or deferred text) reply while a question, draft or edit is pending. */
export const parseReply: JobHandler<'parse_reply'> = async (ctx, payload) => {
  const message = await ctx.db.getMessage(payload.messageId);
  if (!message) throw new PermanentJobError(`message ${payload.messageId} not found`);
  const transcript = message.type === 'audio' ? await ctx.db.getTranscript(message.id) : null;
  const text = transcript?.text ?? message.body ?? '';
  if (!text.trim()) {
    ctx.log.info('empty reply ignored', { message_id: message.id });
    return;
  }
  const session = await createSession(ctx, message);
  if (!session) throw new PermanentJobError(`message ${message.id} has no reporter`);
  await handleReplyText(session, text, message.type === 'audio');
};
