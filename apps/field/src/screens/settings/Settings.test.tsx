import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import type { PreferencesResponse, ResolveResponse } from '@sitelog/shared/field-contract.ts';
import { i18n } from '@/i18n/i18n';
import { US_COUNTRY, apiError, demoSession, fakeRoutes, renderApp } from '@/test/render';

/** Marco's settings: link, English, the pack's order, the three consents of Field-02. */
function prefs(patch: Partial<PreferencesResponse> = {}): PreferencesResponse {
  return {
    contactPref: 'link',
    locale: 'en-US',
    messageChannel: null,
    messageChannels: ['sms'],
    consents: [
      { type: 'sms', held: true },
      { type: 'recording', held: true },
      { type: 'data_processing', held: true },
    ],
    textsOptedOut: false,
    ...patch,
  };
}

/** Texts turned off (or never given): the texts consent reads Off. */
const TEXTS_OFF: PreferencesResponse['consents'] = [
  { type: 'sms', held: false },
  { type: 'recording', held: true },
  { type: 'data_processing', held: true },
];

describe('Settings (F15, §9.3; W2-02)', () => {
  it('shows the preference, the language, the consents with their state and sign out', async () => {
    const routes = fakeRoutes({ preferences: vi.fn().mockResolvedValue(prefs()) });
    renderApp('/settings', { routes });
    expect(await screen.findByText('Texts with my daily report link')).toBeInTheDocument();
    expect(routes.preferences).toHaveBeenCalledWith('K7Q2MX', expect.any(AbortSignal));
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(document.title).toBe('Settings · SiteLog');
    expect(screen.getByRole('radio', { name: /Text link/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Phone call/ })).not.toBeChecked();
    // One built channel: no channel choice (W2-14 / W2-15 add the others).
    expect(screen.queryByText('Where should we send your messages?')).toBeNull();
    const lang = screen.getByRole('radiogroup', { name: 'Language' });
    expect(within(lang).getByRole('radio', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      screen.getByText('Processing of my reports for Kestrel Build Group'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('On')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^Turn off: / })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Sign out this phone' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/today');
    // "Don't call me today" is M8's.
    expect(screen.queryByText(/call me today/i)).toBeNull();
  });

  it('saves the preference and the language as they change; the UI follows the language', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs()),
      updatePreferences: vi
        .fn()
        .mockResolvedValueOnce(prefs({ contactPref: 'call' }))
        .mockResolvedValueOnce(prefs({ contactPref: 'call', locale: 'es-US' })),
    });
    renderApp('/settings', { routes });
    fireEvent.click(await screen.findByRole('radio', { name: /Phone call/ }));
    expect(routes.updatePreferences).toHaveBeenCalledWith('K7Q2MX', { contactPref: 'call' });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Phone call/ })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Español' }));
    expect(routes.updatePreferences).toHaveBeenLastCalledWith('K7Q2MX', { locale: 'es-US' });
    const es = UI_RESOURCES.es.field.settings;
    expect(await screen.findByText(es.saved)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('es');
    await act(() => i18n.changeLanguage('en'));
  });

  it('offers the message channel only when the pack has more than one built channel', async () => {
    const routes = fakeRoutes({
      preferences: vi
        .fn()
        .mockResolvedValue(prefs({ messageChannels: ['whatsapp', 'sms'], messageChannel: null })),
      updatePreferences: vi
        .fn()
        .mockResolvedValue(prefs({ messageChannels: ['whatsapp', 'sms'], messageChannel: 'sms' })),
    });
    renderApp('/settings', { routes });
    const group = await screen.findByRole('group', { name: 'Where should we send your messages?' });
    expect(within(group).getByRole('radio', { name: /Best available/ })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Text message (SMS)' }));
    expect(routes.updatePreferences).toHaveBeenCalledWith('K7Q2MX', { messageChannel: 'sms' });
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: 'Text message (SMS)' })).toBeChecked(),
    );
  });

  it('turns texts off at once; the consent then reads Off', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs()),
      revokeConsent: vi.fn().mockResolvedValue(
        prefs({
          consents: [
            { type: 'sms', held: false },
            { type: 'recording', held: true },
            { type: 'data_processing', held: true },
          ],
        }),
      ),
    });
    renderApp('/settings', { routes });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Turn off: Texts with my daily report link' }),
    );
    expect(routes.revokeConsent).toHaveBeenCalledWith('K7Q2MX', { type: 'sms' });
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Turn off: / })).toHaveLength(2);
  });

  it('turns texts back on after the sheet that shows the wording again (§19 Q86)', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs({ consents: TEXTS_OFF })),
      grantConsent: vi.fn().mockResolvedValue(prefs()),
    });
    renderApp('/settings', { routes });
    const on = await screen.findByRole('button', {
      name: 'Turn on: Texts with my daily report link',
    });
    // Only texts: recording and processing come back through the Welcome screen.
    expect(screen.getAllByRole('button', { name: /^Turn on: / })).toHaveLength(1);
    fireEvent.click(on);
    const sheet = screen.getByRole('dialog', { name: 'Turn texts back on?' });
    expect(sheet).toHaveTextContent('Text me the daily report link');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Not now' }));
    expect(routes.grantConsent).not.toHaveBeenCalled();

    fireEvent.click(on);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Turn texts back on?' })).getByRole('button', {
        name: 'Turn on',
      }),
    );
    expect(routes.grantConsent).toHaveBeenCalledWith('K7Q2MX', {
      type: 'sms',
      textVersion: 'field.consent.v1',
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getAllByText('On')).toHaveLength(3);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends the pack’s consent key as the version when it names one', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs({ consents: TEXTS_OFF })),
      grantConsent: vi.fn().mockResolvedValue(prefs()),
    });
    renderApp('/settings', {
      routes,
      session: demoSession({ country: { ...US_COUNTRY, legalKeys: { consent: 'US.consent.v2' } } }),
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Turn on: / }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn on' }));
    expect(routes.grantConsent).toHaveBeenCalledWith('K7Q2MX', {
      type: 'sms',
      textVersion: 'US.consent.v2',
    });
  });

  it('a phone opted out by STOP gets no Turn on: text START on a two-way pack', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs({ consents: TEXTS_OFF, textsOptedOut: true })),
    });
    renderApp('/settings', { routes });
    expect(
      await screen.findByText(
        'You stopped our texts by replying STOP. To get them again, reply START to one of our texts.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Turn on: / })).toBeNull();
  });

  it('on a one-way pack the opted-out line sends them to the office (§19 Q94)', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs({ textsOptedOut: true })),
    });
    renderApp('/settings', {
      routes,
      session: demoSession({ country: { ...US_COUNTRY, twoWaySms: false } }),
    });
    expect(
      await screen.findByText('Texts to this phone are stopped. Ask the office.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reply START/)).toBeNull();
  });

  it('a STOP that came in meanwhile: the refusal reloads and shows the line', async () => {
    const routes = fakeRoutes({
      preferences: vi
        .fn()
        .mockResolvedValueOnce(prefs({ consents: TEXTS_OFF }))
        .mockResolvedValue(prefs({ consents: TEXTS_OFF, textsOptedOut: true })),
      grantConsent: vi.fn().mockRejectedValue(apiError(409, 'texts_opted_out')),
    });
    renderApp('/settings', { routes });
    fireEvent.click(await screen.findByRole('button', { name: /^Turn on: / }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText(/reply START to one of our texts/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(routes.preferences).toHaveBeenCalledTimes(2);
  });

  it('turns recording off only after the sheet that says reports stop, then back to the consent', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs()),
      revokeConsent: vi.fn().mockResolvedValue(prefs()),
      resolve: vi.fn(() => new Promise<ResolveResponse>(() => {})),
    });
    renderApp('/settings', { routes });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Turn off: Recording of my voice notes, photos and calls',
      }),
    );
    const sheet = screen.getByRole('dialog', { name: 'Stop reporting?' });
    expect(sheet).toHaveTextContent('your reports stop. The office is told.');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Keep it on' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(routes.revokeConsent).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Turn off: Recording of my voice notes, photos and calls',
      }),
    );
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn off' }));
    expect(routes.revokeConsent).toHaveBeenCalledWith('K7Q2MX', { type: 'recording' });
    // The link flow (`/r/:code`) resolves again: the Welcome & consent screen follows.
    await waitFor(() => expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX'));
  });

  it('signs out this phone after the confirm sheet and goes back through the device check', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs()),
      signOut: vi.fn().mockResolvedValue({ signedOut: true }),
      resolve: vi.fn(() => new Promise<ResolveResponse>(() => {})),
    });
    renderApp('/settings', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out this phone' }));
    const sheet = screen.getByRole('dialog', { name: 'Sign out this phone?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Sign out' }));
    expect(routes.signOut).toHaveBeenCalledWith('K7Q2MX');
    await waitFor(() => expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX'));
  });

  it('says so when a change fails, and keeps what was there', async () => {
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs()),
      updatePreferences: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });
    renderApp('/settings', { routes });
    fireEvent.click(await screen.findByRole('radio', { name: /Phone call/ }));
    expect(
      await screen.findByText('Couldn’t save. Check your signal and try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Text link/ })).toBeChecked();
  });

  it('sends a phone that is no longer verified back to the link flow; a failed load can retry', async () => {
    const relink = fakeRoutes({
      preferences: vi.fn().mockRejectedValue(apiError(401, 'device_unverified')),
      resolve: vi.fn(() => new Promise<ResolveResponse>(() => {})),
    });
    const { unmount } = renderApp('/settings', { routes: relink });
    await waitFor(() => expect(relink.resolve).toHaveBeenCalledWith('K7Q2MX'));
    unmount();

    const routes = fakeRoutes({
      preferences: vi
        .fn()
        .mockRejectedValueOnce(apiError(500, 'internal'))
        .mockResolvedValue(prefs()),
    });
    renderApp('/settings', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Texts with my daily report link')).toBeInTheDocument();
  });

  it('asks for the link when none is stored', () => {
    renderApp('/settings', { session: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Open your link' })).toBeInTheDocument();
  });

  it.each(['es', 'tr'] as const)('renders in %s', async (lng) => {
    await act(() => i18n.changeLanguage(lng));
    const copy = UI_RESOURCES[lng].field.settings;
    const routes = fakeRoutes({
      preferences: vi.fn().mockResolvedValue(prefs({ locale: lng === 'es' ? 'es-US' : 'tr-TR' })),
    });
    renderApp('/settings', {
      routes,
      session: demoSession({
        reporter: { ...demoSession().reporter, locale: lng === 'es' ? 'es-US' : 'tr-TR' },
      }),
    });
    expect(await screen.findByText(copy.consents.sms)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: UI_RESOURCES[lng].field.routes.settings }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.signOut })).toBeInTheDocument();
    expect(screen.getAllByText(copy.on)).toHaveLength(3);
    expect(copy.turnOn.length).toBeGreaterThan(0);
    expect(copy.turnOnSheet.title).not.toBe(UI_RESOURCES.en.field.settings.turnOnSheet.title);
    expect(copy.textsStopped.start).toContain('START');
    await act(() => i18n.changeLanguage('en'));
  });
});
