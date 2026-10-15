import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { Route, Routes, useNavigate } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { assertE164 } from '@sitelog/shared/format.ts';
import { i18n } from '@/i18n/i18n';
import { FakeMediaRecorder } from '@/test/fakeMediaRecorder';
import { fakeMediaRecorderDepsFor } from './test-helpers';
import { formatClock } from './clock';
import { Record } from './Record';
import { demoSession, fakeQueue, renderApp } from '@/test/render';

/** The system back button or gesture: a route change the screen does not make itself. */
function BackButton() {
  const navigate = useNavigate();
  useEffect(() => {
    const back = () => navigate('/today');
    window.addEventListener('test:back', back);
    return () => window.removeEventListener('test:back', back);
  }, [navigate]);
  return null;
}

function mount(
  deps: ReturnType<typeof fakeMediaRecorderDepsFor>['deps'],
  queue = fakeQueue().queue,
  session = demoSession(),
) {
  return renderApp('/record', {
    session,
    queue,
    children: (
      <>
        <BackButton />
        <Routes>
          <Route path="/record" element={<Record recorderDeps={deps} />} />
          <Route path="/report/:id" element={<h1>processing-stub</h1>} />
          <Route path="/today" element={<h1>today-stub</h1>} />
        </Routes>
      </>
    ),
  });
}

function photo(name = 'site.jpg') {
  return new File(['jpeg'], name, { type: 'image/jpeg', lastModified: 1_760_000_000_000 });
}

describe('Recording (F5 step 2, Field-04)', () => {
  it('formats the timer', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(134_000)).toBe('02:14');
    expect(formatClock(15 * 60_000)).toBe('15:00');
  });

  it('records, pauses, resumes, stops and sends the clip, then opens Processing', async () => {
    const h = fakeMediaRecorderDepsFor();
    const q = fakeQueue();
    mount(h.deps, q.queue);
    expect(await screen.findByRole('button', { name: 'Pause recording' })).toBeEnabled();
    expect(h.deps.getUserMedia).toHaveBeenCalled();
    expect(screen.getByRole('timer')).toHaveTextContent('00:00');
    act(() => h.tick(3_000));
    expect(screen.getByRole('timer')).toHaveTextContent('00:03');
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }));
    // The name says what a tap does; no "pressed" state to contradict it.
    const resume = screen.getByRole('button', { name: 'Resume recording' });
    expect(resume).not.toHaveAttribute('aria-pressed');
    expect(screen.getByRole('status')).toHaveTextContent('Paused — tap play to go on');
    act(() => h.tick(10_000));
    expect(screen.getByRole('timer')).toHaveTextContent('00:03');
    fireEvent.click(resume);
    act(() => h.tick(3_000));
    expect(screen.getByRole('timer')).toHaveTextContent('00:06');
    // Saved as it is recorded: the draft and its chunks are in the queue's store.
    await waitFor(() => expect(q.store.drafts.size).toBe(1));
    expect([...q.store.drafts.values()][0]).toMatchObject({ mime: 'audio/webm;codecs=opus' });
    expect(q.store.chunks.size).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Stop & send' }));
    expect(await screen.findByRole('heading', { name: 'processing-stub' })).toBeInTheDocument();
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]).toMatchObject({
      code: 'K7Q2MX',
      kind: 'audio',
      mime: 'audio/webm;codecs=opus',
      siteId: demoSession().sites[0]!.id,
      recordedAt: new Date(10_000).toISOString(),
    });
    expect(q.calls[0]!.blob!.size).toBe(4);
    expect(h.track.stop).toHaveBeenCalled();
    // The clip went to the queue in the write that deleted its draft.
    expect(q.store.drafts.size).toBe(0);
    expect(q.store.chunks.size).toBe(0);
  });

  it('refuses a clip shorter than 5 seconds and lets the reporter try again', async () => {
    const h = fakeMediaRecorderDepsFor();
    const q = fakeQueue();
    mount(h.deps, q.queue);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop & send' }));
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'I couldn’t hear anything — try again',
    });
    // Focus moves to the new phase's heading (Stop & send is gone), in an effect after render.
    await waitFor(() => expect(heading).toHaveFocus());
    expect(q.calls).toHaveLength(0);
    await waitFor(() => expect(q.store.drafts.size).toBe(0));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Pause recording' })).toBeInTheDocument();
    expect(h.deps.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('refuses a silent clip like a short one (a covered microphone)', async () => {
    const h = fakeMediaRecorderDepsFor();
    h.level.read.mockReturnValue(0);
    const q = fakeQueue();
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(6_000));
    fireEvent.click(screen.getByRole('button', { name: 'Stop & send' }));
    expect(
      await screen.findByRole('heading', { name: 'I couldn’t hear anything — try again' }),
    ).toBeInTheDocument();
    expect(q.calls).toHaveLength(0);
  });

  it('sends the clip at the 15-minute cap and says so', async () => {
    const h = fakeMediaRecorderDepsFor({ capMs: 2_000 });
    const q = fakeQueue(async () => ({ ok: false, permanent: false, error: 'network' }));
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(6_000));
    expect(
      await screen.findByText('15 minutes — sending this clip. Record another one if you need to.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(q.calls).toHaveLength(1));
  });

  it('sends what was said when the phone takes the microphone mid-clip', async () => {
    const h = fakeMediaRecorderDepsFor();
    const q = fakeQueue(async () => ({ ok: false, permanent: false, error: 'network' }));
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(6_000));
    act(() => h.recorder().interrupt());
    expect(
      await screen.findByText('The microphone stopped — a call or another app may have taken it.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(q.calls).toHaveLength(1));
    expect(q.calls[0]).toMatchObject({ kind: 'audio' });
    expect(q.calls[0]!.blob!.size).toBe(4);
  });

  it('keeps the clip when the reporter leaves mid-recording (system back)', async () => {
    const h = fakeMediaRecorderDepsFor();
    const q = fakeQueue();
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(8_000));
    act(() => {
      window.dispatchEvent(new Event('test:back'));
    });
    expect(await screen.findByRole('heading', { name: 'today-stub' })).toBeInTheDocument();
    // The queue outlives the screen: the clip is in it, and the microphone is released.
    await waitFor(() => expect(q.calls).toHaveLength(1));
    expect(q.calls[0]).toMatchObject({ kind: 'audio', recordedAt: new Date(10_000).toISOString() });
    expect(q.calls[0]!.blob!.size).toBe(4);
    expect(h.track.stop).toHaveBeenCalled();
    expect(q.store.drafts.size).toBe(0);
  });

  it('asks before the page unloads while recording', async () => {
    const h = fakeMediaRecorderDepsFor();
    mount(h.deps);
    await screen.findByRole('button', { name: 'Pause recording' });
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('holds the photos taken while recording until the clip goes, and drops a removed one', async () => {
    const h = fakeMediaRecorderDepsFor();
    const q = fakeQueue();
    URL.createObjectURL = vi.fn(() => 'blob:thumb');
    URL.revokeObjectURL = vi.fn();
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    const input = document.querySelector<HTMLInputElement>('input[accept="image/*"]')!;
    fireEvent.change(input, { target: { files: [photo('a.jpg'), photo('b.jpg')] } });
    expect(await screen.findByRole('button', { name: 'Remove photo 2' })).toBeInTheDocument();
    // In the queue (it survives the page), not sent yet.
    expect(q.queue.getSnapshot().items.filter((i) => i.status === 'held')).toHaveLength(2);
    expect(q.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 2' }));
    await waitFor(() => expect(q.queue.getSnapshot().items).toHaveLength(1));
    act(() => h.tick(6_000));
    fireEvent.click(screen.getByRole('button', { name: 'Stop & send' }));
    expect(await screen.findByRole('heading', { name: 'processing-stub' })).toBeInTheDocument();
    await waitFor(() => expect(q.calls).toHaveLength(2));
    expect(q.calls.map((c) => c.kind).sort()).toEqual(['audio', 'photo']);
  });

  it('sends a clip the phone could not store, and says to keep the app open', async () => {
    const h = fakeMediaRecorderDepsFor();
    let finish: () => void = () => undefined;
    const q = fakeQueue(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              result: {
                reportId: 'r1',
                reportNo: 'RL-2041-0188',
                reportStatus: 'processing',
                created: true,
                alreadyComplete: false,
              },
            });
        }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(q.store, 'add').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(6_000));
    fireEvent.click(screen.getByRole('button', { name: 'Stop & send' }));
    // Not stuck on "Starting…": the clip goes from memory, and the reporter is told.
    expect(await screen.findByRole('heading', { level: 1, name: 'Sending…' })).toBeInTheDocument();
    expect(
      screen.getByText('Not saved on this phone: keep SiteLog open until it is sent.'),
    ).toBeInTheDocument();
    await act(async () => finish());
    expect(await screen.findByRole('heading', { name: 'processing-stub' })).toBeInTheDocument();
    expect(q.calls).toHaveLength(1);
    warn.mockRestore();
  });

  it('keeps a clip that cannot be sent now, and offers to remove one nothing can send', async () => {
    const h = fakeMediaRecorderDepsFor();
    const q = fakeQueue(async () => ({ ok: false, permanent: true, error: 'report_filed' }));
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(6_000));
    fireEvent.click(screen.getByRole('button', { name: 'Stop & send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Today’s report was already sent, so this can’t be added to it.',
    );
    expect(q.store.items.size).toBe(1);
    // No retry that cannot succeed: Remove (the reporter's tap) or Back.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/today');
    fireEvent.click(screen.getByRole('button', { name: 'Remove this recording' }));
    expect(await screen.findByRole('heading', { name: 'today-stub' })).toBeInTheDocument();
    await waitFor(() => expect(q.store.items.size).toBe(0));
  });

  it('offers Try again for a refusal the office can lift', async () => {
    const h = fakeMediaRecorderDepsFor();
    let tries = 0;
    const q = fakeQueue(async () =>
      ++tries === 1
        ? { ok: false, permanent: true, error: 'site_inactive' }
        : {
            ok: true,
            result: {
              reportId: 'r1',
              reportNo: 'RL-2041-0188',
              reportStatus: 'processing',
              created: true,
              alreadyComplete: false,
            },
          },
    );
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(6_000));
    fireEvent.click(screen.getByRole('button', { name: 'Stop & send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This site is paused. Ask the office, then try again.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'processing-stub' })).toBeInTheDocument();
  });

  it('stays on Today when the reporter leaves while the clip is still sending', async () => {
    const h = fakeMediaRecorderDepsFor();
    let finish: () => void = () => undefined;
    const q = fakeQueue(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              result: {
                reportId: 'r1',
                reportNo: 'RL-2041-0188',
                reportStatus: 'processing',
                created: true,
                alreadyComplete: false,
              },
            });
        }),
    );
    mount(h.deps, q.queue);
    await screen.findByRole('button', { name: 'Pause recording' });
    act(() => h.tick(6_000));
    fireEvent.click(screen.getByRole('button', { name: 'Stop & send' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Back to Today' }));
    expect(await screen.findByRole('heading', { name: 'today-stub' })).toBeInTheDocument();
    // The queue sends on without the screen; its answer does not pull the reporter away.
    await act(async () => finish());
    await waitFor(() => expect(q.queue.getSnapshot().items[0]?.status).toBe('done'));
    expect(screen.getByRole('heading', { name: 'today-stub' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'processing-stub' })).toBeNull();
    expect(q.calls).toHaveLength(1);
  });

  it('offers a way back to Today after a clip too short to send', async () => {
    const h = fakeMediaRecorderDepsFor();
    mount(h.deps);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop & send' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Back to Today' }));
    expect(await screen.findByRole('heading', { name: 'today-stub' })).toBeInTheDocument();
    // Leaving released the microphone.
    expect(h.track.stop).toHaveBeenCalled();
  });

  it('explains a refused microphone with the settings steps and the file fallback', async () => {
    const h = fakeMediaRecorderDepsFor({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    });
    mount(
      h.deps,
      fakeQueue().queue,
      demoSession({
        country: { ...demoSession().country, voiceNumber: assertE164('+15550142290') },
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Microphone needed' }),
    ).toBeInTheDocument();
    expect(screen.getByText('iPhone: Settings → Safari → Microphone → Allow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a recording' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Or call +1 555 014 2290' })).toHaveAttribute(
      'href',
      'tel:+15550142290',
    );
  });

  it('says the browser cannot record (not the microphone) without MediaRecorder', async () => {
    const h = fakeMediaRecorderDepsFor({ Recorder: undefined });
    mount(h.deps);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This browser can’t record here' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Record with your phone’s voice recorder and send the file.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Allow the microphone/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose a recording' })).toBeInTheDocument();
  });

  it('shows a light Try again on the dark screen when the microphone fails', async () => {
    const h = fakeMediaRecorderDepsFor({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('busy', 'NotReadableError');
      }),
    });
    mount(h.deps);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Recording stopped unexpectedly. Try again.',
      }),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toHaveClass('bg-chalk', 'text-asphalt');
    expect(retry).not.toHaveClass('bg-asphalt');
  });

  it.each(['es', 'tr'] as const)('has its copy in %s', async (lng) => {
    await act(() => i18n.changeLanguage(lng));
    const copy = UI_RESOURCES[lng].field.recording;
    FakeMediaRecorder.instances = [];
    const h = fakeMediaRecorderDepsFor();
    mount(
      h.deps,
      fakeQueue().queue,
      demoSession({
        reporter: { ...demoSession().reporter, locale: lng === 'es' ? 'es-US' : 'tr-TR' },
      }),
    );
    expect(await screen.findByRole('button', { name: copy.pause })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.stopSend })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.addPhoto })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent(copy.title);
  });
});
