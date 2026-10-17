/**
 * W4-12 · the local SMS stand-in (`pnpm sms:stand-in`): a tiny HTTP server in place of Twilio
 * and İletimerkezi, so a **real** (non-demo) org's texts (the welcome, the device code, the
 * filed text) are sent through the real drivers and read back by the tests without a phone or a
 * provider account. Never for a hosted project.
 *
 *   pnpm sms:stand-in                     # http://0.0.0.0:4010 (SMS_STAND_IN_PORT)
 *
 * The worker and the edge functions reach it with SMS_PROVIDER_STUB=true and TWILIO_API_BASE /
 * ILETIMERKEZI_API_BASE pointed here (`smsApiBases`): the worker at http://127.0.0.1:4010, the
 * Edge Runtime container at http://host.docker.internal:4010 (CI's e2e-supabase job). It answers:
 *
 * - `POST /2010-04-01/Accounts/{sid}/Messages.json` (Twilio SMS and WhatsApp): 201 with a fresh
 *   `SM…` sid, as Twilio accepts a message;
 * - `POST /v1/send-sms/json` (İletimerkezi): status 200 with a fresh order id;
 * - `GET /__stand-in/messages[?to=+1…]`: what it received, oldest first (`StandInMessage`);
 *   `DELETE` empties it; `GET /__stand-in/health`: `{ok: true}`.
 *
 * It checks the shape the drivers send (credentials present, a sender, a recipient, a body) and
 * answers 400 otherwise, so a driver that drifts from the provider's API fails here too. Nothing
 * is delivered anywhere; the list lives in memory until the process ends.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMS_STAND_IN_ROUTES, type StandInMessage } from '@sitelog/shared';

export const DEFAULT_STAND_IN_PORT = 4010;

const TWILIO_SEND = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/;
const ILETIMERKEZI_SEND = '/v1/send-sms/json';

export interface SmsStandIn {
  server: Server;
  messages: StandInMessage[];
  /** `http://127.0.0.1:<port>` once listening. */
  url(): string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function stripWhatsapp(address: string): { channel: 'sms' | 'whatsapp'; value: string } {
  return address.startsWith('whatsapp:')
    ? { channel: 'whatsapp', value: address.slice('whatsapp:'.length) }
    : { channel: 'sms', value: address };
}

/** The Twilio send: form-encoded To, From (or MessagingServiceSid), Body or ContentSid. */
function twilioSend(
  req: IncomingMessage,
  raw: string,
  messages: StandInMessage[],
  now: () => Date,
): [number, unknown] {
  if (!/^Basic /.test(req.headers.authorization ?? ''))
    return [401, { code: 20003, message: 'Authenticate', status: 401 }];
  const form = new URLSearchParams(raw);
  const to = form.get('To') ?? '';
  const from = form.get('From') ?? form.get('MessagingServiceSid') ?? '';
  const body =
    form.get('Body') ?? (form.get('ContentSid') ? `[template ${form.get('ContentSid')}]` : '');
  if (!to || !from || !body)
    return [400, { code: 21604, message: 'To, From and Body are required', status: 400 }];
  const dest = stripWhatsapp(to);
  const sid = `SM${randomBytes(16).toString('hex')}`;
  messages.push({
    id: sid,
    provider: 'twilio',
    channel: dest.channel,
    to: dest.value,
    from: stripWhatsapp(from).value,
    body: form.get('ContentVariables') ? `${body} ${form.get('ContentVariables')}` : body,
    at: now().toISOString(),
  });
  return [201, { sid, status: 'queued', to, from, body }];
}

/** The İletimerkezi send: `request.authentication {key, hash}` and `request.order`. */
function iletimerkeziSend(
  raw: string,
  messages: StandInMessage[],
  nextOrder: () => number,
  now: () => Date,
): [number, unknown] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [400, { response: { status: { code: 400, message: 'invalid JSON' } } }];
  }
  const request = (parsed as { request?: Record<string, unknown> } | null)?.request;
  const auth = request?.authentication as { key?: unknown; hash?: unknown } | undefined;
  if (!auth?.key || !auth?.hash)
    return [401, { response: { status: { code: 401, message: 'Üyelik bilgileri hatalı' } } }];
  const order = request?.order as
    | { sender?: unknown; message?: { text?: unknown; receipents?: { number?: unknown } } }
    | undefined;
  const numbers = order?.message?.receipents?.number;
  const text = order?.message?.text;
  if (typeof order?.sender !== 'string' || typeof text !== 'string' || !Array.isArray(numbers))
    return [400, { response: { status: { code: 400, message: 'order is incomplete' } } }];
  const id = nextOrder();
  for (const n of numbers) {
    messages.push({
      id: `iletimerkezi:${id}`,
      provider: 'iletimerkezi',
      channel: 'sms',
      to: `+${String(n).replace(/^\+/, '')}`,
      from: order.sender,
      body: text,
      at: now().toISOString(),
    });
  }
  return [200, { response: { status: { code: 200, message: 'İşlem başarılı' }, order: { id } } }];
}

/** The stand-in on `port` (0: any free port). */
export async function startSmsStandIn(
  opts: { port?: number; host?: string; now?: () => Date } = {},
): Promise<SmsStandIn> {
  const messages: StandInMessage[] = [];
  const now = opts.now ?? (() => new Date());
  let orders = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const raw = req.method === 'POST' ? await readBody(req) : '';
      if (url.pathname === SMS_STAND_IN_ROUTES.health) return send(res, 200, { ok: true });
      if (url.pathname === SMS_STAND_IN_ROUTES.messages) {
        if (req.method === 'DELETE') {
          messages.length = 0;
          return send(res, 200, { ok: true });
        }
        const to = url.searchParams.get('to');
        return send(res, 200, to ? messages.filter((m) => m.to === to) : messages);
      }
      if (req.method === 'POST' && TWILIO_SEND.test(url.pathname)) {
        const [status, body] = twilioSend(req, raw, messages, now);
        return send(res, status, body);
      }
      if (req.method === 'POST' && url.pathname === ILETIMERKEZI_SEND) {
        const [status, body] = iletimerkeziSend(raw, messages, () => (orders += 1), now);
        return send(res, status, body);
      }
      return send(res, 404, { message: `the SMS stand-in has no ${req.method} ${url.pathname}` });
    })().catch((err: unknown) => send(res, 500, { message: String(err) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_STAND_IN_PORT, opts.host ?? '0.0.0.0', () => resolve());
  });
  return {
    server,
    messages,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const isMain = process.argv[1]?.endsWith('sms-stand-in.ts');
if (isMain) {
  const port = Number(process.env.SMS_STAND_IN_PORT ?? DEFAULT_STAND_IN_PORT);
  startSmsStandIn({ port })
    .then((s) => {
      console.log(`sms:stand-in listening on ${s.url()} (all interfaces)`);
      s.server.on('request', (req: IncomingMessage) => {
        if (req.method === 'POST') console.log(`sms:stand-in ${req.method} ${req.url ?? ''}`);
      });
    })
    .catch((err: unknown) => {
      console.error(`sms:stand-in: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
