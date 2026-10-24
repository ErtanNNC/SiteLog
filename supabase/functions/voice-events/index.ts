import { requireEnv } from '../_shared/env.ts';
import { adminClient } from '../_shared/supabase.ts';
import { createVoiceEvents } from './app.ts';
import { supabaseVoiceEventsStore } from './store_supabase.ts';

/**
 * voice-events (W3-04): LiveKit's webhooks (app.ts). verify_jwt = false (supabase/config.toml):
 * LiveKit sends no Supabase JWT; its requests carry their own, signed with LIVEKIT_API_SECRET.
 */

let handler: ((req: Request) => Promise<Response>) | null = null;

function voiceEvents() {
  if (!handler) {
    handler = createVoiceEvents({
      store: supabaseVoiceEventsStore(adminClient()),
      apiKey: () => requireEnv('LIVEKIT_API_KEY'),
      apiSecret: () => requireEnv('LIVEKIT_API_SECRET'),
    });
  }
  return handler;
}

Deno.serve((req) => voiceEvents()(req));
