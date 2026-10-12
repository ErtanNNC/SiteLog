import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderEvidencePackPdf, renderReportPdf } from './render';
import { sampleEvidencePackInput, sampleReportInput } from '@sitelog/pdf/sample-data.ts';

/** `pnpm --filter @sitelog/worker render-sample-pdf` → apps/worker/tmp/*.pdf for visual checks against the §12 artboards. */
async function main(): Promise<void> {
  const out = join(process.cwd(), 'tmp');
  await mkdir(out, { recursive: true });
  const report = await renderReportPdf(sampleReportInput);
  await writeFile(join(out, 'RL-2041-0187_2026-10-09_v2.pdf'), report);
  const a4 = await renderReportPdf({
    ...sampleReportInput,
    settings: { ...sampleReportInput.settings, paper: 'a4' },
  });
  await writeFile(join(out, 'RL-2041-0187_2026-10-09_v2_a4.pdf'), a4);
  const pack = await renderEvidencePackPdf(sampleEvidencePackInput);
  await writeFile(join(out, 'eot_RL-2041_2026-10-01_2026-10-09.pdf'), pack);
  console.log(
    `wrote ${out}: report ${report.length} bytes, a4 ${a4.length} bytes, pack ${pack.length} bytes`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
