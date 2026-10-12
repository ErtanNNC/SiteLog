/**
 * "Try it on WhatsApp" scenarios: golden cases from fixtures/ (the voice-note transcript and the
 * DailyReportData the extraction must produce for it). The simulator has no AI, so where
 * production transcribes and extracts a free-form note, it replays these recorded results.
 */
import { DailyReportDataSchema, type DailyReportData } from '@sitelog/shared/schemas/report.ts';
import type { QuestionField } from '@sitelog/shared/schemas/report.ts';
import elmNoWorkExpected from '../../../../../fixtures/expected/elm-2026-10-08-no-work.json';
import elmNoWorkTranscript from '../../../../../fixtures/transcripts/elm-2026-10-08-no-work.json';
import elmRainExpected from '../../../../../fixtures/expected/elm-2026-10-02-rain-morning.json';
import elmRainTranscript from '../../../../../fixtures/transcripts/elm-2026-10-02-rain-morning.json';
import elmTextExpected from '../../../../../fixtures/expected/elm-2026-10-07-text-report.json';
import elmTextTranscript from '../../../../../fixtures/transcripts/elm-2026-10-07-text-report.json';
import hillcrestWxExpected from '../../../../../fixtures/expected/hillcrest-2026-10-06-full-weather-day.json';
import hillcrestWxTranscript from '../../../../../fixtures/transcripts/hillcrest-2026-10-06-full-weather-day.json';
import ngCorrectionExpected from '../../../../../fixtures/expected/northgate-2026-10-06-correction-near-miss.json';
import ngCorrectionTranscript from '../../../../../fixtures/transcripts/northgate-2026-10-06-correction-near-miss.json';
import ngOvertimeExpected from '../../../../../fixtures/expected/northgate-2026-10-08-overtime-pour.json';
import ngOvertimeTranscript from '../../../../../fixtures/transcripts/northgate-2026-10-08-overtime-pour.json';
import oakHeadcountExpected from '../../../../../fixtures/expected/oakmont-2026-10-08-missing-headcount.json';
import oakHeadcountTranscript from '../../../../../fixtures/transcripts/oakmont-2026-10-08-missing-headcount.json';
import pierRoofExpected from '../../../../../fixtures/expected/pier9-2026-10-09-rain-unknown-roofer.json';
import pierRoofTranscript from '../../../../../fixtures/transcripts/pier9-2026-10-09-rain-unknown-roofer.json';
import heroExpected from '../../../../../fixtures/expected/riverside-2026-10-09.json';
import heroTranscript from '../../../../../fixtures/transcripts/riverside-2026-10-09.json';
import spanishExpected from '../../../../../fixtures/expected/riverside-2026-10-07-spanish.json';
import spanishTranscript from '../../../../../fixtures/transcripts/riverside-2026-10-07-spanish.json';

/** The parts of a fixtures/transcripts/*.json file the simulator uses. */
interface TranscriptFixture {
  id: string;
  expectedQuestion: { field: string; path: string } | null;
  site: { projectCode: string };
  reportDate: string;
  reporterFirstName: string;
  companies: Array<{ id: string; name: string }>;
  photos: Array<{ messageId: string; caption?: string }>;
  segments: Array<{ messageId: string; start: number; end: number; text: string }>;
  texts?: Array<{ messageId: string; text: string }>;
}

export type ScenarioId =
  | 'riverside-2026-10-09'
  | 'oakmont-2026-10-08-missing-headcount'
  | 'pier9-2026-10-09-rain-unknown-roofer'
  | 'elm-2026-10-02-rain-morning'
  | 'northgate-2026-10-08-overtime-pour'
  | 'riverside-2026-10-07-spanish'
  | 'northgate-2026-10-06-correction-near-miss'
  | 'hillcrest-2026-10-06-full-weather-day'
  | 'elm-2026-10-08-no-work'
  | 'elm-2026-10-07-text-report';

/** What the scenario is meant to show (drives tests and the picker's tag). */
export type ScenarioOutcome = 'draft' | 'question' | 'weather_day' | 'no_work';

export interface Scenario {
  id: ScenarioId;
  /** Kestrel §18 project code: the site (and its primary reporter) the note belongs to. */
  siteCode: string;
  /** Voice note, or a typed report (F5 edge case "text instead of audio"). */
  kind: 'voice' | 'text';
  durationS: number | null;
  languages: string[];
  segments: Array<{ start: number; end: number; text: string }>;
  /** Transcript (voice) or message body (text). */
  text: string;
  /** Message ids in the fixture that the extraction's sources point at. */
  sourceMessageIds: string[];
  photos: Array<{ caption: string | null }>;
  /** The day the golden case was recorded; the simulator replays it as today. */
  recordedOn: string;
  /** What the extraction returns for this note (fixtures/expected). */
  extraction: DailyReportData;
  /** Fixture company id → name, to map onto the demo org's companies. */
  fixtureCompanies: Record<string, string>;
  expectedQuestion: { field: QuestionField; path: string } | null;
  outcome: ScenarioOutcome;
}

function build(
  t: TranscriptFixture,
  expected: unknown,
  opts: { outcome: ScenarioOutcome; durationS?: number },
): Scenario {
  const voiceIds = [...new Set(t.segments.map((s) => s.messageId))];
  const texts = t.texts ?? [];
  const kind = voiceIds.length > 0 ? 'voice' : 'text';
  const extraction = DailyReportDataSchema.parse(expected);
  const segEnd = t.segments.reduce((a, s) => Math.max(a, s.end), 0);
  return {
    id: t.id as ScenarioId,
    siteCode: t.site.projectCode,
    kind,
    durationS: kind === 'voice' ? (opts.durationS ?? Math.round(segEnd)) : null,
    languages: extraction.languageDetected.length ? extraction.languageDetected : ['en'],
    segments: t.segments.map(({ start, end, text }) => ({ start, end, text })),
    text:
      kind === 'voice'
        ? t.segments.map((s) => s.text).join(' ')
        : texts.map((x) => x.text).join('\n'),
    sourceMessageIds: kind === 'voice' ? voiceIds : texts.map((x) => x.messageId),
    photos: t.photos.map((p) => ({ caption: p.caption ?? null })),
    recordedOn: t.reportDate,
    extraction,
    fixtureCompanies: Object.fromEntries(t.companies.map((c) => [c.id, c.name])),
    expectedQuestion: t.expectedQuestion
      ? { field: t.expectedQuestion.field as QuestionField, path: t.expectedQuestion.path }
      : null,
    outcome: opts.outcome,
  };
}

/** Picker order: the hero first, then the range of what the agent does. */
export const SCENARIOS: Scenario[] = [
  // §18 hero note: 2 min 48 s (the golden transcript keeps the 67 s that matter).
  build(heroTranscript as TranscriptFixture, heroExpected, { outcome: 'question', durationS: 168 }),
  build(oakHeadcountTranscript as TranscriptFixture, oakHeadcountExpected, {
    outcome: 'question',
  }),
  build(pierRoofTranscript as TranscriptFixture, pierRoofExpected, { outcome: 'question' }),
  build(elmRainTranscript as TranscriptFixture, elmRainExpected, { outcome: 'draft' }),
  build(ngOvertimeTranscript as TranscriptFixture, ngOvertimeExpected, { outcome: 'draft' }),
  build(spanishTranscript as TranscriptFixture, spanishExpected, { outcome: 'draft' }),
  build(ngCorrectionTranscript as TranscriptFixture, ngCorrectionExpected, { outcome: 'draft' }),
  build(hillcrestWxTranscript as TranscriptFixture, hillcrestWxExpected, {
    outcome: 'weather_day',
  }),
  build(elmNoWorkTranscript as TranscriptFixture, elmNoWorkExpected, { outcome: 'no_work' }),
  build(elmTextTranscript as TranscriptFixture, elmTextExpected, { outcome: 'question' }),
];

export const HERO_SCENARIO_ID: ScenarioId = 'riverside-2026-10-09';

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
