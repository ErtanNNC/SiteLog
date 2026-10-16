import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResolveResponse } from '@sitelog/shared/field-contract.ts';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { i18n } from '@/i18n/i18n';
import { MemoryQueueStore } from '@/queue/store';
import { UploadQueue } from '@/queue/queue';
import type { StoredUpload } from '@/queue/types';
import { apiError, fakeRoutes, renderApp, SITE, todayResponse, US_COUNTRY } from '@/test/render';

function resolved(patch: Partial<ResolveResponse> = {}): ResolveResponse {
  return {
    reporter: {
      name: 'Marco Ruiz',
      firstName: 'Marco',
      locale: 'en-US',
      contactPref: 'link',
      status: 'invited',
    },
    org: { name: 'Kestrel Build Group' },
    link: { kind: 'personal', siteId: null, reportDate: null, expiresAt: null },
    needsDeviceCheck: true,
    needsConsent: true,
    sites: [],
    country: US_COUNTRY,
    ...patch,
  };
}

describe('/r/:code (F4: resolve → device check → welcome → Today)', () => {
  it('runs the first open end to end', async () => {
    const routes = fakeRoutes({
      resolve: vi
        .fn()
        .mockResolvedValueOnce(resolved())
        .mockResolvedValue(resolved({ needsDeviceCheck: false, sites: [SITE] })),
      sendCode: vi.fn().mockResolvedValue({ sent: true, expiresAt: '2026-10-09T20:10:00Z' }),
      verify: vi.fn().mockResolvedValue({ verified: true, needsConsent: true }),
      consent: vi.fn().mockResolvedValue({
        consents: ['data_processing', 'recording', 'sms'],
        status: 'active',
        contactPref: 'link',
        locale: 'en-US',
      }),
      today: vi.fn().mockResolvedValue(todayResponse()),
    });
    renderApp('/r/k7q2mx', { session: null, routes });

    // Device check (new phone): the code is asked for, then typed (or auto-filled) and checked.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Is this Marco Ruiz’s phone?' }),
    ).toBeInTheDocument();
    expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, text me a code' }));
    const input = await screen.findByLabelText('6-digit code');
    expect(routes.sendCode).toHaveBeenCalledWith('K7Q2MX');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('maxlength', '6');
    expect(screen.getByRole('status')).toHaveTextContent('Code sent. It expires in 10 minutes.');
    fireEvent.change(input, { target: { value: '48 29 13' } });
    await waitFor(() => expect(routes.verify).toHaveBeenCalledWith('K7Q2MX', '482913'));

    // Welcome & consent (first open): the notice names the company; the required box gates Continue.
    const welcome = await screen.findByRole('heading', {
      level: 1,
      name: 'Hi Marco — one minute before your first report',
    });
    // The code field is gone: focus is on the new screen's heading.
    expect(welcome).toHaveFocus();
    expect(screen.getByText(/daily report for Kestrel Build Group/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Privacy notice' })).toBeNull();
    // Upper-cased by CSS (`text-transform`, locale-aware through <html lang>), as on Field-02.
    expect(screen.getByText('Kestrel Build Group · Riverside Lofts — Block B')).toHaveClass(
      'uppercase',
    );
    const required = screen.getByRole('checkbox', {
      name: 'I agree to the recording and processing of my reports',
    });
    expect(required).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Text me the daily report link' })).toBeChecked();
    // The pack lists no WhatsApp: no opt-in (W2-15).
    expect(screen.queryByRole('checkbox', { name: 'Message me on WhatsApp' })).toBeNull();
    // No automated calls before M8 (spec §19 Q33, Q51): the auto_call box is not asked.
    expect(screen.queryByRole('checkbox', { name: /Call me at report time/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /Text link/ })).toBeChecked();
    const languages = screen.getByRole('radiogroup', { name: 'Language' });
    expect(languages).toHaveTextContent('English');
    expect(languages).toHaveTextContent('Español');
    expect(languages).not.toHaveTextContent('Türkçe');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tick the first box to continue.');
    expect(routes.consent).not.toHaveBeenCalled();
    fireEvent.click(required);
    fireEvent.click(screen.getByRole('radio', { name: /Phone call/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(routes.consent).toHaveBeenCalledWith('K7Q2MX', {
        types: ['recording', 'data_processing', 'sms'],
        textVersion: 'field.consent.v1',
        contactPref: 'call',
        locale: 'en-US',
      }),
    );

    // F4's optional test recording (W2-13), first open only; skipped here.
    const test = await screen.findByRole('heading', { level: 1, name: 'Try a 20-second test' });
    expect(test).toHaveFocus();
    expect(screen.getByText('Say anything — nothing gets filed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip the test' }));

    // Today.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Say it in any order' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Not sent yet')).toBeInTheDocument();
  });

  it('sends again, under this link, the clips a dead link or an unverified phone kept back (cold open)', async () => {
    const store = new MemoryQueueStore();
    const stored = (id: string, patch: Partial<StoredUpload>): StoredUpload => ({
      id,
      code: 'OLD123',
      kind: 'audio',
      mime: 'audio/webm',
      bytes: 3,
      siteId: SITE.id,
      date: '2026-10-09',
      recordedAt: null,
      createdAt: 1,
      status: 'failed',
      attempts: 1,
      nextAt: 0,
      uploadId: null,
      signedUrl: null,
      putDone: false,
      error: 'link_expired',
      result: null,
      holdId: null,
      doneAt: null,
      ...patch,
    });
    await store.add(stored('expired', {}), new Blob(['abc']));
    await store.add(stored('filed', { error: 'report_filed', createdAt: 2 }), new Blob(['d']));
    const sent: string[] = [];
    const queue = new UploadQueue({
      store,
      upload: async (item) => {
        sent.push(`${item.id}:${item.code}`);
        return {
          ok: true,
          result: {
            reportId: 'r1',
            reportNo: 'RL-2041-0188',
            reportStatus: 'processing',
            created: true,
            alreadyComplete: false,
          },
        };
      },
      locks: null,
    });
    const routes = fakeRoutes({
      resolve: vi
        .fn()
        .mockResolvedValue(
          resolved({ needsDeviceCheck: false, needsConsent: false, sites: [SITE] }),
        ),
      today: vi.fn().mockResolvedValue(todayResponse()),
    });
    renderApp('/r/K7Q2MX', { session: null, routes, queue });
    await waitFor(() => expect(sent).toEqual(['expired:K7Q2MX']));
    expect(queue.get('filed')?.status).toBe('failed');
  });

  it('links the pack’s privacy notice only when it names one, and asks no auto_call consent before M8', async () => {
    const routes = fakeRoutes({
      resolve: vi.fn().mockResolvedValue(
        resolved({
          needsDeviceCheck: false,
          sites: [SITE],
          country: {
            ...US_COUNTRY,
            voiceNumber: '+15550142290' as never,
            legalKeys: { privacyNotice: 'US.privacy_notice.v1', consent: 'US.consent.v1' },
          },
        }),
      ),
      consent: vi.fn().mockResolvedValue({
        consents: [],
        status: 'active',
        contactPref: 'link',
        locale: 'en-US',
      }),
      today: vi.fn().mockResolvedValue(todayResponse()),
    });
    renderApp('/r/K7Q2MX', { session: null, routes });
    const privacy = await screen.findByRole('link', { name: 'Privacy notice' });
    expect(privacy).toHaveAttribute('href', '/legal/US.privacy_notice.v1');
    // A voice number alone is inbound calling (Talk now / Call {number}), not automated calls.
    expect(screen.queryByRole('checkbox', { name: /Call me at report time/ })).toBeNull();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I agree to the recording and processing of my reports',
      }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Text me the daily report link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The pack's consent key is the text version stored (spec §19 Q28); SMS unticked is not sent.
    await waitFor(() =>
      expect(routes.consent).toHaveBeenCalledWith('K7Q2MX', {
        types: ['recording', 'data_processing'],
        textVersion: 'US.consent.v1',
        contactPref: 'link',
        locale: 'en-US',
      }),
    );
  });

  it('offers Message me on WhatsApp, unticked, only where the pack lists it (W2-15, §19 Q25)', async () => {
    const routes = fakeRoutes({
      resolve: vi.fn().mockResolvedValue(
        resolved({
          needsDeviceCheck: false,
          sites: [SITE],
          country: { ...US_COUNTRY, messageChannels: ['push', 'sms', 'whatsapp'] },
        }),
      ),
      consent: vi.fn().mockResolvedValue({
        consents: [],
        status: 'active',
        contactPref: 'link',
        locale: 'en-US',
      }),
      today: vi.fn().mockResolvedValue(todayResponse()),
    });
    renderApp('/r/K7Q2MX', { session: null, routes });
    const wa = await screen.findByRole('checkbox', { name: 'Message me on WhatsApp' });
    expect(wa).not.toBeChecked();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I agree to the recording and processing of my reports',
      }),
    );
    fireEvent.click(wa);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(routes.consent).toHaveBeenCalledWith('K7Q2MX', {
        types: ['recording', 'data_processing', 'sms', 'whatsapp'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: 'en-US',
      }),
    );
  });

  it('skips the device check and the welcome on a verified, consented phone', async () => {
    const routes = fakeRoutes({
      resolve: vi
        .fn()
        .mockResolvedValue(
          resolved({ needsDeviceCheck: false, needsConsent: false, sites: [SITE] }),
        ),
      today: vi.fn().mockResolvedValue(todayResponse()),
    });
    renderApp('/r/K7Q2MX', { session: null, routes });
    expect(await screen.findByText('Not sent yet')).toBeInTheDocument();
    expect(routes.sendCode).not.toHaveBeenCalled();
  });

  it('speaks the reporter’s language once the link is resolved, and offers the pack’s locales', async () => {
    const routes = fakeRoutes({
      resolve: vi
        .fn()
        .mockResolvedValue(resolved({ reporter: { ...resolved().reporter, locale: 'es-US' } })),
    });
    renderApp('/r/K7Q2MX', { session: null, routes });
    expect(
      await screen.findByRole('heading', { level: 1, name: '¿Este es el teléfono de Marco Ruiz?' }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('es');
    await act(() => i18n.changeLanguage('en'));
  });

  it('shows the code errors with the tries left and the resend wait', async () => {
    const routes = fakeRoutes({
      resolve: vi.fn().mockResolvedValue(resolved()),
      sendCode: vi
        .fn()
        .mockResolvedValueOnce({ sent: true, expiresAt: 'x' })
        .mockRejectedValueOnce(apiError(429, 'rate_limited', { retryAfter: 1800 })),
      verify: vi
        .fn()
        .mockRejectedValueOnce(apiError(400, 'code_invalid', { details: { attemptsLeft: 3 } })),
    });
    renderApp('/r/K7Q2MX', { session: null, routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, text me a code' }));
    const input = await screen.findByLabelText('6-digit code');
    fireEvent.change(input, { target: { value: '000000' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code isn’t right. Tries left: 3.',
    );
    expect(input).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByText('You can ask for another code in 30 min')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send a new code' })).toBeNull();
  });

  it('explains a link field-api refuses, in the reporter’s language for an expired one', async () => {
    const routes = fakeRoutes({
      resolve: vi.fn().mockRejectedValue(apiError(404, 'link_not_found')),
    });
    const { unmount } = renderApp('/r/NOPE', { session: null, routes });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Link not found' }),
    ).toBeInTheDocument();
    unmount();
    const expired = fakeRoutes({
      resolve: vi
        .fn()
        .mockRejectedValue(apiError(410, 'link_expired', { locale: 'tr-TR', country: US_COUNTRY })),
    });
    renderApp('/r/OLD', { session: null, routes: expired });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: UI_RESOURCES.tr.field.expired.title,
      }),
    ).toBeInTheDocument();
    await act(() => i18n.changeLanguage('en'));
  });

  it.each(['es', 'tr'] as const)('has the device and welcome copy in %s', async (lng) => {
    await act(() => i18n.changeLanguage(lng));
    const copy = UI_RESOURCES[lng].field;
    const routes = fakeRoutes({
      resolve: vi.fn().mockResolvedValue(
        resolved({
          reporter: { ...resolved().reporter, locale: lng === 'es' ? 'es-US' : 'tr-TR' },
        }),
      ),
      sendCode: vi.fn().mockResolvedValue({ sent: true, expiresAt: 'x' }),
    });
    renderApp('/r/K7Q2MX', { session: null, routes });
    expect(await screen.findByRole('button', { name: copy.device.send })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.device.send }));
    expect(await screen.findByLabelText(copy.device.codeLabel)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.device.verify })).toBeDisabled();
  });
});
