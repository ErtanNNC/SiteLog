import { waCopy } from '../copy/whatsapp.ts';
import type { DailyReportDataV1 } from '../schemas/report.ts';
import { deriveTotals } from './hours.ts';

/**
 * §F5 step 3 — the lines of the progress bubble ("Writing your report…" + the steps done so far).
 * The worker decides when to send it (pipeline/progress.ts); the simulator reuses the same lines.
 */

export interface ProgressFacts {
  /** Every voice note of the report has a transcript (false for text-only reports). */
  transcribed: boolean;
  /** The extracted draft, once extraction finished on a settled set of sources. */
  draft?: DailyReportDataV1 | null;
  selfPerformCompanyIds?: ReadonlySet<string>;
}

/** Lines under "Writing your report…": transcribed · crew found · weather logged · checking hours. */
export function progressSteps(facts: ProgressFacts): string[] {
  const steps: string[] = [];
  if (facts.transcribed) steps.push(waCopy.progressTranscribed());
  const draft = facts.draft;
  if (draft) {
    if (draft.manpower.length > 0) {
      const totals = deriveTotals(draft, { selfPerformCompanyIds: facts.selfPerformCompanyIds });
      // A partial headcount ("the Delta guys") would show a wrong total; the question fixes it.
      if (totals.headcountKnown && totals.crewOnSite > 0) {
        steps.push(waCopy.progressCrew(totals.crewOnSite, totals.subcontractors));
      }
    }
    const delay = draft.weather.periods.find(
      (p) => (p.lostHours > 0 || p.fullDay === true) && p.start && p.end,
    );
    if (delay?.start && delay.end) {
      steps.push(waCopy.progressRain(delay.start, delay.end, conditionLabel(delay.condition)));
    }
  }
  steps.push(waCopy.progressHours());
  return steps;
}

function conditionLabel(condition: string): string {
  const c = condition.trim();
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Weather';
}
