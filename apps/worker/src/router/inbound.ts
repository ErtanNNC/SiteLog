import { parseButtonId, type MessageRow, type ParsedButton } from '@sitelog/shared';

/**
 * What the reporter sent, normalised from the stored `messages` row. The webhook stores the raw
 * Meta message (or the normalised InboundMessage) in `payload`; both shapes are accepted here.
 */
export type InboundContent =
  | { kind: 'button'; id: string; title: string | null; parsed: ParsedButton }
  | { kind: 'text'; text: string }
  | { kind: 'audio'; mediaId: string | null; durationS: number | null }
  | { kind: 'image'; mediaId: string | null; caption: string | null }
  | { kind: 'document'; mediaId: string | null; caption: string | null; mime: string | null }
  | { kind: 'reaction'; emoji: string | null; toWaMessageId: string | null }
  | { kind: 'unsupported' };

type Dict = Record<string, unknown>;

function dict(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Button / list reply id or template quick-reply payload, wherever the webhook put it. */
export function buttonIdOf(message: Pick<MessageRow, 'payload'>): { id: string; title: string | null } | null {
  const p = dict(message.payload);
  const raw = dict(p.raw);
  const interactive = dict(p.interactive ?? raw.interactive);
  const buttonReply = dict(interactive.button_reply);
  const listReply = dict(interactive.list_reply);
  const button = dict(p.button ?? raw.button);
  const id = str(p.replyId) ?? str(buttonReply.id) ?? str(listReply.id) ?? str(button.payload);
  if (!id) return null;
  const title = str(p.replyTitle) ?? str(buttonReply.title) ?? str(listReply.title) ?? str(button.text);
  return { id, title };
}

export function reactionOf(message: Pick<MessageRow, 'payload'>): { emoji: string | null; toWaMessageId: string | null } {
  const p = dict(message.payload);
  const raw = dict(p.raw);
  const reaction = dict(p.reaction ?? raw.reaction);
  return {
    emoji: str(p.reactionEmoji) ?? str(reaction.emoji),
    toWaMessageId: str(p.reactionTo) ?? str(reaction.message_id),
  };
}

export const THUMBS_UP = /^\u{1F44D}(\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?$/u;

export function isThumbsUp(emoji: string | null): boolean {
  return !!emoji && THUMBS_UP.test(emoji);
}

export function parseInbound(message: MessageRow): InboundContent {
  switch (message.type) {
    case 'interactive': {
      const b = buttonIdOf(message);
      if (b) return { kind: 'button', id: b.id, title: b.title ?? message.body, parsed: parseButtonId(b.id) };
      return message.body ? { kind: 'text', text: message.body } : { kind: 'unsupported' };
    }
    case 'text':
      return { kind: 'text', text: (message.body ?? '').trim() };
    case 'audio':
      return { kind: 'audio', mediaId: message.media_id, durationS: message.duration_s };
    case 'image':
      return { kind: 'image', mediaId: message.media_id, caption: message.body };
    case 'document':
      return { kind: 'document', mediaId: message.media_id, caption: message.body, mime: message.media_mime };
    case 'reaction':
      return { kind: 'reaction', ...reactionOf(message) };
    default:
      return { kind: 'unsupported' };
  }
}

/** A text long enough to be a report rather than a reply (§9.5 new_report_content heuristic). */
export function looksLikeReportText(text: string, minWords = 25): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= minWords;
}
