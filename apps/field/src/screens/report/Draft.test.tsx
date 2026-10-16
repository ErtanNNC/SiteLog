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

  it('shows the sections with the draft’s numbers, crew lines to change, Fix by voice and Confirm & send', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(draftView()) });
    renderApp('/report/r1', { routes });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Check today’s report' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('DRAFT · FRI OCT 9')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Riverside Lofts — Block B');

    // Crew: the day's total and each company's workers × hours, read out in words.
    const crew = screen.getByRole('region', { name: 'CREW' });
    expect(crew).toHaveTextContent('23 · 184 h');
    // W2-10: each crew line is a stepper's button, read as Field-06's label.
    expect(
      within(crew)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Apex Concrete, 6 workers, 8 hours each — change',
      'BrightLine Electric, 5 workers, 8 hours each — change',
      'Delta Mechanical, 5 workers, 8 hours each — change',
      'Ironclad Steel, 3 workers, 8 hours each — change',
      'Kestrel crew, 4 workers, 8 hours each — change',
    ]);
    expect(
      within(crew)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual([
      'Apex Concrete6 × 8 h',
      'BrightLine Electric5 × 8 h',
      'Delta MechanicalANSWERED5 × 8 h',
      'Ironclad Steel3 × 8 h',
      'Kestrel crew4 × 8 h',
    ]);
    expect(screen.getByRole('button', { name: 'Fix by voice' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Confirm & send' })).toBeEnabled();

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
    expect(
      within(crew).getByRole('button', { name: 'Delta Mechanical, Not stated — change' }),
    ).toBeInTheDocument();
    const defs = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(defs).toEqual(['Not stated', 'Not stated', 'Not stated', 'None']);
  });

  it('confirms the version and revision shown, then polls while it is filed', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(draftView({ currentVersion: 2, draftRev: 3 }))
        // Queued, not filed yet: "Filing your report…".
        .mockResolvedValueOnce(draftView({ currentVersion: 2, draftRev: 3 }))
        .mockResolvedValue(
          draftView({
            status: 'filed',
            currentVersion: 2,
            pdfUrl: 'https://storage.example/a.pdf',
          }),
        ),
      confirm: vi.fn().mockResolvedValue({ status: 'queued' }),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & send' }));
    expect(routes.confirm).toHaveBeenCalledWith('K7Q2MX', 'r1', { version: 2, draftRev: 3 });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Filing your report…' }),
    ).toBeInTheDocument();
    expect(screen.getByText('You’ll get a text with the PDF in a minute.')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(await screen.findByRole('heading', { level: 1, name: 'Filed.' })).toBeInTheDocument();
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
      expect(routes.confirm).toHaveBeenLastCalledWith('K7Q2MX', 'r1', { version: 2, draftRev: 1 }),
    );
  });

  it('shows the draft again when a late photo rewrote it in place after Confirm & send', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(draftView({ draftRev: 1 }))
        // The confirmed filing goes stale in the worker: the same version, a newer revision.
        .mockResolvedValue(draftView({ draftRev: 2 })),
      confirm: vi.fn().mockResolvedValue({ status: 'queued' }),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & send' }));
    expect(routes.confirm).toHaveBeenCalledWith('K7Q2MX', 'r1', { version: 1, draftRev: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your report changed. Check it again, then send.',
    );
    // Back on the draft, not polling: the reporter checks it and confirms the new revision.
    const calls = vi.mocked(routes.report).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & send' }));
    await waitFor(() =>
      expect(routes.confirm).toHaveBeenLastCalledWith('K7Q2MX', 'r1', { version: 1, draftRev: 2 }),
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

  // ── W2-10: the steppers and Fix by voice ──────────────────────────────────────────────────────

  it('a crew line’s stepper saves workers and hours on the draft shown, then the draft again', async () => {
    const changed = heroData(5);
    changed.manpower[0] = { ...changed.manpower[0]!, workers: 7, totalHours: 56 };
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(draftView())
        .mockResolvedValueOnce(draftView({ status: 'processing' }))
        .mockResolvedValue(draftView({ data: changed, draftRev: 2 })),
      edit: vi.fn().mockResolvedValue({ status: 'processing', reportStatus: 'processing' }),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Apex Concrete, 6 workers, 8 hours each — change',
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Apex Concrete' });
    const workers = within(sheet).getByRole('textbox', { name: 'Workers' });
    expect(workers).toHaveValue('6');
    fireEvent.click(within(sheet).getByRole('button', { name: 'One worker more' }));
    expect(workers).toHaveValue('7');
    expect(within(sheet).getByText('Total: 56 h')).toBeInTheDocument();
    // Typed: an hours value too.
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Hours each' }), {
      target: { value: '8' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(routes.edit).toHaveBeenCalledWith('K7Q2MX', 'r1', {
        version: 1,
        draftRev: 1,
        index: 0,
        workers: 7,
        hoursPerWorker: 8,
      }),
    );
    // The report processes the change, then the draft is shown again with it.
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(
      await screen.findByRole('button', {
        name: 'Apex Concrete, 7 workers, 8 hours each — change',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Change saved. Check the report again, then send.'),
    ).toBeInTheDocument();
  });

  it('a fix the report moved on from says so when the draft is shown again (W2-10 review)', async () => {
    const stale = {
      id: 'c1',
      status: 'stale' as const,
      via: 'voice' as const,
      changes: null,
      clarification: null,
      reason: 'report_moved_on',
      version: null,
      draftRev: null,
      afterFiling: false,
    };
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(draftView({ correction: stale })),
    });
    renderApp('/report/r1', { routes });
    expect(
      await screen.findByText(
        'Your report changed while I was listening. Check it, then say the fix again.',
      ),
    ).toBeInTheDocument();
  });

  it('no stepper while Confirm & send is in flight (W2-10 review)', async () => {
    let answer: (v: { status: 'queued' }) => void = () => {};
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(draftView()),
      confirm: vi.fn(() => new Promise<{ status: 'queued' }>((r) => (answer = r))),
    });
    renderApp('/report/r1', { routes });
    await screen.findByRole('button', { name: 'Apex Concrete, 6 workers, 8 hours each — change' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & send' }));
    await waitFor(() => expect(routes.confirm).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: 'Apex Concrete, 6 workers, 8 hours each — change' }),
    ).toBeNull();
    await act(async () => answer({ status: 'queued' }));
  });

  it('a stepper refuses what is not a number, and closes without a call when nothing changed', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(draftView()) });
    renderApp('/report/r1', { routes });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Ironclad Steel, 3 workers, 8 hours each — change',
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Ironclad Steel' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Workers' }), {
      target: { value: '3.5' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(
      await within(sheet).findByText('Enter a whole number of workers and up to 24 hours.'),
    ).toBeInTheDocument();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Workers' }), {
      target: { value: '3' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(routes.edit).not.toHaveBeenCalled();
  });

  it('Fix by voice, typed: listening, the preview from code’s numbers, Save change', async () => {
    const lines = [
      {
        kind: 'crew' as const,
        company: 'Apex Concrete',
        change: 'changed' as const,
        workers: [6, 7] as [number, number],
        hoursPerWorker: [8, 8] as [number, number],
        totalHours: [48, 56] as [number, number],
      },
    ];
    const fix = {
      id: 'c1',
      via: 'text' as const,
      changes: null,
      clarification: null,
      reason: null,
      version: null,
      draftRev: null,
    };
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(draftView())
        .mockResolvedValueOnce(draftView({ status: 'processing' }))
        .mockResolvedValue(draftView({ draftRev: 2 })),
      correction: vi.fn().mockResolvedValue({ ...fix, status: 'listening' }),
      correctionView: vi
        .fn()
        .mockResolvedValueOnce({ ...fix, status: 'listening' })
        .mockResolvedValue({ ...fix, status: 'ready', changes: lines, version: 1, draftRev: 1 }),
      applyCorrection: vi.fn().mockResolvedValue({ status: 'applied', reportStatus: 'processing' }),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Fix by voice' }));
    const sheet = await screen.findByRole('dialog', { name: 'Fix by voice' });
    expect(within(sheet).getByRole('button', { name: 'Record your fix' })).toBeInTheDocument();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'What should change?' }), {
      target: { value: 'Apex had 7, not 6' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(routes.correction).toHaveBeenCalledWith('K7Q2MX', 'r1', { text: 'Apex had 7, not 6' }),
    );
    expect(await screen.findByText('Listening to your fix…')).toBeInTheDocument();
    // Nothing is sent while the draft is about to change.
    expect(screen.getByRole('button', { name: 'Confirm & send' })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(4_100));
    const preview = await screen.findByRole('region', { name: 'Check the change' });
    expect(within(preview).getByRole('listitem')).toHaveTextContent(
      'Apex Concrete 6 → 7 workers, 48 → 56 h',
    );
    expect(screen.getByRole('button', { name: 'Confirm & send' })).toBeDisabled();
    fireEvent.click(within(preview).getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(routes.applyCorrection).toHaveBeenCalledWith('K7Q2MX', 'r1', 'c1'));
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(
      await screen.findByText('Change saved. Check the report again, then send.'),
    ).toBeInTheDocument();
  });

  it('a preview waiting on reload; a newer draft at Save change; an unclear fix asks again', async () => {
    const ready = {
      id: 'c1',
      status: 'ready' as const,
      via: 'voice' as const,
      changes: [{ kind: 'lost_hours' as const, lostHours: [3.5, 2] as [number, number] }],
      clarification: null,
      reason: null,
      version: 1,
      draftRev: 1,
      afterFiling: false,
    };
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(draftView({ correction: ready })),
      applyCorrection: vi.fn().mockRejectedValue(apiError(409, 'draft_changed')),
      correction: vi.fn().mockResolvedValue({
        ...ready,
        id: 'c2',
        status: 'unclear',
        changes: null,
        version: null,
        draftRev: null,
        reason: 'clarification',
        clarification: 'Which crew had three?',
      }),
    });
    renderApp('/report/r1', { routes });
    const preview = await screen.findByRole('region', { name: 'Check the change' });
    expect(preview).toHaveTextContent('Weather: 3.5 → 2 h lost');
    fireEvent.click(within(preview).getByRole('button', { name: 'Save change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your report changed while I was listening. Check it, then say the fix again.',
    );
    await waitFor(() => expect(routes.report).toHaveBeenCalledTimes(2));

    // An unclear fix: the model's question, and Try again opens the sheet.
    vi.mocked(routes.report).mockResolvedValue(draftView());
    fireEvent.click(await screen.findByRole('button', { name: 'Fix by voice' }));
    const sheet = await screen.findByRole('dialog', { name: 'Fix by voice' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'What should change?' }), {
      target: { value: 'change it to three' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('I couldn’t make that change.')).toBeInTheDocument();
    expect(screen.getByText('Which crew had three?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm & send' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Fix by voice' })).toBeInTheDocument();
  });

  it('Fix by voice in Spanish and Turkish', async () => {
    await act(() => i18n.changeLanguage('es'));
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(draftView()) });
    const as = (locale: 'es-US' | 'tr-TR') =>
      demoSession({ reporter: { ...demoSession().reporter, locale } });
    const { unmount } = renderApp('/report/r1', { routes, session: as('es-US') });
    expect(await screen.findByRole('button', { name: 'Corregir por voz' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Apex Concrete, 6 trabajadores, 8 horas cada uno: cambiar',
      }),
    ).toBeInTheDocument();
    unmount();
    await act(() => i18n.changeLanguage('tr'));
    renderApp('/report/r1', { routes, session: as('tr-TR') });
    expect(await screen.findByRole('button', { name: 'Sesle düzelt' })).toBeInTheDocument();
  });
});
