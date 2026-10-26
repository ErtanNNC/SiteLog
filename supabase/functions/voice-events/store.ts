import type { VoiceEvent, VoiceEventResult } from '@sitelog/shared';

/**
 * What voice-events writes, behind one interface: `store_supabase.ts` (the service-only
 * `voice_call_event()` of 20261016000320_voice_events.sql, one transaction per event) and
 * `fake_store.ts` in the Deno tests.
 */
export interface VoiceEventsStore {
  /**
   * Stores the event id once, moves the call's line status (never backwards), and on
   * `room_finished` for a call the agent never ended, ends it (the backstop) with its one
   * `post_call_reconcile` job. A stored id answers `duplicate` and changes nothing.
   */
  applyEvent(event: VoiceEvent): Promise<VoiceEventResult>;
}
