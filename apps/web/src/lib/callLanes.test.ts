import { describe, expect, it } from 'vitest';
import type { TranscriptExcerpt, TranscriptSegment } from '@/data/types';
import { callExcerptLines, foldLanes, foldTo, laneDimmed, showsSpeaker } from './callLanes';

describe('call lanes (W3-05, §11.3)', () => {
  it('folds peaks to exactly n bars, each the loudest of its share, and stretches short lanes', () => {
    expect(foldTo([0.1, 0.9, 0.2, 0.4], 2)).toEqual([0.9, 0.4]);
    expect(foldTo([0.1, 0.5], 4)).toEqual([0.1, 0.1, 0.5, 0.5]);
    expect(foldTo([], 4)).toEqual([]);
  });

  it('folds two lanes to the same bar count, so a bar is the same second in both', () => {
    const reporter = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.8 : 0.02));
    const agent = Array.from({ length: 96 }, (_, i) => (i < 48 ? 0.02 : 0.7));
    const lanes = foldLanes(reporter, agent, 64);
    expect(lanes.reporter).toHaveLength(64);
    expect(lanes.agent).toHaveLength(64);
    // The first half is the reporter's, the second the assistant's, in both lanes.
    expect(lanes.reporter[10]).toBe(0.8);
    expect(lanes.agent![10]).toBe(0.02);
    expect(lanes.reporter[60]).toBe(0.02);
    expect(lanes.agent![60]).toBe(0.7);
  });

  it('keeps a v1 single array as one lane', () => {
    const lanes = foldLanes([0.2, 0.4, 0.6], null);
    expect(lanes).toEqual({ reporter: [0.2, 0.4, 0.6], agent: null });
  });

  it('draws an empty lane flat when the other has peaks', () => {
    expect(foldLanes([0.5, 0.5], []).agent).toEqual([0, 0]);
  });

  it('filters lines by speaker; a line without a speaker is the reporter’s', () => {
    expect(showsSpeaker('both', 'agent')).toBe(true);
    expect(showsSpeaker('reporter', 'agent')).toBe(false);
    expect(showsSpeaker('reporter', undefined)).toBe(true);
    expect(showsSpeaker('agent', undefined)).toBe(false);
    expect(showsSpeaker('agent', 'agent')).toBe(true);
    expect(laneDimmed('both', 'agent')).toBe(false);
    expect(laneDimmed('reporter', 'agent')).toBe(true);
    expect(laneDimmed('reporter', 'reporter')).toBe(false);
  });

  it('puts the assistant’s line before each quoted reporter line, once each', () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 9.5, text: 'Hi Kevin, tell me about today.', speaker: 'agent' },
      { start: 10, end: 19, text: 'Apex, 3 guys, 8 hours.', speaker: 'reporter' },
      { start: 19.5, end: 21, text: 'Our crew, 8 guys.', speaker: 'reporter' },
      { start: 41.3, end: 49.7, text: 'Got it. What else?', speaker: 'agent' },
      { start: 50, end: 59, text: 'Glazing units came in.', speaker: 'reporter' },
    ];
    const ex = (start: number, end: number, quote: string): TranscriptExcerpt => ({
      start,
      end,
      quote,
      mapped: 'facts',
      section: 'manpower',
      speaker: 'reporter',
    });
    const lines = callExcerptLines(
      [ex(10, 19, 'Apex, 3 guys, 8 hours.'), ex(19.5, 21, 'Our crew, 8 guys.'), ex(50, 59, 'x')],
      segments,
    );
    expect(lines.map((l) => [l.start, l.speaker, l.mapped])).toEqual([
      [0, 'agent', ''],
      [10, 'reporter', 'facts'],
      [19.5, 'reporter', 'facts'],
      [41.3, 'agent', ''],
      [50, 'reporter', 'facts'],
    ]);
  });

  it('leaves a voice note’s excerpts as they are', () => {
    const e: TranscriptExcerpt = { start: 3, end: 8, quote: 'q', mapped: 'm', section: 'other' };
    expect(callExcerptLines([e], [{ start: 0, end: 8, text: 'q' }])).toEqual([e]);
  });
});
