import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toObservedIn,
  weatherHoursIn,
  weatherUnitLabels,
  type DailyReportData,
  type ReportLanguage,
  type ReporterLocale,
  type SiteDayWeather,
  type UnitSystem,
} from '@sitelog/shared';
import type { ExtractionCompany, ExtractionGlossaryTerm } from './extraction';

export { buildOrgContextBlock } from './extraction';

/**
 * Extraction v2 (spec §10.4; W1-12, GAP D24): the system prompt is `extract.v2.md`, the spec's
 * text verbatim (a test compares the two), followed by the source-format note as a separate cached
 * block: the spec's prompt names the source kinds but not their JSON, and the tool needs the ids
 * (README "Deliberate deviations"). The user message is the v1 template plus REPORT_LANGUAGE,
 * UNITS, REPORTER_LOCALE, CHANNEL and WORKING_HOURS, with OBSERVED_WEATHER in the org's units.
 * Every block goes through `redactPhones` in `callTool` before it leaves the worker.
 */

const PROMPT_FILE = 'extract.v2.md';

/** Where `extract.v2.md` is: next to this file in the source tree, `dist/prompts` in the bundle. */
export function promptPath(file = PROMPT_FILE): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, file),
    join(here, 'prompts', file),
    join(here, 'ai', 'prompts', file),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`${file} not found; looked in ${candidates.join(', ')}`);
}

let cached: string | null = null;

/** §10.4 system prompt (v2), verbatim. */
export function extractionSystemPromptV2(): string {
  cached ??= readFileSync(promptPath(), 'utf8').trimEnd();
  return cached;
}

/** The source bookkeeping the tool schema needs (a separate cached system block): spec §10.4 "Source-format note (v2)" verbatim (§19 Q59). */
export const EXTRACTION_V2_SOURCE_NOTE = `Source format: each voice note in the input carries an uploadId. A voice-note source is
{"type":"voice_note","uploadId":"<uploadId of that voice note>","start":<segment start seconds>,"end":<segment end seconds>};
a value from an earlier answer is {"type":"answer","questionId":"<questionId of that answer>"}.
A proposedQuestions field is the path of the gap it fills as written in missingRequired or lowConfidence.
Do not output photos, schemaVersion, reportDate, reportLanguage, units or weather.observed — the system adds them.`;

export interface ExtractionSegmentV2 {
  uploadId: string;
  start: number;
  end: number;
  text: string;
}

export interface ExtractionInputV2 {
  site: { name: string; projectCode: string; timezone: string; workingHours: string | null };
  reportDate: string;
  /** The org's report language (§9.6). */
  reportLanguage: ReportLanguage;
  /** The org's units: quantities and OBSERVED_WEATHER are given and written in them. */
  units: UnitSystem;
  /** The reporter's locale: proposedQuestions are written in it (rule 11). */
  reporterLocale: ReporterLocale;
  channel: 'web' | 'call';
  defaultShiftHours: number;
  requiredFields: string[];
  companies: ExtractionCompany[];
  glossary: ExtractionGlossaryTerm[];
  rejectedMappings: Array<{ heard: string; official: string }>;
  observedWeather: SiteDayWeather | null;
  previousAnswers: Array<{ field: string; question: string; answer: string; questionId: string }>;
  previousDraft: DailyReportData | null;
  photos: Array<{ uploadId: string; caption?: string; takenAt: string }>;
  /** Voice notes: segments grouped by upload in arrival order. */
  segments: ExtractionSegmentV2[];
  reporterFirstName: string;
}

function fmtSeconds(s: number): string {
  return (Math.round(s * 10) / 10).toFixed(1);
}

const fmt = (v: number | null) => (v === null ? '?' : String(v));

/** OBSERVED_WEATHER in the org's units (§10.11: "units per org"). */
export function formatObservedWeatherIn(w: SiteDayWeather | null, units: UnitSystem): string {
  if (!w) return 'not available';
  const u = weatherUnitLabels(units);
  const decimals = units === 'metric' ? 1 : 2;
  const hours = weatherHoursIn(w, units)
    .filter((h) => h.precip > 0 || h.gust !== null)
    .slice(0, 24)
    .map(
      (h) =>
        `${h.time} precip ${h.precip.toFixed(decimals)} ${u.precip}, temp ${fmt(h.temp)} ${u.temp}, wind ${fmt(h.wind)} ${u.wind}, gusts ${fmt(h.gust)} ${u.wind}`,
    );
  // The day's figures as weather.observed carries them (the same conversion, §10.3).
  const o = toObservedIn(w, units);
  const summary = [
    `day total precip ${o.precip.toFixed(decimals)} ${u.precip}`,
    `temp ${o.tempMin}–${o.tempMax} ${u.temp}`,
    `wind ${o.wind} ${u.wind}`,
    `max gust ${o.gust ?? '?'} ${u.wind}`,
  ].join(' · ');
  return `${summary} (${w.provider})\n${hours.join('\n')}`;
}

const UNIT_WORDS: Record<UnitSystem, string> = {
  imperial: 'imperial (in, °F, mph, yd³, ft)',
  metric: 'metric (mm, °C, km/h, m³, m)',
};

/** §10.4 user message template, v2 (COMPANIES / GLOSSARY / REJECTED live in the cached block). */
export function buildExtractionUserMessageV2(input: ExtractionInputV2): string {
  const lines: string[] = [
    `SITE: ${input.site.name} (${input.site.projectCode}) · time zone ${input.site.timezone}`,
    `REPORT_DATE: ${input.reportDate}`,
    `REPORT_LANGUAGE: ${input.reportLanguage}`,
    `UNITS: ${UNIT_WORDS[input.units]}`,
    `REPORTER_LOCALE: ${input.reporterLocale}`,
    `CHANNEL: ${input.channel}`,
    `WORKING_HOURS: ${input.site.workingHours ?? 'not set'}`,
    `DEFAULT_SHIFT_HOURS: ${input.defaultShiftHours}`,
    `REQUIRED_FIELDS: ${input.requiredFields.join(', ')}`,
    `REPORTER: ${input.reporterFirstName}`,
    `OBSERVED_WEATHER (hourly, local): ${formatObservedWeatherIn(input.observedWeather, input.units)}`,
    `PREVIOUS ANSWERS: ${JSON.stringify(input.previousAnswers)}`,
    `PREVIOUS DRAFT (if merging): ${input.previousDraft ? JSON.stringify(input.previousDraft) : 'none'}`,
    `PHOTOS: ${JSON.stringify(input.photos)}`,
    'TRANSCRIPT SEGMENTS:',
  ];
  const byUpload = new Map<string, ExtractionSegmentV2[]>();
  for (const s of input.segments) {
    const list = byUpload.get(s.uploadId) ?? [];
    list.push(s);
    byUpload.set(s.uploadId, list);
  }
  if (byUpload.size === 0) lines.push('(no voice note)');
  for (const [uploadId, segs] of byUpload) {
    lines.push(`VOICE NOTE uploadId=${uploadId}`);
    for (const s of segs)
      lines.push(`[${fmtSeconds(s.start)}–${fmtSeconds(s.end)}] ${s.text.trim()}`);
  }
  return lines.join('\n');
}
