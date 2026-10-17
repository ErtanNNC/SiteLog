import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import type { PreferencesResponse } from '@sitelog/shared/field-contract.ts';
import type * as PushLib from '@/lib/push';
import { fakeRoutes, renderApp } from '@/test/render';

// The installed app with the Push API, on a phone that refused notifications before.
vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof PushLib>()),
  pushSupported: () => true,
  pushBlocked: () => true,
}));

const PREFS: PreferencesResponse = {
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
  push: { offered: true, on: false },
  placesCalls: false,
  noCallsUntil: null,
};

describe('Settings: Notifications blocked before (W2-14 review)', () => {
  it('shows how to allow them as a status, not an alert on arrival', async () => {
    const s = UI_RESOURCES.en.field.settings;
    renderApp('/settings', {
      routes: fakeRoutes({ preferences: vi.fn().mockResolvedValue(PREFS) }),
    });
    const line = await screen.findByText(s.push.blocked);
    expect(line).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
