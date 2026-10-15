import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeMediaRecorder, fakeRecorderDeps } from '@/test/fakeMediaRecorder';
import { AUDIO_BITS_PER_SECOND, createRecorder } from './recorder';
import { silentClip, SILENT_LEVEL } from './level';

describe('recorder engine (F5 step 2)', () => {
  afterEach(() => {
    FakeMediaRecorder.refuseOptions = false;
  });

  it('records, pauses without counting the pause, resumes, and stops with a clip', async () => {
    const chunks: [number, number][] = [];
    const h = fakeRecorderDeps({ onChunk: (blob, at) => chunks.push([blob.size, at]) });
    const rec = createRecorder(h.deps);
    const seen: string[] = [];
    rec.subscribe(() => seen.push(rec.getState().status));
    await rec.start();
    expect(rec.getState()).toMatchObject({
      status: 'recording',
      mime: 'audio/webm;codecs=opus',
      startedAt: new Date(10_000).toISOString(),
    });
    expect(h.deps.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    // Speech bitrate: a 15-minute clip is about 3.6 MB, not 14.
    expect(h.recorder().options).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    expect(AUDIO_BITS_PER_SECOND).toBe(32_000);
    expect(h.deps.vibrate).toHaveBeenCalledWith(30);
    h.tick(1_000);
    expect(rec.getState().elapsedMs).toBe(1_000);
    expect(rec.getState().levels.at(-1)).toBe(0.5);
    rec.pause();
    expect(rec.getState().status).toBe('paused');
    h.tick(5_000);
    expect(rec.getState().elapsedMs).toBe(1_000);
    rec.resume();
    h.tick(2_000);
    expect(rec.getState().elapsedMs).toBe(3_000);
    const clip = await rec.stop();
    expect(clip).toMatchObject({
      mime: 'audio/webm;codecs=opus',
      durationMs: 3_000,
      peakLevel: 0.5,
    });
    expect(clip!.blob.type).toBe('audio/webm');
    expect(clip!.blob.size).toBe(4);
    expect(clip!.startedAt).toBe(new Date(10_000).toISOString());
    // Every chunk went to `onChunk` as it came, with the recording time (the draft).
    expect(chunks).toEqual([
      [2, 0],
      [2, 3_000],
    ]);
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.level.close).toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
    expect(seen).toContain('stopping');
    expect(rec.getState().status).toBe('stopped');
  });

  it('names the upload after the recorder’s real type (Safari answers audio/mp4)', async () => {
    FakeMediaRecorder.refuseOptions = true;
    const h = fakeRecorderDeps();
    const rec = createRecorder(h.deps);
    await rec.start();
    expect(rec.getState().mime).toBe('audio/mp4');
    rec.dispose();
  });

  it('reports a refused microphone, no MediaRecorder, and other failures', async () => {
    const refused = fakeRecorderDeps({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    });
    const a = createRecorder(refused.deps);
    await a.start();
    expect(a.getState()).toMatchObject({ status: 'error', error: 'permission' });

    const b = createRecorder(fakeRecorderDeps({ Recorder: undefined }).deps);
    await b.start();
    expect(b.getState()).toMatchObject({ status: 'error', error: 'unsupported' });

    const c = createRecorder(fakeRecorderDeps({ requestedMime: null }).deps);
    await c.start();
    expect(c.getState().error).toBe('unsupported');

    const broken = fakeRecorderDeps({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('no mic', 'NotFoundError');
      }),
    });
    const d = createRecorder(broken.deps);
    await d.start();
    expect(d.getState().error).toBe('failed');
  });

  it('flags the 15-minute cap and lets another clip start after a stop', async () => {
    const h = fakeRecorderDeps({ capMs: 3_000 });
    const rec = createRecorder(h.deps);
    await rec.start();
    h.tick(2_000);
    expect(rec.getState().capReached).toBe(false);
    h.tick(1_000);
    expect(rec.getState().capReached).toBe(true);
    await rec.stop();
    await rec.start();
    expect(rec.getState()).toMatchObject({ status: 'recording', elapsedMs: 0, capReached: false });
    rec.dispose();
  });

  it('answers null when nothing was recorded, and dispose releases the microphone', async () => {
    const h = fakeRecorderDeps();
    const rec = createRecorder(h.deps);
    expect(await rec.stop()).toBeNull();
    await rec.start();
    rec.dispose();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.recorder().state).toBe('inactive');
  });

  it('keeps the clip when the browser stops the recording by itself (a call takes the microphone)', async () => {
    const h = fakeRecorderDeps();
    const rec = createRecorder(h.deps);
    await rec.start();
    h.tick(6_000);
    // The OS takes the microphone: the recorder goes inactive and fires its last chunk and stop.
    h.recorder().interrupt();
    expect(rec.getState()).toMatchObject({ status: 'stopped', interrupted: true });
    expect(h.timers).toHaveLength(0);
    expect(h.track.stop).toHaveBeenCalled();
    // Stop & send (or the screen reacting to `interrupted`) gets that clip at once.
    const clip = await rec.stop();
    expect(clip).toMatchObject({ durationMs: 6_000 });
    expect(clip!.blob.size).toBe(4);
    expect(rec.getState().interrupted).toBe(false);
    expect(await rec.stop()).toBeNull();
  });

  it('ends the recording when the microphone track ends (a headset gone)', async () => {
    const h = fakeRecorderDeps();
    const rec = createRecorder(h.deps);
    await rec.start();
    h.tick(6_000);
    h.track.end();
    expect(rec.getState()).toMatchObject({ status: 'stopped', interrupted: true });
    expect((await rec.stop())?.blob.size).toBe(4);
  });

  it('resolves Stop when the recorder went inactive and its stop event never comes', async () => {
    const h = fakeRecorderDeps();
    const rec = createRecorder(h.deps);
    await rec.start();
    h.tick(6_000);
    const fake = h.recorder();
    // Inactive without its events (yet): the clip is built from what came, after a short wait.
    fake.state = 'inactive';
    const stopping = rec.stop();
    expect(rec.getState().status).toBe('stopping');
    h.runTimeouts();
    const clip = await stopping;
    expect(clip).toMatchObject({ durationMs: 6_000 });
    expect(clip!.blob.size).toBe(2);
    // A stop event arriving after that changes nothing.
    fake.onstop?.();
    expect(rec.getState().status).toBe('stopped');
  });

  it('keeps what was recorded after a recorder error, and says failed when nothing came', async () => {
    const h = fakeRecorderDeps();
    const rec = createRecorder(h.deps);
    await rec.start();
    h.tick(6_000);
    h.recorder().onerror?.(new Event('error'));
    expect(rec.getState()).toMatchObject({ status: 'stopped', interrupted: true });
    expect((await rec.stop())?.durationMs).toBe(6_000);

    // A recorder that fails before handing out any audio.
    class Empty extends FakeMediaRecorder {
      override start() {
        this.state = 'recording';
      }
      override stop() {
        this.state = 'inactive';
        this.onstop?.();
      }
    }
    const empty = fakeRecorderDeps({ Recorder: Empty as never });
    const quiet = createRecorder(empty.deps);
    await quiet.start();
    empty.recorder().onerror?.(new Event('error'));
    expect(quiet.getState()).toMatchObject({ status: 'error', error: 'failed' });
  });

  it('never cuts a clip short when the screen goes during Stop', async () => {
    const h = fakeRecorderDeps();
    const rec = createRecorder(h.deps);
    await rec.start();
    h.tick(6_000);
    const fake = h.recorder();
    // A stop whose events come later (as in a browser).
    const stop = fake.stop.bind(fake);
    fake.stop = () => {
      fake.state = 'inactive';
    };
    const stopping = rec.stop();
    rec.dispose();
    expect(rec.getState().status).toBe('stopping');
    fake.state = 'recording';
    stop();
    const clip = await stopping;
    expect(clip!.blob.size).toBe(4);
  });

  it('measures the loudest level only while the meter really listens', async () => {
    const h = fakeRecorderDeps();
    let live = false;
    const level = { read: vi.fn(() => 0.4), live: () => live, close: vi.fn() };
    const rec = createRecorder({ ...h.deps, analyser: () => level });
    await rec.start();
    h.tick(1_000);
    expect(rec.getState().levels.at(-1)).toBe(0);
    live = true;
    level.read.mockReturnValue(0.01);
    h.tick(1_000);
    const clip = await rec.stop();
    expect(clip!.peakLevel).toBe(0.01);
    expect(silentClip(clip!.peakLevel)).toBe(true);
    expect(silentClip(SILENT_LEVEL)).toBe(false);
    // No meter at all: never called silent.
    const none = createRecorder({ ...fakeRecorderDeps().deps, analyser: () => null });
    await none.start();
    expect((await none.stop())!.peakLevel).toBeNull();
    expect(silentClip(null)).toBe(false);
  });

  it('never leaves the microphone open when the screen goes away during the permission prompt', async () => {
    const h = fakeRecorderDeps();
    let grant: (s: MediaStream) => void = () => undefined;
    let asks = 0;
    const stream = { getTracks: () => [h.track] } as unknown as MediaStream;
    // The first ask waits for the reporter's answer; later ones are granted at once.
    h.deps.getUserMedia = vi.fn(() =>
      ++asks === 1
        ? new Promise<MediaStream>((resolve) => (grant = resolve))
        : Promise.resolve(stream),
    );
    const rec = createRecorder(h.deps);
    const starting = rec.start();
    expect(rec.getState().status).toBe('starting');
    rec.dispose();
    expect(rec.getState().status).toBe('idle');
    grant(stream);
    await starting;
    // The late answer is closed at once and nothing records.
    expect(h.track.stop).toHaveBeenCalled();
    expect(rec.getState().status).toBe('idle');
    // A screen mounted again (React StrictMode in development) can start once more.
    await rec.start();
    expect(rec.getState().status).toBe('recording');
    rec.dispose();
  });
});
