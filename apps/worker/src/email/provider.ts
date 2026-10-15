import { Resend } from 'resend';
import { raceJobSignal } from '../abort';
import type { Logger } from '../log';

/**
 * Email provider abstraction (§13): Resend in production, console when no key is configured. The
 * console provider logs each email and, given a store, files it for the panel's Demo phone
 * (`console_emails`, the Email tab, §11.1; W1-08): recipients, subject, the text body and the
 * attachments' names and sizes, never the files.
 */

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  replyTo?: string;
  tags?: Record<string, string>;
  /** The org the email is about; the console provider files it there (no org: logged only). */
  orgId?: string | null;
  /**
   * One email per key, however often the job sending it is retried (W1-15): Resend's
   * `Idempotency-Key` (24 h), the console provider's `console_emails.dedupe_key`, the memory
   * provider's list. `send_email` passes its job's dedupe key.
   */
  idempotencyKey?: string;
}

/** Where the console provider files what it would have sent (`console_emails`). */
export interface ConsoleEmailStore {
  /** The row's id; a row with the same `dedupe_key` already filed returns that row's id. */
  insertConsoleEmail(row: {
    org_id: string;
    kind: string;
    recipients: string[];
    subject: string;
    body_text: string;
    attachments: Array<{ filename: string; bytes: number }>;
    dedupe_key?: string | null;
  }): Promise<string>;
}

export interface EmailProvider {
  readonly name: 'resend' | 'console' | 'memory';
  send(msg: EmailMessage): Promise<{ id: string | null }>;
}

export function createResendProvider(apiKey: string, from: string): EmailProvider {
  const resend = new Resend(apiKey);
  return {
    name: 'resend',
    async send(msg) {
      // Resend takes no fetch or signal: a timed-out job stops waiting for it (W1-10).
      const { data, error } = await raceJobSignal(
        resend.emails.send(
          {
            from,
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            replyTo: msg.replyTo,
            attachments: msg.attachments?.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            })),
            tags: msg.tags
              ? Object.entries(msg.tags).map(([name, value]) => ({ name, value }))
              : undefined,
          },
          msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : undefined,
        ),
      );
      if (error) throw new Error(`Resend: ${error.name ?? 'error'} ${error.message}`);
      return { id: data?.id ?? null };
    },
  };
}

export function createConsoleProvider(
  log: Logger,
  from: string,
  store?: ConsoleEmailStore,
): EmailProvider {
  return {
    name: 'console',
    async send(msg) {
      const attachments =
        msg.attachments?.map((a) => ({ filename: a.filename, bytes: a.content.length })) ?? [];
      log.info('email (console provider)', {
        from,
        to: msg.to,
        subject: msg.subject,
        text_preview: msg.text.slice(0, 400),
        attachments: attachments.map((a) => `${a.filename} (${a.bytes} bytes)`),
      });
      if (!store || !msg.orgId) return { id: null };
      const id = await store.insertConsoleEmail({
        org_id: msg.orgId,
        kind: msg.tags?.kind ?? 'email',
        recipients: msg.to,
        subject: msg.subject,
        body_text: msg.text,
        attachments,
        dedupe_key: msg.idempotencyKey ?? null,
      });
      return { id: `console:${id}` };
    },
  };
}

export function createMemoryProvider(): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: 'memory',
    sent,
    async send(msg) {
      const i = msg.idempotencyKey
        ? sent.findIndex((m) => m.idempotencyKey === msg.idempotencyKey)
        : -1;
      if (i >= 0) return { id: `mem-${i + 1}` };
      sent.push(msg);
      return { id: `mem-${sent.length}` };
    },
  };
}

export function createEmailProvider(
  cfg: { provider: 'resend' | 'console'; apiKey: string; from: string },
  log: Logger,
  store?: ConsoleEmailStore,
): EmailProvider {
  if (cfg.provider === 'resend' && cfg.apiKey) return createResendProvider(cfg.apiKey, cfg.from);
  return createConsoleProvider(log, cfg.from, store);
}
