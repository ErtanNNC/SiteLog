import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
import { renderWithProviders } from '@/test/render';
import { TopBar } from './TopBar';

const noop = () => undefined;

async function openBell() {
  renderWithProviders(<TopBar onOpenMenu={noop} desktopSlotRef={noop} mobileSlotRef={noop} />, {
    as: 'admin',
  });
  await userEvent.click(await screen.findByTestId('notifications-bell'));
  return screen.findByRole('list', { name: /Notifications|Bildirimler/ });
}

describe('TopBar notifications', () => {
  it('shows each notice in English from its data', async () => {
    const list = await openBell();
    expect(await within(list).findByText('Elm St. Townhomes — no report')).toBeInTheDocument();
    expect(within(list).getByText('Priya didn’t answer 2 reminders.')).toBeInTheDocument();
    expect(within(list).getByText('Invoice gap: BrightLine Electric +16 h')).toBeInTheDocument();
    expect(within(list).getByText('Unknown number tried to report')).toBeInTheDocument();
    // A body someone said stays as stored.
    expect(
      within(list).getByText('+1 555 019 4410 · "this is Luis, covering Elm St. today…"'),
    ).toBeInTheDocument();
  });

  it('shows the same notices in Turkish when the panel speaks Turkish', async () => {
    await act(() => i18n.changeLanguage('tr'));
    try {
      const list = await openBell();
      expect(await within(list).findByText('Elm St. Townhomes: rapor yok')).toBeInTheDocument();
      expect(within(list).getByText('Priya 2 hatırlatmaya yanıt vermedi.')).toBeInTheDocument();
      expect(
        within(list).getByText('Fatura farkı: BrightLine Electric +16 sa'),
      ).toBeInTheDocument();
      expect(
        within(list).getByText('Bilinmeyen bir numara rapor göndermeye çalıştı'),
      ).toBeInTheDocument();
      expect(within(list).queryByText(/no report|needs review/)).not.toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('keeps the stored English of a notice without data', async () => {
    const store = new DemoStore();
    for (const n of store.data.notifications) n.data = null;
    store.data.notifications[0]!.title = 'Stored English title';
    await act(() => i18n.changeLanguage('tr'));
    try {
      renderWithProviders(<TopBar onOpenMenu={noop} desktopSlotRef={noop} mobileSlotRef={noop} />, {
        as: 'admin',
        store,
      });
      await userEvent.click(await screen.findByTestId('notifications-bell'));
      const list = await screen.findByRole('list', { name: 'Bildirimler' });
      expect(await within(list).findByText('Stored English title')).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });
});
