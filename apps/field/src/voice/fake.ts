import type { VoiceCall, VoiceCallHandlers, VoiceClient } from './client';

/**
 * A scripted `VoiceClient` (W3-13): plays a call's turns without audio, for the unit tests and the
 * Playwright specs on the fake field-api. The script is the `livekitUrl`'s query
 * (`fake:scripted?turns=4&turnMs=400&end=remote&reconnect=1`):
 *
 * - `turns`: how many turns, the assistant's first, then the reporter's, alternating (default 4);
 * - `turnMs`: each turn's length in milliseconds (default 400);
 * - `end`: `remote` (the assistant ends the call after the turns, as after filing; default) or
 *   `none` (the call goes on until End call);
 * - `reconnect`: `1` drops the line once after the first turn (reconnecting, then connected);
 * - `fail`: `connect` refuses to connect, `drop` loses the line for good after the turns.
 *
 * It uses no microphone: the screen asks for it before connecting, as with LiveKit.
 */
export interface FakeScript {
  turns: number;
  turnMs: number;
  end: 'remote' | 'none';
  reconnect: boolean;
  fail: 'connect' | 'drop' | null;
}

export function parseFakeScript(url: string): FakeScript {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const q = new URLSearchParams(query);
  const num = (key: string, fallback: number, max: number) => {
    const n = Number(q.get(key));
    return Number.isFinite(n) && n >= 0 && q.has(key) ? Math.min(n, max) : fallback;
  };
  const fail = q.get('fail');
  return {
    turns: num('turns', 4, 50),
    turnMs: num('turnMs', 400, 10_000),
    end: q.get('end') === 'none' ? 'none' : 'remote',
    reconnect: q.get('reconnect') === '1',
    fail: fail === 'connect' || fail === 'drop' ? fail : null,
  };
}

export function createFakeVoiceClient(
  timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): VoiceClient & { lastMuted: () => boolean } {
  let muted = false;
  return {
    lastMuted: () => muted,
    connect({ url }, handlers: VoiceCallHandlers): Promise<VoiceCall> {
      const script = parseFakeScript(url);
      handlers.onState('connecting');
      if (script.fail === 'connect') return Promise.reject(new Error('fake: cannot connect'));
      let over = false;
      const pending = new Set<unknown>();
      const later = (ms: number, fn: () => void) => {
        const h = timers.setTimeout(() => {
          pending.delete(h);
          if (!over) fn();
        }, ms);
        pending.add(h);
      };
      const end = (reason: 'local' | 'remote' | 'failed') => {
        if (over) return;
        over = true;
        for (const h of pending) timers.clearTimeout(h);
        pending.clear();
        handlers.onAgentSpeaking(false);
        handlers.onEnded(reason);
      };
      const play = (turn: number) => {
        if (turn >= script.turns) {
          if (script.fail === 'drop') end('failed');
          else if (script.end === 'remote') end('remote');
          else handlers.onAgentSpeaking(false);
          return;
        }
        handlers.onAgentSpeaking(turn % 2 === 0);
        if (turn === 1 && script.reconnect) {
          handlers.onState('reconnecting');
          later(script.turnMs, () => {
            handlers.onState('connected');
            play(turn + 1);
          });
          return;
        }
        later(script.turnMs, () => play(turn + 1));
      };
      return new Promise((resolve) => {
        later(50, () => {
          handlers.onState('connected');
          resolve({
            setMuted: (m) => {
              muted = m;
              return Promise.resolve();
            },
            resumeAudio: () => Promise.resolve(),
            hangUp: () => {
              end('local');
              return Promise.resolve();
            },
          });
          play(0);
        });
      });
    },
  };
}

/** The default export the lazy loader picks (`load.ts`). */
export const fakeVoiceClient: VoiceClient = createFakeVoiceClient();
