import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { homeFor } from '@/auth/guards';
import { Logo } from '@/components/shell/Sidebar';
import { copy } from '@/copy/en';

/**
 * /auth/callback — the magic link lands here. supabase-js exchanges the code (PKCE) and
 * onAuthStateChange flips the AuthProvider; ≥ 1 org membership → home, none → /setup.
 */
export default function AuthCallbackPage() {
  const { status, orgs, role } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const err =
      params.get('error') ??
      params.get('error_code') ??
      hash.get('error') ??
      hash.get('error_code');
    if (err) {
      void navigate(`/login?error=${/expired|otp/i.test(err) ? 'expired' : 'auth'}`, {
        replace: true,
      });
      return;
    }
    if (status === 'signed_in') {
      void navigate(orgs.length ? homeFor(role) : '/setup', { replace: true });
      return;
    }
    // Signed in, but the companies did not load: the app's guard shows Retry and Sign out.
    if (status === 'error') {
      void navigate('/', { replace: true });
      return;
    }
    if (status === 'signed_out') {
      const t = setTimeout(() => void navigate('/login?error=auth', { replace: true }), 15_000);
      return () => clearTimeout(t);
    }
  }, [status, orgs.length, role, params, navigate]);

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-concrete p-6 text-center"
      role="status"
      aria-live="polite"
    >
      <span className="rounded-btn bg-asphalt px-3 py-2">
        <Logo />
      </span>
      <h1 className="font-display text-[26px]">{copy.login.callbackTitle}</h1>
      <p className="text-dust">{copy.login.callbackBody}</p>
    </div>
  );
}
