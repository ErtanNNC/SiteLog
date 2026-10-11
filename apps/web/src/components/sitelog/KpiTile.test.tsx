import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { KpiTile } from './KpiTile';

describe('KpiTile', () => {
  it('shows label, value, unit and a segmented bar with an accessible breakdown', () => {
    render(
      <KpiTile
        label="Reports in"
        value="4 / 6"
        segments={[
          { key: 'filed', label: 'Filed', value: 4, tone: 'filed' },
          { key: 'weather', label: 'Weather day', value: 1, tone: 'weather' },
          { key: 'missing', label: 'Missing', value: 1, tone: 'missing' },
          { key: 'awaiting', label: 'Awaiting', value: 0, tone: 'awaiting' },
        ]}
      />,
    );
    expect(screen.getByText('Reports in')).toBeInTheDocument();
    expect(screen.getByText('4 / 6')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Filed 4, Weather day 1, Missing 1, Awaiting 0/ }),
    ).toBeInTheDocument();
  });

  it('renders the dark variant with a link', () => {
    render(
      <MemoryRouter>
        <KpiTile
          dark
          label="Weather-affected sites"
          value={3}
          link={{ to: '/weather', label: 'Added to delay log' }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Added to delay log/ })).toHaveAttribute(
      'href',
      '/weather',
    );
    expect(screen.getByText('3').closest('div.on-dark')).toHaveClass('bg-asphalt');
  });
});
