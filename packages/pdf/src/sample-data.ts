import { upgradeV1toV2, type DailyReportData, type DailyReportDataV1 } from '@sitelog/shared';
import type { EvidencePackInput, PdfPhoto, ReportPdfInput } from './types';

/**
 * The §18 hero report (RL-2041-0187, Fri Oct 9, v2 after "Apex 6 → 7") as PDF input, for visual
 * checks, the smoke test and the PDF text snapshot. The report data is stored as v1 (WhatsApp
 * era); the documents read it the way every reader does, through upgradeV1toV2.
 */

const AUDIO = 'a1b2c3d4-0000-4000-8000-000000000001';
const REPLY = 'a1b2c3d4-0000-4000-8000-000000000002';

export const heroReportDataV1: DailyReportDataV1 = {
  schemaVersion: 1,
  reportDate: '2026-10-09',
  languageDetected: ['es', 'en'],
  summary:
    'Level 4 slab pour completed (approx. 68 yd³). Rain from 07:00 to 10:30 stopped exterior masonry for 3.5 h; crew moved to interior blockwork. Level 3 electrical rough-in approximately 60% complete; Level 2 ductwork continued in the east wing. Two loads of rebar delivered by Ironclad Steel at about 13:00. Toolbox talk on wet-weather access; no incidents.',
  workingHours: { start: '07:00', end: '15:30' },
  weather: {
    observed: {
      precipIn: 0.4,
      tempMinF: 58,
      tempMaxF: 64,
      windMph: 9,
      gustMph: 17,
      provider: 'Open-Meteo',
    },
    conditionsText: 'Rain in the morning, overcast afternoon',
    periods: [
      {
        start: '07:00',
        end: '10:30',
        condition: 'Rain',
        impact: 'Exterior masonry stopped; crew moved to interior blockwork',
        lostHours: 3.5,
        source: [{ type: 'audio', messageId: AUDIO, start: 41, end: 47.2 }],
      },
    ],
  },
  manpower: [
    {
      companyId: 'c-apex',
      companyNameHeard: 'Apex',
      companyName: 'Apex Concrete',
      trade: 'Concrete',
      area: 'Level 4',
      workers: 7,
      hoursPerWorker: 8,
      totalHours: 56,
      hoursBasis: 'full_day_default',
      confidence: 0.95,
      source: [
        { type: 'audio', messageId: AUDIO, start: 12.4, end: 18.9 },
        { type: 'reply', messageId: REPLY },
      ],
    },
    {
      companyId: 'c-bright',
      companyNameHeard: 'BrightLine',
      companyName: 'BrightLine Electric',
      trade: 'Electrical',
      area: 'Level 3',
      workers: 5,
      hoursPerWorker: 8,
      totalHours: 40,
      hoursBasis: 'full_day_default',
      confidence: 0.92,
      source: [{ type: 'audio', messageId: AUDIO, start: 22, end: 27 }],
    },
    {
      companyId: 'c-delta',
      companyNameHeard: 'the Delta guys',
      companyName: 'Delta Mechanical',
      trade: 'HVAC',
      area: 'Level 2',
      workers: 5,
      hoursPerWorker: 8,
      totalHours: 40,
      hoursBasis: 'full_day_default',
      confidence: 0.9,
      source: [
        { type: 'audio', messageId: AUDIO, start: 29, end: 33 },
        { type: 'reply', messageId: REPLY },
      ],
    },
    {
      companyId: 'c-iron',
      companyNameHeard: 'Ironclad',
      companyName: 'Ironclad Steel',
      trade: 'Rebar',
      area: 'Level 5 deck',
      workers: 3,
      hoursPerWorker: 8,
      totalHours: 24,
      hoursBasis: 'full_day_default',
      confidence: 0.9,
      source: [{ type: 'audio', messageId: AUDIO, start: 55, end: 60 }],
    },
    {
      companyId: 'c-self',
      companyNameHeard: 'our guys',
      companyName: 'Kestrel self-perform',
      trade: 'General labor',
      area: 'Site',
      workers: 4,
      hoursPerWorker: 8,
      totalHours: 32,
      hoursBasis: 'full_day_default',
      confidence: 0.88,
      source: [{ type: 'audio', messageId: AUDIO, start: 62, end: 66 }],
    },
  ],
  workPerformed: [
    {
      area: 'Level 4',
      activity: 'Slab pour',
      status: 'complete',
      quantity: { value: 68, unit: 'yd³', heardAs: 'sixty-eight yards' },
      source: [{ type: 'audio', messageId: AUDIO, start: 12.4, end: 18.9 }],
    },
    {
      area: 'Level 3',
      activity: 'Electrical rough-in',
      status: 'in_progress',
      percentComplete: 60,
      source: [{ type: 'audio', messageId: AUDIO, start: 22, end: 27 }],
    },
    {
      area: 'Level 2',
      activity: 'Ductwork, east wing',
      status: 'in_progress',
      source: [{ type: 'audio', messageId: AUDIO, start: 29, end: 33 }],
    },
    {
      area: 'Exterior — south elevation',
      activity: 'CMU blockwork',
      status: 'stopped',
      source: [{ type: 'audio', messageId: AUDIO, start: 41, end: 47.2 }],
    },
  ],
  deliveries: [
    {
      item: 'Rebar',
      quantity: '2 loads',
      supplier: 'Ironclad Steel',
      time: '13:00',
      source: [{ type: 'audio', messageId: AUDIO, start: 70, end: 74 }],
    },
  ],
  equipment: [
    {
      item: 'Concrete pump',
      note: 'Released 14:00',
      source: [{ type: 'audio', messageId: AUDIO, start: 76, end: 79 }],
    },
  ],
  safety: {
    toolboxTalk: 'Wet-weather access',
    incidents: [],
    noIncidentsStated: true,
    visitors: [],
    source: [{ type: 'audio', messageId: AUDIO, start: 84, end: 90 }],
  },
  issues: [],
  nextWorkday: [
    {
      item: 'Concrete pump Monday 07:00 for Level 5 deck',
      source: [{ type: 'audio', messageId: AUDIO, start: 95, end: 101 }],
    },
  ],
  photos: [
    { messageId: 'p1', caption: 'L4 pour complete', takenAt: '2026-10-09T22:31:00Z' },
    { messageId: 'p2', caption: 'Rain at the south elevation', takenAt: '2026-10-09T14:05:00Z' },
  ],
  newTerms: [],
  missingRequired: [],
  lowConfidence: [],
  proposedQuestions: [],
};

/** The hero report as the PDF reads it (§10.3 v2). */
export const heroReportData: DailyReportData = upgradeV1toV2(heroReportDataV1);

/** A tiny valid 1×1 PNG, tinted grey, so sample photos render without binary fixtures. */
export const samplePng: Uint8Array = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

export const samplePhotos: PdfPhoto[] = [
  { data: samplePng, format: 'png', takenAt: '2026-10-09T22:31:00Z', caption: 'L4 pour complete' },
  {
    data: samplePng,
    format: 'png',
    takenAt: '2026-10-09T14:05:00Z',
    caption: 'Rain at the south elevation',
  },
];

export const sampleReportInput: ReportPdfInput = {
  org: {
    name: 'Kestrel Build Group',
    address: '1200 Industrial Pkwy, Austin, TX 78741',
    licenseNo: 'TX-GC-20481',
    letterheadLines: ['office@kestrelbuild.example · (555) 014-2200'],
    logo: null,
  },
  site: {
    name: 'Riverside Lofts — Block B',
    projectCode: 'RL-2041',
    address: '400 Riverside Dr, Austin, TX',
    workingHours: '07:00–15:30',
    timezone: 'America/Chicago',
  },
  report: {
    reportNo: 'RL-2041-0187',
    version: 2,
    status: 'signed_off',
    kind: 'daily',
    filedAt: '2026-10-09T22:43:00Z',
    confirmedAt: '2026-10-09T22:43:00Z',
    signedOffAt: '2026-10-10T01:10:00Z',
    signedOffByName: 'Sam Kowalski',
    isLate: false,
    reviewReasons: [],
  },
  data: heroReportData,
  reporterName: 'Marco Ruiz',
  sources: {
    audioCount: 1,
    totalAudioSeconds: 168,
    languages: ['es', 'en'],
    receivedAt: '2026-10-09T22:31:00Z',
    textCount: 0,
  },
  photos: samplePhotos,
  companies: [
    { id: 'c-apex', name: 'Apex Concrete', status: 'confirmed', isSelfPerform: false },
    { id: 'c-bright', name: 'BrightLine Electric', status: 'confirmed', isSelfPerform: false },
    { id: 'c-delta', name: 'Delta Mechanical', status: 'confirmed', isSelfPerform: false },
    { id: 'c-iron', name: 'Ironclad Steel', status: 'confirmed', isSelfPerform: false },
    { id: 'c-self', name: 'Kestrel self-perform', status: 'confirmed', isSelfPerform: true },
  ],
  edits: [
    { version: 1, author: 'agent', changeNote: null, createdAt: '2026-10-09T22:43:00Z' },
    {
      version: 2,
      author: 'reporter',
      changeNote: 'Apex Concrete 6 → 7 workers',
      createdAt: '2026-10-10T01:10:00Z',
    },
  ],
  settings: { paper: 'letter', footerEnabled: true, maxPhotos: 4 },
  generatedAt: '2026-10-10T01:12:00Z',
};

export const sampleEvidencePackInput: EvidencePackInput = {
  org: { name: 'Kestrel Build Group', logo: null },
  site: {
    name: 'Riverside Lofts — Block B',
    projectCode: 'RL-2041',
    address: '400 Riverside Dr, Austin, TX',
    timezone: 'America/Chicago',
  },
  periodStart: '2026-10-01',
  periodEnd: '2026-10-09',
  days: [
    {
      date: '2026-10-02',
      reportNo: 'RL-2041-0182',
      version: 1,
      signedOff: true,
      data: upgradeV1toV2({
        ...heroReportDataV1,
        reportDate: '2026-10-02',
        summary:
          'Rain from 06:30 to 10:00 stopped exterior masonry for 3.5 h; crew reassigned to interior blockwork. Level 3 slab prep continued.',
        weather: {
          ...heroReportDataV1.weather,
          periods: [
            {
              start: '06:30',
              end: '10:00',
              condition: 'Rain',
              impact: 'Exterior masonry stopped; crew reassigned',
              lostHours: 3.5,
              source: [{ type: 'audio', messageId: AUDIO, start: 20 }],
            },
          ],
        },
      }),
      lostHours: 3.5,
      fullDay: false,
      claimReady: true,
      transcriptExcerpts: [
        {
          start: 18.2,
          end: 24.9,
          text: 'llovió desde las seis y media hasta las diez, no pudimos hacer block afuera',
        },
        {
          start: 24.9,
          end: 31,
          text: 'so we moved everybody inside for the interior block on three',
        },
      ],
      photos: [samplePhotos[1]!],
      observed: {
        date: '2026-10-02',
        provider: 'Open-Meteo',
        fetchedAt: '2026-10-02T23:30:00Z',
        units: { precip: 'in', temp: 'F', wind: 'mph' },
        hours: Array.from({ length: 24 }, (_, h) => ({
          time: `${String(h).padStart(2, '0')}:00`,
          precipIn: h >= 6 && h <= 9 ? 0.1 : 0,
          tempF: 58 + (h > 12 ? 6 : 0),
          windMph: 9,
          gustMph: 15,
        })),
        summary: {
          precipIn: 0.4,
          tempMinF: 58,
          tempMaxF: 64,
          windMph: 9,
          gustMph: 15,
          provider: 'Open-Meteo',
          precipWorkingHoursIn: 0.3,
          maxGustWorkingHoursMph: 15,
        },
      },
      photoCount: 1,
      audioCount: 1,
    },
    {
      date: '2026-10-09',
      reportNo: 'RL-2041-0187',
      version: 2,
      signedOff: true,
      data: heroReportData,
      lostHours: 3.5,
      fullDay: false,
      claimReady: true,
      transcriptExcerpts: [
        {
          start: 41,
          end: 47.2,
          text: 'llovió desde las siete hasta las diez y media, no pudimos hacer block afuera',
        },
        {
          start: 47.2,
          end: 52,
          text: 'we lost about three and a half hours on the south elevation',
        },
      ],
      photos: samplePhotos,
      observed: null,
      photoCount: 2,
      audioCount: 1,
    },
  ],
  settings: { paper: 'letter' },
  generatedAt: '2026-10-10T09:00:00Z',
  requestedBy: 'Sam Kowalski',
};
