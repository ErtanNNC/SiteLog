import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { AnswerConfirmation, ReportView } from '@sitelog/shared/field-contract.ts';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { NoLink } from '@/screens/NoLink';
import { useSession } from '@/session/useSession';
import { Draft } from './Draft';
import { Filed, PDF_WAIT_MS } from './Filed';
import { confirmationLine } from './lines';
import { confirmedDraftReplaced, pollsIn, reportPhase, type ConfirmedDraft } from './phase';
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
  return (
    <ReportLoaded
      key={id}
      code={session.code}
      id={id}
      reporterName={session.reporter.name}
      sites={session.sites}
    />
  );
}

function ReportLoaded({
  code,
  id,
  reporterName,
  sites,
}: {
  code: string;
  id: string;
  reporterName: string;
  sites: readonly { id: string; timezone: string }[];
}) {
  const { t, language } = useFieldCopy();
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  // The draft Confirm & send was accepted for (null: not filing).
  const [confirmed, setConfirmed] = useState<ConfirmedDraft | null>(null);
  const filing = confirmed !== null;
  const [confirmation, setConfirmation] = useState<AnswerConfirmation | null>(null);
  // A refusal that sent the screen back to the latest view ("That question was already answered").
  const [notice, setNotice] = useState<string | null>(null);
  // Filed without a PDF (or with photos being added, F9): what the screen is waiting for (the
  // version, and whether photos are pending), since when, and whether it has stopped waiting.
  const pdfWait = useRef<{ key: string; from: number } | null>(null);
  const [pdfLate, setPdfLate] = useState(false);
  const keepPolling = useCallback(
    (view: ReportView) => {
      if (confirmed && confirmedDraftReplaced(view, confirmed)) {
        // A newer draft replaced the one confirmed (its filing goes stale): show it, with a note.
        setConfirmed(null);
        setNotice(t('draft.errors.draft_changed'));
        return false;
      }
      const next = reportPhase(view, { answered, filing });
      if (pollsIn(next)) return true;
      if (next !== 'filed') return false;
      const pending = (view.addPhotos?.pending ?? 0) > 0;
      if (view.pdfUrl && !pending) return false;
      // Filed before render_pdf stored the file, or photos added after filing waiting for their
      // caption (F9): check again until the PDF of this version is there, for PDF_WAIT_MS at most
      // per version (a render that died must not poll forever).
      const key = `${view.currentVersion}:${pending}`;
      if (pdfWait.current?.key !== key) {
        pdfWait.current = { key, from: Date.now() };
        setPdfLate(false);
      }
      if (Date.now() - pdfWait.current.from < PDF_WAIT_MS) return true;
      setPdfLate(true);
      return false;
    },
    [answered, filing, confirmed, t],
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
  const onConfirmed = useCallback(
    (draft: ConfirmedDraft) => {
      setConfirmed(draft);
      setNotice(null);
      setConfirmation(null);
      restart();
    },
    [restart],
  );

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
        code={code}
        view={view}
        reporterName={reporterName}
        timezone={sites.find((s) => s.id === view.siteId)?.timezone}
        onRefresh={restart}
        notice={notices}
        pdfLate={pdfLate && (!view.pdfUrl || (view.addPhotos?.pending ?? 0) > 0)}
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
