import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { recordingNoticeFor } from '@sitelog/shared/copy/legal/index.ts';
import type { FieldApiErrorCode } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { InverseButton } from '@/components/Buttons';
import { buttonClasses } from '@/components/buttonStyles';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { ActionBar, Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { retryMinutes } from '@/lib/errors';
import { permissionError } from '@/recorder/recorder';
import { formatClock } from '@/screens/record/clock';
import { NoLink } from '@/screens/NoLink';
import { currentSite } from '@/session/session';
import { useSession } from '@/session/useSession';
import type { VoiceCall, VoiceCallState, VoiceClient } from '@/voice/client';
import { loadVoiceClient } from '@/voice/load';

/** The refusals the screen words itself; anything else is `generic`. */
const TALK_ERRORS = [
  'rate_limited',
  'talk_now_unavailable',
  'voice_unavailable',
  'kind_not_allowed',
] as const satisfies readonly FieldApiErrorCode[];
type TalkErrorKey = (typeof TALK_ERRORS)[number] | 'connect' | 'generic';

/** Refusals the link flow handles or explains (as Today and Processing do). */
const RELINK = new Set<string>([
  'device_unverified',
  'consent_required',
  'link_expired',
  'link_revoked',
  'link_not_found',
  'reporter_disabled',
]);

type Phase =
  | { kind: 'microphone' }
  | { kind: 'denied' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'ended' }
  | { kind: 'failed'; key: TalkErrorKey; vars?: Record<string, number> };

export interface TalkDeps {
  /** The `VoiceClient` for the token's URL (default: the lazy fake / LiveKit loader). */
  loadClient?: (livekitUrl: string) => Promise<VoiceClient>;
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  now?: () => number;
}

/** What Today hands over: the site shown there (F14). */
export interface TalkState {
  siteId?: string;
}

function browserGetUserMedia() {
  const md = globalThis.navigator?.mediaDevices;
  return typeof md?.getUserMedia === 'function'
    ? (c: MediaStreamConstraints) => md.getUserMedia(c)
    : null;
}

function HangUpIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 14.5c5-4.7 13-4.7 18 0l-2.4 2.6-3.6-1.4v-2.6a10 10 0 0 0-6 0v2.6l-3.6 1.4z" />
    </svg>
  );
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0 M12 18v3" />
      {off ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}

/**
 * Talk now (W3-13; spec §9.3, §9.4, §19 Q121; Field-08 is not exported, so built from Q121's
 * list and the Recording screen's pattern): the microphone first (asked once; refused → how to allow
 * it, and Record instead), then `voice/token` and the call through a `VoiceClient` (LiveKit, or the
 * scripted fake for a fake field-api), lazy-loaded with this screen. In the call: "Speaking with the
 * SiteLog assistant", the line's status (connecting, the assistant speaking or listening,
 * reconnecting), the recording notice as text (the pack's `legal_keys.recording_notice` when it has
 * this language, W4-06, else the voice copy's line; the sentence the agent says first), a
 * timer, Mute and **End call** (56 px); no captions in M7. After the call it reads the day again:
 * a report → its screen (Filed, or the draft after a hang-up), else Today.
 */
export function Talk(deps: TalkDeps = {}) {
  const { session } = useSession();
  const location = useLocation();
  if (!session) return <NoLink />;
  // A photos link takes photos only (F9).
  if (session.link.kind === 'photos') return <Navigate to="/photos" replace />;
  const state = (location.state ?? {}) as TalkState;
  const siteId = state.siteId ?? session.siteId ?? currentSite(session)?.id ?? null;
  const site = session.sites.find((s) => s.id === siteId);
  if (!siteId) return <Navigate to="/today" replace />;
  return (
    <TalkCall
      code={session.code}
      siteId={siteId}
      siteName={site?.name}
      noticeKey={session.country.legalKeys.recordingNotice}
      deps={deps}
    />
  );
}

function TalkCall({
  code,
  siteId,
  siteName,
  noticeKey,
  deps,
}: {
  code: string;
  siteId: string;
  siteName: string | undefined;
  /** W4-06: the pack's `legal_keys.recording_notice`, if it names one. */
  noticeKey: string | undefined;
  deps: TalkDeps;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const { t, tc, language } = useFieldCopy();
  const [phase, setPhase] = useState<Phase>({ kind: 'microphone' });
  const [line, setLine] = useState<VoiceCallState>('connecting');
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const call = useRef<VoiceCall | null>(null);
  const ended = useRef(false);
  const started = useRef(false);
  const startedAt = useRef<number | null>(null);
  /** A hang-up scheduled by an unmount; a StrictMode remount cancels it. */
  const disposal = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerId = useId();
  const noticeId = useId();
  const now = deps.now ?? (() => Date.now());
  const latest = useRef({ api, navigate, code, siteId });
  useEffect(() => {
    latest.current = { api, navigate, code, siteId };
  });

  /** After the call: the day's report (Filed, or the draft after a hang-up), else Today. */
  const afterCall = useCallback(async () => {
    const { api: a, navigate: go, code: c, siteId: s } = latest.current;
    try {
      const today = await a.today(c, s);
      if (today.report) go(`/report/${today.report.id}`, { replace: true });
      else go('/today', { replace: true });
    } catch {
      go('/today', { replace: true });
    }
  }, []);

  const start = useCallback(async () => {
    ended.current = false;
    call.current = null;
    startedAt.current = null;
    setElapsed(0);
    setMuted(false);
    setSpeaking(false);
    setAudioBlocked(false);
    setLine('connecting');
    setPhase({ kind: 'microphone' });
    // The microphone first (§9.3: Talk now asks once); released at once, the call opens its own.
    const gum = deps.getUserMedia === undefined ? browserGetUserMedia() : deps.getUserMedia;
    if (!gum) {
      setPhase({ kind: 'denied' });
      return;
    }
    try {
      const stream = await gum({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch (err) {
      setPhase(permissionError(err) ? { kind: 'denied' } : { kind: 'failed', key: 'connect' });
      return;
    }
    setPhase({ kind: 'connecting' });
    const { api: a, navigate: go, code: c, siteId: s } = latest.current;
    let token: Awaited<ReturnType<typeof a.voiceToken>>;
    try {
      token = await a.voiceToken(c, s);
    } catch (err) {
      const apiCode = apiErrorCode(err);
      if (apiCode && RELINK.has(apiCode)) {
        go(`/r/${c}`, { replace: true });
        return;
      }
      const key = (TALK_ERRORS as readonly string[]).includes(apiCode ?? '')
        ? (apiCode as TalkErrorKey)
        : 'generic';
      // §19 Q171: the Talk now limit says when the next call is possible (`retryAfter`).
      setPhase(
        key === 'rate_limited'
          ? { kind: 'failed', key, vars: { minutes: retryMinutes(err) } }
          : { kind: 'failed', key },
      );
      return;
    }
    try {
      const client = await (deps.loadClient ?? loadVoiceClient)(token.livekitUrl);
      const live = await client.connect(
        { url: token.livekitUrl, token: token.token },
        {
          onState: setLine,
          onAgentSpeaking: setSpeaking,
          onAudioBlocked: setAudioBlocked,
          onEnded: () => {
            if (ended.current) return;
            ended.current = true;
            call.current = null;
            setPhase({ kind: 'ended' });
            void afterCall();
          },
        },
      );
      if (ended.current) {
        // End call (or leaving the screen) while it was connecting: leave the room at once.
        void live.hangUp();
        return;
      }
      call.current = live;
      startedAt.current = now();
      setLine('connected');
      setPhase({ kind: 'live' });
    } catch (err) {
      console.error('[field] Talk now could not connect', err);
      setPhase({ kind: 'failed', key: 'connect' });
    }
    // `now` is stable for a screen (a test's clock or Date.now).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterCall, deps.getUserMedia, deps.loadClient]);

  // Start once on open (a StrictMode remount does not start a second call), hang up on leaving.
  useEffect(() => {
    if (disposal.current) {
      clearTimeout(disposal.current);
      disposal.current = null;
    }
    if (!started.current) {
      started.current = true;
      void start();
    }
    return () => {
      disposal.current = setTimeout(() => {
        ended.current = true;
        void call.current?.hangUp();
        call.current = null;
      }, 0);
    };
  }, [start]);

  // The timer, from the moment the call is up.
  useEffect(() => {
    if (phase.kind !== 'live') return;
    const tick = () => {
      if (startedAt.current !== null) setElapsed(now() - startedAt.current);
    };
    tick();
    const handle = setInterval(tick, 500);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  async function toggleMute() {
    const next = !muted;
    setMuted(next);
    try {
      await call.current?.setMuted(next);
    } catch {
      setMuted(!next);
    }
  }

  async function endCall() {
    const live = call.current;
    if (live) {
      await live.hangUp();
      return;
    }
    // Still connecting: no call to leave yet; the connect hangs up when it lands.
    ended.current = true;
    navigate('/today', { replace: true });
  }

  const header = <Header siteName={siteName} />;
  const recordInstead = (
    <Link to="/record" replace className={buttonClasses('steel', 'no-underline')}>
      {t('talk.recordInstead')}
    </Link>
  );
  const backToToday = (
    <Link to="/today" replace className={buttonClasses('steel', 'no-underline')}>
      {t('sending.backToToday')}
    </Link>
  );

  if (phase.kind === 'denied') {
    return (
      <Screen key="denied" title={t('talk.title')} header={header} dark dateLine={false}>
        <ScreenTitle>{t('recording.permission.title')}</ScreenTitle>
        <p className="m-0 text-[16px] leading-6 text-dust-light">
          {t('recording.permission.body')}
        </p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[15px] leading-[21px] text-dust-light">
          <li>{t('recording.permission.ios')}</li>
          <li>{t('recording.permission.android')}</li>
        </ul>
        <InverseButton onClick={() => void start()}>{tc('retry')}</InverseButton>
        {recordInstead}
        <ActionBar dark>{backToToday}</ActionBar>
      </Screen>
    );
  }

  if (phase.kind === 'failed') {
    const retry = phase.key !== 'talk_now_unavailable' && phase.key !== 'kind_not_allowed';
    return (
      <Screen key="failed" title={t('talk.title')} header={header} dark dateLine={false}>
        <ScreenTitle>{t('talk.title')}</ScreenTitle>
        <p role="alert" className="m-0 text-[16px] leading-6 text-dust-light">
          {t(`talk.errors.${phase.key}`, phase.vars)}
        </p>
        {retry && phase.key !== 'rate_limited' ? (
          <InverseButton onClick={() => void start()}>{tc('retry')}</InverseButton>
        ) : null}
        {phase.key === 'kind_not_allowed' ? null : recordInstead}
        <ActionBar dark>{backToToday}</ActionBar>
      </Screen>
    );
  }

  const live = phase.kind === 'live';
  const status =
    phase.kind === 'microphone'
      ? t('talk.status.microphone')
      : phase.kind === 'connecting'
        ? t('talk.status.connecting')
        : phase.kind === 'ended'
          ? t('talk.status.ended')
          : line === 'reconnecting'
            ? t('talk.status.reconnecting')
            : speaking
              ? t('talk.status.speaking')
              : t('talk.status.listening');
  // W4-06 (§19 Q28): the pack's recording notice when it names one in this language, else the
  // voice copy's own: the sentence the agent says first.
  const notice = recordingNoticeFor(noticeKey, language).text;

  return (
    <Screen key="call" title={t('talk.title')} header={header} dark dateLine={false}>
      <OfflineBanner />
      <ScreenTitle>{t('talk.assistant')}</ScreenTitle>
      <div className="flex flex-col items-center gap-2 pt-2">
        <span id={timerId} className="sr-only">
          {t('talk.timerLabel')}
        </span>
        <span
          role="timer"
          aria-labelledby={timerId}
          className="font-mono text-[60px] leading-none font-medium tracking-[-0.02em]"
        >
          {formatClock(elapsed)}
        </span>
        <span role="status" className="flex min-h-6 items-center gap-2 text-[16px] text-chalk">
          {live && line === 'connected' ? (
            // The live state's dot: orange is the signal of a call in progress (§14.1); the words
            // beside it say the same.
            <span aria-hidden="true" className="size-2.5 flex-none rounded-full bg-signal" />
          ) : null}
          {status}
        </span>
        {live && muted ? (
          <span className="text-[15px] text-dust-light">{t('talk.status.muted')}</span>
        ) : null}
      </div>

      <section
        aria-labelledby={noticeId}
        className="flex flex-col gap-1.5 rounded-card bg-steel px-4 py-3.5"
      >
        <h2
          id={noticeId}
          className="m-0 font-mono text-[12px] leading-[18px] font-normal tracking-[0.08em] text-dust-light uppercase"
        >
          {t('talk.noticeLabel')}
        </h2>
        <p className="m-0 text-[16px] leading-6">{notice}</p>
      </section>

      {live && audioBlocked ? (
        <InverseButton
          onClick={() => {
            void call.current?.resumeAudio().then(() => setAudioBlocked(false));
          }}
        >
          {t('talk.enableAudio')}
        </InverseButton>
      ) : null}

      <ActionBar dark>
        {/* The name says what a tap does (as Recording's Pause: no aria-pressed). */}
        <button
          type="button"
          aria-label={t(muted ? 'talk.unmute' : 'talk.mute')}
          disabled={!live}
          onClick={() => void toggleMute()}
          className="flex size-target flex-none items-center justify-center rounded-full border border-iron bg-steel text-chalk disabled:opacity-60"
        >
          <MicIcon off={muted} />
        </button>
        <button
          type="button"
          disabled={phase.kind === 'ended'}
          onClick={() => void endCall()}
          className={buttonClasses('end', 'flex-1')}
        >
          <HangUpIcon />
          {t('talk.endCall')}
        </button>
      </ActionBar>
    </Screen>
  );
}
