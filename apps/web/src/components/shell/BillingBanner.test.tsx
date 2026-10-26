import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuditLogRow } from '@sitelog/shared/db/types.ts';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
import { renderWithProviders } from '@/test/render';
import { BillingBanner } from './BillingBanner';

/**
 * W4-10 (F23 "past-due banner", spec §19 Q235): a real US org whose 14-day trial ended yesterday
 * without a card shows the banner on every page for admins, with the day reminders and calls stop;
 * after its grace days it says they are paused. Demo time: Fri Oct 9 2026, 19:05 Chicago.
 */

/** A real (not demo) Kestrel-shaped org with no subscription, its trial ending at `trialEnd`. */
function lapsedOrg(trialEnd: string, patch: Record<string, unknown> = {}) {
  const d = kestrelDemo();
  return new DemoStore({
    ...d,
    org: {
      ...d.org,
      is_demo: false,
      billing_status: 'trialing',
      billing_customer_id: null,
      billing_subscription_id: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      trial_ends_at: trialEnd,
      ...patch,
    },
  });
}

function render(store: DemoStore, as: 'admin' | 'pm' = 'admin') {
  const u = demoUserFor(as);
  const source = new DemoSource(store, { id: u.id, email: u.email, name: u.name, role: u.role });
  return renderWithProviders(<BillingBanner />, { as, source });
}

describe('BillingBanner', () => {
  it('a trial that ended yesterday: the day it ended and the day reminders and calls stop', async () => {
    render(lapsedOrg('2026-10-08T17:00:00.000Z'));
    const banner = await screen.findByTestId('billing-banner');
    expect(banner).toHaveAttribute('data-kind', 'trial_ended');
    expect(banner).toHaveTextContent(
      'Your free trial ended on Thu, Oct 8, 2026. Add payment details by Thu, Oct 22, 2026 to keep reminders and calls on.',
    );
    expect(screen.getByRole('link', { name: 'Open Billing' })).toHaveAttribute('href', '/billing');
  });

  it('after the grace days: reminders and calls are paused', async () => {
    render(lapsedOrg('2026-09-20T17:00:00.000Z'));
    expect(await screen.findByTestId('billing-banner')).toHaveTextContent(
      'Reminders and calls are paused: billing is past due.',
    );
  });

  it('a failed payment: past due from the audited change, in Turkish too', async () => {
    const store = lapsedOrg('2026-09-01T17:00:00.000Z', {
      billing_status: 'past_due',
      billing_subscription_id: 'sub_1',
    });
    store.data.audit.push({
      id: 99_001,
      org_id: store.data.org.id,
      actor_type: 'system',
      actor_id: null,
      action: 'billing.status_changed',
      entity: 'org',
      entity_id: store.data.org.id,
      diff: { from: 'active', to: 'past_due' },
      created_at: '2026-10-05T12:00:00.000Z',
    } as AuditLogRow);
    await act(() => i18n.changeLanguage('tr'));
    try {
      render(store);
      const banner = await screen.findByTestId('billing-banner');
      expect(banner).toHaveAttribute('data-kind', 'past_due');
      expect(banner).toHaveTextContent(
        'Ödemeniz gecikti. Hatırlatmaların ve aramaların sürmesi için ödeme yöntemini Pzt, 19 Eki 2026 tarihine kadar güncelleyin.',
      );
      expect(screen.getByRole('link', { name: 'Faturalandırmayı aç' })).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('nothing for a pm, a demo org, a manual org on trial or an org that pays', async () => {
    render(lapsedOrg('2026-10-08T17:00:00.000Z'), 'pm');
    for (const store of [
      lapsedOrg('2026-10-08T17:00:00.000Z', { is_demo: true }),
      lapsedOrg('2026-10-08T17:00:00.000Z', { billing_provider: 'manual' }),
      new DemoStore(),
    ]) {
      render(store);
    }
    // Let the queries settle: none renders a banner.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByTestId('billing-banner')).toBeNull();
  });
});
