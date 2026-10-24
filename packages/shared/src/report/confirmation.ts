import type { AnswerConfirmation } from '../field-contract.ts';
import type { AnswerValue } from '../schemas/ai.ts';
import type { DailyReportData, QuestionField } from '../schemas/report.ts';
import type { QuestionSpec } from './validate.ts';

/**
 * F7's confirmation line after an answer ("Delta Mechanical: 5 workers, 8 hours each — 40
 * hours."), as numbers read from the draft the answer produced (`applyAnswer`'s `data`): the totals
 * are code's, never the model's. The field app words it in the reporter's language
 * (`field.confirmation.*`, W1-13). Pure.
 */
export function answerConfirmation(
  field: QuestionField,
  target: Pick<QuestionSpec['target'], 'manpowerIndex'>,
  data: Pick<DailyReportData, 'manpower'>,
  value: AnswerValue,
): AnswerConfirmation {
  switch (field) {
    case 'manpower.workers':
    case 'manpower.hours': {
      // applyAnswer adds the crew at the end when the draft had none (a headcount for "the crew").
      const entry =
        target.manpowerIndex !== undefined
          ? data.manpower[target.manpowerIndex]
          : data.manpower[data.manpower.length - 1];
      if (!entry) return { kind: 'noted' };
      return {
        kind: 'crew',
        company: entry.companyName,
        workers: entry.workers,
        hoursPerWorker: entry.hoursPerWorker,
        totalHours: entry.totalHours,
      };
    }
    case 'company.unknown': {
      const entry =
        target.manpowerIndex !== undefined ? data.manpower[target.manpowerIndex] : undefined;
      if (!entry) return { kind: 'noted' };
      if (value.companyAction === 'map')
        return { kind: 'company_mapped', company: entry.companyName };
      if (value.companyAction === 'add')
        return { kind: 'company_added', company: entry.companyName };
      return { kind: 'noted' };
    }
    case 'weather.impact':
      return typeof value.lostHours === 'number'
        ? { kind: 'weather', lostHours: value.lostHours }
        : { kind: 'noted' };
    case 'safety':
    case 'photo':
      return { kind: 'noted' };
  }
}
