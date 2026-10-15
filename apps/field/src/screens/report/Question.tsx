import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AnswerRequest } from '@sitelog/shared/field-api.ts';
import type { AnswerConfirmation, ReportView } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode, isOfflineError } from '@/api/field';
import { useApi } from '@/api/useApi';
import { ChoiceButton, PrimaryButton } from '@/components/Buttons';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { heardAt, parseTypedNumber } from './lines';
import { RELINK } from './useReportPoll';

type OpenQuestion = NonNullable<ReportView['question']>;

/** Fields a typed number answers (D28; `numberAnswer` in @sitelog/shared). */
type NumberField = 'manpower.workers' | 'manpower.hours' | 'weather.impact';
const NUMBER_FIELDS: readonly string[] = ['manpower.workers', 'manpower.hours', 'weather.impact'];

/**
 * The open question (F7, Field-05; W1-13): one per screen, the "Quick check" card with at most two
 * answers to tap (56 px), or for a question without answers (D28) a number input, with "Full day"
 * as the default hours of a headcount. _Other…_ (say it, M6) is not shown. The answer goes to
 * field-api (`reports/:id/answer`, mapped in code there); `ReportScreen` then shows F7's
 * confirmation line and polls for the next question or the draft.
 */
export function Question({
  code,
  view,
  question,
  notice,
  onAnswered,
  onStale,
}: {
  code: string;
  view: ReportView;
  question: OpenQuestion;
  notice?: ReactNode;
  onAnswered: (questionId: string, confirmation: AnswerConfirmation) => void;
  onStale: (message: string) => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const { t } = useFieldCopy();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heard = heardAt(view);
  const options = question.options ?? [];
  const progress = progressLines(view, t);

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
        <div className="mt-auto flex flex-col gap-2.5">
          {options.length > 0 ? (
            options.slice(0, 2).map((option) => (
              <ChoiceButton
                key={option.id}
                disabled={sending}
                onClick={() => void send({ optionId: option.id })}
              >
                {option.label}
              </ChoiceButton>
            ))
          ) : NUMBER_FIELDS.includes(question.field) ? (
            <NumberAnswer
              field={question.field as NumberField}
              sending={sending}
              onSend={(answer) => void send(answer)}
            />
          ) : (
            <p className="m-0 text-[16px] leading-6 text-steel">{t('question.cannotAnswer')}</p>
          )}
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
