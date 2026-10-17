import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { DemoStore } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
import { renderWithProviders } from '@/test/render';
import GlossaryPage from './Page';

/** The demo org with a Turkish crew word waiting for review (W3-08, spec §19 Q138: a company). */
function withTurkishTerm(): DemoStore {
  const d = kestrelDemo();
  return new DemoStore({
    ...d,
    glossary: [
      ...d.glossary,
      {
        id: 'term-demirci',
        org_id: d.org.id,
        scope_site_id: null,
        scope_reporter_id: null,
        heard: 'demirci ekibi',
        official: 'Donatı ekibi',
        language: 'tr',
        kind: 'company',
        company_id: null,
        status: 'needs_review',
        times_heard: 1,
        first_seen_at: d.now,
        last_seen_at: d.now,
      },
    ],
  });
}

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

  it('changes and rejects a built-in starter term from its row (W4-08, §19 Q238)', async () => {
    const store = new DemoStore();
    renderWithProviders(<GlossaryPage />, { route: '/glossary', store });
    const table = await screen.findByRole('table', { name: 'All terms' });
    const iron = within(table).getByText('“the iron”').closest('tr')!;
    expect(within(iron).getByText('Built-in')).toBeInTheDocument();
    // SiteLog's global terms (org_id null) are read-only: no row actions.
    const llovio = within(table).getByText('“llovió”').closest('tr')!;
    expect(within(llovio).queryByRole('button')).not.toBeInTheDocument();

    await userEvent.click(within(iron).getByRole('button', { name: 'Change “the iron”' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change built-in term' });
    const input = within(dialog).getByLabelText('Official term');
    expect(input).toHaveValue('Reinforcing steel (rebar)');
    await userEvent.clear(input);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the official term.');
    await userEvent.type(input, 'Rebar');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(store.data.glossary.find((t) => t.heard === 'the iron')).toMatchObject({
      status: 'confirmed',
      official: 'Rebar',
    });
    const changed = within(table).getByText('“the iron”').closest('tr')!;
    expect(within(changed).getByText('Confirmed')).toBeInTheDocument();
    expect(within(changed).queryByRole('button')).not.toBeInTheDocument();

    const ppe = within(table).getByText('“PPE”').closest('tr')!;
    await userEvent.click(within(ppe).getByRole('button', { name: 'Reject “PPE”' }));
    await waitFor(() => expect(within(table).queryByText('“PPE”')).not.toBeInTheDocument());
    expect(store.data.glossary.find((t) => t.heard === 'PPE')!.status).toBe('rejected');
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'glossary.reviewed',
      diff: expect.objectContaining({ action: 'reject' }),
    });
  });

  it('reads in Turkish: approving a Turkish crew word puts it in the Turkish tab', async () => {
    await act(() => i18n.changeLanguage('tr'));
    try {
      const store = withTurkishTerm();
      renderWithProviders(<GlossaryPage />, { route: '/glossary', store });
      expect(await screen.findByRole('heading', { name: 'Şantiye sözlüğü' })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Bu hafta yeni · 4 inceleme' }),
      ).toBeInTheDocument();
      const queue = screen.getByTestId('review-queue');
      expect(queue).toHaveTextContent('4 kez duyuldu · Oakmont');
      const card = within(queue)
        .getByText('“demirci ekibi”')
        .closest<HTMLElement>('[data-testid="review-card"]')!;
      expect(card).toHaveTextContent('1 kez duyuldu · tr');
      expect(card).toHaveTextContent('Donatı ekibi');

      const table = screen.getByRole('table', { name: 'Tüm terimler' });
      await userEvent.click(screen.getByRole('tab', { name: 'Türkçe' }));
      expect(within(table).queryByText('“demirci ekibi”')).toBeInTheDocument();
      expect(within(table).queryByText('“the deck”')).not.toBeInTheDocument();
      expect(within(table).getByText('İnceleme gerekli')).toBeInTheDocument();

      await userEvent.click(within(card).getByRole('button', { name: 'Taşeron olarak ekle' }));
      await waitFor(() =>
        expect(within(queue).queryByText('“demirci ekibi”')).not.toBeInTheDocument(),
      );
      expect(store.data.glossary.find((t) => t.heard === 'demirci ekibi')).toMatchObject({
        status: 'confirmed',
        kind: 'company',
        language: 'tr',
      });
      const row = within(table).getByText('“demirci ekibi”').closest('tr')!;
      expect(within(row).getByText('Doğrulandı')).toBeInTheDocument();
      expect(store.data.audit.at(-1)).toMatchObject({ action: 'glossary.reviewed' });
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('adds a Turkish term in Turkish, and the same phrase again updates it', async () => {
    await act(() => i18n.changeLanguage('tr'));
    try {
      const store = new DemoStore();
      renderWithProviders(<GlossaryPage />, { route: '/glossary', store });
      const add = async (official: string) => {
        await userEvent.click(await screen.findByRole('button', { name: 'Terim ekle' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByLabelText('Dil')).toHaveTextContent('Türkçe');
        await userEvent.type(within(dialog).getByLabelText('Sahada duyulan'), 'döküm');
        await userEvent.type(within(dialog).getByLabelText('Raporlarda yazılışı'), official);
        await userEvent.click(within(dialog).getByRole('button', { name: 'Terim ekle' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      };
      await add('Döküm');
      await add('Beton dökümü');
      const rows = store.data.glossary.filter((t) => t.heard === 'döküm');
      expect(rows).toEqual([
        expect.objectContaining({ official: 'Beton dökümü', language: 'tr', status: 'confirmed' }),
      ]);
      await userEvent.click(screen.getByRole('tab', { name: 'Türkçe' }));
      const table = screen.getByRole('table', { name: 'Tüm terimler' });
      await waitFor(() => expect(within(table).getByText('“döküm”')).toBeInTheDocument());
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });
});
