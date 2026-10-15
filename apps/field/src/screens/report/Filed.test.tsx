import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { demoSession, fakeRoutes, renderApp, SITE, US_COUNTRY } from '@/test/render';
import { PDF_URL_REFRESH_MS } from './Filed';
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
    // Week 1 (§19 Q67): no Add photos, no Past reports, no edit hint.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Past reports/)).toBeNull();

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
