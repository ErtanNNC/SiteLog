import {
  pickNextQuestion,
  validateReport,
  type CompanyRow,
  type DailyReportData,
  type OrgSettingsRow,
  type QuestionRow,
  type QuestionSpec,
  type RequiredFieldKey,
  type ValidationResult,
} from '@sitelog/shared';

/** §10.5 — validation + question selection against the org's settings (pure wrappers over shared). */

export function requiredFieldsOf(settings: Pick<OrgSettingsRow, 'required_fields'>): RequiredFieldKey[] {
  const allowed = new Set<string>(['manpower', 'hours', 'weather', 'work_performed', 'safety', 'photo']);
  return settings.required_fields.filter((f): f is RequiredFieldKey => allowed.has(f));
}

export function validateDraft(data: DailyReportData, settings: Pick<OrgSettingsRow, 'required_fields'>, photoCount: number): ValidationResult {
  return validateReport(data, { requiredFields: requiredFieldsOf(settings), photoCount });
}

/** questions.target carries the gap path so re-asks and "asked" bookkeeping are exact. */
export function askedPathsOf(questions: QuestionRow[]): string[] {
  return questions.map((q) => {
    const t = (q.target ?? {}) as { path?: string };
    return t.path ?? q.field;
  });
}

export function selectNextQuestion(
  data: DailyReportData,
  validation: ValidationResult,
  questions: QuestionRow[],
  settings: Pick<OrgSettingsRow, 'max_questions_per_report'>,
  companies: CompanyRow[],
): QuestionSpec | null {
  return pickNextQuestion(data, validation, {
    askedPaths: askedPathsOf(questions),
    askedCount: questions.length,
    maxQuestions: settings.max_questions_per_report,
    companies: companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
  });
}

/** reports.review_reasons at filing: validation reasons + unanswered questions + extras, deduplicated. */
export function reviewReasons(validation: ValidationResult, questions: QuestionRow[], extras: string[] = []): string[] {
  const reasons = new Set<string>(validation.reviewReasons);
  for (const q of questions) {
    if (!q.answered_at) reasons.add(`unanswered:${q.field}`);
    const a = q.answer as { unanswered?: boolean } | null;
    if (a?.unanswered) reasons.add(`unanswered:${q.field}`);
  }
  for (const e of extras) if (e) reasons.add(e);
  return Array.from(reasons);
}
