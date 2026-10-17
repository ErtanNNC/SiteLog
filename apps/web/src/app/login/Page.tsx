import { zodResolver } from '@hookform/resolvers/zod';
import { Check, CircleAlert, Lock, Mic } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { useAuth } from '@/auth/AuthProvider';
import { homeFor } from '@/auth/guards';
import { LanguageSwitch } from '@/components/shell/LanguageSwitch';
import { Button } from '@/components/ui/Button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/Form';
import { Input } from '@/components/ui/Input';
import { Tip } from '@/components/ui/Tooltip';
import { demoUserFor } from '@/data/demo/store';
import { translate, useCopy } from '@/i18n/useCopy';
import { assetUrl } from '@/lib/asset';

// The message is read when the form validates, so it is in the language of that moment.
const schema = z.object({
  email: z
    .string()
    .trim()
    .email({ error: () => translate('login.emailInvalid') }),
});
type FormValues = z.infer<typeof schema>;

export const RESEND_SECONDS = 60;

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }
  | { kind: 'error'; key: SignInErrorKey };

type SignInErrorKey = 'login.authError' | 'login.rateLimited';

/**
 * GoTrue's messages are English ("Email rate limit exceeded", "For security purposes, you can only
 * request this after 43 seconds."): show ours instead, in the panel's language. A 429 (too many
 * sign-in emails) gets its own text.
 */
function signInErrorKey(err: unknown): SignInErrorKey {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const rateLimited =
    e.status === 429 ||
    (typeof e.code === 'string' && /rate_limit/i.test(e.code)) ||
    (typeof e.message === 'string' && /rate limit|only request this after/i.test(e.message));
  return rateLimited ? 'login.rateLimited' : 'login.authError';
}

const BULLETS = ['link', 'pdf', 'trace'] as const;

/**
 * P1 · Sign in (§11.4, F1, Web-Login artboard): brand panel with the EN/TR switch, then the
 * magic-link form. Demo: any email signs in; `?as=pm|ops|accounts` picks the user.
 */
export default function LoginPage() {
  const { status, role, signInWithEmail, isDemo } = useAuth();
  const { t, language } = useCopy();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [countdown, setCountdown] = useState(0);
  const as = params.get('as');
  const expired = params.get('error') === 'expired';
  const authError = params.get('error') === 'auth';
  const from = (location.state as { from?: string } | null)?.from;

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '' } });
  const { trigger, getFieldState } = form;

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // A validation message on screen follows a language switch.
  useEffect(() => {
    if (getFieldState('email').error) void trigger('email');
  }, [language, getFieldState, trigger]);

  if (status === 'signed_in' && !as) {
    return <Navigate to={from && from !== '/login' ? from : homeFor(role)} replace />;
  }

  const submit = async (values: FormValues) => {
    setState({ kind: 'sending' });
    try {
      await signInWithEmail(values.email, { as });
      if (isDemo) {
        void navigate(from && from !== '/login' ? from : homeFor(demoUserFor(as).role), {
          replace: true,
        });
        return;
      }
      setState({ kind: 'sent', email: values.email });
      setCountdown(RESEND_SECONDS);
    } catch (err) {
      setState({ kind: 'error', key: signInErrorKey(err) });
    }
  };

  const resend = async (email: string) => {
    if (countdown > 0) return;
    try {
      await signInWithEmail(email, { as });
      setCountdown(RESEND_SECONDS);
    } catch (err) {
      setState({ kind: 'error', key: signInErrorKey(err) });
    }
  };

  return (
    <div className="min-h-screen bg-concrete lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Brand panel */}
      <section
        className="on-dark relative flex flex-col justify-between gap-12 overflow-hidden bg-asphalt px-6 pt-8 text-chalk sm:px-10 lg:min-h-screen lg:px-14 lg:pt-10"
        aria-label={t('app.name')}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img
              src={assetUrl('brand/logo-mark.svg')}
              alt=""
              width={40}
              height={40}
              className="size-10"
            />
            <span className="font-display text-[26px] leading-none">{t('app.name')}</span>
          </div>
          <LanguageSwitch tone="dark" />
        </div>
        <div className="max-w-xl">
          <h2 className="font-display text-[36px] leading-[40px] sm:text-[44px] sm:leading-[48px] xl:text-display">
            {t('login.headline')}
          </h2>
          <ul className="mt-7 space-y-3.5">
            {BULLETS.map((b) => (
              <li key={b} className="flex items-start gap-3 text-[17px] leading-6 text-chalk">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-filed text-chalk">
                  <Check className="size-3.5 stroke-[3]" aria-hidden="true" />
                </span>
                <span>{t(`login.bullets.${b}`)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4">
          <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-dust-light">
            {t('login.tagline')}
          </p>
          <div aria-hidden="true" className="hazard-stripe -mx-6 h-[18px] sm:-mx-10 lg:-mx-14" />
        </div>
      </section>

      {/* Sign-in form */}
      <section className="flex items-center justify-center px-4 py-12 sm:px-6">
        <div className="flex w-full max-w-[400px] flex-col gap-6">
          {expired ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-chip border border-missing/40 bg-chip-miss-bg/60 px-3 py-2 text-caption text-chip-miss-fg"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t('login.expired')}
            </div>
          ) : null}
          {authError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-chip border border-missing/40 bg-chip-miss-bg/60 px-3 py-2 text-caption text-chip-miss-fg"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t('login.authError')}
            </div>
          ) : null}

          {state.kind === 'sent' ? (
            <div data-testid="login-sent">
              <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-chip-filed-bg text-chip-filed-fg">
                <Check className="size-6" aria-hidden="true" />
              </div>
              <h1 className="font-display text-[30px] leading-9">{t('login.sentTitle')}</h1>
              <p className="mt-2 text-[15px] text-dust">
                {t('login.sent', { email: state.email })}
              </p>
              <div className="mt-6 flex flex-col gap-2">
                <Button
                  variant="secondary"
                  disabled={countdown > 0}
                  onClick={() => void resend(state.email)}
                >
                  {countdown > 0 ? t('login.resendIn', { seconds: countdown }) : t('login.resend')}
                </Button>
                <Button variant="link" onClick={() => setState({ kind: 'idle' })}>
                  {t('login.useAnother')}
                </Button>
              </div>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(submit)} noValidate>
                <h1 className="font-display text-[30px] leading-9">{t('login.title')}</h1>
                <p className="mt-2 text-[15px] text-dust">{t('login.subtitle')}</p>
                {isDemo ? (
                  <p
                    className="mt-3 rounded-chip bg-signal-tint px-3 py-2 text-caption text-chip-await-fg"
                    data-testid="demo-hint"
                  >
                    {as
                      ? t('login.demoHintAs', { name: demoUserFor(as).name })
                      : t('login.demoHint')}
                  </p>
                ) : null}
                <div className="mt-6">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('login.emailLabel')}</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            autoComplete="email"
                            inputMode="email"
                            placeholder={t('login.emailPlaceholder')}
                            required
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {state.kind === 'error' ? (
                  <p role="alert" className="mt-3 text-caption font-medium text-missing">
                    {t(state.key)}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  variant="primary"
                  className="mt-4 w-full"
                  loading={state.kind === 'sending'}
                >
                  {state.kind === 'sending' ? t('login.sending') : t('login.submit')}
                </Button>
                <div className="my-5 flex items-center gap-3 text-caption text-dust">
                  <span className="h-px flex-1 bg-rebar" />
                  {t('login.or')}
                  <span className="h-px flex-1 bg-rebar" />
                </div>
                <Tip label={t('login.ssoSoon')}>
                  <span className="block">
                    <Button
                      variant="ghost"
                      className="w-full"
                      disabled
                      aria-disabled="true"
                      aria-describedby="sso-soon"
                    >
                      <Lock aria-hidden="true" />
                      {t('login.sso')}
                    </Button>
                  </span>
                </Tip>
                <span id="sso-soon" className="sr-only">
                  {t('login.ssoSoon')}
                </span>
                <p
                  className="mt-5 flex items-start gap-3 rounded-btn bg-chip-wx-bg px-4 py-3.5 text-[14px] leading-5 text-asphalt"
                  data-testid="managers-note"
                >
                  <Mic className="mt-px size-5 shrink-0 text-steel" aria-hidden="true" />
                  <span>
                    <b className="font-semibold">{t('login.managersNoteLead')}</b>{' '}
                    {t('login.managersNote')}
                  </span>
                </p>
              </form>
            </Form>
          )}
          <p className="text-[14px] text-dust">
            {t('login.footer')}{' '}
            <Link
              to="/setup"
              className="font-semibold text-level underline-offset-4 hover:underline"
            >
              {t('login.footerCta')}
            </Link>{' '}
            {t('login.footerSuffix')}
          </p>
        </div>
      </section>
    </div>
  );
}
