import type { DailyReportData, SiteDayWeather } from '@sitelog/shared';

/** Image bytes (worker) or a URL react-pdf fetches itself (browser). */
export type PdfImage =
  | { data: Uint8Array; format: 'png' | 'jpg' }
  | { url: string; format: 'png' | 'jpg' };

export type PdfPhoto = PdfImage & {
  takenAt: string;
  caption: string | null;
};

export interface PdfEdit {
  version: number;
  author: 'agent' | 'reporter_reply' | 'office_user';
  changeNote: string | null;
  createdAt: string;
}

/** Everything ReportDocument needs; built from DB rows by the worker (pdf/render.ts) or the panel. */
export interface ReportPdfInput {
  org: {
    name: string;
    address: string | null;
    licenseNo: string | null;
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
  };
  data: DailyReportData;
  reporterName: string | null;
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
