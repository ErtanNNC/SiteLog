import { zodResolver } from '@hookform/resolvers/zod';
import { Check, CircleAlert, Info, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { useAuth } from '@/auth/AuthProvider';
import { homeFor } from '@/auth/guards';
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
import { copy } from '@/copy/en';
import { demoUserFor } from '@/data/demo/store';
import { errorMessage } from '@/lib/utils';

const schema = z.object({ email: z.string().trim().email(copy.login.emailInvalid) });
type FormValues = z.infer<typeof schema>;

export const RESEND_SECONDS = 60;

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }
  | { kind: 'error'; message: string };

/** P1 · Sign in — split layout (§11.4). Demo: any email signs in; `?as=pm|ops|accounts` picks the user. */
export default function LoginPage() {
  const { status, role, signInWithEmail, isDemo } = useAuth();
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

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

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
      setState({ kind: 'error', message: errorMessage(err, copy.login.authError) });
    }
  };

  const resend = async (email: string) => {
    if (countdown > 0) return;
    try {
      await signInWithEmail(email, { as });
      setCountdown(RESEND_SECONDS);
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err, copy.login.authError) });
    }
  };

  return (
    <div className="min-h-screen bg-concrete lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Brand panel */}
      <section
        className="on-dark relative flex flex-col justify-between overflow-hidden bg-asphalt px-6 py-8 text-chalk sm:px-10 lg:min-h-screen lg:px-14 lg:py-12"
        aria-label={copy.app.name}
      >
        <div className="flex items-center gap-3">
          <img src="/brand/logo-mark.svg" alt="" width={40} height={40} className="size-10" />
          <span className="font-display text-[26px] leading-none">{copy.app.name}</span>
        </div>
        <div className="my-10 max-w-xl lg:my-16">
          <div className="eyebrow mb-4 text-signal">{copy.login.eyebrow}</div>
          <h1 className="font-display text-[36px] leading-[40px] sm:text-[44px] sm:leading-[48px] xl:text-display">
            {copy.login.headline}
          </h1>
          <ul className="mt-8 space-y-3">
            {copy.login.bullets.map((b) => (
              <li
                key={b}
                className="flex items-start gap-3 text-[15px] leading-[22px] text-dust-light"
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-filed text-chalk">
                  <Check className="size-3.5 stroke-[3]" aria-hidden="true" />
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
          <p className="mt-8 font-mono text-[13px] uppercase tracking-[0.08em] text-chalk">
            {copy.login.tagline}
          </p>
        </div>
        <div aria-hidden="true" className="hazard-stripe -mx-6 h-4 sm:-mx-10 lg:-mx-14" />
      </section>

      {/* Form card */}
      <section className="flex items-center justify-center px-4 py-10 sm:px-8 lg:py-12">
        <div className="w-full max-w-[400px] rounded-card border border-rebar bg-chalk p-6 sm:p-8">
          {expired ? (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2 rounded-chip border border-missing/40 bg-chip-miss-bg/60 px-3 py-2 text-caption text-chip-miss-fg"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {copy.login.expired}
            </div>
          ) : null}
          {authError ? (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2 rounded-chip border border-missing/40 bg-chip-miss-bg/60 px-3 py-2 text-caption text-chip-miss-fg"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {copy.login.authError}
            </div>
          ) : null}

          {state.kind === 'sent' ? (
            <div data-testid="login-sent">
              <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-chip-filed-bg text-chip-filed-fg">
                <Check className="size-6" aria-hidden="true" />
              </div>
              <h2 className="font-display text-[26px] leading-8">{copy.login.sentTitle}</h2>
              <p className="mt-2 text-[15px] text-dust">{copy.login.sent(state.email)}</p>
              <div className="mt-6 flex flex-col gap-2">
                <Button
                  variant="secondary"
                  disabled={countdown > 0}
                  onClick={() => void resend(state.email)}
                >
                  {countdown > 0 ? copy.login.resendIn(countdown) : copy.login.resend}
                </Button>
                <Button variant="link" onClick={() => setState({ kind: 'idle' })}>
                  {copy.login.useAnother}
                </Button>
              </div>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(submit)} noValidate>
                <h2 className="font-display text-[26px] leading-8">{copy.login.title}</h2>
                <p className="mt-1 text-[15px] text-dust">{copy.login.subtitle}</p>
                {isDemo ? (
                  <p
                    className="mt-3 rounded-chip bg-signal-tint px-3 py-2 text-caption text-chip-await-fg"
                    data-testid="demo-hint"
                  >
                    {as ? copy.login.demoHintAs(demoUserFor(as).name) : copy.login.demoHint}
                  </p>
                ) : null}
                <div className="mt-6">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{copy.login.emailLabel}</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            autoComplete="email"
                            inputMode="email"
                            placeholder={copy.login.emailPlaceholder}
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
                    {state.message}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  variant="primary"
                  className="mt-4 w-full"
                  loading={state.kind === 'sending'}
                >
                  {state.kind === 'sending' ? copy.login.sending : copy.login.submit}
                </Button>
                <div className="my-5 flex items-center gap-3 text-caption text-dust">
                  <span className="h-px flex-1 bg-rebar" />
                  {copy.login.or}
                  <span className="h-px flex-1 bg-rebar" />
                </div>
                <Tip label={copy.login.ssoSoon}>
                  <span className="block">
                    <Button
                      variant="ghost"
                      className="w-full"
                      disabled
                      aria-disabled="true"
                      aria-describedby="sso-soon"
                    >
                      <Lock aria-hidden="true" />
                      {copy.login.sso}
                    </Button>
                  </span>
                </Tip>
                <span id="sso-soon" className="sr-only">
                  {copy.login.ssoSoon}
                </span>
                <div className="mt-5 flex items-start gap-2 rounded-chip border border-rebar bg-concrete/60 px-3 py-2 text-caption text-dust">
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {copy.login.managersNote}
                </div>
              </form>
            </Form>
          )}
          <p className="mt-6 text-caption text-dust">
            {copy.login.footer}{' '}
            <Link to="/setup" className="font-medium text-level underline-offset-4 hover:underline">
              {copy.login.footerCta}
            </Link>{' '}
            {copy.login.footerSuffix}
          </p>
        </div>
      </section>
    </div>
  );
}
