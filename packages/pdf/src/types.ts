import type { DailyReportData, FieldChannel, SiteDayWeather, VersionAuthor } from '@sitelog/shared';

/** Image bytes (worker) or a URL react-pdf fetches itself (browser). */
export type PdfImage =
  { data: Uint8Array; format: 'png' | 'jpg' } | { url: string; format: 'png' | 'jpg' };

export type PdfPhoto = PdfImage & {
  takenAt: string;
  caption: string | null;
};

export interface PdfEdit {
  version: number;
  /** §6.2 version_author. */
  author: VersionAuthor;
  changeNote: string | null;
  createdAt: string;
}

/** Everything ReportDocument needs; built from DB rows by the worker (pdf/render.ts) or the panel. */
export interface ReportPdfInput {
  org: {
    name: string;
    address: string | null;
    licenseNo: string | null;
    /** `orgs.tax_no`: printed on the letterhead line after the address and license. */
    taxNo: string | null;
    letterheadLines: string[];
    logo: PdfImage | null;
  };
  site: {
    name: string;
    projectCode: string;
    address: string | null;
    workingHours: string | null;
    timezone: string;
  };
  report: {
    reportNo: string;
    version: number;
    status: string;
    kind: 'daily' | 'weather_day' | 'no_work';
    filedAt: string | null;
    confirmedAt: string | null;
    signedOffAt: string | null;
    signedOffByName: string | null;
    isLate: boolean;
    reviewReasons: string[];
    /**
     * `reports.channel` and `confirmed_via` (§6.3): the source record and the site manager's
     * sign-off line follow them. null on reports from before v1.2 (Meta WhatsApp, D13).
     */
    channel: FieldChannel | null;
    confirmedVia: FieldChannel | null;
  };
  /**
   * The version's data (§10.3 v2). The document prints in `data.reportLanguage` (§9.6, §12: the
   * org's report language) and in `data.units`.
   */
  data: DailyReportData;
  reporterName: string | null;
  /** Office user who typed the report in the panel (no WhatsApp source); absent otherwise. */
  enteredBy?: string | null;
  sources: {
    audioCount: number;
    totalAudioSeconds: number;
    languages: string[];
    receivedAt: string | null;
    textCount: number;
  };
  photos: PdfPhoto[];
  companies: Array<{
    id: string;
    name: string;
    status: 'confirmed' | 'unconfirmed';
    isSelfPerform: boolean;
  }>;
  edits: PdfEdit[];
  /**
   * Answered questions by id (and, for v1 data, by the reply's message id, which a v1 `reply`
   * source carries as its questionId): when, and which field, for the manpower footnote.
   */
  answers?: Record<string, { answeredAt: string | null; field: string | null }>;
  settings: { paper: 'letter' | 'a4'; footerEnabled: boolean; maxPhotos: number };
  generatedAt: string;
}

export interface EvidenceDay {
  date: string;
  reportNo: string;
  version: number;
  signedOff: boolean;
  data: DailyReportData;
  lostHours: number;
  fullDay: boolean;
  claimReady: boolean;
  transcriptExcerpts: Array<{ start: number; end: number; text: string }>;
  photos: PdfPhoto[];
  observed: SiteDayWeather | null;
  photoCount: number;
  audioCount: number;
}

export interface EvidencePackInput {
  org: { name: string; logo: PdfImage | null };
  site: { name: string; projectCode: string; address: string | null; timezone: string };
  periodStart: string;
  periodEnd: string;
  days: EvidenceDay[];
  settings: { paper: 'letter' | 'a4' };
  generatedAt: string;
  requestedBy: string | null;
}
