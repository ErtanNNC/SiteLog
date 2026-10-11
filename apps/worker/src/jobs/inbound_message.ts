import { routeInbound } from '../router';
import { PermanentJobError, type JobHandler } from './types';

/** §4.3 step 3 — route an inbound message by conversation state. */
export const inboundMessage: JobHandler<'inbound_message'> = async (ctx, payload) => {
  const message = await ctx.db.getMessage(payload.messageId);
  if (!message) throw new PermanentJobError(`message ${payload.messageId} not found`);
  await routeInbound(ctx, message);
};
