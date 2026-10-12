/**
 * The §12 daily report and §F16 evidence pack as react-pdf documents. The worker renders them
 * with renderToBuffer (apps/worker/src/pdf/render.ts); the web panel renders office-entered
 * reports in the browser. Call setFontSource() once before the first render.
 */
export { ReportDocument } from './ReportDocument';
export { EvidencePack } from './EvidencePack';
export { imageSrc } from './components';
export { FONT_FILES, setFontSource, type FontFile } from './fonts';
export type * from './types';
