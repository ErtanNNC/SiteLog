import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { assertE164 } from '@sitelog/shared/format.ts';
import { i18n } from '@/i18n/i18n';
import {
  apiError,
  demoSession,
  fakeQueue,
  fakeRoutes,
  renderApp,
  SITE,
  SITE_2,
  todayResponse,
} from '@/test/render';

describe('Today (F5 step 1, Field-03 / Field-10)', () => {
  it('shows site, date, deadline in the site’s time zone, status, prompts and the actions', async () => {
    const routes = fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()) });
    renderApp('/today', { routes });
    expect(await screen.findByText('Not sent yet')).toBeInTheDocument();
    expect(routes.today).toHaveBeenCalledWith('K7Q2MX', null, expect.any(AbortSignal));
    expect(screen.getByRole('banner')).toHaveTextContent('Riverside Lofts — Block B');
    // One site: no switcher.
    expect(screen.queryByRole('button', { name: /Change site/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    const time = screen.getByText('FRI, OCT 9');
    expect(time).toHaveAttribute('datetime', '2026-10-09');
    expect(time.parentElement).toHaveTextContent('FRI, OCT 9 · DUE 17:30');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Say it in any order' }),
    ).toBeInTheDocument();
    for (const p of [
      'Work done & where',
      'Crew by company',
      'Hours',
      'Weather & lost time',
      'Deliveries',
      'Safety',
    ]) {
      expect(screen.getByText(p)).toBeInTheDocument();
    }
    const record = screen.getByRole('link', { name: 'Record today’s report' });
    expect(record).toHaveAttribute('href', '/record');
    // ≥ 120 px (§14.6): the artboard's 148 px circle.
    expect(record.className).toContain('size-[148px]');
    expect(screen.getByText('Tap to record')).toBeInTheDocument();
    expect(screen.getByText('Usually 2–3 minutes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No work today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Site closed: weather' })).toBeInTheDocument();
    // Talk now is behind VITE_FEATURE_TALK_NOW (off); no voice number in the pack: no call line.
    expect(screen.queryByText(/Talk now/)).toBeNull();
    expect(screen.queryByRole('link', { name: /or call/ })).toBeNull();
    expect(document.title).toBe('Today · SiteLog');
  });

  it('offers Call {number} only when the pack has a voice number, and the site switcher with two sites', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockResolvedValue(todayResponse({ sites: [SITE, SITE_2] })),
    });
    renderApp('/today', {
      routes,
      session: demoSession({
        sites: [SITE, SITE_2],
        country: { ...demoSession().country, voiceNumber: assertE164('+15550142290') },
      }),
    });
    // The number as the shared formatter writes it (`formatPhone`, the panel's convention too).
    const call = await screen.findByRole('link', { name: 'or call +1 555 014 2290' });
    expect(call).toHaveAttribute('href', 'tel:+15550142290');
    // The visible site name is part of the switcher's name (WCAG 2.5.3 label in name).
    fireEvent.click(screen.getByRole('button', { name: 'Riverside Lofts — Block B, Change site' }));
    const sheet = screen.getByRole('dialog', { name: 'Which site?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pier 9 Warehouse' }));
    await waitFor(() =>
      expect(routes.today).toHaveBeenLastCalledWith('K7Q2MX', SITE_2.id, expect.any(AbortSignal)),
    );
  });

  it('keeps Today when the switcher picks the site already shown (F14, W2-17)', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockResolvedValue(todayResponse({ sites: [SITE, SITE_2] })),
    });
    renderApp('/today', { routes, session: demoSession({ sites: [SITE, SITE_2] }) });
    expect(await screen.findByText('Not sent yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Riverside Lofts — Block B, Change site' }));
    const sheet = screen.getByRole('dialog', { name: 'Which site?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Riverside Lofts — Block B' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Which site?' })).toBeNull());
    expect(screen.getByText('Not sent yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Record today’s report' })).toBeInTheDocument();
  });

  it('writes No work and Weather through day-status after a confirm sheet (F12)', async () => {
    const routes = fakeRoutes({
      today: vi
        .fn()
        .mockResolvedValueOnce(todayResponse())
        .mockResolvedValueOnce(todayResponse({ dayStatus: 'no_work' }))
        .mockResolvedValue(todayResponse({ dayStatus: 'weather_day' })),
      dayStatus: vi.fn().mockResolvedValue({ siteDayId: 'd1', status: 'no_work', changed: true }),
    });
    renderApp('/today', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'No work today' }));
    const sheet = screen.getByRole('dialog', { name: 'No work today?' });
    expect(sheet).toHaveTextContent(
      'The office will see “No work today” for Riverside Lofts — Block B.',
    );
    fireEvent.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(routes.dayStatus).toHaveBeenCalledWith('K7Q2MX', {
        siteId: SITE.id,
        status: 'no_work',
        date: '2026-10-09',
      }),
    );
    expect(await screen.findByText('No work today', { selector: 'span' })).toBeInTheDocument();
    expect(
      screen.getByText('This day’s report is in. Nothing more can be added from here.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Record today’s report' })).toBeNull();
  });

  it('asks since when and how many for a weather day, and shows field-api’s refusal', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockResolvedValue(todayResponse()),
      dayStatus: vi.fn().mockRejectedValueOnce(apiError(409, 'report_in_progress')),
    });
    renderApp('/today', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Site closed: weather' }));
    const sheet = screen.getByRole('dialog', { name: 'Site closed for weather?' });
    fireEvent.click(within(sheet).getByRole('radio', { name: '09:00' }));
    fireEvent.change(within(sheet).getByLabelText('How many were on site before?'), {
      target: { value: '12' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(routes.dayStatus).toHaveBeenCalledWith('K7Q2MX', {
        siteId: SITE.id,
        status: 'weather_day',
        date: '2026-10-09',
        details: { since: '09:00', workersBefore: 12 },
      }),
    );
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'A report is already on its way for today. Finish it first.',
    );
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks today or yesterday before noon site time (F5, spec §19 Q43)', async () => {
    const routes = fakeRoutes({
      today: vi
        .fn()
        .mockResolvedValue(
          todayResponse({ date: '2026-10-12', allowedDates: ['2026-10-12', '2026-10-09'] }),
        ),
    });
    renderApp('/today', { routes });
    const group = await screen.findByRole('radiogroup', {
      name: 'Is this for today or yesterday?',
    });
    expect(within(group).getByRole('radio', { name: 'Today' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Yesterday, Friday, Oct 9' }));
    expect(within(group).getByRole('radio', { name: 'Yesterday, Friday, Oct 9' })).toBeChecked();
    expect(screen.getByText('FRI, OCT 9')).toBeInTheDocument();
  });

  it('shows the in-progress report and keeps Record for another clip', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockResolvedValue(
        todayResponse({
          dayStatus: 'processing',
          report: { id: 'r1', reportNo: 'RL-2041-0188', status: 'processing', kind: 'daily' },
        }),
      ),
    });
    renderApp('/today', { routes });
    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open report RL-2041-0188' })).toHaveAttribute(
      'href',
      '/report/r1',
    );
    expect(screen.getByRole('link', { name: 'Record today’s report' })).toBeInTheDocument();
  });

  it('W2-08: a weather-day report closes the day and offers the photo of the conditions', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockResolvedValue(
        todayResponse({
          dayStatus: 'weather_day',
          report: { id: 'r9', reportNo: 'RL-2041-0190', status: 'filed', kind: 'weather_day' },
        }),
      ),
    });
    renderApp('/today', { routes });
    expect(await screen.findByText('Weather day')).toBeInTheDocument();
    expect(
      screen.getByText('A photo of the conditions makes the delay record stronger.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a photo of the conditions' })).toHaveAttribute(
      'href',
      '/report/r9',
    );
    expect(screen.queryByRole('link', { name: 'Record today’s report' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'No work today' })).toBeNull();
  });

  it('W2-08: the weather sheet needs since when before it confirms', async () => {
    const dayStatus = vi.fn().mockResolvedValue({
      siteDayId: 'sd1',
      status: 'weather_day',
      changed: true,
      report: { id: 'r9', reportNo: 'RL-2041-0190' },
    });
    const routes = fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()), dayStatus });
    renderApp('/today', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Site closed: weather' }));
    const sheet = await screen.findByRole('dialog', { name: 'Site closed for weather?' });
    const confirm = within(sheet).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription('Pick since when to confirm.');
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Never started' }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(dayStatus).toHaveBeenCalledWith(
        'K7Q2MX',
        expect.objectContaining({ status: 'weather_day', details: { since: 'never_started' } }),
      ),
    );
  });

  it('sends the phone back through the link when the device or consent is gone', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockRejectedValueOnce(apiError(401, 'device_unverified')),
      resolve: vi.fn().mockRejectedValue(apiError(404, 'link_not_found')),
    });
    renderApp('/today', { routes });
    await waitFor(() => expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX'));
  });

  it.each([
    [410, 'link_revoked', 'Link no longer valid'],
    [410, 'link_expired', 'This link has expired'],
    [403, 'reporter_disabled', 'Account paused'],
  ] as const)(
    'explains a link refused with %s %s through the link flow, not as a lost signal',
    async (status, code, title) => {
      const routes = fakeRoutes({
        today: vi.fn().mockRejectedValue(apiError(status, code)),
        resolve: vi.fn().mockRejectedValue(apiError(status, code)),
      });
      renderApp('/today', { routes });
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX');
      expect(screen.queryByText(/Check your signal/)).not.toBeInTheDocument();
    },
  );

  it('asks for the link when none is stored, and recovers from a failed load', async () => {
    renderApp('/today', { session: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Open your link' })).toBeInTheDocument();
    const routes = fakeRoutes({
      today: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(todayResponse()),
    });
    renderApp('/today', { routes });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load today. Check your signal and try again.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Not sent yet')).toBeInTheDocument();
  });

  it.each(['es', 'tr'] as const)('renders in %s (Field-10 for Turkish)', async (lng) => {
    await act(() => i18n.changeLanguage(lng));
    const copy = UI_RESOURCES[lng].field.today;
    const routes = fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()) });
    renderApp('/today', {
      routes,
      session: demoSession({
        reporter: { ...demoSession().reporter, locale: lng === 'es' ? 'es-US' : 'tr-TR' },
      }),
    });
    expect(await screen.findByText(copy.status.notSent)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: copy.promptsTitle })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.record })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.noWork })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.weather })).toBeInTheDocument();
    expect(
      screen.getByText(lng === 'tr' ? 'CUMA, 9 EKİM' : 'VIE, 9 OCT').parentElement,
    ).toHaveTextContent(copy.due.replace('{{time}}', '17:30'));
  });

  it('lists refused items with their reason: Try again where it can help, Remove always', async () => {
    let tries = 0;
    const { queue } = fakeQueue(async () =>
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
    const item = await queue.enqueue({
      code: 'K7Q2MX',
      kind: 'audio',
      mime: 'audio/webm',
      blob: new Blob(['abc']),
      siteId: SITE.id,
      date: '2026-10-09',
      recordedAt: null,
    });
    await queue.waitFor(item.id);
    const routes = fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()) });
    renderApp('/today', { routes, queue });
    expect(await screen.findByText('Not sent: 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const sheet = screen.getByRole('dialog', { name: 'Not sent' });
    expect(sheet).toHaveTextContent('Voice note · Friday, Oct 9');
    expect(sheet).toHaveTextContent('This site is paused. Ask the office, then try again.');
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Try again: Voice note · Friday, Oct 9' }),
    );
    await waitFor(() => expect(screen.queryByText('Not sent: 1')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tries).toBe(2);
  });

  it('offers only Remove for a refusal nothing can change, and removes on that tap', async () => {
    const { queue, store } = fakeQueue(async () => ({
      ok: false,
      permanent: true,
      error: 'report_filed',
    }));
    const item = await queue.enqueue({
      code: 'K7Q2MX',
      kind: 'photo',
      mime: 'image/jpeg',
      blob: new Blob(['abc']),
      siteId: SITE.id,
      date: '2026-10-09',
      recordedAt: null,
    });
    await queue.waitFor(item.id);
    renderApp('/today', {
      routes: fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()) }),
      queue,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const sheet = screen.getByRole('dialog', { name: 'Not sent' });
    expect(sheet).toHaveTextContent(
      'Today’s report was already sent, so this can’t be added to it.',
    );
    expect(within(sheet).queryByRole('button', { name: /Try again/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove: Photo · Friday, Oct 9' }));
    await waitFor(() => expect(screen.queryByText('Not sent: 1')).toBeNull());
    expect(store.items.size).toBe(0);
  });

  it('shows the report a clip sent in the background created, with no tap', async () => {
    let send: () => void = () => undefined;
    const { queue } = fakeQueue(
      () =>
        new Promise((resolve) => {
          send = () =>
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
    const routes = fakeRoutes({
      today: vi
        .fn()
        .mockResolvedValueOnce(todayResponse())
        .mockResolvedValue(
          todayResponse({
            dayStatus: 'processing',
            report: { id: 'r1', reportNo: 'RL-2041-0188', status: 'processing', kind: 'daily' },
          }),
        ),
    });
    renderApp('/today', { routes, queue });
    expect(await screen.findByText('Not sent yet')).toBeInTheDocument();
    await queue.enqueue({
      code: 'K7Q2MX',
      kind: 'audio',
      mime: 'audio/webm',
      blob: new Blob(['abc']),
      siteId: SITE.id,
      date: '2026-10-09',
      recordedAt: null,
    });
    await waitFor(() => expect(queue.getSnapshot().uploading).not.toBeNull());
    await act(async () => send());
    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open report RL-2041-0188' })).toBeInTheDocument();
    // A day with a report on its way is not offered as a no-work or weather day.
    expect(screen.queryByRole('button', { name: 'No work today' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Site closed: weather' })).toBeNull();
  });

  it('loads again when the signal comes back after a failed load', async () => {
    const routes = fakeRoutes({
      today: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(todayResponse()),
    });
    renderApp('/today', { routes });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByText('Not sent yet')).toBeInTheDocument();
  });

  it('keeps the focus in the weather sheet while the screen behind it changes', async () => {
    const { queue } = fakeQueue(() => new Promise(() => undefined));
    renderApp('/today', {
      routes: fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()) }),
      queue,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Site closed: weather' }));
    const sheet = screen.getByRole('dialog', { name: 'Site closed for weather?' });
    const workers = within(sheet).getByLabelText('How many were on site before?');
    workers.focus();
    expect(workers).toHaveFocus();
    // A photo starts uploading behind the sheet: Today re-renders.
    await act(async () => {
      await queue.enqueue({
        code: 'K7Q2MX',
        kind: 'photo',
        mime: 'image/jpeg',
        blob: new Blob(['abc']),
        siteId: SITE.id,
        date: '2026-10-09',
        recordedAt: null,
      });
    });
    expect(await screen.findByText('Sending 1 photo(s)…')).toBeInTheDocument();
    expect(workers).toHaveFocus();
    // The screen behind is out of reach while the sheet is open.
    expect(screen.getByRole('button', { name: 'Add photos' }).closest('[inert]')).not.toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('[inert]')).toBeNull();
  });
});
