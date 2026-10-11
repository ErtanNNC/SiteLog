import { z } from 'zod';
import type { MsgType } from '../enums.ts';

/**
 * WhatsApp Cloud API webhook payload (field: messages).
 * Parsed loosely: Meta adds fields over time; we only rely on the documented core.
 */
const Loose = z.looseObject;

export const MetaMediaSchema = Loose({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});

export const MetaMessageSchema = Loose({
  id: z.string(),
  from: z.string().describe('wa_id digits, no +'),
  timestamp: z.string(),
  type: z.string(),
  text: Loose({ body: z.string() }).optional(),
  audio: MetaMediaSchema.optional(),
  image: MetaMediaSchema.optional(),
  document: MetaMediaSchema.optional(),
  video: MetaMediaSchema.optional(),
  sticker: MetaMediaSchema.optional(),
  interactive: Loose({
    type: z.string(),
    button_reply: Loose({ id: z.string(), title: z.string() }).optional(),
    list_reply: Loose({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
    }).optional(),
  }).optional(),
  button: Loose({ payload: z.string().optional(), text: z.string().optional() }).optional(),
  reaction: Loose({ message_id: z.string(), emoji: z.string().optional() }).optional(),
  location: Loose({
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
  }).optional(),
  context: Loose({ from: z.string().optional(), id: z.string().optional() }).optional(),
  errors: z.array(Loose({ code: z.number().optional(), title: z.string().optional() })).optional(),
});
export type MetaMessage = z.infer<typeof MetaMessageSchema>;

export const MetaStatusSchema = Loose({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string().optional(),
  errors: z
    .array(
      Loose({
        code: z.number().optional(),
        title: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
});
export type MetaStatus = z.infer<typeof MetaStatusSchema>;

export const MetaChangeValueSchema = Loose({
  messaging_product: z.string().optional(),
  metadata: Loose({
    display_phone_number: z.string().optional(),
    phone_number_id: z.string().optional(),
  }).optional(),
  contacts: z
    .array(Loose({ profile: Loose({ name: z.string().optional() }).optional(), wa_id: z.string() }))
    .optional(),
  messages: z.array(MetaMessageSchema).optional(),
  statuses: z.array(MetaStatusSchema).optional(),
});

export const MetaWebhookSchema = Loose({
  object: z.string(),
  entry: z.array(
    Loose({
      id: z.string().optional(),
      changes: z.array(Loose({ field: z.string().optional(), value: MetaChangeValueSchema })),
    }),
  ),
});
export type MetaWebhook = z.infer<typeof MetaWebhookSchema>;

/** A webhook message normalised into what the `messages` table needs. */
export interface InboundMessage {
  waMessageId: string;
  phoneE164: string;
  profileName: string | null;
  phoneNumberId: string | null;
  sentAt: Date;
  type: MsgType;
  body: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  mediaSha256: string | null;
  filename: string | null;
  /** Interactive button/list reply id, or template quick-reply payload. */
  replyId: string | null;
  replyTitle: string | null;
  /** The outbound message this one replies to (Meta context). */
  contextMessageId: string | null;
  reactionEmoji: string | null;
  reactionTo: string | null;
  raw: MetaMessage;
}

export interface InboundStatus {
  waMessageId: string;
  status: string;
  at: Date;
  recipientE164: string | null;
  error: string | null;
}

export function toE164(waId: string): string {
  const digits = waId.replace(/\D/g, '');
  return `+${digits}`;
}

export function mapMetaType(t: string): MsgType {
  switch (t) {
    case 'text':
    case 'audio':
    case 'image':
    case 'document':
    case 'interactive':
    case 'reaction':
      return t;
    case 'button':
      return 'interactive';
    default:
      return 'unsupported';
  }
}

export function normalizeWebhook(payload: unknown): {
  messages: InboundMessage[];
  statuses: InboundStatus[];
} {
  const parsed = MetaWebhookSchema.parse(payload);
  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      const v = change.value;
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c.profile?.name) names.set(c.wa_id, c.profile.name);
      for (const m of v.messages ?? []) {
        const media = m.audio ?? m.image ?? m.document ?? m.video ?? m.sticker ?? null;
        const replyId =
          m.interactive?.button_reply?.id ??
          m.interactive?.list_reply?.id ??
          m.button?.payload ??
          null;
        const replyTitle =
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          m.button?.text ??
          null;
        const body = m.text?.body ?? media?.caption ?? replyTitle ?? null;
        messages.push({
          waMessageId: m.id,
          phoneE164: toE164(m.from),
          profileName: names.get(m.from) ?? null,
          phoneNumberId: v.metadata?.phone_number_id ?? null,
          sentAt: new Date(Number(m.timestamp) * 1000),
          type: mapMetaType(m.type),
          body,
          mediaId: media?.id ?? null,
          mediaMime: media?.mime_type ?? null,
          mediaSha256: media?.sha256 ?? null,
          filename: media?.filename ?? null,
          replyId,
          replyTitle,
          contextMessageId: m.context?.id ?? null,
          reactionEmoji: m.reaction?.emoji ?? null,
          reactionTo: m.reaction?.message_id ?? null,
          raw: m,
        });
      }
      for (const s of v.statuses ?? []) {
        statuses.push({
          waMessageId: s.id,
          status: s.status,
          at: new Date(Number(s.timestamp) * 1000),
          recipientE164: s.recipient_id ? toE164(s.recipient_id) : null,
          error: s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null,
        });
      }
    }
  }
  return { messages, statuses };
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compute `sha256=<hex>` for a raw body with the Meta app secret (WebCrypto; Node 22, Deno, browsers). */
export async function metaSignature(
  rawBody: string | Uint8Array,
  appSecret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // Copy into a fresh Uint8Array so the buffer is a plain ArrayBuffer (WebCrypto rejects shared buffers).
  const data = new Uint8Array(typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `sha256=${toHex(sig)}`;
}

/** Verify the `X-Hub-Signature-256` header. */
export async function verifyMetaSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = await metaSignature(rawBody, appSecret);
  return timingSafeEqual(expected.toLowerCase(), header.trim().toLowerCase());
}

/** GET verification handshake (hub.mode / hub.verify_token / hub.challenge). */
export function verifyChallenge(
  params: URLSearchParams,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode === 'subscribe' && token === verifyToken && challenge) return { ok: true, challenge };
  return { ok: false };
}
