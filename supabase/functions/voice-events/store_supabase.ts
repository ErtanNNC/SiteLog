import type { Json, VoiceEventResult } from '@sitelog/shared';
import type { AppClient } from '../_shared/supabase.ts';
import type { VoiceEventsStore } from './store.ts';

/** voice-events' store on the service role: `voice_call_event()`, one transaction per event. */
export function supabaseVoiceEventsStore(admin: AppClient): VoiceEventsStore {
  return {
    async applyEvent(event) {
      const { data, error } = await admin.rpc('voice_call_event', {
        p_event_id: event.eventId,
        p_event: event.event,
        p_room: event.room,
        p_at: event.at,
        p_status: event.status,
        p_detail: event.detail as unknown as Json,
      });
      if (error) throw new Error(`voice-events rpc: ${error.message}`);
      return data as unknown as VoiceEventResult;
    },
  };
}
