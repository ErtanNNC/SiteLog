import { describe, expect, it } from 'vitest';
import {
  TALK_NOW_TOKEN_TTL_S,
  liveKitHttpOrigin,
  mintLiveKitToken,
  talkNowParticipantToken,
} from './token.ts';

/** A local test pair: never a real project's. */
const KEY = 'APItest';
const SECRET = 'test-livekit-secret-0123456789abcdef';
const NOW = new Date('2026-10-09T21:40:00Z');
const CALL = '6a0c1e2f-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

function part(token: string, i: number): Record<string, unknown> {
  const text = token.split('.')[i]!.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(text + '='.repeat((4 - (text.length % 4)) % 4))) as Record<
    string,
    unknown
  >;
}

async function verifies(token: string, secret: string): Promise<boolean> {
  const [h, p, s] = token.split('.') as [string, string, string];
  const sig = Uint8Array.from(
    atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${h}.${p}`));
}

describe('mintLiveKitToken', () => {
  it('signs HS256 with the secret, iss the key, nbf/exp from the clock', async () => {
    const token = await mintLiveKitToken({
      apiKey: KEY,
      apiSecret: SECRET,
      video: { roomCreate: true },
      ttlS: 60,
      now: NOW,
    });
    expect(part(token, 0)).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = part(token, 1);
    expect(claims).toEqual({
      iss: KEY,
      nbf: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 60,
      video: { roomCreate: true },
    });
    expect(await verifies(token, SECRET)).toBe(true);
    expect(await verifies(token, 'another-secret')).toBe(false);
  });

  it('refuses to mint without a key pair', async () => {
    await expect(
      mintLiveKitToken({ apiKey: '', apiSecret: SECRET, video: {}, ttlS: 60 }),
    ).rejects.toThrow(/required/);
  });
});

describe('talkNowParticipantToken', () => {
  it('joins its one room as the call (never a phone), microphone only', async () => {
    const room = `call-${CALL}`;
    const token = await talkNowParticipantToken({
      apiKey: KEY,
      apiSecret: SECRET,
      room,
      callId: CALL,
      now: NOW,
    });
    const claims = part(token, 1);
    expect(claims).toMatchObject({
      iss: KEY,
      sub: CALL,
      jti: CALL,
      exp: NOW.getTime() / 1000 + TALK_NOW_TOKEN_TTL_S,
      video: {
        roomJoin: true,
        room,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: ['microphone'],
      },
    });
    expect(claims).not.toHaveProperty('video.roomAdmin');
    expect(claims).not.toHaveProperty('video.roomCreate');
    expect(JSON.stringify(claims)).not.toMatch(/\+\d{7,}/);
    expect(await verifies(token, SECRET)).toBe(true);
  });
});

describe('liveKitHttpOrigin', () => {
  it('maps LIVEKIT_URL to the Twirp origin', () => {
    expect(liveKitHttpOrigin('wss://sitelog-abc.livekit.cloud')).toBe(
      'https://sitelog-abc.livekit.cloud',
    );
    expect(liveKitHttpOrigin('ws://localhost:7880/')).toBe('http://localhost:7880');
    expect(liveKitHttpOrigin('https://lk.example.com')).toBe('https://lk.example.com');
    expect(liveKitHttpOrigin('ftp://x')).toBeNull();
    expect(liveKitHttpOrigin('not a url')).toBeNull();
  });
});
