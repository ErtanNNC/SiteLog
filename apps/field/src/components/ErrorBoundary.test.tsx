import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('shows a way back instead of a blank page, in the app’s language', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(() => i18n.changeLanguage('es'));
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Algo salió mal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Intente de nuevo' })).toBeInTheDocument();
  });
});
