import { optionalEnv, requireEnv } from '../_shared/env.ts';
import { edgeNotifier } from '../_shared/messaging.ts';
import { adminClient } from '../_shared/supabase.ts';
import { createFieldApp } from './app.ts';
import { notifierCodeSender, notifierDailyLinkSender } from './code_sender.ts';
import { fieldOrigins } from './logic.ts';
import { supabaseFieldStore } from './store_supabase.ts';

/**
 * field-api (W1-07): the field app's only backend (spec §6.5, Appendix B; README.md here).
 * verify_jwt = false (supabase/config.toml): the field host's /api proxy carries no Supabase JWT;
 * the link code and the device cookie authenticate instead. The service-role client is built on
 * the first request, so the module loads without secrets.
 */

let app: ReturnType<typeof createFieldApp> | null = null;

function fieldApp() {
  if (!app) {
    const admin = adminClient();
    const notifier = edgeNotifier(admin);
    app = createFieldApp({
      store: supabaseFieldStore(admin),
      // The Notifier (spec §4.5): the pack's SMS driver, console for demo orgs and unset senders.
      sendVerifyCode: notifierCodeSender(notifier),
      // F16 "Send me today's link" (W2-03): the reporter's channel order.
      sendDailyLink: notifierDailyLinkSender(notifier),
      fieldAppUrl: () => requireEnv('FIELD_APP_URL'),
      dailyLinkTtlHours: () => {
        const raw = optionalEnv('DAILY_LINK_TTL_HOURS');
        return raw ? Number(raw) : undefined;
      },
      linkSigningSecret: () => requireEnv('LINK_SIGNING_SECRET'),
      allowedOrigins: () =>
        fieldOrigins(optionalEnv('FIELD_APP_URL'), optionalEnv('CORS_EXTRA_ORIGINS')),
      // Local stacks only: the gateway as the browser reaches it (.env.example, STORAGE_PUBLIC_URL).
      publicUrl: () => optionalEnv('STORAGE_PUBLIC_URL'),
      // W2-14: the browser subscribes with it; the private key stays with the worker.
      vapidPublicKey: () => optionalEnv('VAPID_PUBLIC_KEY'),
    });
  }
  return app;
}

Deno.serve((req) => fieldApp().fetch(req));
