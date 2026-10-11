import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StreakCell } from '@/data/types';
import { StreakBar } from './StreakBar';

const cells: StreakCell[] = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-09-${String(16 + i).padStart(2, '0')}`,
  status: i === 3 ? 'late' : 'on_time',
}));

describe('StreakBar', () => {
  it('renders 14 cells and summarises in the aria-label', () => {
    render(<StreakBar cells={cells} />);
    const bar = screen.getByRole('img', { name: '13 of 14 on time' });
    expect(bar.querySelectorAll('span')).toHaveLength(14);
    expect(bar.querySelectorAll('[data-status="late"]')).toHaveLength(1);
  });
});
