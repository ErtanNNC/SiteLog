import { FAKE_VOICE_SCHEME, type VoiceClient } from './client';

/**
 * The `VoiceClient` for a `voice/token` answer (W3-13): the scripted fake for a `fake:` URL (only a
 * fake field-api answers one: the Playwright specs), else LiveKit. Each is a dynamic import, so
 * `livekit-client` is its own chunk, loaded only when a real call starts.
 */
export async function loadVoiceClient(livekitUrl: string): Promise<VoiceClient> {
  if (livekitUrl.startsWith(FAKE_VOICE_SCHEME)) {
    return (await import('./fake')).fakeVoiceClient;
  }
  return (await import('./livekit')).liveKitVoiceClient;
}
