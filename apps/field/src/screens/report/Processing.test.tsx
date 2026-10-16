import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { apiError, fakeRoutes, renderApp } from '@/test/render';
import { stillProcessing, ticksDone } from './ticks';

function view(patch: Partial<ReportView> = {}): ReportView {
  return {
    id: 'r1',
    reportNo: 'RL-2041-0188',
    status: 'processing',
    kind: 'daily',
    siteId: 's1',
    siteName: 'Riverside Lofts — Block B',
    date: '2026-10-09',
    channel: 'web',
    currentVersion: 0,
    needsReview: false,
    filedAt: null,
    confirmedAt: null,
    question: null,
    data: null,
    draftRev: null,
    progress: { voiceNotes: 1, transcribed: 0, photos: 2 },
    pdfUrl: null,
    addPhotos: null,
    changeNote: null,
    lastVoiceAnswer: null,
    ...patch,
  };
}

describe('Processing (F5 step 4)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('polls every 2 s at first, ticks the steps from the data, and stops when the worker is done', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(view())
        .mockResolvedValueOnce(view({ progress: { voiceNotes: 1, transcribed: 1, photos: 2 } }))
        .mockResolvedValue(
          view({
            status: 'awaiting_confirmation',
            progress: { voiceNotes: 1, transcribed: 1, photos: 2 },
          }),
        ),
    });
    renderApp('/report/r1', { routes });
    expect(
      await screen.findByText('REPORT RL-2041-0188 · RIVERSIDE LOFTS — BLOCK B', { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Writing your report…' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 voice note(s) · 2 photo(s)')).toBeInTheDocument();
    expect(screen.getByText('You can close this — I’ll message you')).toBeInTheDocument();
    expect(routes.report).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(routes.report).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(routes.report).toHaveBeenCalledTimes(3);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: 'Your report is ready to check' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('You can close this — I’ll message you')).toBeNull();
    // Done ticks say so in their name too (status never by an icon alone).
    expect(screen.getByRole('list', { name: 'Writing your report…' })).toHaveTextContent(
      'Transcribed (done)',
    );
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(routes.report).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/today');
  });

  it('says a filed report is filed (opened from Today): the Filed screen', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValue(view({ status: 'filed', pdfUrl: 'https://s.example/a.pdf' })),
    });
    renderApp('/report/r1', { routes });
    expect(await screen.findByRole('heading', { level: 1, name: 'Filed.' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(routes.report).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through a failed poll and says so', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(view()),
    });
    renderApp('/report/r1', { routes });
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t check on your report.');
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('polls less often as it goes, under the device’s rate limit', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(view()) });
    renderApp('/report/r1', { routes });
    await screen.findByText('REPORT RL-2041-0188 · RIVERSIDE LOFTS — BLOCK B', { exact: false });
    // The first 20 s: every 2 s.
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    const fast = vi.mocked(routes.report).mock.calls.length;
    expect(fast).toBeGreaterThanOrEqual(10);
    expect(fast).toBeLessThanOrEqual(11);
    // Then every 5 s.
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(vi.mocked(routes.report).mock.calls.length - fast).toBe(4);
    // After a minute, every 10 s.
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    const minute = vi.mocked(routes.report).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(vi.mocked(routes.report).mock.calls.length - minute).toBe(6);
  });

  it('does not poll while the page is hidden, and polls at once when it is back', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(view()) });
    let hidden = false;
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => (hidden ? 'hidden' : 'visible'));
    renderApp('/report/r1', { routes });
    await screen.findByText('REPORT RL-2041-0188 · RIVERSIDE LOFTS — BLOCK B', { exact: false });
    hidden = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(routes.report).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(routes.report).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it('waits what a rate limit says before the next poll', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockRejectedValueOnce(apiError(429, 'rate_limited', { retryAfter: 30 }))
        .mockResolvedValue(view()),
    });
    renderApp('/report/r1', { routes });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(routes.report).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    expect(routes.report).toHaveBeenCalledTimes(2);
  });

  it('stops polling and sends the phone through the link when field-api no longer takes it', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockRejectedValue(apiError(401, 'device_unverified')),
      resolve: vi.fn(() => new Promise<never>(() => undefined)),
    });
    renderApp('/report/r1', { routes });
    await waitFor(() => expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX'));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(1);
  });

  it('says a report field-api no longer finds is not available, and stops', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockRejectedValue(apiError(404, 'not_found')) });
    renderApp('/report/r1', { routes });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This report isn’t available here any more.',
    );
    expect(screen.queryByText('You can close this — I’ll message you')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Back to Today' })).toBeInTheDocument();
  });

  it('derives the ticks from the view, never from a flag', () => {
    const base = view();
    expect(ticksDone(base)).toEqual({
      transcribed: false,
      crew: false,
      weather: false,
      hours: false,
    });
    const drafted = view({
      status: 'awaiting_answer',
      progress: { voiceNotes: 2, transcribed: 2, photos: 0 },
      data: { manpower: [{}], weather: { periods: [{}] } } as never,
    });
    expect(ticksDone(drafted)).toEqual({
      transcribed: true,
      crew: true,
      weather: true,
      hours: true,
    });
    expect(stillProcessing(base)).toBe(true);
    expect(stillProcessing(drafted)).toBe(false);
  });
});
