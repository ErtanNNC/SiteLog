import { renderEvidencePackPdf, renderReportPdf } from './render';
import {
  demirReportInput,
  sampleEvidencePackInput,
  sampleReportInput,
} from '@sitelog/pdf/sample-data.ts';

/**
 * Renders the samples through pdf/render.ts (what render_pdf and build_evidence_pack call) and
 * prints the sizes. tsx-runtime.test.ts runs it under tsx, the way `pnpm dev:worker` runs the
 * worker.
 */
const sizes = [
  (await renderReportPdf(sampleReportInput)).length,
  (await renderReportPdf(demirReportInput)).length,
  (await renderEvidencePackPdf(sampleEvidencePackInput)).length,
];
console.log(`rendered ${sizes.join(' ')}`);
