import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import type { HistoryResponse } from '@sitelog/shared/field-contract.ts';
import { i18n } from '@/i18n/i18n';
import { draftView, heroData, reportView } from '@/screens/report/test-views';
import { apiError, demoSession, fakeRoutes, renderApp, SITE, SITE_2 } from '@/test/render';

const RIVERSIDE = SITE.name;

function history(): HistoryResponse {
  return {
    reports: [
      {
        id: 'r3',
        reportNo: 'P9-3007-0012',
        status: 'awaiting_confirmation',
        siteId: SITE_2.id,
        siteName: SITE_2.name,
        date: '2026-10-09',
        filedAt: null,
        currentVersion: 1,
        isLate: false,
      },
      {
        id: 'r2',
        reportNo: 'RL-2041-0187',
        status: 'filed',
        siteId: SITE.id,
        siteName: RIVERSIDE,
        date: '2026-10-09',
        filedAt: '2026-10-09T22:44:00Z',
        currentVersion: 2,
        isLate: false,
      },
      {
        id: 'r1',
        reportNo: 'RL-2041-0186',
        status: 'signed_off',
        siteId: SITE.id,
        siteName: RIVERSIDE,
        date: '2026-10-08',
        filedAt: '2026-10-09T01:10:00Z',
        currentVersion: 1,
        isLate: true,
      },
    ],
  };
}

afterEach(async () => {
  await act(() => i18n.changeLanguage('en'));
});

describe('Past reports (F10, F14, §9.3; W2-03)', () => {
  it('lists the last 14 days per site with the status in words and the Late badge', async () => {
    const routes = fakeRoutes({ history: vi.fn().mockResolvedValue(history()) });
    renderApp('/history', { routes });
    expect(await screen.findByText('RL-2041-0187')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Past reports' })).toBeInTheDocument();
    expect(document.title).toBe('Past reports · SiteLog');
    // Two sites: a heading per site, the newest site first.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([SITE_2.name.toUpperCase(), RIVERSIDE.toUpperCase()]);
    expect(screen.getByText('Ready to check')).toBeInTheDocument();
    expect(screen.getByText('Filed')).toBeInTheDocument();
    expect(screen.getByText('Signed off')).toBeInTheDocument();
    expect(screen.getAllByText('Late')).toHaveLength(1);
    const link = screen.getByRole('link', { name: /RL-2041-0186/ });
    expect(link).toHaveAttribute('href', '/history/r1');
    expect(link).toHaveTextContent('Thursday, Oct 8');
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/today');
  });

  it('says when there is nothing, and retries a failed load', async () => {
    const routes = fakeRoutes({
      history: vi
        .fn()
        .mockRejectedValueOnce(apiError(500, 'internal'))
        .mockResolvedValueOnce({ reports: [] }),
    });
    renderApp('/history', { routes });
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your past reports.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No reports in the last 14 days.')).toBeInTheDocument();
  });

  it('sends a phone field-api refuses back through the link check', async () => {
    const routes = fakeRoutes({
      history: vi.fn().mockRejectedValue(apiError(401, 'device_unverified')),
    });
    renderApp('/history', { routes });
    await waitFor(() => expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX'));
  });

  it('shows one report read-only, with the PDF and no edit action', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(
        reportView({
          id: 'r2',
          status: 'filed',
          currentVersion: 2,
          data: heroData(),
          pdfUrl: 'https://storage.test/pdf?token=t',
        }),
      ),
    });
    renderApp('/history/r2', { routes });
    expect(await screen.findByText('Open the PDF')).toBeInTheDocument();
    expect(routes.report).toHaveBeenCalledWith('K7Q2MX', 'r2', expect.any(AbortSignal));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/RL-2041/);
    expect(screen.getByText('Filed')).toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText('Delta Mechanical')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the PDF/ })).toHaveAttribute(
      'href',
      'https://storage.test/pdf?token=t',
    );
    // Change something is W2-11; Confirm & send is the draft's.
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Continue this report' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Past reports' })).toHaveAttribute(
      'href',
      '/history',
    );
  });

  it('offers to continue a report still in progress', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(draftView({ id: 'r3' })),
    });
    renderApp('/history/r3', { routes });
    const go = await screen.findByRole('link', { name: 'Continue this report' });
    expect(go).toHaveAttribute('href', '/report/r3');
    expect(screen.getByText('Ready to check')).toBeInTheDocument();
    expect(screen.queryByText('Open the PDF')).toBeNull();
  });

  it.each(['es', 'tr'] as const)('has its copy in %s', async (lng) => {
    await act(() => i18n.changeLanguage(lng));
    const copy = UI_RESOURCES[lng].field;
    const routes = fakeRoutes({ history: vi.fn().mockResolvedValue(history()) });
    const session = demoSession();
    session.reporter.locale = lng === 'es' ? 'es-US' : 'tr-TR';
    renderApp('/history', { routes, session });
    expect(await screen.findByText(copy.history.status.awaiting_confirmation)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: copy.routes.history }),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.history.late)).toBeInTheDocument();
  });
});
