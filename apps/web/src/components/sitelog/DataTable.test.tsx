import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DataTable, type Column } from './DataTable';

interface Row {
  id: string;
  company: string;
  hours: number;
}

const columns: Column<Row>[] = [
  { key: 'company', header: 'Company', cell: (r) => r.company },
  { key: 'hours', header: 'Hours', numeric: true, cell: (r) => r.hours },
];

describe('DataTable', () => {
  it('renders a sticky header, mono right-aligned numbers and row links', () => {
    render(
      <MemoryRouter>
        <DataTable
          columns={columns}
          rows={[{ id: 'a', company: 'Apex Concrete', hours: 472 }]}
          rowKey={(r) => r.id}
          rowHref={(r) => `/companies/${r.id}`}
          rowLabel={(r) => r.company}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('columnheader', { name: 'Company' }).closest('thead')).toHaveClass(
      'sticky',
    );
    expect(screen.getByText('472')).toHaveClass('font-mono', 'text-right');
    expect(screen.getByRole('link', { name: 'Open Apex Concrete' })).toBeInTheDocument();
  });

  it('shows the empty state when there are no rows', () => {
    render(
      <MemoryRouter>
        <DataTable
          columns={columns}
          rows={[]}
          rowKey={(r) => r.id}
          empty={{ title: 'No hours reported this week.' }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('No hours reported this week.');
  });
});
