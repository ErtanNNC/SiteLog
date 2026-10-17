import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
} from 'livekit-client';
import type { VoiceCall, VoiceCallHandlers, VoiceClient } from './client';

/**
 * The LiveKit `VoiceClient` (W3-13; spec §9.4 "Talk now: WebRTC (browser mic)"): joins the room
 * `voice/token` named with its participant token, publishes the microphone (echo cancellation,
 * noise suppression and gain control on: a site is loud) and plays the assistant's audio. This
 * module, and `livekit-client` with it, is its own chunk: the call screen loads it only for a real
 * call (`load.ts`).
 *
 * The end: the reporter's End call disconnects (`local`); the room closing or the assistant
 * leaving with nobody else in the room ends the call (`remote`); a reconnection that gives up is
 * `failed`. LiveKit's own reconnection after a network change shows as `reconnecting`.
 */
export const liveKitVoiceClient: VoiceClient = {
  async connect({ url, token }, handlers: VoiceCallHandlers): Promise<VoiceCall> {
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const elements = new Set<HTMLMediaElement>();
    let leaving = false;
    let ended = false;
    const end = (reason: 'local' | 'remote' | 'failed') => {
      if (ended) return;
      ended = true;
      for (const el of elements) el.remove();
      elements.clear();
      handlers.onAgentSpeaking(false);
      handlers.onEnded(reason);
    };

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.hidden = true;
        document.body.appendChild(el);
        elements.add(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) {
          el.remove();
          elements.delete(el);
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        handlers.onAgentSpeaking(
          speakers.some((p) => p.identity !== room.localParticipant.identity),
        );
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        handlers.onAudioBlocked(!room.canPlaybackAudio);
      })
      .on(RoomEvent.Reconnecting, () => handlers.onState('reconnecting'))
      .on(RoomEvent.Reconnected, () => handlers.onState('connected'))
      .on(RoomEvent.ParticipantDisconnected, () => {
        // The assistant left and nobody else is here: the call is over.
        if (room.remoteParticipants.size === 0 && !leaving) {
          leaving = true;
          void room.disconnect().finally(() => end('remote'));
        }
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (leaving) return;
        // The room closed or this participant was removed: the call's end; anything else lost it.
        const closed =
          reason === DisconnectReason.ROOM_DELETED ||
          reason === DisconnectReason.ROOM_CLOSED ||
          reason === DisconnectReason.PARTICIPANT_REMOVED;
        end(closed ? 'remote' : 'failed');
      });

    handlers.onState('connecting');
    await room.connect(url, token, { autoSubscribe: true });
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      leaving = true;
      await room.disconnect();
      throw err;
    }
    handlers.onState('connected');
    handlers.onAudioBlocked(!room.canPlaybackAudio);

    return {
      setMuted: async (muted) => {
        await room.localParticipant.setMicrophoneEnabled(!muted);
      },
      resumeAudio: () => room.startAudio(),
      hangUp: async () => {
        leaving = true;
        await room.disconnect();
        end('local');
      },
    };
  },
};
