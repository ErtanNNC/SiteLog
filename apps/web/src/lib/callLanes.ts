/**
 * A call recording's two speaker lanes (spec §11.3 `MediaPlayer`: "for calls, two lanes (reporter
 * / assistant) and a speaker filter"; W3-05). Pure: the player draws what these return.
 */
import type { TranscriptExcerpt, TranscriptSegment } from '@/data/types';
import { MAX_WAVEFORM_BARS } from './peaks';

/** The speaker filter: both lanes, the site manager's only, or the assistant's only. */
export const SPEAKER_FILTERS = ['both', 'reporter', 'agent'] as const;
export type SpeakerFilter = (typeof SPEAKER_FILTERS)[number];
export type Speaker = 'reporter' | 'agent';

/** Peaks folded (or stretched) to exactly `n` bars, each the loudest peak of its share. */
export function foldTo(peaks: readonly number[], n: number): number[] {
  if (!peaks.length || n <= 0) return [];
  return Array.from({ length: n }, (_, b) => {
    const from = Math.floor((b * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((b + 1) * peaks.length) / n));
    return Math.max(...peaks.slice(from, to));
  });
}

export interface CallLanes {
  reporter: number[];
  /** Null: one lane (a v1 call row's single array is the reporter's, `readCallPeaks`). */
  agent: number[] | null;
}

/**
 * The lanes as bars: one lane folds as a voice note does; two lanes fold to the same bar count,
 * so a bar of one lane is the same second as the bar under it.
 */
export function foldLanes(
  reporter: readonly number[],
  agent: readonly number[] | null | undefined,
  max = MAX_WAVEFORM_BARS,
): CallLanes {
  if (!agent) return { reporter: foldTo(reporter, Math.min(max, reporter.length)), agent: null };
  const n = Math.min(max, Math.max(reporter.length, agent.length));
  return {
    reporter: reporter.length ? foldTo(reporter, n) : Array.from({ length: n }, () => 0),
    agent: agent.length ? foldTo(agent, n) : Array.from({ length: n }, () => 0),
  };
}

/**
 * Whether a line of this speaker shows under the filter. A line without a speaker (a v1 call's
 * transcript) is the reporter's, as its single lane is.
 */
export function showsSpeaker(filter: SpeakerFilter, speaker: Speaker | undefined): boolean {
  if (filter === 'both') return true;
  return (speaker ?? 'reporter') === filter;
}

/** Whether a lane is dimmed by the filter. */
export function laneDimmed(filter: SpeakerFilter, lane: Speaker): boolean {
  return filter !== 'both' && filter !== lane;
}

/**
 * A call clip's excerpt lines: the excerpts (reporter lines with their mapped facts) and, before
 * each, the assistant's line that led to it (its question or prompt, muted), in time order and
 * each once. A voice note's excerpts pass through.
 */
export function callExcerptLines(
  excerpts: readonly TranscriptExcerpt[],
  segments: readonly TranscriptSegment[],
): TranscriptExcerpt[] {
  if (!segments.some((s) => s.speaker === 'agent')) return [...excerpts];
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const out = new Map<number, TranscriptExcerpt>();
  for (const e of excerpts) {
    const i = ordered.findIndex((s) => Math.abs(s.start - e.start) < 0.01);
    const before = i > 0 ? ordered[i - 1] : undefined;
    if (before?.speaker === 'agent' && !out.has(before.start))
      out.set(before.start, {
        start: before.start,
        end: before.end,
        quote: before.text,
        mapped: '',
        section: e.section,
        speaker: 'agent',
      });
    if (!out.has(e.start)) out.set(e.start, e);
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}
