import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, Suspense, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { captureError } from '@/lib/sentry';
import { AppErrorBoundary } from './AppErrorBoundary';

vi.mock('@/lib/sentry', () => ({ captureError: vi.fn(() => 'evt-123') }));

let broken = false;
/** A page that throws while rendering as long as `broken` is set. */
function Flaky() {
  const [label] = useState('Overview loaded');
  if (broken) throw new Error('render exploded');
  return <p>{label}</p>;
}

describe('AppErrorBoundary (§11.5)', () => {
  beforeEach(() => {
    // React logs caught render errors; keep the test output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    broken = false;
  });

  it('renders the app while nothing throws', () => {
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('Overview loaded')).toBeInTheDocument();
    expect(captureError).not.toHaveBeenCalled();
  });

  it('shows the fallback, reports to Sentry and retries into the app', async () => {
    broken = true;
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    const heading = await screen.findByRole('heading', { level: 1, name: 'Something went wrong' });
    expect(heading).toHaveFocus();
    expect(
      screen.getByText('SiteLog hit an unexpected error. Try again, or sign out and sign back in.'),
    ).toBeInTheDocument();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'render exploded' }),
      expect.objectContaining({ boundary: 'app' }),
    );
    expect(screen.getByText('Error ID evt-123')).toBeInTheDocument();

    broken = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Overview loaded')).toBeInTheDocument();
    expect(screen.queryByTestId('app-error')).not.toBeInTheDocument();
  });

  it('reloads the page when a lazy page failed to load: lazy() keeps the rejected import', async () => {
    let attempts = 0;
    const Page = lazy(() => {
      attempts += 1;
      return Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    });
    const onReload = vi.fn();
    render(
      <AppErrorBoundary onReload={onReload}>
        <Suspense fallback={<p>Loading page</p>}>
          <Page />
        </Suspense>
      </AppErrorBoundary>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    // Re-rendering would only throw the cached rejection again; the fallback stays until reload.
    expect(screen.getByTestId('app-error')).toBeInTheDocument();
    expect(attempts).toBe(1);
  });

  it('re-mounts without a reload for any other error', async () => {
    broken = true;
    const onReload = vi.fn();
    render(
      <AppErrorBoundary onReload={onReload}>
        <Flaky />
      </AppErrorBoundary>,
    );
    broken = false;
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(onReload).not.toHaveBeenCalled();
    expect(screen.getByText('Overview loaded')).toBeInTheDocument();
  });

  it('signs out from the fallback', async () => {
    broken = true;
    const onSignOut = vi.fn(async () => {});
    render(
      <AppErrorBoundary onSignOut={onSignOut}>
        <Flaky />
      </AppErrorBoundary>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('speaks Turkish when the panel does', async () => {
    await act(() => i18n.changeLanguage('tr'));
    broken = true;
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bir sorun oluştu' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tekrar dene' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Çıkış yap' })).toBeInTheDocument();
    expect(screen.getByText('Hata kimliği evt-123')).toBeInTheDocument();
  });
});
