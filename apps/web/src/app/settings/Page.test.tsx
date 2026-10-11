import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import SettingsPage from './Page';

const opts = (store: DemoStore, section = 'reports') => ({
  route: `/settings/${section}`,
  path: '/settings/:section',
  store,
});

describe('SettingsPage (demo data)', () => {
  it('renders the reports section from org_settings with Save disabled until dirty, then persists', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store));
    expect(await screen.findByRole('heading', { name: 'Reports & reminders' })).toBeInTheDocument();
    expect(screen.getByLabelText('Report deadline')).toHaveValue('17:30');
    const save = screen.getByTestId('save-settings');
    expect(save).toBeDisabled();
    const ladder = screen.getByTestId('ladder');
    expect(within(ladder).getByTestId('stage-headsUp')).toHaveTextContent('at 16:55');
    expect(within(ladder).getByTestId('stage-missing')).toHaveTextContent('at 19:00');

    await userEvent.click(within(ladder).getByRole('switch', { name: 'Reminder 2' }));
    await userEvent.click(within(screen.getByTestId('working-days')).getByRole('button', { name: 'Sat' }));
    await userEvent.click(screen.getByRole('radio', { name: 'File automatically after 15 minutes' }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(store.data.settings.reminder2_enabled).toBe(false);
    expect(store.data.settings.working_days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(store.data.settings.filing_mode).toBe('auto_15min');
    expect(store.data.settings.default_deadline).toBe('17:30:00');
    expect(store.data.audit.at(-1)!.action).toBe('settings.updated');
  });

  it('guards navigation while dirty and lets the user leave', async () => {
    const store = new DemoStore();
    renderWithProviders(
      <>
        <a href="/hours">Elsewhere</a>
        <SettingsPage />
      </>,
      opts(store),
    );
    await screen.findByRole('heading', { name: 'Reports & reminders' });
    await userEvent.click(screen.getByRole('switch', { name: 'Sign-off required' }));
    await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Unsaved changes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Reports & reminders' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Reports & reminders' })).not.toBeInTheDocument(),
    );
    expect(store.data.settings.signoff_required).toBe(true);
  });

  it('edits recipients per site and applies one list to all sites', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'recipients'));
    expect(await screen.findByRole('heading', { name: 'Recipients' })).toBeInTheDocument();
    const cards = screen.getAllByTestId('site-recipients');
    expect(cards).toHaveLength(6);
    const riverside = cards.find((c) => c.dataset.site === 'Riverside Lofts — Block B')!;
    await userEvent.type(within(riverside).getByRole('textbox'), 'owner@riverside.example');
    await userEvent.click(within(riverside).getByRole('button', { name: /^Add email · Riverside/ }));
    expect(within(riverside).getByText('owner@riverside.example')).toBeInTheDocument();
    await userEvent.click(within(riverside).getByRole('button', { name: /^Apply to all sites · Riverside/ }));
    const elm = cards.find((c) => c.dataset.site === 'Elm St. Townhomes')!;
    expect(within(elm).getByText('owner@riverside.example')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('save-settings'));
    await waitFor(() => expect(screen.getByTestId('save-settings')).toBeDisabled());
    const elmSite = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
    expect(store.data.recipients.filter((r) => r.site_id === elmSite.id).map((r) => r.email)).toContain(
      'owner@riverside.example',
    );
  });

  it('shows the PDF preview with the paper size and letterhead lines', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'pdf'));
    expect(await screen.findByRole('heading', { name: 'PDF template' })).toBeInTheDocument();
    const preview = screen.getByTestId('pdf-preview');
    expect(preview).toHaveAttribute('data-paper', 'letter');
    expect(preview).toHaveTextContent('2101 W Fulton St, Chicago, IL 60612');
    await userEvent.click(screen.getByRole('radio', { name: 'A4' }));
    expect(preview).toHaveAttribute('data-paper', 'a4');
    await userEvent.click(screen.getByTestId('save-settings'));
    await waitFor(() => expect(store.data.settings.pdf_paper).toBe('a4'));
  });
});
