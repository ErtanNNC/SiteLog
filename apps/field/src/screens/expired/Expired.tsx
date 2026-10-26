import { useState } from 'react';
import { useLocation } from 'react-router';
import type { FieldCountryView } from '@sitelog/shared/countries.ts';
import type { ExpiredLinkResponse } from '@sitelog/shared/field-contract.ts';
import { formatPhone } from '@sitelog/shared/format.ts';
import { useApi } from '@/api/useApi';
import { PrimaryButton } from '@/components/Buttons';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { copyError, type CopyError } from '@/lib/errors';
import { useSession } from '@/session/useSession';

/** What the link check hands `/expired` (the 410 `link_expired` body's pack subset). */
export interface ExpiredState {
  code: string;
  country: FieldCountryView | null;
}

function expiredState(value: unknown): ExpiredState | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<ExpiredState>;
  return typeof s.code === 'string' ? { code: s.code, country: s.country ?? null } : null;
}

/**
 * Expired link (F16, spec §9.3 _Expired_; W2-03): "This link has expired", **Send me today's
 * link** (`POST expired/daily-link`: field-api texts today's daily link of the same site to the
 * phone on file through the Notifier; the answer never holds the link) and *Call {number}* only
 * when the pack has a voice number. The link check (`/r/:code`) opens it on a 410 `link_expired`,
 * in the reporter's language. Opened without that (a reload), it asks for the latest text instead.
 * There is no artboard: built from §9.3 and the Field-02 / Field-03 patterns.
 */
export function Expired() {
  const location = useLocation();
  const { session } = useSession();
  const api = useApi();
  const { t } = useFieldCopy();
  const state = expiredState(location.state);
  const country = state?.country ?? session?.country ?? null;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExpiredLinkResponse | null>(null);
  const [error, setError] = useState<CopyError | null>(null);

  async function send() {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.expiredDailyLink(state.code));
    } catch (err) {
      const e = copyError(err, []);
      setError(e.key === 'rate_limited' || e.key === 'offline' ? e : { key: 'generic' });
    } finally {
      setBusy(false);
    }
  }

  const title = t('expired.title');
  return (
    <Screen title={title}>
      <OfflineBanner />
      <ScreenTitle>{title}</ScreenTitle>
      {result ? (
        <p role="status" className="m-0 text-[17px] leading-6 text-steel">
          {result.sent ? t('expired.sent') : t(`expired.reasons.${result.reason}`)}
        </p>
      ) : state ? (
        <>
          <p className="m-0 text-[17px] leading-6 text-steel">{t('expired.body')}</p>
          {error ? (
            <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
              {t(
                `expired.errors.${error.key as 'rate_limited' | 'offline' | 'generic'}`,
                error.vars,
              )}
            </p>
          ) : null}
          <PrimaryButton disabled={busy} onClick={() => void send()}>
            {busy ? t('expired.sending') : t('expired.send')}
          </PrimaryButton>
        </>
      ) : (
        <p className="m-0 text-[17px] leading-6 text-steel">{t('expired.noCode')}</p>
      )}
      {country?.voiceNumber ? (
        <a
          href={`tel:${country.voiceNumber}`}
          className="flex h-target items-center justify-center text-[15px] font-semibold text-level no-underline"
        >
          {t('today.call', { number: formatPhone(country.voiceNumber) })}
        </a>
      ) : null}
    </Screen>
  );
}
