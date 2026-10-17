/**
 * Talk now's browser call (W3-13; spec §9.3, §9.4): the call screen talks to a `VoiceClient`, never
 * to LiveKit directly, so the screen runs on a scripted fake in the unit tests and in Playwright.
 *
 * Which one: `loadVoiceClient(livekitUrl)` (`load.ts`) by the URL `voice/token` answered: a
 * `fake:` URL is the scripted fake (`fake.ts`; only a fake field-api answers one), anything else
 * the LiveKit client (`livekit.ts`, with `livekit-client`). Both are their own lazy chunks, so
 * neither is in the main bundle (§16.2 M12, the field bundle budget).
 */

/** The call's line: joining, in the room, or LiveKit reconnecting after a network change. */
export type VoiceCallState = 'connecting' | 'connected' | 'reconnecting';

/**
 * Why the call ended: the reporter's End call (`local`), the assistant or the room ending it
 * (`remote`: after filing, a hang-up of the agent, the room closed), or the line lost for good
 * (`failed`).
 */
export type VoiceEndReason = 'local' | 'remote' | 'failed';

export interface VoiceCallHandlers {
  onState: (state: VoiceCallState) => void;
  /** The assistant started or stopped speaking (the screen's status line, never captions). */
  onAgentSpeaking: (speaking: boolean) => void;
  /** The browser holds the assistant's audio until a tap (iOS autoplay rules). */
  onAudioBlocked: (blocked: boolean) => void;
  /** Once, when the call is over. */
  onEnded: (reason: VoiceEndReason) => void;
}

export interface VoiceCall {
  setMuted: (muted: boolean) => Promise<void>;
  /** After `onAudioBlocked(true)`: called from the reporter's tap. */
  resumeAudio: () => Promise<void>;
  /** End call: leaves the room (`onEnded('local')`). */
  hangUp: () => Promise<void>;
}

export interface VoiceClient {
  /**
   * Joins the room with the participant token and publishes the microphone; resolves once in the
   * call, rejects when it cannot connect.
   */
  connect: (
    input: { url: string; token: string },
    handlers: VoiceCallHandlers,
  ) => Promise<VoiceCall>;
}

/** The scheme of a fake field-api's `livekitUrl` (`fake:scripted?…`, `fake.ts`). */
export const FAKE_VOICE_SCHEME = 'fake:';
