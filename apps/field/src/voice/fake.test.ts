import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceCallHandlers } from './client';
import { createFakeVoiceClient, parseFakeScript } from './fake';
import { loadVoiceClient } from './load';

function recorder() {
  const events: string[] = [];
  const handlers: VoiceCallHandlers = {
    onState: (s) => events.push(`state:${s}`),
    onAgentSpeaking: (b) => events.push(b ? 'agent' : 'reporter'),
    onAudioBlocked: (b) => events.push(`blocked:${b}`),
    onEnded: (r) => events.push(`ended:${r}`),
  };
  return { events, handlers };
}

describe('the scripted VoiceClient (W3-13)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads its script from the URL, with defaults and limits', () => {
    expect(parseFakeScript('fake:scripted')).toEqual({
      turns: 4,
      turnMs: 400,
      end: 'remote',
      reconnect: false,
      fail: null,
    });
    expect(
      parseFakeScript('fake:scripted?turns=2&turnMs=100&end=none&reconnect=1&fail=drop'),
    ).toEqual({ turns: 2, turnMs: 100, end: 'none', reconnect: true, fail: 'drop' });
    expect(parseFakeScript('fake:scripted?turns=999&turnMs=-1').turns).toBe(50);
    expect(parseFakeScript('fake:scripted?turnMs=-1').turnMs).toBe(400);
  });

  it('plays the turns, the assistant first, then the assistant ends the call', async () => {
    const { events, handlers } = recorder();
    const client = createFakeVoiceClient();
    const connecting = client.connect(
      { url: 'fake:scripted?turns=3&turnMs=100', token: 't' },
      handlers,
    );
    await vi.advanceTimersByTimeAsync(50);
    await connecting;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([
      'state:connecting',
      'state:connected',
      'agent',
      'reporter',
      'agent',
      'reporter',
      'ended:remote',
    ]);
  });

  it('reconnects once when asked, and End call ends it locally, once', async () => {
    const { events, handlers } = recorder();
    const client = createFakeVoiceClient();
    const connecting = client.connect(
      { url: 'fake:scripted?turns=10&turnMs=100&end=none&reconnect=1', token: 't' },
      handlers,
    );
    await vi.advanceTimersByTimeAsync(50);
    const call = await connecting;
    await vi.advanceTimersByTimeAsync(250);
    expect(events).toContain('state:reconnecting');
    expect(events.filter((e) => e === 'state:connected')).toHaveLength(2);
    await call.setMuted(true);
    expect(client.lastMuted()).toBe(true);
    await call.hangUp();
    await call.hangUp();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.filter((e) => e.startsWith('ended:'))).toEqual(['ended:local']);
  });

  it('can refuse to connect, or lose the line for good', async () => {
    const client = createFakeVoiceClient();
    await expect(
      client.connect({ url: 'fake:scripted?fail=connect', token: 't' }, recorder().handlers),
    ).rejects.toThrow();
    const { events, handlers } = recorder();
    const connecting = client.connect(
      { url: 'fake:scripted?turns=1&fail=drop', token: 't' },
      handlers,
    );
    await vi.advanceTimersByTimeAsync(50);
    await connecting;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.at(-1)).toBe('ended:failed');
  });
});

describe('loadVoiceClient', () => {
  it('loads the fake for a fake: URL, LiveKit otherwise (each its own chunk)', async () => {
    const fake = await loadVoiceClient('fake:scripted');
    const { fakeVoiceClient } = await import('./fake');
    expect(fake).toBe(fakeVoiceClient);
    const real = await loadVoiceClient('wss://sitelog.livekit.cloud');
    const { liveKitVoiceClient } = await import('./livekit');
    expect(real).toBe(liveKitVoiceClient);
  });
});
