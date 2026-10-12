import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  it('shows every nav item for an admin with the review / unknown-number / glossary badges', async () => {
    renderWithProviders(<Sidebar />, { as: 'admin' });
    for (const label of [
      'Overview',
      'Sites',
      'Reports',
      'Crew hours',
      'Weather & delays',
      'Team & numbers',
      'Site glossary',
      'Settings',
      'Billing',
      'Try it on WhatsApp',
    ]) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByLabelText('1 report to review')).toHaveTextContent('1'));
    expect(screen.getByLabelText('1 unknown number')).toHaveTextContent('1');
    expect(screen.getByLabelText('3 terms to review')).toHaveTextContent('3');
    expect(screen.getByLabelText('1 report to review')).toHaveClass('bg-level');
    expect(screen.getByLabelText('1 unknown number')).toHaveClass('bg-signal');
    expect(screen.getByTestId('demo-chip')).toHaveTextContent('Demo');
    expect(screen.getByText('+1 555 014 2290')).toBeInTheDocument();
  });

  it('hides Settings and Billing for a project manager and Team for ops-only pages', () => {
    renderWithProviders(<Sidebar />, { as: 'pm' });
    expect(screen.getByRole('link', { name: /Try it on WhatsApp/ })).toHaveAttribute(
      'href',
      '/try',
    );
    expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Billing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Team & numbers/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Site glossary/ })).toBeInTheDocument();
  });

  it('shows only Crew hours for accounts users', () => {
    renderWithProviders(<Sidebar />, { as: 'accounts' });
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent?.trim())).toEqual(['Crew hours']);
  });
});
