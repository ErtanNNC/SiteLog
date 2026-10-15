import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { normalizeLinkCode } from '@sitelog/shared/links.ts';
import type { LinkExpiredBody } from '@sitelog/shared/field-contract.ts';
import { apiErrorBody, apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { useQueue } from '@/queue/useQueue';
import { Screen, ScreenTitle } from '@/components/Screen';
import { SolidButton } from '@/components/Buttons';
import { i18n } from '@/i18n/i18n';
import { fieldLanguageOf } from '@/i18n/language';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { sessionFromResolve, type FieldSession } from '@/session/session';
import { useSession } from '@/session/useSession';
import { DeviceCheck } from './DeviceCheck';
import { Welcome } from './Welcome';

type LinkErrorKey = 'notFound' | 'expired' | 'revoked' | 'disabled';
type Phase =
  | { kind: 'resolving' }
  | { kind: 'device'; session: FieldSession }
  | { kind: 'welcome'; session: FieldSession }
  | { kind: 'error'; key: LinkErrorKey | 'failed' };

function linkError(err: unknown): LinkErrorKey | 'failed' {
  switch (apiErrorCode(err)) {
    case 'link_not_found':
    case 'invalid_request':
      return 'notFound';
    case 'link_expired':
      return 'expired';
    case 'link_revoked':
      return 'revoked';
    case 'reporter_disabled':
      return 'disabled';
    default:
      return 'failed';
  }
}

/**
 * `/r/:code` (F4): resolves the link, then the device check on a new phone, the welcome and
 * consent on the first open, then Today. The resolved link becomes the app's session, so Today
 * and the installed app's `/` work without the SMS afterwards. `/r/:code/report/:id` (the `filed`
 * text's link, W1-15) does the same and then opens that report instead of Today.
 */
export function LinkScreen() {
  const { code: raw = '', id } = useParams();
  const code = normalizeLinkCode(raw);
  const target = id ? `/report/${encodeURIComponent(id)}` : '/today';
  const api = useApi();
  const navigate = useNavigate();
  const { session, update } = useSession();
  const queue = useQueue();
  const { t, tc } = useFieldCopy();
  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });
  // The stored session, for `sessionFromResolve` to keep the chosen site and date of the same link.
  const previous = useRef(session);
  useEffect(() => {
    previous.current = session;
  }, [session]);

  const resolve = useCallback(async () => {
    try {
      const res = await api.resolve(code);
      const next = sessionFromResolve(code, res, previous.current);
      update(next);
      if (next.needsDeviceCheck) setPhase({ kind: 'device', session: next });
      else if (next.needsConsent) setPhase({ kind: 'welcome', session: next });
      else {
        // Clips refused while this phone was unverified, without consent or on a dead link go
        // now, under this link.
        void queue.relink(
          code,
          next.sites.map((s) => s.id),
        );
        navigate(target, { replace: true });
      }
    } catch (err) {
      const key = linkError(err);
      if (key === 'expired') {
        // The Expired screen's language is the reporter's (the body carries it, spec §9.3).
        const body = apiErrorBody(err) as LinkExpiredBody | null;
        const lang = fieldLanguageOf(body?.locale);
        if (lang && i18n.resolvedLanguage !== lang) void i18n.changeLanguage(lang);
      }
      setPhase({ kind: 'error', key });
    }
  }, [api, code, navigate, update, queue, target]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const again = () => {
    setPhase({ kind: 'resolving' });
    void resolve();
  };

  if (phase.kind === 'device') {
    return (
      <Screen
        key="device"
        title={t('device.title', { name: phase.session.reporter.name })}
        dateLine={false}
      >
        <DeviceCheck code={code} name={phase.session.reporter.name} onVerified={again} />
      </Screen>
    );
  }
  if (phase.kind === 'welcome') {
    return (
      <Welcome
        session={phase.session}
        onDone={(res) => {
          update({
            ...phase.session,
            needsConsent: false,
            reporter: {
              ...phase.session.reporter,
              status: res.status,
              contactPref: res.contactPref,
              locale: res.locale,
            },
          });
          void queue.relink(
            code,
            phase.session.sites.map((s) => s.id),
          );
          navigate(target, { replace: true });
        }}
      />
    );
  }
  if (phase.kind === 'error') {
    const key = phase.key === 'failed' ? null : phase.key;
    const title = key ? t(`link.${key}.title`) : tc('errorTitle');
    return (
      <Screen key="error" title={title} dateLine={false}>
        <ScreenTitle>{title}</ScreenTitle>
        <p className="m-0 text-dust">{key ? t(`link.${key}.body`) : t('link.failed')}</p>
        {key ? null : <SolidButton onClick={again}>{tc('retry')}</SolidButton>}
      </Screen>
    );
  }
  return (
    <Screen key="resolving" title={t('routes.link')} dateLine={false}>
      <div role="status">
        <ScreenTitle>{t('routes.link')}</ScreenTitle>
      </div>
    </Screen>
  );
}
