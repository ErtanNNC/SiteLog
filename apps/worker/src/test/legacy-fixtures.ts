import {
  downgradeExtractionV2,
  downgradeV2toV1,
  type DailyReportDataV1,
  type ExtractionOutput,
} from '@sitelog/shared';
import { loadFixture, type EvalFixture } from '../ai/eval';
import type { ExtractionInput } from '../ai/extract';

/**
 * The golden set in v1 terms for the WhatsApp worker's tests (its extraction is v1 until step 22).
 * The fixtures are v2 from W1-12 (eval.ts); these read them the way the v1.0 code saw them: a
 * voice upload's id is the WhatsApp message id (the same UUID), an answer's question id the reply
 * message id, and a `whatsappText` case's note the typed message it was.
 */

const cache = new Map<string, EvalFixture>();
function fixture(id: string): EvalFixture {
  let f = cache.get(id);
  if (!f) {
    f = loadFixture(id);
    cache.set(id, f);
  }
  return f;
}

function textIdsOf(f: EvalFixture): Set<string> {
  return new Set(f.whatsappText ? f.input.segments.map((s) => s.uploadId) : []);
}

/** The v1 extraction input of a golden case. */
export function legacyInput(id: string): ExtractionInput {
  const f = fixture(id);
  const i = f.input;
  const text = textIdsOf(f);
  return {
    site: i.site,
    reportDate: i.reportDate,
    defaultShiftHours: i.defaultShiftHours,
    requiredFields: i.requiredFields,
    companies: i.companies,
    glossary: i.glossary,
    rejectedMappings: i.rejectedMappings,
    observedWeather: i.observedWeather,
    previousAnswers: i.previousAnswers.map(({ questionId, ...a }) => ({
      ...a,
      messageId: questionId,
    })),
    previousDraft: i.previousDraft ? downgradeV2toV1(i.previousDraft, { textIds: text }) : null,
    photos: i.photos.map(({ uploadId, ...p }) => ({ messageId: uploadId, ...p })),
    segments: i.segments
      .filter((s) => !text.has(s.uploadId))
      .map(({ uploadId, ...s }) => ({ messageId: uploadId, ...s })),
    texts: i.segments
      .filter((s) => text.has(s.uploadId))
      .map((s) => ({ messageId: s.uploadId, text: s.text })),
    reporterFirstName: i.reporterFirstName,
  };
}

/** The recorded tool output of a golden case in v1 terms. */
export function legacyRecorded(id: string): ExtractionOutput {
  const f = fixture(id);
  return downgradeExtractionV2(f.recorded!, { textIds: textIdsOf(f) });
}

/** The expected data of a golden case in v1 terms. */
export function legacyExpected(id: string): DailyReportDataV1 {
  const f = fixture(id);
  return downgradeV2toV1(f.expected, { textIds: textIdsOf(f) });
}
