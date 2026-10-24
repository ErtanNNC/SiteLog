import { optionalEnv, requireEnv } from '../_shared/env.ts';
import { edgeNotifier } from '../_shared/messaging.ts';
import { adminClient } from '../_shared/supabase.ts';
import { createFieldApp } from './app.ts';
import { notifierCodeSender, notifierDailyLinkSender } from './code_sender.ts';
import { fieldOrigins } from './logic.ts';
import { supabaseFieldStore } from './store_supabase.ts';
import { liveKitConfig, liveKitHttpApi, supabaseTalkNowStore } from './talk_now.ts';
import { supabaseVoiceSpecialStore } from './voice_special.ts';

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
      // W3-03: the voice agent's bearer, and field-api's own key of the per-call tokens.
      voiceToolSecret: () => requireEnv('VOICE_AGENT_TOOL_SECRET'),
      callTokenSecret: () => requireEnv('VOICE_CALL_TOKEN_SECRET'),
      // W3-09 (§19 Q117): a live tool's wait for its worker turn (default 12 s, at most 15 s).
      voiceToolWaitMs: () => {
        const raw = optionalEnv('VOICE_TOOL_WAIT_MS');
        return raw ? Number(raw) : undefined;
      },
      // W3-14: the special requests on a call, consent on a call, unknown callers.
      voiceSpecial: { store: supabaseVoiceSpecialStore(admin) },
      // W3-13: Talk now when LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set here.
      talkNow: {
        store: supabaseTalkNowStore(admin),
        livekit: () => {
          const cfg = liveKitConfig(optionalEnv);
          return cfg ? liveKitHttpApi(cfg) : null;
        },
        agentName: () => optionalEnv('LIVEKIT_AGENT_NAME') ?? 'sitelog-voice',
      },
    });
  }
  return app;
}

Deno.serve((req) => fieldApp().fetch(req));
