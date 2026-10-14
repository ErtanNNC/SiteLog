import { optionalEnv, requireEnv } from '../_shared/env.ts';
import { adminClient } from '../_shared/supabase.ts';
import { createFieldApp } from './app.ts';
import { consoleVerifyCodeSender } from './console_code.ts';
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
    app = createFieldApp({
      store: supabaseFieldStore(admin),
      // W1-08 replaces the console text with the Notifier (spec §4.5) and the pack's SMS driver.
      sendVerifyCode: consoleVerifyCodeSender(admin),
      linkSigningSecret: () => requireEnv('LINK_SIGNING_SECRET'),
      allowedOrigins: () =>
        fieldOrigins(optionalEnv('FIELD_APP_URL'), optionalEnv('CORS_EXTRA_ORIGINS')),
    });
  }
  return app;
}

Deno.serve((req) => fieldApp().fetch(req));
