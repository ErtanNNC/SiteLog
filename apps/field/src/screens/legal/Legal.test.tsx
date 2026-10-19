import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_DOCS } from '@sitelog/shared/copy/legal/index.ts';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import type { FieldCountryView } from '@sitelog/shared/countries.ts';
import type { PreferencesResponse, ResolveResponse } from '@sitelog/shared/field-contract.ts';
import { i18n } from '@/i18n/i18n';
import { demoSession, fakeRoutes, renderApp, SITE, todayResponse } from '@/test/render';

/**
 * W4-06 (§19 Q28, Q50): a test pack naming the three test-only keys (`ZZ.*`, placeholders: no real
 * pack can name them), in Turkish as the TR pack would.
 */
const KEYED_TR: FieldCountryView = {
  code: 'TR',
  voiceNumber: null,
  fieldLocales: ['tr-TR', 'en-US'],
  twoWaySms: false,
  messageChannels: ['sms'],
  legalKeys: {
    privacyNotice: 'ZZ.privacy_notice.v1',
    recordingNotice: 'ZZ.recording_notice.v1',
    consent: 'ZZ.consent.v1',
  },
};
const PRIVACY = LEGAL_DOCS['ZZ.privacy_notice.v1']!;
const TR = UI_RESOURCES.tr.field;

function resolved(patch: Partial<ResolveResponse> = {}): ResolveResponse {
  return {
    reporter: {
      name: 'Emre Yıldız',
      firstName: 'Emre',
      locale: 'tr-TR',
      contactPref: 'link',
      status: 'invited',
    },
    org: { name: 'Demir Yapı A.Ş.' },
    link: { kind: 'personal', siteId: null, reportDate: null, expiresAt: null },
    needsDeviceCheck: false,
    needsConsent: true,
    sites: [SITE],
    country: KEYED_TR,
    talkNow: false,
    placesCalls: false,
    ...patch,
  };
}

afterEach(async () => {
  await act(() => i18n.changeLanguage('en'));
});

describe('/legal/:key (W4-06, §19 Q50)', () => {
  it('Welcome in TR links the pack’s notice; the page shows it with its version; Back returns; the consent stores its key', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const routes = fakeRoutes({
      resolve: vi.fn().mockResolvedValue(resolved()),
      consent: vi.fn().mockResolvedValue({
        consents: [],
        status: 'active',
        contactPref: 'link',
        locale: 'tr-TR',
      }),
      today: vi.fn().mockResolvedValue(todayResponse()),
    });
    renderApp('/r/K7Q2MX', { session: null, routes });
    const link = await screen.findByRole('link', { name: TR.welcome.privacy });
    expect(link).toHaveAttribute('href', '/legal/ZZ.privacy_notice.v1');
    fireEvent.click(link);

    const tr = PRIVACY.texts.tr!;
    expect(await screen.findByRole('heading', { level: 1, name: tr.title })).toBeInTheDocument();
    expect(document.title).toBe(`${tr.title} · TalkOlog`);
    for (const paragraph of tr.body) expect(screen.getByText(paragraph)).toBeInTheDocument();
    expect(screen.getByText('Sürüm 1 · Cumartesi, 17 Ekim 2026')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveAttribute('lang', 'tr');

    fireEvent.click(screen.getByRole('button', { name: TR.legal.back }));
    fireEvent.click(await screen.findByRole('checkbox', { name: TR.welcome.consentRequired }));
    fireEvent.click(screen.getByRole('button', { name: TR.welcome.continue }));
    // The pack's consent key is the text version the consent row stores (§19 Q28).
    await waitFor(() =>
      expect(routes.consent).toHaveBeenCalledWith(
        'K7Q2MX',
        expect.objectContaining({ textVersion: 'ZZ.consent.v1', locale: 'tr-TR' }),
      ),
    );
  });

  it('opens on its own without a link, in the phone’s language; Back goes to Today', async () => {
    await act(() => i18n.changeLanguage('es'));
    renderApp('/legal/ZZ.privacy_notice.v1', { session: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: PRIVACY.texts.es!.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Versión 1 · /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: UI_RESOURCES.es.field.legal.back }));
    expect(
      await screen.findByRole('heading', { level: 1, name: UI_RESOURCES.es.field.link.none.title }),
    ).toBeInTheDocument();
  });

  it('an unknown key says so, with Back', async () => {
    renderApp('/legal/US.privacy_notice.v9', { session: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Text not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('Settings lists the pack’s texts by title, and none while the pack names none', async () => {
    const prefs: PreferencesResponse = {
      contactPref: 'link',
      locale: 'en-US',
      messageChannel: null,
      messageChannels: ['sms'],
      consents: [{ type: 'recording', held: true }],
      textsOptedOut: false,
      push: { offered: false, on: false },
      placesCalls: false,
      noCallsUntil: null,
    };
    const routes = fakeRoutes({ preferences: vi.fn().mockResolvedValue(prefs) });
    const view = renderApp('/settings', { routes });
    expect(await screen.findByText('What you agreed to')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Privacy and recording' })).toBeNull();
    view.unmount();

    renderApp('/settings', {
      routes,
      session: demoSession({ country: { ...KEYED_TR, fieldLocales: ['tr-TR', 'en-US'] } }),
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Privacy and recording' }),
    ).toBeInTheDocument();
    for (const key of ['ZZ.privacy_notice.v1', 'ZZ.recording_notice.v1', 'ZZ.consent.v1']) {
      expect(screen.getByRole('link', { name: LEGAL_DOCS[key]!.texts.en!.title })).toHaveAttribute(
        'href',
        `/legal/${key}`,
      );
    }
  });
});
