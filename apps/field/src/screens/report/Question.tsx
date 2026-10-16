import { useCallback, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AnswerRequest } from '@sitelog/shared/field-api.ts';
import type { AnswerConfirmation, ReportView } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode, isOfflineError } from '@/api/field';
import { useApi } from '@/api/useApi';
import { ChoiceButton, PrimaryButton, SolidButton } from '@/components/Buttons';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { useQueue } from '@/queue/useQueue';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { heardAt, parseTypedNumber } from './lines';
import { OtherSheet } from './OtherSheet';
import { RELINK } from './useReportPoll';

type OpenQuestion = NonNullable<ReportView['question']>;

/** Fields a typed number answers (D28; `numberAnswer` in @sitelog/shared). */
type NumberField = 'manpower.workers' | 'manpower.hours' | 'weather.impact';
const NUMBER_FIELDS: readonly string[] = ['manpower.workers', 'manpower.hours', 'weather.impact'];

/**
 * The open question (F7, Field-05; W1-13): one per screen, the "Quick check" card with at most two
 * answers to tap (56 px), or for a question without answers (D28) a number input, with "Full day"
 * as the default hours of a headcount. The answer goes to field-api (`reports/:id/answer`, mapped
 * in code there); `ReportScreen` then shows F7's confirmation line and polls for the next
 * question or the draft.
 *
 * W2-09: *Other — say it* on every question opens `OtherSheet`: the answer said (a clip of at most
 * 30 seconds through the upload queue, then `answer {uploadId}`; the worker parses it) or, for a
 * number field, typed. While the worker listens (`question.voice.state`, or the clip still in the
 * queue) the card says "Listening to your answer…"; after a clip it could not read it says "I
 * didn't catch that" and asks again with the same answers.
 */
export function Question({
  code,
  view,
  question,
  notice,
  listening = false,
  onAnswered,
  onSpoken,
  onStale,
  recorderDeps,
}: {
  code: string;
  view: ReportView;
  question: OpenQuestion;
  notice?: ReactNode;
  /** The worker is listening to a spoken answer of this question (ReportScreen polls). */
  listening?: boolean;
  onAnswered: (questionId: string, confirmation: AnswerConfirmation) => void;
  /** A spoken answer reached field-api (`answer {uploadId}`): poll for what the worker made of it. */
  onSpoken?: (questionId: string) => void;
  onStale: (message: string) => void;
  /** Tests: a fake MediaRecorder for *Say it*. */
  recorderDeps?: RecorderDeps;
}) {
  const api = useApi();
  const queue = useQueue();
  const navigate = useNavigate();
  const { t } = useFieldCopy();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  // A clip of this question sent from here, until the view shows the worker has it (listening)
  // or settled it (one more unclear try than when it was sent).
  const [queued, setQueued] = useState<{ unclear: number } | null>(null);
  const unclearNow = question.voice?.unclear ?? 0;
  if (queued && (listening || unclearNow > queued.unclear)) setQueued(null);
  const heard = heardAt(view);
  const options = question.options ?? [];
  const progress = progressLines(view, t);
  const numberField = NUMBER_FIELDS.includes(question.field);
  const waiting = listening || queued !== null;
  const retry = !waiting && question.voice?.state === 'retry';

  const say = useCallback(
    (clip: Clip) => {
      setOtherOpen(false);
      setError(null);
      setQueued({ unclear: unclearNow });
      void (async () => {
        try {
          const item = await queue.enqueue({
            code,
            kind: 'audio',
            mime: clip.mime,
            blob: clip.blob,
            siteId: view.siteId,
            date: view.date,
            recordedAt: clip.startedAt,
            answerTo: { reportId: view.id, questionId: question.id },
          });
          const done = await queue.waitFor(item.id);
          if (done.status === 'failed') {
            setError(t('question.errors.generic'));
            setQueued(null);
            return;
          }
          onSpoken?.(question.id);
        } catch (err) {
          console.error('[field] could not queue the spoken answer', err);
          setError(t('question.queueFailed'));
          setQueued(null);
        }
      })();
    },
    [code, onSpoken, queue, question.id, t, unclearNow, view.date, view.id, view.siteId],
  );

  async function send(answer: Omit<AnswerRequest, 'questionId'>) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.answer(code, view.id, { questionId: question.id, ...answer });
      // A field-api older than W1-13 sends no line: "Got it." rather than nothing.
      onAnswered(question.id, res.confirmation ?? { kind: 'noted' });
    } catch (err) {
      const apiCode = apiErrorCode(err);
      if (apiCode && RELINK.has(apiCode)) {
        navigate(`/r/${code}`, { replace: true });
        return;
      }
      if (apiCode === 'question_closed' || apiCode === 'wrong_state') {
        onStale(t(`question.errors.${apiCode}`));
        return;
      }
      setError(
        apiCode === 'answer_not_accepted'
          ? t('question.errors.answer_not_accepted')
          : isOfflineError(err)
            ? t('question.errors.offline')
            : t('question.errors.generic'),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Screen
      title={t('question.badge')}
      dateLine={false}
      header={<Header siteName={view.siteName} />}
    >
      <OfflineBanner />
      {notice}
      <section
        aria-label={t('question.progress')}
        className="flex flex-col gap-2 text-[15px] leading-[22px]"
      >
        <span className="font-mono text-[12px] leading-[18px] tracking-[0.08em] text-dust uppercase">
          {t('question.progress')} ·{' '}
          {t('processing.counts', {
            voiceNotes: view.progress.voiceNotes,
            photos: view.progress.photos,
          })}
        </span>
        {progress.map((line) => (
          <span key={line} className="flex items-center gap-2">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              className="flex-none text-filed"
            >
              <path d="M5 12l5 5 9-10" />
            </svg>
            {line}
          </span>
        ))}
      </section>

      <section className="flex flex-1 flex-col gap-3.5 rounded-[10px] border-2 border-asphalt bg-white px-[18px] py-5">
        <span className="self-start rounded-chip bg-chip-await-bg px-[9px] py-[3px] font-mono text-[12px] leading-[18px] font-semibold tracking-[0.06em] text-chip-await-fg uppercase">
          {t('question.badge')}
        </span>
        <h1
          tabIndex={-1}
          className="m-0 text-[22px] leading-[29px] font-bold [overflow-wrap:anywhere] [text-wrap:pretty]"
        >
          {question.prompt}
        </h1>
        {heard ? (
          <span className="text-[14px] leading-5 text-dust">
            {t('question.heardAt', { time: heard })}
          </span>
        ) : null}
        {waiting ? (
          <p
            role="status"
            className="m-0 flex items-center gap-2 rounded-card bg-concrete px-3.5 py-2.5 text-[16px] leading-6 font-semibold"
          >
            <span
              aria-hidden="true"
              className="size-2.5 flex-none rounded-full bg-signal motion-safe:animate-pulse"
            />
            {t('question.listening')}
          </p>
        ) : retry ? (
          <p
            role="status"
            className="m-0 rounded-card border border-rebar bg-concrete px-3.5 py-2.5 text-[16px] leading-6"
          >
            {t('question.retry')}
          </p>
        ) : null}
        <div className="mt-auto flex flex-col gap-2.5">
          {options.length > 0 ? (
            options.slice(0, 2).map((option) => (
              <ChoiceButton
                key={option.id}
                disabled={sending || waiting}
                onClick={() => void send({ optionId: option.id })}
              >
                {option.label}
              </ChoiceButton>
            ))
          ) : numberField ? (
            <NumberAnswer
              field={question.field as NumberField}
              sending={sending || waiting}
              onSend={(answer) => void send(answer)}
            />
          ) : null}
          <SolidButton
            disabled={sending || waiting}
            aria-haspopup="dialog"
            onClick={() => setOtherOpen(true)}
          >
            <svg
              width="20"
              height="20"
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
            {t('question.other')}
          </SolidButton>
          {sending ? (
            <p role="status" className="m-0 text-[15px] leading-5 text-dust">
              {t('question.sending')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <p className="m-0 text-center text-[14px] leading-5 text-dust">{t('question.close')}</p>
      <OtherSheet
        open={otherOpen}
        prompt={question.prompt}
        typed={
          numberField ? (
            <NumberAnswer
              field={question.field as NumberField}
              sending={sending}
              onSend={(answer) => {
                setOtherOpen(false);
                void send(answer);
              }}
            />
          ) : null
        }
        onSay={say}
        onClose={() => setOtherOpen(false)}
        recorderDeps={recorderDeps}
      />
    </Screen>
  );
}

/**
 * The lines above the card (Field-05): what is done so far. Only facts the view states: the
 * transcription, and a weather stop with its times; no crew count while the crew is the question.
 */
function progressLines(view: ReportView, t: ReturnType<typeof useFieldCopy>['t']): string[] {
  const lines: string[] = [];
  const p = view.progress;
  if (p.voiceNotes > 0 && p.transcribed >= p.voiceNotes)
    lines.push(t('processing.steps.transcribed'));
  const delay = view.data?.weather.periods.find(
    (w) => (w.lostHours > 0 || w.fullDay === true) && w.start && w.end,
  );
  if (delay?.start && delay.end) {
    const condition = delay.condition.trim();
    lines.push(
      t('processing.steps.weather', {
        condition: condition.charAt(0).toLocaleUpperCase() + condition.slice(1),
        start: delay.start,
        end: delay.end,
      }),
    );
  }
  return lines;
}

/** D28: the number the question asks for, and for a headcount the hours ("Full day" by default). */
function NumberAnswer({
  field,
  sending,
  onSend,
}: {
  field: NumberField;
  sending: boolean;
  onSend: (answer: Omit<AnswerRequest, 'questionId'>) => void;
}) {
  const { t } = useFieldCopy();
  const ids = useId();
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<'full_day' | 'set'>('full_day');
  const [hours, setHours] = useState('');
  const [invalid, setInvalid] = useState<'value' | 'hours' | null>(null);
  const headcount = field === 'manpower.workers';
  const label =
    field === 'manpower.workers'
      ? t('question.workers')
      : field === 'manpower.hours'
        ? t('question.hoursEach')
        : t('question.hoursLost');

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = parseTypedNumber(value, { integer: headcount, max: headcount ? 9999 : 24 });
    if (n === null) {
      setInvalid('value');
      return;
    }
    if (headcount && mode === 'set') {
      const h = parseTypedNumber(hours, { integer: false, max: 24 });
      if (h === null) {
        setInvalid('hours');
        return;
      }
      setInvalid(null);
      onSend({ value: n, hours: h });
      return;
    }
    setInvalid(null);
    onSend(headcount ? { value: n, hours: 'full_day' } : { value: n });
  }

  const inputClasses =
    'h-target w-full rounded-card border border-rebar bg-chalk px-4 font-mono text-[20px] text-asphalt aria-[invalid=true]:border-missing';
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor={`${ids}-value`} className="text-[16px] leading-6 font-semibold">
        {label}
      </label>
      <input
        id={`${ids}-value`}
        type="text"
        inputMode={headcount ? 'numeric' : 'decimal'}
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={invalid === 'value'}
        aria-describedby={invalid === 'value' ? `${ids}-error` : undefined}
        className={inputClasses}
      />
      {headcount ? (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-[16px] leading-6 font-semibold">
            {t('question.hoursLegend')}
          </legend>
          <div className="flex gap-2.5">
            {(['full_day', 'set'] as const).map((m) => (
              <label
                key={m}
                className="flex h-target flex-1 items-center gap-2.5 rounded-card border border-rebar bg-chalk px-4 text-[16px] font-semibold has-[:checked]:border-2 has-[:checked]:border-asphalt"
              >
                <input
                  type="radio"
                  name={`${ids}-mode`}
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="size-5 accent-asphalt"
                />
                {m === 'full_day' ? t('question.fullDay') : t('question.setHours')}
              </label>
            ))}
          </div>
          {mode === 'set' ? (
            <>
              <label htmlFor={`${ids}-hours`} className="text-[16px] leading-6 font-semibold">
                {t('question.hoursEach')}
              </label>
              <input
                id={`${ids}-hours`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                aria-invalid={invalid === 'hours'}
                aria-describedby={invalid === 'hours' ? `${ids}-error` : undefined}
                className={inputClasses}
              />
            </>
          ) : null}
        </fieldset>
      ) : null}
      {invalid ? (
        <p id={`${ids}-error`} className="m-0 text-[15px] leading-5 text-missing">
          {t('question.invalidNumber')}
        </p>
      ) : null}
      <PrimaryButton type="submit" disabled={sending}>
        {t('question.send')}
      </PrimaryButton>
    </form>
  );
}
