import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { VERIFY_CODE_LENGTH } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { PrimaryButton, SolidButton, TextButton } from '@/components/Buttons';
import { ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { copyError, retryMinutes, type CopyError } from '@/lib/errors';

const KNOWN = ['code_invalid', 'code_expired', 'no_code', 'code_undeliverable'] as const;

/**
 * F4 step 2 (new phones): "Is this Marco Ruiz's phone?" → a 6-digit code by SMS (a demo org's goes
 * to the Demo phone) → the code, auto-filled from the text where the phone can
 * (`autocomplete="one-time-code"`), checked as soon as six digits are in. The send and check
 * limits (5 an hour per phone) are shown with their wait.
 */
export function DeviceCheck({
  code,
  name,
  onVerified,
}: {
  code: string;
  name: string;
  onVerified: () => void;
}) {
  const api = useApi();
  const { t } = useFieldCopy();
  const [step, setStep] = useState<'ask' | 'code'>('ask');
  const [busy, setBusy] = useState(false);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<CopyError | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  const submitted = useRef('');

  // The resend wait counts down by the minute.
  useEffect(() => {
    if (resendAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [resendAt]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendCode(code);
      if (res.alreadyVerified) {
        onVerified();
        return;
      }
      setStep('code');
      setOtp('');
      submitted.current = '';
      setResendAt(null);
    } catch (err) {
      const e = copyError(err, KNOWN);
      if (e.key === 'rate_limited') {
        const at = Date.now();
        setNow(at);
        setResendAt(at + retryMinutes(err) * 60_000);
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    if (busy || value.length !== VERIFY_CODE_LENGTH) return;
    submitted.current = value;
    setBusy(true);
    setError(null);
    try {
      await api.verify(code, value);
      onVerified();
    } catch (err) {
      const apiCode = apiErrorCode(err);
      if (apiCode === 'device_required' || apiCode === 'no_code') setStep('ask');
      setError(copyError(err, KNOWN));
      setOtp('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void verify(otp);
  }

  function onChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, VERIFY_CODE_LENGTH);
    setOtp(digits);
    // Auto-fill (and a sixth digit typed) submit without another tap.
    if (digits.length === VERIFY_CODE_LENGTH && submitted.current !== digits) void verify(digits);
  }

  const waitMinutes = resendAt !== null ? Math.ceil((resendAt - now) / 60_000) : 0;
  const errorText = error ? t(`device.errors.${error.key}` as never, error.vars) : null;

  return (
    <>
      <ScreenTitle>{t('device.title', { name })}</ScreenTitle>
      <p className="m-0 text-dust">{t('device.body')}</p>
      {step === 'ask' ? (
        <>
          {errorText ? (
            <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
              {errorText}
            </p>
          ) : null}
          <div className="sticky bottom-0 mt-auto bg-chalk pt-3 pb-2">
            {waitMinutes > 0 ? (
              <p className="m-0 mb-3 text-center text-[15px] text-dust">
                {t('device.resendIn', { minutes: waitMinutes })}
              </p>
            ) : null}
            <PrimaryButton onClick={() => void send()} disabled={busy || waitMinutes > 0}>
              {busy ? t('device.sending') : t('device.send')}
            </PrimaryButton>
          </div>
        </>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-1 flex-col gap-4" noValidate>
          <p role="status" className="m-0 text-[15px] text-dust">
            {t('device.sent')}
          </p>
          <label htmlFor={inputId} className="text-[15px] font-semibold">
            {t('device.codeLabel')}
          </label>
          <input
            ref={input}
            id={inputId}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={VERIFY_CODE_LENGTH}
            value={otp}
            onChange={(e) => onChange(e.target.value)}
            autoFocus
            aria-describedby={errorText ? errorId : undefined}
            aria-invalid={errorText ? true : undefined}
            className="h-target w-full rounded-card border border-rebar bg-white px-4 text-center font-mono text-[28px] tracking-[0.3em] text-asphalt"
          />
          {errorText ? (
            <p id={errorId} role="alert" className="m-0 text-[15px] leading-5 text-missing">
              {errorText}
            </p>
          ) : null}
          <div className="sticky bottom-0 mt-auto flex flex-col gap-2 bg-chalk pt-3 pb-2">
            <SolidButton type="submit" disabled={busy || otp.length !== VERIFY_CODE_LENGTH}>
              {busy ? t('device.verifying') : t('device.verify')}
            </SolidButton>
            {waitMinutes > 0 ? (
              <p className="m-0 text-center text-[15px] text-dust">
                {t('device.resendIn', { minutes: waitMinutes })}
              </p>
            ) : (
              <TextButton onClick={() => void send()} disabled={busy}>
                {t('device.resend')}
              </TextButton>
            )}
          </div>
        </form>
      )}
    </>
  );
}
