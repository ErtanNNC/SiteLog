import { requireUser } from '../_shared/auth.ts';
import { requireEnv } from '../_shared/env.ts';
import { edgeNotifier, smsWebhookUrl } from '../_shared/messaging.ts';
import { adminClient } from '../_shared/supabase.ts';
import { createSmsWebhook } from './app.ts';
import { supabaseSmsStore } from './store_supabase.ts';

/**
 * sms-webhook (W1-08): Twilio's inbound messages and status callbacks, and the Demo phone's
 * replies (app.ts). verify_jwt = false (supabase/config.toml): Twilio sends no Supabase JWT; its
 * requests carry X-Twilio-Signature, and the Demo phone route checks the office user's JWT itself.
 */

let handler: ((req: Request) => Promise<Response>) | null = null;

function smsWebhook() {
  if (!handler) {
    const admin = adminClient();
    handler = createSmsWebhook({
      store: supabaseSmsStore(admin),
      notifier: edgeNotifier(admin),
      authToken: () => requireEnv('TWILIO_AUTH_TOKEN'),
      webhookUrl: smsWebhookUrl,
      linkSecret: () => requireEnv('LINK_SIGNING_SECRET'),
      fieldAppUrl: () => requireEnv('FIELD_APP_URL'),
      authUser: requireUser,
    });
  }
  return handler;
}

Deno.serve((req) => smsWebhook()(req));
