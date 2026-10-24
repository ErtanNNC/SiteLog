import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { LANGUAGE_KEY } from '@/i18n/language';
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
  it('renders the split layout with the v1.2 copy (P1, Web-Login), the disabled SSO button and the managers note', () => {
    renderLogin();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sign in to the office panel' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'End-of-day reports, spoken in three minutes.',
      }),
    ).toBeInTheDocument();
    for (const bullet of [
      'Site managers tap a text link or take a call — nothing to install.',
      'A formatted PDF daily report lands here, ready to file.',
      'Sub hours and weather delays, each traceable to the recording.',
    ]) {
      expect(screen.getByText(bullet)).toBeInTheDocument();
    }
    expect(screen.getByText('Talk. It’s logged.')).toBeInTheDocument();
    expect(
      screen.getByText('We’ll email you a one-time link. No password to remember.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with company SSO/ })).toBeDisabled();
    expect(screen.getByTestId('managers-note')).toHaveTextContent(
      'Site managers don’t sign in. They report by text link or phone call.',
    );
    expect(screen.getByRole('link', { name: 'Set up your company' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(document.body).not.toHaveTextContent(/WhatsApp/);
  });

  it('switches to Turkish on the page, saves the choice and stays on /login (F1)', async () => {
    renderLogin();
    const group = screen.getByRole('group', { name: 'Language' });
    expect(within(group).getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(group).getByRole('button', { name: 'Türkçe' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ofis paneline giriş yapın' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Gün sonu raporları, üç dakikada anlatılır.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bana giriş linki gönder' })).toBeInTheDocument();
    expect(screen.getByTestId('managers-note')).toHaveTextContent(
      'Şantiye şefleri giriş yapmaz. Mesajdaki link ya da telefon aramasıyla rapor verirler.',
    );
    expect(screen.getByRole('group', { name: 'Dil' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Türkçe' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.lang).toBe('tr');
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('"tr"');
    expect(screen.getByLabelText('İş e-postası')).toBeInTheDocument();

    // A validation message follows the language, and back to English.
    await userEvent.type(screen.getByLabelText('İş e-postası'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Bana giriş linki gönder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Geçerli bir iş e-postası girin.');
    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid work email.');
    expect(document.documentElement.lang).toBe('en');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sign in to the office panel' }),
    ).toBeInTheDocument();
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

  it('shows its own inline error when sending fails, never GoTrue’s English message', async () => {
    renderLogin({
      isDemo: false,
      signIn: async () => {
        throw new Error('Database error finding user');
      },
    });
    await userEvent.type(screen.getByLabelText('Work email'), 'lena@kestrelbuild.example');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in didn’t work. Try again.');
    expect(alert).not.toHaveTextContent('Database error');
  });

  it('explains a rate limit (429), in the panel’s language', async () => {
    renderLogin({
      isDemo: false,
      signIn: async () => {
        throw Object.assign(new Error('Email rate limit exceeded'), { status: 429 });
      },
    });
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Language' })).getByRole('button', {
        name: 'Türkçe',
      }),
    );
    await userEvent.type(screen.getByLabelText('İş e-postası'), 'lena@kestrelbuild.example');
    await userEvent.click(screen.getByRole('button', { name: 'Bana giriş linki gönder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Çok fazla giriş e-postası istendi. Bir dakika bekleyip tekrar deneyin.',
    );
    // The text follows a language switch: it is a key, not a stored message.
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Dil' })).getByRole('button', { name: 'English' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many sign-in emails. Wait a minute and try again.',
    );
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
