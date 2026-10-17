import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderVoice } from '@sitelog/shared/copy/voice.ts';
import {
  DEFAULT_OUT,
  SAMPLE_RATES,
  SPEC_VOICES,
  candidateVoices,
  linesFor,
  missingKeys,
  parseSamplesArgs,
  runVoiceSamples,
  sampleFile,
  ttsRequest,
  voiceLanguage,
  type SamplesDeps,
} from './voice-samples.ts';

/**
 * W3-16: the listening test's text half (which lines, in which language, rendered by code as on a
 * call), the candidates, the requests per provider, and the refusal without keys. No network.
 */

describe('the lines each language reads', () => {
  it('EN: the disclosure with the recording notice, the hero read-back, the weather day, the goodbye', () => {
    const lines = linesFor('en');
    expect(lines.map((l) => l.key)).toEqual([
      'disclosure',
      'readback',
      'readback_weather',
      'goodbye_filed',
    ]);
    expect(lines[0]!.text).toBe(
      "SiteLog, hi Marco. This call is recorded to write your daily report. Go ahead with today's report for Riverside Lofts — Block B.",
    );
    expect(lines[1]!.text).toMatch(
      /^Here's what I've got: twenty-three on site from five companies, one hundred eighty-four hours\. Weather stopped work for three and a half hours\..*Shall I file it\?$/,
    );
    expect(lines[2]!.text).toContain('Weather stopped work for five hours.');
    expect(lines[3]!.text).toBe(renderVoice('goodbye_filed', 'en'));
  });

  it("ES: the call language's copy; an EN report's lines are said as counts (§19 Q161)", () => {
    const lines = linesFor('es');
    expect(lines[0]!.text).toContain(renderVoice('recording_notice', 'es'));
    expect(lines[0]!.text).toContain('Marco');
    expect(lines[1]!.text).toMatch(
      /^Esto es lo que tengo: veintitrés en la obra de cinco empresas, ciento ochenta y cuatro horas\./,
    );
    expect(lines[1]!.text).toContain('Trabajos anotados: tres.');
    expect(lines[1]!.text).not.toContain('slab pour');
    expect(lines[3]!.text).toBe(renderVoice('goodbye_filed', 'es'));
  });

  it('TR: Turkish copy, numbers said as words (W4-07), Turkish characters kept', () => {
    const lines = linesFor('tr');
    expect(lines[0]!.text).toContain('Emre');
    expect(lines[0]!.text).toContain(renderVoice('recording_notice', 'tr'));
    expect(lines[0]!.text).toContain('Kartal Konutları — B Blok');
    expect(lines[1]!.text).toMatch(/Kaydedeyim mi\?$/);
    expect(lines[2]!.text).toContain('üç buçuk saat');
    for (const l of lines) expect(l.text, l.key).not.toMatch(/\d/);
    expect(lines.every((l) => l.text.length > 0)).toBe(true);
  });
});

describe('candidates', () => {
  it('only the voice ids the spec names, plus TTS_VOICE_* and --voice', () => {
    expect(SPEC_VOICES).toEqual({
      en: ['aura-2-thalia-en'],
      es: ['aura-2-nestor-es'],
      tr: ['tr-TR-EmelNeural', 'tr-TR-AhmetNeural'],
    });
    const args = parseSamplesArgs(['--voice', 'aura-2-zeus-en', '--voice=aura-2-thalia-en'], '/r');
    expect(
      candidateVoices(args, { TTS_VOICE_ES: 'aura-2-other-es', TTS_VOICE_TR: 'aura-2-bad-en' }),
    ).toEqual({
      en: ['aura-2-thalia-en', 'aura-2-zeus-en'],
      es: ['aura-2-nestor-es', 'aura-2-other-es'],
      tr: ['tr-TR-EmelNeural', 'tr-TR-AhmetNeural'],
    });
    expect(candidateVoices(parseSamplesArgs(['--lang', 'tr'], '/r'), {}).en).toEqual([]);
  });

  it('voice ids by provider; anything else refused', () => {
    expect(voiceLanguage('aura-2-thalia-en')).toBe('en');
    expect(voiceLanguage('aura-2-nestor-es')).toBe('es');
    expect(voiceLanguage('tr-TR-AhmetNeural')).toBe('tr');
    expect(voiceLanguage('aura-asteria-en')).toBeNull();
    expect(() => parseSamplesArgs(['--voice', 'en-US-JennyNeural'])).toThrow(/--voice takes/);
    expect(() => parseSamplesArgs(['--lang', 'de'])).toThrow(/--lang/);
    expect(() => parseSamplesArgs(['--key', 'x'])).toThrow(/unknown argument/);
    expect(parseSamplesArgs([], '/r').out).toBe(DEFAULT_OUT);
    expect(parseSamplesArgs(['--out', 'x'], '/r').out).toBe(join('/r', 'x'));
  });
});

describe('requests', () => {
  const env = {
    DEEPGRAM_API_KEY: 'dg-key',
    AZURE_SPEECH_KEY: 'az-key',
    AZURE_SPEECH_REGION: 'westeurope',
  };

  it('Deepgram Aura-2: /v1/speak, WAV at the rate, the key in the header only', () => {
    const r = ttsRequest('aura-2-thalia-en', 'Shall I file it?', 8000, env);
    expect(r.url).toBe(
      'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&container=wav&sample_rate=8000',
    );
    expect(r.init.headers.Authorization).toBe('Token dg-key');
    expect(JSON.parse(r.init.body)).toEqual({ text: 'Shall I file it?' });
    expect(r.url).not.toContain('dg-key');
  });

  it('Azure: SSML with the voice and escaped text, RIFF PCM at the rate', () => {
    const r = ttsRequest('tr-TR-EmelNeural', 'Usta & Volt <test>', 24000, env);
    expect(r.url).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(r.init.headers['X-Microsoft-OutputFormat']).toBe('riff-24khz-16bit-mono-pcm');
    expect(r.init.headers['Ocp-Apim-Subscription-Key']).toBe('az-key');
    expect(r.init.body).toContain(
      '<voice name="tr-TR-EmelNeural">Usta &amp; Volt &lt;test&gt;</voice>',
    );
    expect(r.init.body).toContain('xml:lang="tr-TR"');
    expect(ttsRequest('tr-TR-AhmetNeural', 'x', 8000, {}).url).toContain('westeurope.');
    expect(() =>
      ttsRequest('tr-TR-AhmetNeural', 'x', 8000, { AZURE_SPEECH_REGION: 'evil.com/x' }),
    ).toThrow(/region/);
  });

  it('names the keys a language needs', () => {
    expect(missingKeys(['en', 'es', 'tr'], {})).toEqual(['DEEPGRAM_API_KEY', 'AZURE_SPEECH_KEY']);
    expect(missingKeys(['tr'], { AZURE_SPEECH_KEY: 'k' })).toEqual([]);
    expect(missingKeys(['es'], { DEEPGRAM_API_KEY: ' ' })).toEqual(['DEEPGRAM_API_KEY']);
  });
});

describe('runVoiceSamples', () => {
  function deps(env: NodeJS.ProcessEnv, status = 200) {
    const calls: string[] = [];
    const files = new Map<string, Uint8Array | string>();
    const log: string[] = [];
    const d: SamplesDeps = {
      env,
      fetch: async (url) => {
        calls.push(url);
        return {
          ok: status === 200,
          status,
          arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer,
        };
      },
      write: (path, bytes) => files.set(path, bytes),
      log: (l) => log.push(l),
    };
    return { d, calls, files, log };
  }

  it('without keys: names them, exits 2, requests nothing', async () => {
    const { d, calls, files, log } = deps({});
    expect(await runVoiceSamples([], d)).toBe(2);
    expect(log.join('\n')).toContain('needs DEEPGRAM_API_KEY and AZURE_SPEECH_KEY');
    expect(calls).toEqual([]);
    expect(files.size).toBe(0);
  });

  it('--dry-run prints the lines with no key and no request', async () => {
    const { d, calls, log } = deps({});
    expect(await runVoiceSamples(['--dry-run'], d)).toBe(0);
    expect(calls).toEqual([]);
    expect(log.join('\n')).toContain('[tr] voices: tr-TR-EmelNeural, tr-TR-AhmetNeural');
    expect(log.join('\n')).toContain('1 of 3 candidates');
  });

  it('renders every voice × line × rate, then lists the texts', async () => {
    const { d, calls, files } = deps({ AZURE_SPEECH_KEY: 'k' });
    expect(await runVoiceSamples(['--lang', 'tr', '--out', '/tmp/s'], d)).toBe(0);
    expect(calls).toHaveLength(2 * 4 * SAMPLE_RATES.length);
    expect([...files.keys()]).toContain(
      sampleFile('/tmp/s', 'tr', 'tr-TR-AhmetNeural', 'readback', 8000),
    );
    expect(String(files.get(join('/tmp/s', 'lines.txt')))).toContain(
      'disclosure: SiteLog, merhaba Emre.',
    );
  });

  it('a failed request is counted, with the status only', async () => {
    const { d, log } = deps({ DEEPGRAM_API_KEY: 'secret-k' }, 401);
    expect(await runVoiceSamples(['--lang', 'en', '--out', '/tmp/s'], d)).toBe(1);
    expect(log.join('\n')).toContain('HTTP 401');
    expect(log.join('\n')).not.toContain('secret-k');
  });
});
