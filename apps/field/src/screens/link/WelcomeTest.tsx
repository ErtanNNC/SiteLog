import { useEffect, useRef, useState } from 'react';
import {
  TEST_CLIP_MAX_MS,
  uploadMediaType,
  type TestClipView,
} from '@sitelog/shared/field-contract.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { PrimaryButton, QuietButton, SolidButton } from '@/components/Buttons';
import { ActionBar, Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { formatClock } from '@/screens/record/clock';
import { useRecorder } from '@/screens/record/useRecorder';

/** How often the screen asks for the snippet, and for how long at most. */
export const TEST_POLL_MS = 1_500;
export const TEST_WAIT_MS = 60_000;

type Outcome =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'heard'; text: string }
  | { kind: 'silent' }
  | { kind: 'failed' }
  | { kind: 'tooMany' };

/** PUTs the clip to its signed URL (the uploader's request, without the queue). */
export type PutClip = (url: string, blob: Blob, mime: string) => Promise<{ status: number }>;

const defaultPut: PutClip = (url, blob, mime) =>
  fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mime, 'x-upsert': 'false' },
    body: blob,
  }).then((res) => ({ status: res.status }));

/**
 * F4 step 3's optional test recording (W2-13, Field-02, spec §19 Q52), right after the consents
 * are stored (the recording consent covers the clip): "Say anything — nothing gets filed." The
 * clip (20 seconds at most) goes to `test-clip` outside any report and the upload queue; the
 * screen asks for the snippet until the worker heard it: "Heard you clearly: '…'", or "I couldn't
 * hear anything" with *Try again*. The reporter can skip it, and goes to Today either way.
 */
export function WelcomeTest({
  code,
  onDone,
  recorderDeps,
  put = defaultPut,
}: {
  code: string;
  onDone: () => void;
  /** Tests: a fake MediaRecorder. */
  recorderDeps?: RecorderDeps;
  put?: PutClip;
}) {
  const api = useApi();
  const { t } = useFieldCopy();
  const { recorder, state } = useRecorder({ capMs: TEST_CLIP_MAX_MS, ...recorderDeps });
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      recorder.dispose();
    };
  }, [recorder]);

  const recording = state.status === 'recording' || state.status === 'starting';

  async function check(clip: Clip) {
    setOutcome({ kind: 'checking' });
    try {
      const media = uploadMediaType(clip.mime);
      const created = await api.createTestClip(code, { mime: clip.mime, bytes: clip.blob.size });
      const res = await put(created.signedUrl, clip.blob, media?.mime ?? clip.mime);
      if (res.status < 200 || res.status >= 300) throw new Error(`storage ${res.status}`);
      await api.completeTestClip(code, created.testClipId);
      const until = Date.now() + TEST_WAIT_MS;
      let view: TestClipView = { status: 'pending', snippet: null };
      while (alive.current && view.status === 'pending' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, TEST_POLL_MS));
        if (!alive.current) return;
        view = await api.testClip(code, created.testClipId);
      }
      if (!alive.current) return;
      setOutcome(
        view.status === 'heard' && view.snippet
          ? { kind: 'heard', text: view.snippet }
          : view.status === 'silent'
            ? { kind: 'silent' }
            : { kind: 'failed' },
      );
    } catch (err) {
      if (!alive.current) return;
      setOutcome(apiErrorCode(err) === 'rate_limited' ? { kind: 'tooMany' } : { kind: 'failed' });
    }
  }

  async function stop() {
    const clip = await recorder.stop();
    if (clip) void check(clip);
  }
  // 20 seconds: the test stops by itself (the latest `check`, which reads the latest api).
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  });
  useEffect(() => {
    if (state.capReached && state.status === 'recording')
      void recorder.stop().then((clip) => clip && checkRef.current(clip));
  }, [state.capReached, state.status, recorder]);

  const done = outcome.kind !== 'idle' && outcome.kind !== 'checking';
  return (
    <Screen title={t('welcomeTest.title')} dateLine={false}>
      <div className="flex flex-1 flex-col gap-4">
        <ScreenTitle>{t('welcomeTest.title')}</ScreenTitle>
        <p className="m-0 text-[17px] leading-6">{t('welcomeTest.body')}</p>

        <section className="flex flex-col items-center gap-3 rounded-card border border-rebar bg-white px-3.5 py-5">
          {state.error ? (
            <p role="status" className="m-0 self-stretch text-[16px] leading-6 text-steel">
              {t('welcomeTest.noMic')}
            </p>
          ) : recording ? (
            <>
              <p className="m-0 flex items-center gap-2 text-[16px] leading-6 font-semibold">
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full bg-signal shadow-[0_0_0_4px_var(--color-signal-tint)] motion-safe:animate-pulse"
                />
                {t('welcomeTest.recording')}
                <span role="timer" className="font-mono text-[15px] font-normal">
                  {formatClock(state.elapsedMs)} / {formatClock(TEST_CLIP_MAX_MS)}
                </span>
              </p>
              <PrimaryButton onClick={() => void stop()}>{t('welcomeTest.stop')}</PrimaryButton>
            </>
          ) : outcome.kind === 'checking' ? (
            <p role="status" className="m-0 text-[16px] leading-6 font-semibold">
              {t('welcomeTest.checking')}
            </p>
          ) : outcome.kind === 'idle' ? (
            <>
              <button
                type="button"
                onClick={() => void recorder.start()}
                className="flex size-[120px] items-center justify-center rounded-full border-0 bg-signal text-asphalt shadow-[0_0_0_8px_var(--color-signal-tint)]"
              >
                <svg
                  width="36"
                  height="36"
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
                </svg>
                <span className="sr-only">{t('welcomeTest.start')}</span>
              </button>
              <span aria-hidden="true" className="text-[16px] leading-6 font-bold">
                {t('welcomeTest.start')}
              </span>
            </>
          ) : (
            <>
              <p
                role="status"
                className="m-0 self-stretch text-[17px] leading-6 [overflow-wrap:anywhere]"
              >
                {outcome.kind === 'heard'
                  ? t('welcomeTest.heard', { text: outcome.text })
                  : t(`welcomeTest.${outcome.kind}`)}
              </p>
              {outcome.kind === 'silent' || outcome.kind === 'failed' ? (
                <SolidButton onClick={() => setOutcome({ kind: 'idle' })}>
                  {t('welcomeTest.again')}
                </SolidButton>
              ) : null}
            </>
          )}
        </section>

        <ActionBar>
          {done ? (
            <PrimaryButton onClick={onDone}>{t('welcomeTest.continue')}</PrimaryButton>
          ) : (
            <QuietButton disabled={recording} onClick={onDone}>
              {t('welcomeTest.skip')}
            </QuietButton>
          )}
        </ActionBar>
      </div>
    </Screen>
  );
}
