import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { memoryLogger } from '../log';
import type { FfmpegRunner } from '../media/ffmpeg';
import { FIXTURES_DIR } from './eval';
import { createFakeTranscriber, fakeAudio } from './fake-transcriber';
import {
  buildKeyterms,
  createOpenAiTranscriber,
  createTranscriber,
  FAKE_TRANSCRIPTION_IN_PRODUCTION,
  KEYTERMS_MAX,
  resolveTranscriberChoice,
  transcriptionLanguage,
  type TranscriptionRequest,
} from './transcriber';
import type { TranscriptionApi } from './transcribe';
import { wordErrorRate } from './transcribe-fixture';
import { loadVoiceFixtures } from './voice-fixtures';

function req(over: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
  return {
    audio: Buffer.from('real-browser-audio'),
    mime: 'audio/webm;codecs=opus',
    language: 'multi',
    keyterms: [],
    prompt: '',
    ...over,
  };
}

describe('language choice (§10.2)', () => {
  it('multi for reporters who speak English and/or Spanish, tr for Turkish, en otherwise', () => {
    // The §18 reporters.
    expect(transcriptionLanguage({ locale: 'en-US', languages: ['es', 'en'] })).toBe('multi'); // Marco
    expect(transcriptionLanguage({ locale: 'es-US', languages: ['es'] })).toBe('multi'); // Jorge
    expect(transcriptionLanguage({ locale: 'en-US', languages: ['en'] })).toBe('multi'); // Dana
    expect(transcriptionLanguage({ locale: 'tr-TR', languages: ['tr'] })).toBe('tr'); // Emre
    expect(transcriptionLanguage({ locale: 'en-US', languages: ['pl', 'en'] })).toBe('en'); // Tomasz
    expect(transcriptionLanguage({ locale: 'en-US', languages: ['en', 'hi'] })).toBe('en'); // Priya
  });

  it('a Turkish locale wins; with no languages the locale stands for them; unknown → en', () => {
    expect(transcriptionLanguage({ locale: 'tr-TR', languages: ['tr', 'en'] })).toBe('tr');
    expect(transcriptionLanguage({ locale: 'en-US', languages: ['tr'] })).toBe('tr');
    expect(transcriptionLanguage({ locale: 'es-US', languages: [] })).toBe('multi');
    expect(transcriptionLanguage({ locale: 'tr-TR', languages: [] })).toBe('tr');
    expect(transcriptionLanguage({ locale: null, languages: null })).toBe('en');
    expect(transcriptionLanguage({ locale: 'de-DE', languages: [] })).toBe('en');
  });
});

describe('key terms (§10.2)', () => {
  const glossary = [
    {
      heard: 'pour on four',
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 9,
      language: 'en',
    },
    {
      heard: 'llovió',
      kind: 'term' as const,
      status: 'built_in' as const,
      times_heard: 3,
      language: 'es',
    },
    {
      heard: 'döküm',
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 5,
      language: 'tr',
    },
    {
      heard: 'the deck',
      kind: 'term' as const,
      status: 'rejected' as const,
      times_heard: 50,
      language: 'en',
    },
    {
      heard: 'east wing',
      official: 'East wing (Level 2)',
      kind: 'area' as const,
      status: 'confirmed' as const,
      times_heard: 1,
      language: 'en',
    },
    {
      heard: 'call me at 512 555 0142',
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 99,
      language: 'en',
    },
  ];

  it('site, companies and aliases, areas (heard and official), then confirmed terms in the reporter languages', () => {
    const terms = buildKeyterms({
      siteName: 'Riverside Lofts — Block B',
      companies: [
        { name: 'Delta Mechanical', aliases: ['the Delta guys', 'Delta'] },
        { name: 'Apex Concrete', aliases: ['apex concrete'] },
      ],
      glossary,
      languages: ['es', 'en'],
    });
    expect(terms).toEqual([
      'Riverside Lofts — Block B',
      'Delta Mechanical',
      'the Delta guys',
      'Delta',
      'Apex Concrete',
      'east wing',
      'East wing (Level 2)',
      'pour on four',
      'llovió',
    ]);
    // Never a phone number, never a rejected term, never another language's term.
    expect(terms.join(' ')).not.toMatch(/555|the deck|döküm/);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      heard: `term ${i}`,
      kind: 'term' as const,
      status: 'confirmed' as const,
      times_heard: 300 - i,
    }));
    const companies = Array.from({ length: 200 }, (_, i) => ({
      name: `Company ${i}`,
      aliases: [],
    }));
    const terms = buildKeyterms({ siteName: 'S', companies, glossary: many });
    expect(terms.length).toBeLessThanOrEqual(KEYTERMS_MAX);
  });
});

describe('provider choice', () => {
  const base = testConfig();

  it('Deepgram nova-3 is the default with its key', () => {
    expect(resolveTranscriberChoice({ ...base, DEEPGRAM_API_KEY: 'k' })).toEqual({
      provider: 'deepgram',
      model: 'nova-3',
      missingKey: null,
      note: null,
    });
    expect(base.TRANSCRIBE_PROVIDER).toBe('deepgram');
  });

  it('keyless: never the fake, in any environment; every job fails naming the key', async () => {
    for (const env of ['development', 'test', 'production'] as const) {
      const config = { ...base, NODE_ENV: env };
      expect(resolveTranscriberChoice(config)).toMatchObject({
        provider: 'deepgram',
        missingKey: 'DEEPGRAM_API_KEY',
      });
      expect(resolveTranscriberChoice({ ...config, TRANSCRIBE_PROVIDER: 'openai' })).toMatchObject({
        provider: 'openai',
        missingKey: 'OPENAI_API_KEY',
      });
      const log = memoryLogger();
      const t = createTranscriber(config, {
        openai: null,
        ffmpeg: async () => ({ stdout: Buffer.alloc(0), stderr: '' }),
        log,
      });
      await expect(t.transcribe(req())).rejects.toThrow(/DEEPGRAM_API_KEY is required/);
      expect(log.lines.join('\n')).toMatch(/"level":"warn".*DEEPGRAM_API_KEY is not set/);
    }
  });

  it('refuses TRANSCRIBE_PROVIDER=fake in production', () => {
    for (const key of ['', 'k']) {
      expect(() =>
        resolveTranscriberChoice({
          ...base,
          TRANSCRIBE_PROVIDER: 'fake',
          DEEPGRAM_API_KEY: key,
          NODE_ENV: 'production',
        }),
      ).toThrow(FAKE_TRANSCRIPTION_IN_PRODUCTION);
    }
  });

  it('OpenAI as the fallback takes its own default model; an explicit model wins; fake when asked', () => {
    expect(
      resolveTranscriberChoice({ ...base, TRANSCRIBE_PROVIDER: 'openai', OPENAI_API_KEY: 'sk' }),
    ).toMatchObject({ provider: 'openai', model: 'whisper-1' });
    expect(
      resolveTranscriberChoice({
        ...base,
        TRANSCRIBE_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk',
        TRANSCRIBE_MODEL: 'gpt-4o-transcribe',
      }).model,
    ).toBe('gpt-4o-transcribe');
    expect(
      resolveTranscriberChoice({ ...base, TRANSCRIBE_PROVIDER: 'fake', DEEPGRAM_API_KEY: 'k' })
        .provider,
    ).toBe('fake');
  });

  it('createTranscriber builds the chosen one', () => {
    const deps = {
      openai: null,
      ffmpeg: (async () => ({ stdout: Buffer.alloc(0), stderr: '' })) as FfmpegRunner,
      log: memoryLogger(),
    };
    expect(createTranscriber({ ...base, DEEPGRAM_API_KEY: 'k' }, deps)).toMatchObject({
      provider: 'deepgram',
      model: 'nova-3',
    });
    expect(createTranscriber({ ...base, TRANSCRIBE_PROVIDER: 'fake' }, deps).provider).toBe('fake');
  });
});

describe('OpenAI behind the Transcriber interface', () => {
  it('runs the v1.0 pipeline (MP3, segments) on the browser file and reports provider and model', async () => {
    const ffmpeg: FfmpegRunner = async (args) => {
      if (args.includes('s16le')) return { stdout: Buffer.alloc(8000 * 2 * 30), stderr: '' }; // 30 s
      writeFileSync(args[args.length - 1]!, 'mp3');
      return { stdout: Buffer.alloc(0), stderr: '' };
    };
    const prompts: Array<string | undefined> = [];
    const api: TranscriptionApi = {
      audio: {
        transcriptions: {
          async create(p) {
            prompts.push(p.prompt);
            return {
              text: 'hello there',
              language: 'english',
              segments: [{ start: 0, end: 2, text: 'hello there' }],
            };
          },
        },
      },
    };
    const t = createOpenAiTranscriber(api, ffmpeg, 'whisper-1');
    const out = await t.transcribe(req({ prompt: 'Construction daily site report for X.' }));
    expect(out).toMatchObject({
      provider: 'openai',
      model: 'whisper-1',
      language: 'en',
      text: 'hello there',
      durationS: 30,
      segments: [{ start: 0, end: 2, text: 'hello there' }],
    });
    expect(prompts).toEqual(['Construction daily site report for X.']);
  });
});

describe('fixtures/voice and the fake transcriber', () => {
  const fixtures = loadVoiceFixtures();

  it('has EN, ES + EN (the hero, Delta headcount unclear) and TR, each consistent with its reporter and text', () => {
    const notes = fixtures.filter((f) => f.kind === 'report');
    expect(notes.map((f) => f.transcriptionLanguage).sort()).toEqual(['en', 'multi', 'tr']);
    // W2-09: spoken answers in EN, ES and TR (fixtures/answers), one too unclear to apply.
    expect(
      fixtures
        .filter((f) => f.kind === 'answer')
        .map((f) => f.id)
        .sort(),
    ).toEqual([
      'answer-en-delta-five-all-day',
      'answer-en-unclear',
      'answer-es-delta-cinco',
      'answer-tr-demirci-alti',
    ]);
    // W2-13: the Welcome screen's test recording in EN, ES + EN and TR.
    expect(
      fixtures
        .filter((f) => f.kind === 'test')
        .map((f) => f.transcriptionLanguage)
        .sort(),
    ).toEqual(['en', 'multi', 'tr']);
    for (const f of fixtures) {
      expect(transcriptionLanguage(f.reporter)).toBe(f.transcriptionLanguage);
      expect(f.text).toBe(f.segments.map((s) => s.text).join(' '));
      expect(f.durationS).toBeGreaterThanOrEqual(f.segments.at(-1)!.end);
      for (let i = 1; i < f.segments.length; i++)
        expect(f.segments[i]!.start).toBeGreaterThanOrEqual(f.segments[i - 1]!.start);
      // Never a phone number in a fixture the fake hands to the pipeline.
      expect(f.text).not.toMatch(/\d{7,}/);
    }
    const hero = notes.find((f) => f.transcriptionLanguage === 'multi')!;
    expect(hero.text).toMatch(/Delta guys were on two/);
    expect(hero.text).not.toMatch(
      /Delta[^.]*\b(\d+|one|two|three|four|five|six) (guys|men|workers)/i,
    );
  });

  it('the EN and ES + EN scripts are the golden extraction cases they name', () => {
    for (const f of fixtures.filter((x) => x.goldenCase)) {
      const golden = JSON.parse(
        readFileSync(join(FIXTURES_DIR, 'transcripts', `${f.goldenCase}.json`), 'utf8'),
      ) as { segments: Array<{ start: number; end: number; text: string }> };
      expect(f.segments).toEqual(
        golden.segments.map(({ start, end, text }) => ({ start, end, text })),
      );
    }
  });

  it('answers with the fixture a fake file names, else the first one in the requested language', async () => {
    const fake = createFakeTranscriber();
    const named = await fake.transcribe(
      req({ audio: fakeAudio('tr-kartal-2026-10-09', 46), language: 'multi' }),
    );
    expect(named).toMatchObject({
      provider: 'fake',
      model: 'fake',
      language: 'tr',
      durationS: 46,
      estCostUsd: 0,
    });
    const byLanguage = await fake.transcribe(req({ language: 'multi', durationS: 12.3 }));
    expect(byLanguage.text).toMatch(/^Okay, Friday report, Riverside Block B/);
    expect(byLanguage.durationS).toBe(12.3);
    expect((await fake.transcribe(req({ language: 'en' }))).text).toMatch(/^Elm Street, Friday/);
    expect(fake.calls.map((c) => c.fixtureId)).toEqual([
      'tr-kartal-2026-10-09',
      'es-en-riverside-2026-10-09',
      'en-elm-2026-10-02',
    ]);
    // W2-09: an answer clip gets an answer transcript in its reporter's language.
    expect((await fake.transcribe(req({ language: 'multi', purpose: 'answer' }))).text).toBe(
      'Five, all day.',
    );
    expect((await fake.transcribe(req({ language: 'tr', purpose: 'answer' }))).text).toMatch(
      /^Demirciler altı kişiydi/,
    );
    expect(fake.calls.slice(3).map((c) => c.fixtureId)).toEqual([
      'answer-en-delta-five-all-day',
      'answer-tr-demirci-alti',
    ]);
    const aborted = new AbortController();
    aborted.abort(new Error('timed out'));
    await expect(fake.transcribe(req({ signal: aborted.signal }))).rejects.toThrow(/timed out/);
  });
});

describe('the by-hand check (pnpm transcribe:fixture)', () => {
  it('scores word error rate without case or punctuation', () => {
    expect(wordErrorRate('Delta guys, todo el día.', 'delta guys todo el dia')).toBe(0.2);
    expect(wordErrorRate('Bugün hava açıktı.', 'Bugün hava açıktı')).toBe(0);
    expect(wordErrorRate('one two three four', 'one three four five')).toBe(0.5);
  });
});
