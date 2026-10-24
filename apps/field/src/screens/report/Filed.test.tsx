import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { demoSession, fakeQueue, fakeRoutes, renderApp, SITE, US_COUNTRY } from '@/test/render';
import { fakeMediaRecorderDepsFor } from '@/screens/record/test-helpers';
import { AddPhotosSheet } from './AddPhotosSheet';
import { PDF_URL_REFRESH_MS, PDF_WAIT_MS } from './Filed';
import { reportView } from './test-views';

const PDF = 'https://storage.example/pdfs/RL-2041-0188_v1.pdf?token=a';

const filedView = (patch = {}) =>
  reportView({
    status: 'filed',
    filedAt: '2026-10-09T22:44:00Z',
    confirmedAt: '2026-10-09T22:43:00Z',
    pdfUrl: PDF,
    ...patch,
  });

describe('Filed (F8, Field-07)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(async () => {
    vi.useRealTimers();
    await act(() => i18n.changeLanguage('en'));
  });

  it('says it is filed, with the report number, the PDF and the way back to Today', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(filedView()) });
    renderApp('/report/r1', { routes });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('banner')).toHaveTextContent('Riverside Lofts — Block B');
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent ===
            'Daily Report RL-2041-0188 is with the office. Thanks, Marco — that’s it for today.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('RL-2041-0188').tagName).toBe('B');

    const pdf = screen.getByRole('link', { name: /^Open the PDF/ });
    expect(pdf).toHaveAttribute('href', PDF);
    expect(pdf).toHaveAttribute('target', '_blank');
    expect(pdf).toHaveAccessibleName(
      'Open the PDF RL-2041-0188_2026-10-09_v1.pdf (opens in a new tab)',
    );
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/today');
    // M6 (§19 Q67, W2-04): Past reports and the edit hint; no Add more photos when the view
    // offers none (`addPhotos` null).
    expect(screen.getByRole('link', { name: 'Past reports' })).toHaveAttribute('href', '/history');
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent ===
            'Need a change later? Open Past reports and say what to fix. The office gets a new version; the old one is kept.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();

    // No polling once the PDF is there; the signed URL is renewed before it expires.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(routes.report).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(PDF_URL_REFRESH_MS));
    expect(routes.report).toHaveBeenCalledTimes(2);
  });

  it('waits for the PDF while render_pdf has not stored it', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(filedView({ pdfUrl: null }))
        .mockResolvedValue(filedView()),
    });
    renderApp('/report/r1', { routes });
    await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the PDF…');
    expect(screen.queryByRole('link', { name: /Open the PDF/ })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(await screen.findByRole('link', { name: /Open the PDF/ })).toHaveAttribute('href', PDF);
    const calls = vi.mocked(routes.report).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(calls);
  });

  it('stops checking when the PDF never comes and says it is on its way', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(filedView({ pdfUrl: null })) });
    renderApp('/report/r1', { routes });
    await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the PDF…');
    await act(() => vi.advanceTimersByTimeAsync(PDF_WAIT_MS + 10_000));
    expect(screen.getByRole('status')).toHaveTextContent(
      'The PDF is on its way. The office already has your report.',
    );
    expect(screen.queryByRole('link', { name: /Open the PDF/ })).toBeNull();
    const calls = vi.mocked(routes.report).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(routes.report).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ['es', 'es-US', 'El PDF está en camino. La oficina ya tiene su reporte.'],
    ['tr', 'tr-TR', 'PDF yolda. Raporunuz ofise ulaştı.'],
  ] as const)('says the PDF is on its way in %s', async (language, locale, text) => {
    await act(() => i18n.changeLanguage(language));
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(filedView({ pdfUrl: null })) });
    renderApp('/report/r1', {
      routes,
      session: demoSession({ reporter: { ...demoSession().reporter, locale } }),
    });
    await screen.findByRole('heading', { level: 1 });
    await act(() => vi.advanceTimersByTimeAsync(PDF_WAIT_MS + 10_000));
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('speaks Spanish', async () => {
    await act(() => i18n.changeLanguage('es'));
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(filedView()) });
    renderApp('/report/r1', {
      routes,
      session: demoSession({ reporter: { ...demoSession().reporter, locale: 'es-US' } }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Registrado.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Abrir el PDF/ })).toBeInTheDocument();
  });

  it('speaks Turkish', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(filedView()) });
    renderApp('/report/r1', {
      routes,
      session: demoSession({ reporter: { ...demoSession().reporter, locale: 'tr-TR' } }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kaydedildi.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent ===
            'Günlük Rapor RL-2041-0188 ofise iletildi. Teşekkürler Marco, bugünlük bu kadar.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bugün ekranına dön' })).toBeInTheDocument();
  });

  it('the `filed` text’s link checks the link, then opens the report', async () => {
    const routes = fakeRoutes({
      resolve: vi.fn().mockResolvedValue({
        reporter: {
          name: 'Marco Ruiz',
          firstName: 'Marco',
          locale: 'en-US',
          contactPref: 'link',
          status: 'active',
        },
        org: { name: 'Kestrel Build Group' },
        link: { kind: 'personal', siteId: null, reportDate: null, expiresAt: null },
        needsDeviceCheck: false,
        needsConsent: false,
        sites: [SITE],
        country: US_COUNTRY,
      }),
      report: vi.fn().mockResolvedValue(filedView()),
    });
    renderApp('/r/k7q2mx/report/r1', { session: demoSession(), routes });
    expect(await screen.findByRole('heading', { level: 1, name: 'Filed.' })).toBeInTheDocument();
    expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX');
    expect(routes.report).toHaveBeenCalledWith('K7Q2MX', 'r1', expect.anything());
  });
});

const ADD = { canAdd: true, remaining: 4, until: '2026-10-11T04:59:00.000Z', pending: 0 };
const photo = (name: string) => new File(['jpg'], name, { type: 'image/jpeg', lastModified: 1 });

function pick(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files } });
}

describe('Filed: Add more photos (F9, W2-04)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(async () => {
    vi.useRealTimers();
    await act(() => i18n.changeLanguage('en'));
  });

  it('W2-08: a weather-day report asks for a photo of the conditions (F12)', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValue(filedView({ addPhotos: ADD, siteId: SITE.id, kind: 'weather_day' })),
    });
    renderApp('/report/r1', { routes });
    await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === 'Weather day report RL-2041-0188 is with the office. Thanks, Marco.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('A photo of the conditions makes the delay record stronger.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add a photo of the conditions' }),
    ).toBeInTheDocument();
  });

  it('sends the photos as one batch and shows the new version', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(filedView({ addPhotos: ADD, siteId: SITE.id }))
        .mockResolvedValue(
          filedView({
            siteId: SITE.id,
            currentVersion: 2,
            changeNote: '2 photos added',
            pdfUrl: 'https://storage.example/pdfs/RL-2041-0188_v2.pdf?token=b',
            addPhotos: { ...ADD, remaining: 2 },
          }),
        ),
    });
    const { queue, calls } = fakeQueue();
    renderApp('/report/r1', { routes, queue });
    await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    expect(screen.getByRole('button', { name: 'Add more photos' })).toBeInTheDocument();

    pick([photo('a.jpg'), photo('b.jpg')]);
    const dialog = await screen.findByRole('dialog', { name: 'Add photos to RL-2041-0188' });
    expect(dialog).toHaveTextContent('Photos chosen: 2');
    // The window's end in the site's time zone: Sat Oct 10, 23:59 in Chicago.
    expect(dialog).toHaveTextContent('Photos you can still add: 4, until Saturday, Oct 10 23:59.');
    expect(screen.getAllByRole('img', { name: /^Photo [12]$/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Send photos' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    const batch = calls[0]!.addTo!;
    expect(batch).toEqual({
      reportId: 'r1',
      batchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      photos: 2,
      caption: false,
    });
    expect(calls.map((c) => [c.kind, c.addTo?.batchId])).toEqual([
      ['photo', batch.batchId],
      ['photo', batch.batchId],
    ]);
    expect(
      await screen.findByText('Photos added. Version 2 is with the office.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Open the PDF/ })).toHaveAccessibleName(
      'Open the PDF RL-2041-0188_2026-10-09_v2.pdf (opens in a new tab)',
    );
  });

  it('keeps only the photos the report still takes, and says so', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(filedView({ addPhotos: { ...ADD, remaining: 1 } })),
    });
    const { queue, calls } = fakeQueue();
    renderApp('/report/r1', { routes, queue });
    await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    pick([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Photos chosen: 1');
    expect(dialog).toHaveTextContent('Only 1 more can be added, so the first 1 are kept.');
    fireEvent.click(screen.getByRole('button', { name: 'Send photos' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.addTo!.photos).toBe(1);
  });

  it('offers no Add more photos once the window closed or the limit is reached', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(filedView({ addPhotos: { ...ADD, canAdd: false } })),
    });
    renderApp('/report/r1', { routes });
    await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    expect(screen.queryByRole('button', { name: 'Add more photos' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Past reports' })).toBeInTheDocument();
  });

  it('says why field-api refused the photos', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(filedView({ addPhotos: ADD })) });
    const { queue } = fakeQueue(async () => ({
      ok: false,
      permanent: true,
      error: 'photos_window_closed',
    }));
    renderApp('/report/r1', { routes, queue });
    await screen.findByRole('heading', { level: 1, name: 'Filed.' });
    pick([photo('a.jpg')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Send photos' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t add the photos. This report takes no more photos',
    );
  });

  it.each([
    ['es', 'es-US', 'Agregar más fotos', 'Reportes anteriores'],
    ['tr', 'tr-TR', 'Daha fazla fotoğraf ekle', 'Geçmiş raporlar'],
  ] as const)('speaks %s', async (language, locale, add, past) => {
    await act(() => i18n.changeLanguage(language));
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(filedView({ addPhotos: ADD })) });
    renderApp('/report/r1', {
      routes,
      session: demoSession({ reporter: { ...demoSession().reporter, locale } }),
    });
    expect(await screen.findByRole('button', { name: add })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: past })).toBeInTheDocument();
  });
});

describe('AddPhotosSheet: the voice caption (F9)', () => {
  it('records a caption and hands it over with Send photos', async () => {
    const h = fakeMediaRecorderDepsFor();
    const onSend = vi.fn();
    render(
      <AddPhotosSheet
        open
        reportNo="RL-2041-0188"
        files={[photo('a.jpg')]}
        dropped={0}
        remaining={4}
        until="Sat, Oct 10 23:59"
        onSend={onSend}
        onClose={() => undefined}
        recorderDeps={h.deps}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record a caption' }));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send photos' })).toBeDisabled();
    act(() => h.tick(3_000));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Caption recorded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send photos' }));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ mime: expect.stringMatching(/^audio\//) }),
    );
  });

  it('sends without a caption when the microphone is refused', async () => {
    const h = fakeMediaRecorderDepsFor({
      getUserMedia: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))),
    });
    const onSend = vi.fn();
    render(
      <AddPhotosSheet
        open
        reportNo="RL-2041-0188"
        files={[photo('a.jpg')]}
        dropped={0}
        remaining={4}
        until="Sat, Oct 10 23:59"
        onSend={onSend}
        onClose={() => undefined}
        recorderDeps={h.deps}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record a caption' }));
    expect(
      await screen.findByText('The microphone isn’t available. The photos go without a caption.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send photos' }));
    expect(onSend).toHaveBeenCalledWith(null);
  });
});
