import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import GlossaryPage from './Page';

describe('GlossaryPage (demo data)', () => {
  it('shows the review queue and the all-terms table with tabs and search', async () => {
    renderWithProviders(<GlossaryPage />, { route: '/glossary' });
    expect(await screen.findByRole('heading', { name: 'Site glossary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New this week · review 3' })).toBeInTheDocument();
    const queue = screen.getByTestId('review-queue');
    expect(within(queue).getAllByTestId('review-card')).toHaveLength(3);
    expect(queue).toHaveTextContent('Heard 4× · Oakmont');
    expect(queue).toHaveTextContent('“mud”');
    const company = within(queue)
      .getByText('“the Ridgeway crew”')
      .closest<HTMLElement>('[data-testid="review-card"]')!;
    expect(
      within(company).getByRole('button', { name: 'Add as subcontractor' }),
    ).toBeInTheDocument();
    expect(within(company).getByRole('button', { name: 'Map to…' })).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'All terms' });
    const deck = within(table).getByText('“the deck”').closest('tr')!;
    expect(deck).toHaveTextContent('Elevated concrete slab');
    expect(deck).toHaveTextContent('128');
    expect(within(deck).getByText('Confirmed')).toBeInTheDocument();
    const llovio = within(table).getByText('“llovió”').closest('tr')!;
    expect(within(llovio).getByText('Built-in')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Spanish' }));
    expect(within(table).queryByText('“the deck”')).not.toBeInTheDocument();
    expect(within(table).getByText('“llovió”')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'All' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search terms' }), 'punch');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('“punch”')).toBeInTheDocument();
  });

  it('approves, changes and rejects review terms', async () => {
    const store = new DemoStore();
    renderWithProviders(<GlossaryPage />, { route: '/glossary', store });
    const queue = await screen.findByTestId('review-queue');
    const mud = within(queue)
      .getByText('“mud”')
      .closest<HTMLElement>('[data-testid="review-card"]')!;
    await userEvent.click(within(mud).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(queue).queryByText('“mud”')).not.toBeInTheDocument());
    expect(store.data.glossary.find((t) => t.heard === 'mud')!.status).toBe('confirmed');

    const colado = within(queue)
      .getByText('“colado”')
      .closest<HTMLElement>('[data-testid="review-card"]')!;
    await userEvent.click(within(colado).getByRole('button', { name: 'Change' }));
    const input = within(colado).getByLabelText('Official term');
    await userEvent.clear(input);
    await userEvent.type(input, 'Concrete placement');
    await userEvent.click(within(colado).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(queue).queryByText('“colado”')).not.toBeInTheDocument());
    const term = store.data.glossary.find((t) => t.heard === 'colado')!;
    expect(term).toMatchObject({ status: 'confirmed', official: 'Concrete placement' });

    const ridge = within(queue)
      .getByText('“the Ridgeway crew”')
      .closest<HTMLElement>('[data-testid="review-card"]')!;
    await userEvent.click(within(ridge).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'New this week · review 0' })).toBeInTheDocument(),
    );
    expect(store.data.glossary.find((t) => t.heard === 'the Ridgeway crew')!.status).toBe(
      'rejected',
    );
    expect(screen.getByText('Nothing to review.')).toBeInTheDocument();
  });

  it('adds a company from the review queue and a term through the dialog', async () => {
    const store = new DemoStore();
    renderWithProviders(<GlossaryPage />, { route: '/glossary', store });
    const queue = await screen.findByTestId('review-queue');
    const ridge = within(queue)
      .getByText('“the Ridgeway crew”')
      .closest<HTMLElement>('[data-testid="review-card"]')!;
    await userEvent.click(within(ridge).getByRole('button', { name: 'Add as subcontractor' }));
    await waitFor(() =>
      expect(within(queue).queryByText('“the Ridgeway crew”')).not.toBeInTheDocument(),
    );
    expect(store.data.companies.find((c) => c.name === 'Ridgeway')!.status).toBe('confirmed');

    await userEvent.click(screen.getByRole('button', { name: 'Add term' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Heard in the field'), 'the slab');
    await userEvent.type(within(dialog).getByLabelText('Written in reports as'), 'Slab on grade');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(store.data.glossary.find((t) => t.heard === 'the slab')!.official).toBe('Slab on grade');
    const table = screen.getByRole('table', { name: 'All terms' });
    await waitFor(() => expect(within(table).getByText('“the slab”')).toBeInTheDocument());
  });
});
