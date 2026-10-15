import { uiEn } from '../copy/ui/en.ts';
import type { UiResources } from '../copy/ui/types.ts';
import type { DailyReportDataV1 } from '../schemas/report.ts';
import { deriveTotals } from './hours.ts';

/**
 * §F5 step 3 — the lines of the progress bubble ("Writing your report…" + the steps done so far).
 * The worker decides when to send it (pipeline/progress.ts); the simulator reuses the same lines.
 * The phrases live in the `field` copy namespace (`field.processing.steps`, EN/ES/TR, W1-09); the
 * WhatsApp copy reads the English ones from there until it is retired (step 22).
 */

export interface ProgressFacts {
  /** Every voice note of the report has a transcript (false for text-only reports). */
  transcribed: boolean;
  /** The extracted draft, once extraction finished on a settled set of sources. */
  draft?: DailyReportDataV1 | null;
  selfPerformCompanyIds?: ReadonlySet<string>;
}

/** The step phrases of one language (`field.processing.steps`). */
export type ProgressCopy = UiResources['field']['processing']['steps'];

export const PROGRESS_COPY_EN: ProgressCopy = uiEn.field.processing.steps;

/** i18next-style `{{name}}` interpolation, for the phrases outside the apps' i18next instances. */
export function fillCopy(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(vars[key] ?? ''));
}

/** Lines under "Writing your report…": transcribed · crew found · weather logged · checking hours. */
export function progressSteps(
  facts: ProgressFacts,
  copy: ProgressCopy = PROGRESS_COPY_EN,
): string[] {
  const steps: string[] = [];
  if (facts.transcribed) steps.push(copy.transcribed);
  const draft = facts.draft;
  if (draft) {
    if (draft.manpower.length > 0) {
      const totals = deriveTotals(draft, { selfPerformCompanyIds: facts.selfPerformCompanyIds });
      // A partial headcount ("the Delta guys") would show a wrong total; the question fixes it.
      if (totals.headcountKnown && totals.crewOnSite > 0) {
        steps.push(progressCrewLine(totals.crewOnSite, totals.subcontractors, copy));
      }
    }
    const delay = draft.weather.periods.find(
      (p) => (p.lostHours > 0 || p.fullDay === true) && p.start && p.end,
    );
    if (delay?.start && delay.end) {
      steps.push(
        fillCopy(copy.weather, {
          condition: conditionLabel(delay.condition),
          start: delay.start,
          end: delay.end,
        }),
      );
    }
  }
  steps.push(copy.hours);
  return steps;
}

/** "15 on site, 2 subcontractors" (one key per count: no plural suffixes across languages). */
export function progressCrewLine(
  onSite: number,
  subcontractors: number,
  copy: ProgressCopy = PROGRESS_COPY_EN,
): string {
  return subcontractors === 1
    ? fillCopy(copy.crewOne, { n: onSite })
    : fillCopy(copy.crewMany, { n: onSite, k: subcontractors });
}

function conditionLabel(condition: string): string {
  const c = condition.trim();
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Weather';
}
