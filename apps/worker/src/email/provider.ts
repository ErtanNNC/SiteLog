import { Resend } from 'resend';
import type { Logger } from '../log';

/** Email provider abstraction (§13): Resend in production, console when no key is configured. */

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
      const { data, error } = await resend.emails.send({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        replyTo: msg.replyTo,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
        tags: msg.tags ? Object.entries(msg.tags).map(([name, value]) => ({ name, value })) : undefined,
      });
      if (error) throw new Error(`Resend: ${error.name ?? 'error'} ${error.message}`);
      return { id: data?.id ?? null };
    },
  };
}

export function createConsoleProvider(log: Logger, from: string): EmailProvider {
  return {
    name: 'console',
    async send(msg) {
      log.info('email (console provider)', {
        from,
        to: msg.to,
        subject: msg.subject,
        text_preview: msg.text.slice(0, 400),
        attachments: msg.attachments?.map((a) => `${a.filename} (${a.content.length} bytes)`) ?? [],
      });
      return { id: null };
    },
  };
}

export function createMemoryProvider(): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: 'memory',
    sent,
    async send(msg) {
      sent.push(msg);
      return { id: `mem-${sent.length}` };
    },
  };
}

export function createEmailProvider(cfg: { provider: 'resend' | 'console'; apiKey: string; from: string }, log: Logger): EmailProvider {
  if (cfg.provider === 'resend' && cfg.apiKey) return createResendProvider(cfg.apiKey, cfg.from);
  return createConsoleProvider(log, cfg.from);
}
