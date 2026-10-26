import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { fakeMediaRecorderDepsFor } from '@/screens/record/test-helpers';
import { apiError, demoSession, fakeRoutes, renderApp } from '@/test/render';
import { TEST_POLL_MS, WelcomeTest } from './WelcomeTest';

/**
 * F4's test recording (W2-13): record (20 s at most), the clip to `test-clip` outside the queue,
 * then the snippet once the worker heard it; nothing heard, a failure and too many tests say so.
 */

const created = {
  testClipId: '7e570000-0000-4000-8000-000000000001',
  bucket: 'audio' as const,
  path: 'test/org/7e570000-0000-4000-8000-000000000001.webm',
  signedUrl: 'https://p/storage/v1/object/upload/sign/audio/test/x.webm?token=t',
  token: 't',
};

function setup(view: { status: 'heard' | 'silent' | 'failed'; snippet: string | null }) {
  const routes = fakeRoutes({
    createTestClip: vi.fn().mockResolvedValue(created),
    completeTestClip: vi.fn().mockResolvedValue({ status: 'pending', snippet: null }),
    testClip: vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', snippet: null })
      .mockResolvedValue(view),
  });
  const put = vi.fn().mockResolvedValue({ status: 200 });
  const onDone = vi.fn();
  const h = fakeMediaRecorderDepsFor();
  renderApp('/', {
    routes,
    children: <WelcomeTest code="K7Q2MX" onDone={onDone} recorderDeps={h.deps} put={put} />,
  });
  return { routes, put, onDone, h };
}

async function recordAndStop(h: ReturnType<typeof fakeMediaRecorderDepsFor>) {
  fireEvent.click(screen.getByRole('button', { name: 'Start the test' }));
  expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
  act(() => h.tick(3_000));
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
}

describe('WelcomeTest (F4, W2-13)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(async () => {
    vi.useRealTimers();
    await act(() => i18n.changeLanguage('en'));
  });

  it('records, sends the clip outside any report and shows what was heard, once', async () => {
    const { routes, put, onDone, h } = setup({
      status: 'heard',
      snippet: 'Testing, one, two, three.',
    });
    expect(screen.getByRole('button', { name: 'Skip the test' })).toBeInTheDocument();
    await recordAndStop(h);
    expect(await screen.findByText('Listening…')).toBeInTheDocument();
    await waitFor(() => expect(routes.completeTestClip).toHaveBeenCalled());
    expect(routes.createTestClip).toHaveBeenCalledWith('K7Q2MX', {
      mime: expect.stringMatching(/^audio\//),
      bytes: expect.any(Number),
    });
    expect(put.mock.calls[0]![0]).toBe(created.signedUrl);
    expect(put.mock.calls[0]![2]).toMatch(/^audio\/(webm|mp4)$/);
    await act(() => vi.advanceTimersByTimeAsync(TEST_POLL_MS * 2 + 10));
    expect(
      await screen.findByText('Heard you clearly: “Testing, one, two, three.”'),
    ).toBeInTheDocument();
    expect(routes.testClip).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Go to today' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('nothing heard: says so, and Try again starts over', async () => {
    const { h } = setup({ status: 'silent', snippet: null });
    await recordAndStop(h);
    await act(() => vi.advanceTimersByTimeAsync(TEST_POLL_MS * 2 + 10));
    expect(
      await screen.findByText('I couldn’t hear anything. Check the microphone and try again.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Start the test' })).toBeInTheDocument();
  });

  it('too many tests, and a failure: says so, the reporter goes on', async () => {
    const { routes, h } = setup({ status: 'failed', snippet: null });
    vi.mocked(routes.createTestClip).mockRejectedValueOnce(
      apiError(429, 'rate_limited', { retryAfter: 3000 }),
    );
    await recordAndStop(h);
    expect(
      await screen.findByText('That’s enough tests for now. You can go on.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to today' })).toBeInTheDocument();
  });

  it.each([
    ['tr-TR', '20 saniyelik bir deneme yapın', 'Denemeyi atla'],
    ['es-US', 'Haga una prueba de 20 segundos', 'Saltar la prueba'],
  ] as const)('speaks %s', async (locale, title, skip) => {
    renderApp('/', {
      session: demoSession({ reporter: { ...demoSession().reporter, locale } }),
      children: <WelcomeTest code="K7Q2MX" onDone={() => undefined} />,
    });
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: skip })).toBeInTheDocument();
  });
});
