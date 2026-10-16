import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { i18n } from '@/i18n/i18n';
import { apiError, fakeRoutes, renderApp, US_COUNTRY } from '@/test/render';

/** `/r/OLD` answered 410 `link_expired`: the link check opens `/expired` with the code. */
function expiredRoutes(
  overrides: Parameters<typeof fakeRoutes>[0] = {},
  voice: string | null = null,
) {
  return fakeRoutes({
    resolve: vi.fn().mockRejectedValue(
      apiError(410, 'link_expired', {
        locale: 'en-US',
        country: { ...US_COUNTRY, voiceNumber: voice },
      }),
    ),
    ...overrides,
  });
}

afterEach(async () => {
  await act(() => i18n.changeLanguage('en'));
});

describe('Expired link (F16, §9.3; W2-03)', () => {
  it('sends today’s link to the phone on file, and never shows it', async () => {
    const routes = expiredRoutes({
      expiredDailyLink: vi.fn().mockResolvedValue({ sent: true, channel: 'sms' }),
    });
    renderApp('/r/OLD', { session: null, routes });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link has expired' }),
    ).toBeInTheDocument();
    // No voice number in the pack: no call option.
    expect(screen.queryByRole('link', { name: /call/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send me today’s link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sent. Open today’s link in the message we just sent you.',
    );
    expect(routes.expiredDailyLink).toHaveBeenCalledWith('OLD');
    expect(screen.queryByRole('button', { name: 'Send me today’s link' })).toBeNull();
  });

  it('offers Call {number} only when the pack has a voice number', async () => {
    renderApp('/r/OLD', { session: null, routes: expiredRoutes({}, '+18885550100') });
    const call = await screen.findByRole('link', { name: /^or call .*888.*555.*0100/ });
    expect(call).toHaveAttribute('href', 'tel:+18885550100');
  });

  it.each([
    ['site_paused', 'This site is paused in SiteLog. Ask the office to resume it.'],
    ['not_working_day', 'Today is not a working day for this site, so there is no link for today.'],
    ['no_consent', 'You turned off texts, so we can’t text you the link. Ask the office for it.'],
  ] as const)('says why nothing was sent: %s', async (reason, text) => {
    const routes = expiredRoutes({
      expiredDailyLink: vi.fn().mockResolvedValue({ sent: false, reason }),
    });
    renderApp('/r/OLD', { session: null, routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Send me today’s link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(text);
  });

  it('explains the limit and a lost connection, and the button stays', async () => {
    const routes = expiredRoutes({
      expiredDailyLink: vi
        .fn()
        .mockRejectedValueOnce(apiError(429, 'rate_limited', { retryAfter: 600 }))
        .mockRejectedValueOnce(new TypeError('Failed to fetch')),
    });
    renderApp('/r/OLD', { session: null, routes });
    const send = await screen.findByRole('button', { name: 'Send me today’s link' });
    fireEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You asked a few times already. Try again in 10 min.',
    );
    fireEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('No connection.');
  });

  it.each(['es', 'tr'] as const)('has its copy in %s', async (lng) => {
    const locale = lng === 'es' ? 'es-US' : 'tr-TR';
    const routes = fakeRoutes({
      resolve: vi
        .fn()
        .mockRejectedValue(apiError(410, 'link_expired', { locale, country: US_COUNTRY })),
    });
    renderApp('/r/OLD', { session: null, routes });
    const copy = UI_RESOURCES[lng].field.expired;
    expect(await screen.findByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.send })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe(lng);
  });
});
