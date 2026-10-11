import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LateBadge, StatusChip } from './StatusChip';

describe('StatusChip', () => {
  it('always renders the label text (status never by colour alone)', () => {
    render(<StatusChip variant="missing" />);
    const chip = screen.getByText('Missing');
    expect(chip).toHaveAttribute('data-variant', 'missing');
    expect(chip).toHaveAttribute('aria-label', 'Status: Missing');
  });

  it('maps every variant to copy and renders the signed-off outline', () => {
    const { rerender } = render(<StatusChip variant="signed_off" />);
    expect(screen.getByText('Signed off')).toHaveClass('border-filed');
    rerender(<StatusChip variant="needs_review" />);
    expect(screen.getByText('Needs review')).toHaveClass('bg-chip-review-bg');
    rerender(<StatusChip variant="weather_day" label="Weather day" />);
    expect(screen.getByText('Weather day')).toBeInTheDocument();
  });

  it('renders the late badge with a time', () => {
    render(<LateBadge time="18:12" />);
    expect(screen.getByText('Late 18:12')).toBeInTheDocument();
  });
});
