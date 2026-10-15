import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { apiError, demoSession, fakeRoutes, renderApp } from '@/test/render';
import { draftView, heroData, reportView } from './test-views';

describe('Draft (F8, Field-06)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(async () => {
    vi.useRealTimers();
    await act(() => i18n.changeLanguage('en'));
  });

  it('shows the sections with the draft’s numbers, read-only, and a sticky Confirm & send', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(draftView()) });
    renderApp('/report/r1', { routes });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Check today’s report' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('DRAFT · FRI OCT 9')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Riverside Lofts — Block B');

    // Crew: the day's total and each company's workers × hours, read out in words.
    const crew = screen.getByRole('region', { name: 'CREW' });
    expect(crew).toHaveTextContent('23 · 184 h');
    const lines = within(crew).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent)).toEqual([
      'Apex Concrete6 × 8 h6 workers, 8 hours each',
      'BrightLine Electric5 × 8 h5 workers, 8 hours each',
      'Delta MechanicalANSWERED5 × 8 h5 workers, 8 hours each',
      'Ironclad Steel3 × 8 h3 workers, 8 hours each',
      'Kestrel crew4 × 8 h4 workers, 8 hours each',
    ]);
    // The steppers are read-only until M6: the one control is Confirm & send.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Confirm & send']);
    expect(screen.queryByText('Fix by voice')).toBeNull();

    const terms = screen.getAllByRole('term').map((d) => d.textContent);
    const defs = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(Object.fromEntries(terms.map((term, i) => [term, defs[i]]))).toEqual({
      WEATHER: 'Rain 07:00–10:30 · masonry stopped 3.5 h',
      DONE: 'L4 slab pour complete · L3 electrical rough-in ~60%',
      DELIVERED: 'Rebar, 2 loads (Ironclad)',
      SAFETY: 'Toolbox talk · no incidents',
      PHOTOS: '2 attached',
    });
    // No polling while the reporter reads.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(1);
  });

  it('never fills in a number the draft does not have', async () => {
    const data = heroData(null);
    data.weather = { conditionsText: '', periods: [] };
    data.safety = { incidents: [], noIncidentsStated: false, visitors: [], source: [] };
    data.workPerformed = [];
    data.deliveries = [];
    data.photos = [];
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(draftView({ data })) });
    renderApp('/report/r1', { routes });
    const crew = await screen.findByRole('region', { name: 'CREW' });
    expect(crew).toHaveTextContent('— · —');
    expect(within(crew).getByText('— × 8 h')).toBeInTheDocument();
    expect(within(crew).getByText('Not stated')).toBeInTheDocument();
    const defs = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(defs).toEqual(['Not stated', 'Not stated', 'Not stated', 'None']);
  });

  it('confirms the version shown, then polls while it is filed', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(draftView({ currentVersion: 2 }))
        // Queued, not filed yet: "Filing your report…".
        .mockResolvedValueOnce(draftView({ currentVersion: 2 }))
        .mockResolvedValue(draftView({ status: 'filed', currentVersion: 2 })),
      confirm: vi.fn().mockResolvedValue({ status: 'queued' }),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & send' }));
    expect(routes.confirm).toHaveBeenCalledWith('K7Q2MX', 'r1', { version: 2 });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Filing your report…' }),
    ).toBeInTheDocument();
    expect(screen.getByText('You’ll get a text with the PDF in a minute.')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Report filed' }),
    ).toBeInTheDocument();
    const calls = vi.mocked(routes.report).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(calls);
  });

  it('shows the newer draft when the one confirmed was replaced', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(draftView({ currentVersion: 1 }))
        .mockResolvedValue(draftView({ currentVersion: 2 })),
      confirm: vi
        .fn()
        .mockRejectedValueOnce(apiError(409, 'draft_changed', { details: { currentVersion: 2 } }))
        .mockResolvedValue({ status: 'queued' }),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your report changed. Check it again, then send.',
    );
    await waitFor(() => expect(routes.report).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & send' }));
    await waitFor(() =>
      expect(routes.confirm).toHaveBeenLastCalledWith('K7Q2MX', 'r1', { version: 2 }),
    );
  });

  it('keeps the draft and says so when Confirm & send did not go through', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(draftView()),
      confirm: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No connection.');
    expect(screen.getByRole('button', { name: 'Confirm & send' })).toBeEnabled();
  });

  it('says it when a draft has no data to show', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(reportView({ status: 'awaiting_confirmation' })),
    });
    renderApp('/report/r1', { routes });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your report is ready to check' }),
    ).toBeInTheDocument();
  });

  it('speaks Turkish, hours in saat', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(draftView()) });
    renderApp('/report/r1', {
      routes,
      session: demoSession({ reporter: { ...demoSession().reporter, locale: 'tr-TR' } }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bugünkü raporu kontrol edin' }),
    ).toBeInTheDocument();
    expect(screen.getByText('TASLAK · CUM 9 EKİ')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'EKİP' })).toHaveTextContent('23 · 184 sa');
    expect(screen.getByText('GÜVENLİK')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Onayla ve gönder' })).toBeInTheDocument();
  });
});
