/**
 * Replays recorded Meta webhook payloads against a running whatsapp-webhook function.
 *
 *   pnpm replay-webhook -- fixtures/webhooks/*.json
 *   pnpm replay-webhook -- --url http://127.0.0.1:54321/functions/v1/whatsapp-webhook fixtures/webhooks/audio-note.json
 *   pnpm replay-webhook -- --dry-run fixtures/webhooks/audio-note.json   # prints the normalised messages only
 *
 * Placeholders inside fixtures are substituted: {{phone}} (WA id digits, --phone), {{ts}} (now, unix seconds),
 * {{id}} (a fresh wamid so dedupe does not swallow the replay).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { metaSignature, normalizeWebhook } from '@sitelog/shared';

interface Args {
  url: string;
  secret: string;
  phone: string;
  dryRun: boolean;
  files: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: process.env.WEBHOOK_URL ?? 'http://127.0.0.1:54321/functions/v1/whatsapp-webhook',
    secret: process.env.WA_APP_SECRET ?? 'dev-app-secret',
    phone: process.env.REPLAY_PHONE ?? '15550143378',
    dryRun: false,
    files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--url') args.url = argv[++i] ?? args.url;
    else if (a === '--secret') args.secret = argv[++i] ?? args.secret;
    else if (a === '--phone') args.phone = (argv[++i] ?? args.phone).replace(/\D/g, '');
    else if (a === '--dry-run') args.dryRun = true;
    else args.files.push(a);
  }
  return args;
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
      'usage: replay-webhook [--url U] [--secret S] [--phone 1555…] [--dry-run] <fixture.json>…',
    );
    process.exit(2);
  }
  let failures = 0;
  for (const file of args.files) {
    const body = substitute(readFileSync(file, 'utf8'), { phone: args.phone });
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
