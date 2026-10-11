import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { monthDays } from '@/data/assemble';
import type { CalendarCell } from '@/data/types';
import { CalendarMonth } from './CalendarMonth';

function cellsFor(month: string): CalendarCell[] {
  return monthDays(month).map((date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isWorkday = dow >= 1 && dow <= 5;
    const filed = isWorkday && date <= '2026-10-09';
    return {
      date,
      isWorkday,
      isToday: date === '2026-10-09',
      isFuture: date > '2026-10-09',
      status: filed ? 'filed' : null,
      chip: filed ? { variant: 'filed', label: 'Filed' } : null,
      crew: filed ? 24 : null,
      hours: filed ? 192 : null,
      weatherAffected: date === '2026-10-02',
      lostHours: date === '2026-10-02' ? 3.5 : 0,
      reportId: filed ? `r-${date}` : null,
      isLate: false,
    };
  });
}

describe('CalendarMonth', () => {
  it('renders a Mon–Sun grid with the month label, today outlined and weekends grey', () => {
    render(
      <MemoryRouter>
        <CalendarMonth month="2026-10" cells={cellsFor('2026-10')} />
      </MemoryRouter>,
    );
    expect(screen.getByText('October 2026')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    const today = screen.getByRole('gridcell', { name: 'Open report for Oct 9' });
    expect(today).toHaveClass('border-asphalt');
    const sat = document.querySelector('[data-date="2026-10-03"]');
    expect(sat).toHaveClass('bg-concrete');
  });

  it('calls onSelect with the cell when a report day is clicked', async () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <CalendarMonth month="2026-10" cells={cellsFor('2026-10')} onSelect={onSelect} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('gridcell', { name: 'Open report for Oct 2' }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-10-02', reportId: 'r-2026-10-02' }),
    );
  });
});
