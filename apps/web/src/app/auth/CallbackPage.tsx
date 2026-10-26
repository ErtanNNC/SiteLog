import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { EmailOtpType } from '@supabase/supabase-js';
import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/lib/supabase';
import { homeFor } from '@/auth/guards';
import { Logo } from '@/components/shell/Sidebar';
import { useCopy } from '@/i18n/useCopy';

/**
 * /auth/callback — the magic link lands here. supabase-js exchanges the code (PKCE) and
 * onAuthStateChange flips the AuthProvider; ≥ 1 org membership → home, none → /setup.
 * A link made server-side (the admin generate_link of the preview phone check) carries
 * `token_hash` + `type` instead: it is verified here, since a PKCE client ignores the implicit
 * tokens such a link would otherwise put in the URL hash.
 */
export default function AuthCallbackPage() {
  const { status, orgs, role } = useAuth();
  const { t } = useCopy();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const verified = useRef(false);

  useEffect(() => {
    const tokenHash = params.get('token_hash');
    const type = params.get('type') as EmailOtpType | null;
    if (!tokenHash || !type || !supabase || verified.current) return;
    verified.current = true;
    void supabase.auth.verifyOtp({ token_hash: tokenHash, type }).then(({ error }) => {
      if (error) void navigate('/login?error=expired', { replace: true });
    });
  }, [params, navigate]);

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
      <h1 className="font-display text-[26px]">{t('login.callbackTitle')}</h1>
      <p className="text-dust">{t('login.callbackBody')}</p>
    </div>
  );
}
