import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildTranscriptionPrompt,
  firstWords,
  isUnintelligible,
  normaliseLanguage,
  stitchLanguages,
  transcribeAudio,
  type TranscriptionApi,
} from './transcribe';
import type { FfmpegRunner } from '../media/ffmpeg';

describe('transcription prompt', () => {
  it('lists site, companies, aliases and top glossary terms within the length cap', () => {
    const prompt = buildTranscriptionPrompt({
      siteName: 'Riverside Lofts — Block B',
      companies: [
        { name: 'Ironclad Steel', aliases: ['Ironclad'] },
        { name: 'BrightLine Electric', aliases: ['BrightLine'] },
      ],
      glossary: Array.from({ length: 80 }, (_, i) => ({
        heard: `term${i}`,
        status: i % 2 ? 'confirmed' : 'rejected',
        times_heard: 100 - i,
      })),
    });
    expect(prompt).toContain('Riverside Lofts');
    expect(prompt).toContain('Ironclad Steel');
    expect(prompt).toContain('BrightLine');
    expect(prompt).toContain('term1,');
    expect(prompt).not.toContain('term0,');
    expect(prompt.length).toBeLessThanOrEqual(700);
  });
});

describe('transcript helpers', () => {
  it('flags fewer than 5 words as unintelligible and takes the first 12 words', () => {
    expect(isUnintelligible('uh what')).toBe(true);
    expect(isUnintelligible('we poured the deck on four today')).toBe(false);
    expect(
      firstWords('one two three four five six seven eight nine ten eleven twelve thirteen.'),
    ).toBe('one two three four five six seven eight nine ten eleven twelve');
  });
  it('normalises languages', () => {
    expect(stitchLanguages(['spanish', 'english', 'es'])).toBe('es+en');
    expect(normaliseLanguage('Polish')).toBe('pl');
  });
});

describe('transcribeAudio with a mocked API and ffmpeg', () => {
  const fakeFfmpeg: FfmpegRunner = async (args) => {
    if (args.includes('s16le')) return { stdout: Buffer.alloc(8000 * 2 * 1300), stderr: '' }; // 1300 s
    writeFileSync(args[args.length - 1]!, 'mp3'); // conversion / chunk commands write their output file
    return { stdout: Buffer.alloc(0), stderr: '' };
  };

  it('splits > 15 min audio into chunks and offsets the segments', async () => {
    const calls: number[] = [];
    const api: TranscriptionApi = {
      audio: {
        transcriptions: {
          async create(params) {
            calls.push(params.file.size);
            expect(params.response_format).toBe('verbose_json');
            expect(params.timestamp_granularities).toEqual(['segment']);
            const n = calls.length;
            return {
              text: `chunk ${n}`,
              language: n === 1 ? 'spanish' : 'english',
              segments: [{ start: 1, end: 5, text: `seg ${n}` }],
            };
          },
        },
      },
    };
    const res = await transcribeAudio(api, fakeFfmpeg, {
      audio: Buffer.from('ogg'),
      ext: 'ogg',
      model: 'whisper-1',
      prompt: 'p',
    });
    expect(res.chunks).toBe(3);
    expect(calls).toHaveLength(3);
    expect(res.segments.map((s) => s.start)).toEqual([1, 434.33, 867.67]);
    expect(res.language).toBe('es+en');
    expect(res.text).toBe('chunk 1 chunk 2 chunk 3');
    expect(res.durationS).toBe(1300);
    expect(res.estCostUsd).toBeCloseTo(0.13, 2);
  });

  it('falls back to json when verbose_json is rejected', async () => {
    let n = 0;
    const api: TranscriptionApi = {
      audio: {
        transcriptions: {
          async create(params) {
            n++;
            if (params.response_format === 'verbose_json')
              throw new Error("response_format 'verbose_json' is not supported for this model");
            return { text: 'hello there everyone on site' };
          },
        },
      },
    };
    const res = await transcribeAudio(api, fakeFfmpeg, {
      audio: Buffer.from('ogg'),
      ext: 'ogg',
      model: 'gpt-4o-transcribe',
      prompt: 'p',
      durationS: 30,
    });
    expect(n).toBe(2);
    expect(res.segments).toEqual([{ start: 0, end: 30, text: 'hello there everyone on site' }]);
  });
});
