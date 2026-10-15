import type { ReportView } from '@sitelog/shared/field-contract.ts';

/**
 * What `/report/:id` shows (§9.3: question / draft / filed; F5 step 4 processing), from the view
 * and what this phone just did. Pure.
 * - `processing`: the worker is writing or deciding (also right after an answer, until its
 *   decide_next has run): poll.
 * - `question` (Field-05), `draft` (Field-06): the reporter's turn; no polling.
 * - `filing`: Confirm & send was accepted, the worker files it: poll until filed.
 * - `filed`: the Filed screen (Field-07, W1-15); it polls only until the PDF exists.
 * - `ready`: awaiting confirmation with no draft to show (not written by the worker): no polling.
 * - `gone`: void.
 */
export type ReportPhase =
  'processing' | 'question' | 'draft' | 'filing' | 'filed' | 'ready' | 'gone';

export interface LocalReportState {
  /** Questions this phone answered: their view may still show them until the next poll. */
  answered: ReadonlySet<string>;
  /** Confirm & send was accepted (queued) for this report. */
  filing: boolean;
}

export function reportPhase(view: ReportView | null, local: LocalReportState): ReportPhase {
  if (!view) return 'processing';
  switch (view.status) {
    case 'filed':
    case 'signed_off':
      return 'filed';
    case 'void':
      return 'gone';
    case 'awaiting_confirmation':
      if (local.filing) return 'filing';
      return view.data ? 'draft' : 'ready';
    case 'awaiting_answer':
      // No open question yet (being written), or the one this phone answered: decide_next runs.
      return view.question && !local.answered.has(view.question.id) ? 'question' : 'processing';
    case 'collecting':
    case 'processing':
      return 'processing';
  }
}

/** Phases that wait for the worker, so the screen keeps polling. */
export function pollsIn(phase: ReportPhase): boolean {
  return phase === 'processing' || phase === 'filing';
}
