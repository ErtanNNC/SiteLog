import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import LoginPage from './Page';

function renderLogin(
  opts: { route?: string; isDemo?: boolean; signIn?: () => Promise<void> } = {},
) {
  const signInWithEmail = vi.fn(opts.signIn ?? (async () => {}));
  renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<div>OVERVIEW HOME</div>} />
      <Route path="/hours" element={<div>HOURS HOME</div>} />
    </Routes>,
    {
      route: opts.route ?? '/login',
      source: null,
      auth: {
        status: 'signed_out',
        user: null,
        orgs: [],
        currentOrg: null,
        role: null,
        isDemo: opts.isDemo ?? true,
        signInWithEmail,
      },
    },
  );
  return { signInWithEmail };
}

describe('LoginPage', () => {
  it('renders the split layout with the brand copy, the disabled SSO button and the managers note', () => {
    renderLogin();
    expect(
      screen.getByRole('heading', { name: 'End-of-day reports, spoken in three minutes.' }),
    ).toBeInTheDocument();
    expect(screen.getByText("Talk. It's logged.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with company SSO/ })).toBeDisabled();
    expect(
      screen.getByText('Site managers don’t sign in. They report by WhatsApp.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up your company' })).toHaveAttribute(
      'href',
      '/setup',
    );
  });

  it('validates the email before sending', async () => {
    const { signInWithEmail } = renderLogin();
    await userEvent.type(screen.getByLabelText('Work email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid work email.');
    expect(signInWithEmail).not.toHaveBeenCalled();
  });

  it('shows the sent state with a resend countdown in Supabase mode', async () => {
    const { signInWithEmail } = renderLogin({ isDemo: false });
    await userEvent.type(screen.getByLabelText('Work email'), 'lena@kestrelbuild.example');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByTestId('login-sent')).toHaveTextContent('Check your inbox');
    expect(
      screen.getByText(/We sent a sign-in link to lena@kestrelbuild.example/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resend in 60 s/ })).toBeDisabled();
    expect(signInWithEmail).toHaveBeenCalledWith('lena@kestrelbuild.example', { as: null });
  });

  it('shows an inline error when sending fails', async () => {
    renderLogin({
      isDemo: false,
      signIn: async () => {
        throw new Error('Rate limited');
      },
    });
    await userEvent.type(screen.getByLabelText('Work email'), 'lena@kestrelbuild.example');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rate limited');
  });

  it('shows the expired-link banner and the demo hint for ?as=accounts', () => {
    renderLogin({ route: '/login?error=expired&as=accounts' });
    expect(screen.getByRole('alert')).toHaveTextContent('That link has expired.');
    expect(screen.getByTestId('demo-hint')).toHaveTextContent('you’ll sign in as Accounts');
  });

  it('in demo mode signs in and navigates home', async () => {
    const { signInWithEmail } = renderLogin({ isDemo: true });
    await userEvent.type(screen.getByLabelText('Work email'), 'anyone@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await waitFor(() => expect(screen.getByText('OVERVIEW HOME')).toBeInTheDocument());
    expect(signInWithEmail).toHaveBeenCalledWith('anyone@example.com', { as: null });
  });
});
