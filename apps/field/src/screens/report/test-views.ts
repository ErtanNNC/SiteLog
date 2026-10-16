import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { emptyReportData, type DailyReportData } from '@sitelog/shared/schemas/report.ts';

/** Report views for the report screen tests: the §18.1 hero (Riverside Lofts, Fri Oct 9). */

export const QUESTION_ID = '11111111-0000-4000-8000-00000000f101';
const UPLOAD = '00000000-0000-4000-8000-000000000001';

const crew = (
  companyName: string,
  workers: number | null,
  hours: number | null,
  extra: Partial<DailyReportData['manpower'][number]> = {},
): DailyReportData['manpower'][number] => ({
  companyId: null,
  companyNameHeard: companyName,
  companyName,
  workers,
  hoursPerWorker: hours,
  totalHours: workers !== null && hours !== null ? workers * hours : null,
  hoursBasis: 'stated',
  confidence: 0.95,
  source: [{ type: 'voice_note', uploadId: UPLOAD, start: 12 }],
  ...extra,
});

/** The hero draft (Field-06): 23 workers, 184 h; Delta's headcount `delta` (null: the question). */
export function heroData(delta: number | null = 5): DailyReportData {
  return {
    ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Slab pour on Level 4.',
    weather: {
      conditionsText: 'Rain AM',
      periods: [
        {
          start: '07:00',
          end: '10:30',
          condition: 'Rain',
          impact: 'masonry stopped; crew moved inside',
          lostHours: 3.5,
          source: [],
        },
      ],
    },
    manpower: [
      crew('Apex Concrete', 6, 8),
      crew('BrightLine Electric', 5, 8),
      crew('Delta Mechanical', delta, 8, {
        companyNameHeard: 'the Delta guys',
        area: 'Level 2',
        hoursBasis: 'full_day_default',
        source:
          delta === null
            ? [{ type: 'voice_note', uploadId: UPLOAD, start: 80 }]
            : [
                { type: 'voice_note', uploadId: UPLOAD, start: 80 },
                { type: 'answer', questionId: QUESTION_ID },
              ],
      }),
      crew('Ironclad Steel', 3, 8),
      crew('Kestrel crew', 4, 8),
    ],
    workPerformed: [
      { area: 'Level 4', activity: 'slab pour', status: 'complete', source: [] },
      {
        area: 'Level 3',
        activity: 'electrical rough-in',
        status: 'in_progress',
        percentComplete: 60,
        source: [],
      },
    ],
    deliveries: [{ item: 'Rebar', quantity: '2 loads', supplier: 'Ironclad', source: [] }],
    safety: {
      toolboxTalk: 'Fall protection',
      incidents: [],
      noIncidentsStated: true,
      visitors: [],
      source: [],
    },
    photos: [
      { uploadId: 'p1', takenAt: '2026-10-09T22:38:00Z' },
      { uploadId: 'p2', takenAt: '2026-10-09T22:38:00Z' },
    ],
  };
}

export function reportView(patch: Partial<ReportView> = {}): ReportView {
  return {
    id: 'r1',
    reportNo: 'RL-2041-0188',
    status: 'processing',
    kind: 'daily',
    siteId: 's1',
    siteName: 'Riverside Lofts — Block B',
    date: '2026-10-09',
    channel: 'web',
    currentVersion: 1,
    needsReview: false,
    filedAt: null,
    confirmedAt: null,
    question: null,
    data: null,
    draftRev: null,
    progress: { voiceNotes: 1, transcribed: 1, photos: 2 },
    pdfUrl: null,
    addPhotos: null,
    changeNote: null,
    lastVoiceAnswer: null,
    ...patch,
  };
}

/** Awaiting an answer: Delta's headcount, with the model's two answers (Field-05) or none (D28). */
export function questionView(options: boolean | 'none' = true): ReportView {
  return reportView({
    status: 'awaiting_answer',
    data: heroData(null),
    question: {
      id: QUESTION_ID,
      field: 'manpower.workers',
      prompt: 'You said “the Delta guys” were on Level 2. How many, and for how long?',
      options:
        options === true
          ? [
              { id: 'o1', label: '4 · full day' },
              { id: 'o2', label: '5 · full day' },
            ]
          : null,
      manpowerIndex: 2,
      voice: null,
    },
  });
}

export function draftView(patch: Partial<ReportView> = {}): ReportView {
  return reportView({ status: 'awaiting_confirmation', data: heroData(5), draftRev: 1, ...patch });
}
