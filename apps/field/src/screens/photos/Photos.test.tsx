import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { reportView } from '@/screens/report/test-views';
import { demoSession, fakeQueue, fakeRoutes, renderApp, SITE, todayResponse } from '@/test/render';

const ADD = { canAdd: true, remaining: 4, until: '2026-10-11T04:59:00.000Z', pending: 0 };
const FILED = { id: 'r1', reportNo: 'RL-2041-0188', status: 'filed', kind: 'daily' } as const;
const photo = (name: string) => new File(['jpg'], name, { type: 'image/jpeg', lastModified: 1 });

const photosSession = () =>
  demoSession({
    link: { kind: 'photos', siteId: SITE.id, reportDate: '2026-10-09', expiresAt: null },
  });

const filedView = (patch = {}) =>
  reportView({
    status: 'filed',
    filedAt: '2026-10-09T22:44:00Z',
    confirmedAt: '2026-10-09T22:43:00Z',
    pdfUrl: 'https://storage.example/pdfs/RL-2041-0188_v1.pdf?token=a',
    siteId: SITE.id,
    addPhotos: ADD,
    ...patch,
  });

describe('a photos link: the photo-only screen (F9, W3-13)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(async () => {
    vi.useRealTimers();
    await act(() => i18n.changeLanguage('en'));
  });

  it('Today sends a photos link here; photos only, no Record or Talk now', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockResolvedValue(todayResponse({ report: FILED, talkNow: true })),
      report: vi.fn().mockResolvedValue(filedView()),
    });
    renderApp('/today', { routes, session: photosSession() });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Add photos' });
    expect(heading).toHaveFocus();
    expect(routes.today).toHaveBeenCalledWith('K7Q2MX', SITE.id, expect.any(AbortSignal));
    await screen.findByText(
      'Photos for report RL-2041-0188, Riverside Lofts — Block B, Friday, Oct 9.',
    );
    expect(
      screen.getByText('Photos you can still add: 4, until Saturday, Oct 10 23:59.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take or choose photos' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Record/ })).toBeNull();
    expect(screen.queryByText(/Talk now/)).toBeNull();
    expect(document.title).toBe('Add photos · SiteLog');
  });

  it('sends two photos as one batch to the filed report and shows version 2', async () => {
    const routes = fakeRoutes({
      today: vi.fn().mockResolvedValue(todayResponse({ report: FILED })),
      report: vi
        .fn()
        .mockResolvedValueOnce(filedView())
        .mockResolvedValue(
          filedView({
            currentVersion: 2,
            changeNote: '2 photos added',
            addPhotos: { ...ADD, remaining: 2 },
          }),
        ),
    });
    const { queue, calls } = fakeQueue();
    renderApp('/photos', { routes, queue, session: photosSession() });
    await screen.findByRole('button', { name: 'Take or choose photos' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [photo('a.jpg'), photo('b.jpg')] } });
    const dialog = await screen.findByRole('dialog', { name: 'Add photos to RL-2041-0188' });
    expect(dialog).toHaveTextContent('Photos chosen: 2');
    fireEvent.click(screen.getByRole('button', { name: 'Send photos' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => [c.kind, c.addTo?.reportId, c.addTo?.photos])).toEqual([
      ['photo', 'r1', 2],
      ['photo', 'r1', 2],
    ]);
    expect(
      await screen.findByText('Photos added. Version 2 is with the office.'),
    ).toBeInTheDocument();
  });

  it('says so when the day has no filed report yet, or the link can add no more', async () => {
    const none = fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()) });
    const view = renderApp('/photos', { routes: none, session: photosSession() });
    expect(
      await screen.findByText(
        'There’s no filed report for this day yet. Photos can be added once it’s filed.',
      ),
    ).toBeInTheDocument();
    view.unmount();

    const closed = fakeRoutes({
      today: vi.fn().mockResolvedValue(todayResponse({ report: FILED })),
      report: vi
        .fn()
        .mockResolvedValue(filedView({ addPhotos: { ...ADD, canAdd: false, remaining: 0 } })),
    });
    renderApp('/photos', { routes: closed, session: photosSession() });
    expect(await screen.findByText('This link can’t add more photos.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take or choose photos' })).toBeNull();
  });

  it('another link has no photo-only screen: Today', async () => {
    const routes = fakeRoutes({ today: vi.fn().mockResolvedValue(todayResponse()) });
    renderApp('/photos', { routes });
    expect(await screen.findByText('Not sent yet')).toBeInTheDocument();
  });
});
