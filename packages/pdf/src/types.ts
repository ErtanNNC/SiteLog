import type {
  DailyReportData,
  FieldChannel,
  PackConfirmation,
  PackSection,
  ReportLanguage,
  SiteDayWeather,
  UnitSystem,
  VersionAuthor,
} from '@sitelog/shared';

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

/** A transcript excerpt of a pack day: the words of one clip, never across clips (F20). */
export interface PackExcerpt {
  /** A voice note, or a call (the reporter's lane only). */
  clip: 'voice_note' | 'call';
  /** The clip's number among the day's clips of that kind, when there is more than one. */
  clipNo: number | null;
  start: number;
  end: number;
  text: string;
}

export interface EvidenceDay {
  date: string;
  reportNo: string;
  version: number;
  signedOff: boolean;
  /** Who signed it off and when (ISO), for the confirmation line. */
  signedOffByName: string | null;
  signedOffAt: string | null;
  /** How the report was confirmed (spec §19 Q134). */
  confirmation: PackConfirmation;
  /** Entered in the panel (no reporter). */
  typed: boolean;
  /** When the site manager confirmed it (ISO), else null. */
  confirmedAt: string | null;
  filedAt: string | null;
  data: DailyReportData;
  lostHours: number;
  fullDay: boolean;
  claimReady: boolean;
  transcriptExcerpts: PackExcerpt[];
  photos: PdfPhoto[];
  observed: SiteDayWeather | null;
  photoCount: number;
  /** Voice notes and calls of the report. */
  audioCount: number;
}

export interface EvidencePackInput {
  org: { name: string; logo: PdfImage | null };
  site: { name: string; projectCode: string; address: string | null; timezone: string };
  /** The org's report language (§9.6, F20) and units (§10.11: observed weather). */
  language: ReportLanguage;
  units: UnitSystem;
  periodStart: string;
  periodEnd: string;
  /** The dialog's included sections (`evidence_packs.sections`), in pack order. */
  sections: PackSection[];
  days: EvidenceDay[];
  settings: { paper: 'letter' | 'a4' };
  generatedAt: string;
  requestedBy: string | null;
}
