/**
 * Replays recorded webhook payloads against a running function: Meta (whatsapp-webhook, until
 * step 22) and Twilio (sms-webhook, W1-08). A fixture with `{ path, params }` is a Twilio form
 * (fixtures/sms/README.md), anything else a Meta JSON payload.
 *
 *   pnpm replay-webhook -- fixtures/webhooks/*.json
 *   pnpm replay-webhook -- --url http://127.0.0.1:54321/functions/v1/whatsapp-webhook fixtures/webhooks/audio-note.json
 *   pnpm replay-webhook -- --dry-run fixtures/webhooks/audio-note.json   # prints the normalised messages only
 *   pnpm replay-webhook -- fixtures/sms/inbound-help.json                # Twilio, signed with TWILIO_AUTH_TOKEN
 *   pnpm replay-webhook -- --sid SM123 fixtures/sms/status-delivered.json
 *   pnpm replay-webhook -- --room call-<uuid> fixtures/livekit/outbound-0*.json   # LiveKit (W3-04)
 *   pnpm replay-webhook -- --room-sid <sid> fixtures/livekit/inbound-0*.json      # §19 Q227
 *
 * Meta placeholders: {{phone}} (WA id digits, --phone), {{ts}} (now, unix seconds), {{id}} (a fresh
 * wamid so dedupe does not swallow the replay). Twilio placeholders: {{phone}} (E.164, --phone),
 * {{to}} (the pack's sender id, --to), {{sid}} (a fresh message SID), {{message_sid}} (--sid),
 * {{user_id}} (a WhatsApp business-scoped user id, §19 Q372: --user-id, default `ZZ.<phone digits>`).
 * Twilio requests are signed for the URL they are posted to (`--sms-url` or SMS_WEBHOOK_URL plus the
 * fixture's path), which must be the URL sms-webhook checks (its SMS_WEBHOOK_URL).
 *
 * LiveKit (voice-events, W3-04; a fixture with `event` and `id`, fixtures/livekit/README.md): signed
 * as LiveKit signs a webhook (an HS256 JWT in `Authorization`, `iss` LIVEKIT_API_KEY, the body's
 * `sha256`) with LIVEKIT_API_KEY / LIVEKIT_API_SECRET (a local pair: never a real project's) and
 * posted to `--voice-url` or VOICE_EVENTS_URL. Placeholders: {{room}} (`--room`, one room for every
 * file of the run, default a fresh `call-{uuid}` that matches no call), {{room_sid}} (`--room-sid`,
 * the room sid after `RM_`; default derived from the room: an inbound phone call's room, named by
 * the dispatch rule, is keyed by it, §19 Q227), {{id}} (a fresh event id),
 * {{ts}} / {{ts+N}} (three minutes ago, plus N seconds), {{phone}} (E.164, `--phone`), {{to}}
 * (`--to`).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fillLiveKitFixture } from '@sitelog/shared/livekit/fixture.ts';
import {
  LiveKitWebhookEventSchema,
  signLiveKitWebhook,
  toVoiceEvent,
  metaSignature,
  normalizeWebhook,
  isTwilioWhatsappForm,
  parseTwilioInbound,
  parseTwilioWhatsappInbound,
  parseTwilioStatus,
  twilioSignature,
} from '@sitelog/shared';

interface Args {
  url: string;
  secret: string;
  phone: string;
  dryRun: boolean;
  files: string[];
  /** Twilio: sms-webhook's URL, its auth token, the pack's sender id and a status SID. */
  smsUrl: string;
  token: string;
  to: string;
  sid: string;
  /** §19 Q372: the WhatsApp user id of `{{user_id}}` (`CC.<id>`); unset: `ZZ.<phone digits>`. */
  userId?: string;
  /** LiveKit: voice-events' URL, the API key and secret it checks, and the call's room. */
  voiceUrl: string;
  livekitKey: string;
  livekitSecret: string;
  room: string;
  /** The room sid after `RM_` (§19 Q227); unset: derived from the room. */
  roomSid?: string;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const args: Args = {
    url: env.WEBHOOK_URL ?? 'http://127.0.0.1:54321/functions/v1/whatsapp-webhook',
    secret: env.WA_APP_SECRET ?? 'dev-app-secret',
    phone: env.REPLAY_PHONE ?? '15550143378',
    dryRun: false,
    files: [],
    smsUrl: env.SMS_WEBHOOK_URL ?? 'http://127.0.0.1:54321/functions/v1/sms-webhook',
    token: env.TWILIO_AUTH_TOKEN ?? 'dev-twilio-auth-token',
    to: env.REPLAY_SMS_TO ?? '+18885550142',
    sid: env.REPLAY_SMS_SID ?? '',
    voiceUrl: env.VOICE_EVENTS_URL ?? 'http://127.0.0.1:54321/functions/v1/voice-events',
    livekitKey: env.LIVEKIT_API_KEY || 'devkey',
    livekitSecret: env.LIVEKIT_API_SECRET || 'dev-livekit-secret',
    room: env.REPLAY_ROOM ?? `call-${randomUUID()}`,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--url') args.url = argv[++i] ?? args.url;
    else if (a === '--secret') args.secret = argv[++i] ?? args.secret;
    else if (a === '--phone') args.phone = (argv[++i] ?? args.phone).replace(/\D/g, '');
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--sms-url') args.smsUrl = argv[++i] ?? args.smsUrl;
    else if (a === '--token') args.token = argv[++i] ?? args.token;
    else if (a === '--to') args.to = argv[++i] ?? args.to;
    else if (a === '--sid') args.sid = argv[++i] ?? args.sid;
    else if (a === '--user-id')
      args.userId = (argv[++i] ?? '').replace(/^whatsapp:/, '') || undefined;
    else if (a === '--voice-url') args.voiceUrl = argv[++i] ?? args.voiceUrl;
    else if (a === '--room') args.room = argv[++i] ?? args.room;
    else if (a === '--room-sid') args.roomSid = (argv[++i] ?? '').replace(/^RM_/, '') || undefined;
    else if (a === '--')
      continue; // `pnpm replay-webhook -- …` passes the separator through
    else args.files.push(a);
  }
  return args;
}

/** A Twilio fixture: the route after /sms-webhook and the form fields. */
export interface TwilioFixture {
  path: string;
  params: Record<string, string>;
}

export function isTwilioFixture(value: unknown): value is TwilioFixture {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as TwilioFixture).path === 'string' &&
    !!(value as TwilioFixture).params &&
    typeof (value as TwilioFixture).params === 'object'
  );
}

/**
 * Fills a Twilio fixture's placeholders: {{phone}} E.164, {{to}}, {{sid}} fresh, {{message_sid}},
 * {{user_id}} (§19 Q372).
 */
export function substituteTwilio(
  template: string,
  vars: { phone: string; to: string; sid: string; userId?: string },
): string {
  const sid = `SM${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  return (
    template
      .replace(/\{\{phone\}\}/g, `+${vars.phone.replace(/\D/g, '')}`)
      .replace(/\{\{to\}\}/g, vars.to)
      // W2-16: a WhatsApp form names the person's number without `+` too.
      .replace(/\{\{wa_id\}\}/g, vars.phone.replace(/\D/g, ''))
      // §19 Q372: the person's WhatsApp user id, the same for every file of the run.
      .replace(/\{\{user_id\}\}/g, vars.userId ?? `ZZ.${vars.phone.replace(/\D/g, '')}`)
      .replace(/\{\{sid\}\}/g, sid)
      .replace(/\{\{message_sid\}\}/g, vars.sid || sid)
  );
}

/** The signed request a Twilio fixture becomes: URL, form body and X-Twilio-Signature. */
export async function twilioRequest(
  fixture: TwilioFixture,
  smsUrl: string,
  token: string,
): Promise<{ url: string; body: string; signature: string }> {
  const url = `${smsUrl.replace(/\/+$/, '')}${fixture.path}`;
  const body = new URLSearchParams(fixture.params).toString();
  return { url, body, signature: await twilioSignature(url, fixture.params, token) };
}

/** A LiveKit webhook fixture (fixtures/livekit): a `WebhookEvent` with its event name and id. */
export function isLiveKitFixture(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { event?: unknown }).event === 'string' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/** The signed request a LiveKit fixture becomes: its body and the `Authorization` token. */
export async function liveKitRequest(
  template: string,
  args: Pick<Args, 'room' | 'roomSid' | 'phone' | 'to' | 'livekitKey' | 'livekitSecret'>,
  now = new Date(),
): Promise<{ body: string; authorization: string }> {
  const body = fillLiveKitFixture(template, {
    room: args.room,
    ...(args.roomSid ? { roomSid: args.roomSid } : {}),
    ts: Math.floor(now.getTime() / 1000) - 180,
    phone: `+${args.phone.replace(/\D/g, '')}`,
    to: args.to,
  });
  const authorization = await signLiveKitWebhook(body, {
    apiKey: args.livekitKey,
    apiSecret: args.livekitSecret,
    now,
  });
  return { body, authorization };
}

async function replayLiveKit(args: Args, file: string, template: string): Promise<boolean> {
  const req = await liveKitRequest(template, args);
  const ev = toVoiceEvent(LiveKitWebhookEventSchema.parse(JSON.parse(req.body)), new Date());
  console.log(
    `\n${file}: LiveKit ${ev ? `${ev.event} ${ev.room} ${ev.status ?? ''}` : '(ignored by voice-events)'}`,
  );
  if (args.dryRun) return true;
  const started = Date.now();
  const res = await fetch(args.voiceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: req.authorization },
    body: req.body,
  });
  const text = await res.text();
  console.log(`  → ${res.status} in ${Date.now() - started} ms ${text.slice(0, 200)}`);
  return res.ok;
}

async function replayTwilio(args: Args, file: string, fixture: TwilioFixture): Promise<boolean> {
  const form = new URLSearchParams(fixture.params);
  // W2-16: a WhatsApp message comes on the same webhook with `whatsapp:` addresses.
  const inbound =
    fixture.path === ''
      ? isTwilioWhatsappForm(form)
        ? parseTwilioWhatsappInbound(form)
        : parseTwilioInbound(form)
      : null;
  const status = fixture.path === '/status' ? parseTwilioStatus(form) : null;
  console.log(
    `\n${file}: Twilio ${fixture.path || 'inbound'} ` +
      (inbound
        ? `${inbound.from ?? 'a WhatsApp user id'} → ${inbound.to}: ${inbound.body}`
        : status
          ? `${status.messageSid} ${status.status}`
          : '(unreadable)'),
  );
  if (args.dryRun) return true;
  const req = await twilioRequest(fixture, args.smsUrl, args.token);
  const started = Date.now();
  const res = await fetch(req.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': req.signature,
    },
    body: req.body,
  });
  const text = await res.text();
  console.log(`  → ${res.status} in ${Date.now() - started} ms ${text.slice(0, 200)}`);
  return res.ok;
}

export function substitute(template: string, vars: { phone: string }): string {
  const ts = Math.floor(Date.now() / 1000);
  return template
    .replace(/\{\{phone\}\}/g, vars.phone)
    .replace(/\{\{ts\}\}/g, String(ts))
    .replace(/\{\{id\}\}/g, () => `wamid.replay.${ts}.${Math.random().toString(36).slice(2, 8)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.files.length === 0) {
    console.error(
      'usage: replay-webhook [--url U] [--secret S] [--phone 1555…] [--sms-url U] [--token T] [--to SENDER] [--sid SM…] [--voice-url U] [--room call-…] [--room-sid RM_…] [--dry-run] <fixture.json>…',
    );
    process.exit(2);
  }
  let failures = 0;
  for (const file of args.files) {
    // pnpm runs the script in scripts/; a path is relative to where `pnpm replay-webhook` ran.
    const raw = readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8');
    const probe = JSON.parse(raw) as unknown;
    if (isLiveKitFixture(probe)) {
      if (!(await replayLiveKit(args, file, raw))) failures++;
      continue;
    }
    if (isTwilioFixture(probe)) {
      const fixture = JSON.parse(
        substituteTwilio(raw, {
          phone: args.phone,
          to: args.to,
          sid: args.sid,
          ...(args.userId ? { userId: args.userId } : {}),
        }),
      ) as TwilioFixture;
      if (!(await replayTwilio(args, file, fixture))) failures++;
      continue;
    }
    const body = substitute(raw, { phone: args.phone });
    const payload = JSON.parse(body) as unknown;
    const { messages, statuses } = normalizeWebhook(payload);
    console.log(`\n${file}: ${messages.length} message(s), ${statuses.length} status(es)`);
    for (const m of messages)
      console.log(
        `  ${m.type.padEnd(11)} ${m.phoneE164} ${m.body ?? m.mediaId ?? ''} ${m.replyId ? `[${m.replyId}]` : ''}`,
      );
    if (args.dryRun) continue;
    const signature = await metaSignature(body, args.secret);
    const started = Date.now();
    const res = await fetch(args.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      body,
    });
    const text = await res.text();
    console.log(`  → ${res.status} in ${Date.now() - started} ms ${text.slice(0, 200)}`);
    if (!res.ok) failures++;
  }
  process.exit(failures ? 1 : 0);
}

if (process.argv[1]?.endsWith('replay-webhook.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
