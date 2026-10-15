import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import type { AnswerConfirmation, ReportView } from '@sitelog/shared/field-contract.ts';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { NoLink } from '@/screens/NoLink';
import { useSession } from '@/session/useSession';
import { Draft } from './Draft';
import { Filed } from './Filed';
import { confirmationLine } from './lines';
import { pollsIn, reportPhase } from './phase';
import { ProcessingView } from './Processing';
import { Question } from './Question';
import { useReportPoll } from './useReportPoll';

/**
 * `/report/:id` (§9.3): Processing while the worker writes (F5 step 4), then one question per
 * screen (F7, Field-05), the draft (F8, Field-06) and, after Confirm & send, filing until the
 * report is filed: the Filed screen (Field-07, W1-15), which the `filed` text's link opens too.
 * One poll (`useReportPoll`) runs while the worker has the report (and on Filed until the PDF
 * exists) and stops when it is the reporter's turn; an answer or Confirm & send starts it again.
 * After an answer, F7's confirmation line stays on the screens that follow it.
 */
export function ReportScreen() {
  const { id = '' } = useParams();
  const { session } = useSession();
  if (!session) return <NoLink />;
  return <ReportLoaded key={id} code={session.code} id={id} reporterName={session.reporter.name} />;
}

function ReportLoaded({
  code,
  id,
  reporterName,
}: {
  code: string;
  id: string;
  reporterName: string;
}) {
  const { t, language } = useFieldCopy();
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [filing, setFiling] = useState(false);
  const [confirmation, setConfirmation] = useState<AnswerConfirmation | null>(null);
  // A refusal that sent the screen back to the latest view ("That question was already answered").
  const [notice, setNotice] = useState<string | null>(null);
  const keepPolling = useCallback(
    (view: ReportView) => {
      const next = reportPhase(view, { answered, filing });
      // Filed before render_pdf stored the file: check again until the PDF is there.
      return pollsIn(next) || (next === 'filed' && !view.pdfUrl);
    },
    [answered, filing],
  );
  const { view, problem, restart } = useReportPoll(code, id, keepPolling);
  const phase = reportPhase(view, { answered, filing });

  const onAnswered = useCallback(
    (questionId: string, result: AnswerConfirmation) => {
      setAnswered((prev) => new Set(prev).add(questionId));
      setConfirmation(result);
      setNotice(null);
      restart();
    },
    [restart],
  );
  const onStale = useCallback(
    (message: string) => {
      setNotice(message);
      restart();
    },
    [restart],
  );
  const onConfirmed = useCallback(() => {
    setFiling(true);
    setNotice(null);
    setConfirmation(null);
    restart();
  }, [restart]);

  // F7's line (a web toast in the spec) stays on the screens after the answer; a refusal that
  // sent the screen back to the latest view says why. Each new screen starts at its heading.
  const notices =
    confirmation || notice ? (
      <div className="flex flex-col gap-2">
        {confirmation ? (
          <p
            role="status"
            className="m-0 rounded-card border border-rebar bg-white px-3.5 py-2.5 text-[16px] leading-6"
          >
            {confirmationLine(confirmation, t, language)}
          </p>
        ) : null}
        {notice ? (
          <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
            {notice}
          </p>
        ) : null}
      </div>
    ) : null;

  if (view && phase === 'question' && view.question) {
    return (
      <Question
        key={`question:${view.question.id}`}
        code={code}
        view={view}
        question={view.question}
        notice={notices}
        onAnswered={onAnswered}
        onStale={onStale}
      />
    );
  }
  if (view && phase === 'draft' && view.data) {
    return (
      <Draft
        key="draft"
        code={code}
        view={view}
        data={view.data}
        notice={notices}
        onConfirmed={onConfirmed}
        onStale={onStale}
      />
    );
  }
  if (view && phase === 'filed') {
    return (
      <Filed
        key="filed"
        view={view}
        reporterName={reporterName}
        onRefresh={restart}
        notice={notices}
      />
    );
  }
  const shown =
    phase === 'question' || phase === 'draft' || phase === 'filed' ? 'processing' : phase;
  return (
    <ProcessingView
      key={`processing:${shown}`}
      view={view}
      phase={shown}
      problem={problem}
      onRetry={restart}
      notice={notices}
    />
  );
}
