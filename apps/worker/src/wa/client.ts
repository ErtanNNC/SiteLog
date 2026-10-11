import { BUTTONS_MAX, truncateTitle, type Button } from '@sitelog/shared';
import type { Logger } from '../log';

/**
 * WhatsApp Cloud API client (Graph API). Pure payload builders are exported for tests;
 * `createWaClient` wraps them with fetch. Limits (§4.4, §9.4): ≤ 3 reply buttons with titles
 * ≤ 20 chars, list messages for 4–10 options (row titles ≤ 24, descriptions ≤ 72), body ≤ 1024.
 */

export interface WaSendResult {
  waMessageId: string | null;
}

export interface ListOption {
  id: string;
  title: string;
  description?: string;
}

export interface DocumentInput {
  buffer: Buffer;
  filename: string;
  mime: string;
  caption?: string;
}

export interface WaMedia {
  buffer: Buffer;
  mime: string | null;
  sha256: string | null;
}

export interface WaClient {
  sendText(to: string, text: string): Promise<WaSendResult>;
  sendButtons(to: string, body: string, buttons: Button[]): Promise<WaSendResult>;
  sendList(
    to: string,
    body: string,
    options: ListOption[],
    buttonText?: string,
  ): Promise<WaSendResult>;
  sendDocument(to: string, doc: DocumentInput): Promise<WaSendResult>;
  sendTemplate(to: string, template: Record<string, unknown>): Promise<WaSendResult>;
  markRead(waMessageId: string): Promise<void>;
  downloadMedia(mediaId: string): Promise<WaMedia>;
  uploadMedia(buffer: Buffer, mime: string, filename: string): Promise<string>;
}

export interface WaClientConfig {
  graphBase: string;
  graphVersion: string;
  phoneNumberId: string;
  accessToken: string;
}

export class WaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'WaApiError';
  }
}

export const WA_BODY_MAX = 1024;
export const WA_LIST_TITLE_MAX = 24;
export const WA_LIST_DESCRIPTION_MAX = 72;
export const WA_LIST_MIN = 1;
export const WA_LIST_MAX = 10;

function toWaId(e164: string): string {
  return e164.replace(/\D/g, '');
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function buildTextPayload(to: string, text: string): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(to),
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4096) },
  };
}

export function buildButtonsPayload(
  to: string,
  body: string,
  buttons: Button[],
): Record<string, unknown> {
  if (buttons.length === 0) throw new Error('at least one button is required');
  if (buttons.length > BUTTONS_MAX) throw new Error(`at most ${BUTTONS_MAX} buttons per message`);
  const seen = new Set<string>();
  for (const b of buttons) {
    if (seen.has(b.id)) throw new Error(`duplicate button id ${b.id}`);
    seen.add(b.id);
    if (b.id.length > 256) throw new Error(`button id too long: ${b.id}`);
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, WA_BODY_MAX) },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: truncateTitle(b.title) },
        })),
      },
    },
  };
}

export function buildListPayload(
  to: string,
  body: string,
  options: ListOption[],
  buttonText = 'Choose',
  sectionTitle = 'Options',
): Record<string, unknown> {
  if (options.length < WA_LIST_MIN || options.length > WA_LIST_MAX) {
    throw new Error(`list messages take ${WA_LIST_MIN}–${WA_LIST_MAX} options`);
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(to),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(body, WA_BODY_MAX) },
      action: {
        button: clip(buttonText, 20),
        sections: [
          {
            title: clip(sectionTitle, WA_LIST_TITLE_MAX),
            rows: options.map((o) => ({
              id: o.id.slice(0, 200),
              title: clip(o.title, WA_LIST_TITLE_MAX),
              ...(o.description
                ? { description: clip(o.description, WA_LIST_DESCRIPTION_MAX) }
                : {}),
            })),
          },
        ],
      },
    },
  };
}

export function buildDocumentPayload(
  to: string,
  mediaId: string,
  filename: string,
  caption?: string,
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(to),
    type: 'document',
    document: {
      id: mediaId,
      filename,
      ...(caption ? { caption: clip(caption, WA_BODY_MAX) } : {}),
    },
  };
}

export function buildTemplateMessagePayload(
  to: string,
  template: Record<string, unknown>,
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(to),
    type: 'template',
    template,
  };
}

export function buildMarkReadPayload(waMessageId: string): Record<string, unknown> {
  return { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId };
}

type FetchLike = typeof fetch;

export function createWaClient(
  cfg: WaClientConfig,
  log: Logger,
  fetchImpl: FetchLike = fetch,
): WaClient {
  const base = `${cfg.graphBase.replace(/\/$/, '')}/${cfg.graphVersion}`;
  const requireConfig = () => {
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      throw new Error(
        'WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID are required to send WhatsApp messages',
      );
    }
  };
  const headers = () => ({ Authorization: `Bearer ${cfg.accessToken}` });

  async function postJson(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    requireConfig();
    const res = await fetchImpl(`${base}/${path}`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const err =
        (body as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 300);
      throw new WaApiError(`WhatsApp API ${res.status}: ${err}`, res.status, body);
    }
    return (body ?? {}) as Record<string, unknown>;
  }

  function messageId(res: Record<string, unknown>): string | null {
    const msgs = res.messages as Array<{ id?: string }> | undefined;
    return msgs?.[0]?.id ?? null;
  }

  const send = async (payload: Record<string, unknown>): Promise<WaSendResult> => {
    const res = await postJson(`${cfg.phoneNumberId}/messages`, payload);
    return { waMessageId: messageId(res) };
  };

  return {
    sendText: (to, text) => send(buildTextPayload(to, text)),
    sendButtons: (to, body, buttons) => send(buildButtonsPayload(to, body, buttons)),
    sendList: (to, body, options, buttonText) =>
      send(buildListPayload(to, body, options, buttonText)),
    sendTemplate: (to, template) => send(buildTemplateMessagePayload(to, template)),
    async sendDocument(to, doc) {
      const mediaId = await this.uploadMedia(doc.buffer, doc.mime, doc.filename);
      return send(buildDocumentPayload(to, mediaId, doc.filename, doc.caption));
    },
    async markRead(waMessageId) {
      try {
        await postJson(`${cfg.phoneNumberId}/messages`, buildMarkReadPayload(waMessageId));
      } catch (err) {
        log.debug('markRead failed', { err, wa_message_id: waMessageId });
      }
    },
    async uploadMedia(buffer, mime, filename) {
      requireConfig();
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mime);
      form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);
      const res = await fetchImpl(`${base}/${cfg.phoneNumberId}/media`, {
        method: 'POST',
        headers: headers(),
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: { message?: string };
      };
      if (!res.ok || !body.id) {
        throw new WaApiError(
          `WhatsApp media upload ${res.status}: ${body.error?.message ?? 'no id'}`,
          res.status,
          body,
        );
      }
      return body.id;
    },
    async downloadMedia(mediaId) {
      requireConfig();
      // Step 1: GET /{media-id} → short-lived URL. Step 2: GET url with bearer. Retry once on failure.
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const metaRes = await fetchImpl(`${base}/${mediaId}`, { headers: headers() });
          const meta = (await metaRes.json().catch(() => ({}))) as {
            url?: string;
            mime_type?: string;
            sha256?: string;
            error?: { message?: string };
          };
          if (!metaRes.ok || !meta.url) {
            throw new WaApiError(
              `WhatsApp media lookup ${metaRes.status}: ${meta.error?.message ?? 'no url'}`,
              metaRes.status,
              meta,
            );
          }
          const fileRes = await fetchImpl(meta.url, { headers: headers() });
          if (!fileRes.ok)
            throw new WaApiError(`WhatsApp media download ${fileRes.status}`, fileRes.status, null);
          const buffer = Buffer.from(await fileRes.arrayBuffer());
          return {
            buffer,
            mime: meta.mime_type ?? fileRes.headers.get('content-type'),
            sha256: meta.sha256 ?? null,
          };
        } catch (err) {
          lastErr = err;
          log.warn('media download failed', { err, media_id: mediaId, attempt });
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

/** Records every outbound call (tests). */
export interface FakeWaClient extends WaClient {
  sent: Array<{
    kind: 'text' | 'buttons' | 'list' | 'document' | 'template';
    to: string;
    body?: string;
    buttons?: Button[];
    options?: ListOption[];
    template?: Record<string, unknown>;
    filename?: string;
  }>;
  media: Map<string, WaMedia>;
  reset(): void;
}

export function createFakeWaClient(): FakeWaClient {
  let n = 0;
  const next = () => ({ waMessageId: `wamid.out.${++n}` });
  const client: FakeWaClient = {
    sent: [],
    media: new Map(),
    reset() {
      this.sent = [];
      n = 0;
    },
    async sendText(to, text) {
      buildTextPayload(to, text);
      this.sent.push({ kind: 'text', to, body: text });
      return next();
    },
    async sendButtons(to, body, buttons) {
      buildButtonsPayload(to, body, buttons);
      this.sent.push({ kind: 'buttons', to, body, buttons });
      return next();
    },
    async sendList(to, body, options) {
      buildListPayload(to, body, options);
      this.sent.push({ kind: 'list', to, body, options });
      return next();
    },
    async sendDocument(to, doc) {
      this.sent.push({ kind: 'document', to, filename: doc.filename, body: doc.caption });
      return next();
    },
    async sendTemplate(to, template) {
      this.sent.push({ kind: 'template', to, template });
      return next();
    },
    async markRead() {},
    async downloadMedia(mediaId) {
      const m = this.media.get(mediaId);
      if (!m) throw new Error(`no fake media ${mediaId}`);
      return m;
    },
    async uploadMedia() {
      return `media.${++n}`;
    },
  };
  return client;
}
