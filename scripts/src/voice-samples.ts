/**
 * W3-16 · the voice listening test (spec §9.1 "voices picked after listening tests", §19 Q1 "re-check
 * the TR voice quality in a listening test", PLAN_WEEK3 W3-16):
 *
 *   pnpm voice:samples                                  # every candidate voice, EN, ES and TR
 *   pnpm voice:samples -- --lang tr                     # one language
 *   pnpm voice:samples -- --voice <aura-2-…-en> …       # add a candidate (repeatable)
 *   pnpm voice:samples -- --dry-run                     # print the lines; no key, no request
 *   pnpm voice:samples -- --out <dir>                   # default: voice-samples/ (git-ignored)
 *
 * Each candidate voice reads the same lines the agent says, rendered by code exactly as on a call:
 * the disclosure (the inbound opening with the recording notice, `copy/voice.*.ts`), two read-backs
 * (`readBack()` on §18's drafts: the Riverside hero report and a rained-out day; TR the Kartal and
 * Ataşehir drafts; an ES call of an EN report says the counts, §19 Q161), and the filed goodbye. Every line is rendered twice: 24 kHz
 * (what Talk now plays) and 8 kHz (what a phone line carries), 16-bit mono WAV, named
 * `<out>/<lang>/<voice>/<line>-<rate>.wav`, with `<out>/lines.txt` listing the texts.
 *
 * Providers (spec §5.2): Deepgram Aura-2 for EN and ES (`DEEPGRAM_API_KEY`), Azure Speech for TR
 * (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, default westeurope). Keys come from the shell or the
 * root `.env`, never from the command line; without the keys a language needs the script names
 * them and exits 2. It writes only local files; nothing touches a database or a LiveKit project.
 *
 * Candidates: only voice ids the spec names (§5.1: `aura-2-thalia-en`, `aura-2-nestor-es`,
 * `tr-TR-EmelNeural`, `tr-TR-AhmetNeural`) plus `TTS_VOICE_*` when set. The ticket wants three EN
 * and three ES voices; the other two of each are the owner's pick from Deepgram's Aura-2 catalogue
 * (`--voice`), spec §19 Q225.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { Language } from '@sitelog/shared/locale.ts';
import { renderVoice } from '@sitelog/shared/copy/voice.ts';
import { readReportData } from '@sitelog/shared/report/upgrade.ts';
import type { StoredReportData } from '@sitelog/shared/schemas/report.ts';
import { readBack } from '@sitelog/shared/voice-tools.ts';
import { DEMO_TODAY, buildKestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import type { DailyReportData } from '@sitelog/shared';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXPECTED_DIR = join(REPO_ROOT, 'fixtures', 'expected');
export const DEFAULT_OUT = join(REPO_ROOT, 'voice-samples');

export const SAMPLE_LANGUAGES: readonly Language[] = ['en', 'es', 'tr'];

/** Voice ids the spec names (§5.1 env block, §19 Q1); the listening test starts from these. */
export const SPEC_VOICES: Readonly<Record<Language, readonly string[]>> = {
  en: ['aura-2-thalia-en'],
  es: ['aura-2-nestor-es'],
  tr: ['tr-TR-EmelNeural', 'tr-TR-AhmetNeural'],
};

/** How many candidates the ticket asks for per language (W3-16: three EN, three ES, both TR). */
export const WANTED_CANDIDATES: Readonly<Record<Language, number>> = { en: 3, es: 3, tr: 2 };

/** The rates rendered: Talk now's wideband and a phone line's narrowband. */
export const SAMPLE_RATES = [24_000, 8_000] as const;
export type SampleRate = (typeof SAMPLE_RATES)[number];

/** The language of a voice id (Aura-2 `aura-2-<name>-<lang>`, Azure `tr-TR-<Name>Neural`). */
export function voiceLanguage(id: string): Language | null {
  const aura = /^aura-2-[a-z]+-(en|es)$/.exec(id);
  if (aura) return aura[1] as Language;
  if (/^tr-TR-[A-Z][A-Za-z]+Neural$/.test(id)) return 'tr';
  return null;
}

export type Provider = 'deepgram' | 'azure';
export const providerOf = (lang: Language): Provider => (lang === 'tr' ? 'azure' : 'deepgram');

/** The keys each provider needs (the region has a default). */
export const PROVIDER_KEYS: Readonly<Record<Provider, readonly string[]>> = {
  deepgram: ['DEEPGRAM_API_KEY'],
  azure: ['AZURE_SPEECH_KEY'],
};

export interface SamplesArgs {
  langs: Language[];
  extraVoices: string[];
  out: string;
  dryRun: boolean;
}

export function parseSamplesArgs(
  argv: readonly string[],
  cwd = process.env.INIT_CWD ?? process.cwd(),
): SamplesArgs {
  const rest = argv.filter((a) => a !== '--');
  const args: SamplesArgs = {
    langs: [...SAMPLE_LANGUAGES],
    extraVoices: [],
    out: DEFAULT_OUT,
    dryRun: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = (name: string) => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      i += 1;
      return next;
    };
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--lang' || a.startsWith('--lang=')) {
      const langs = value('--lang')
        .split(',')
        .map((s) => s.trim());
      for (const l of langs)
        if (!(SAMPLE_LANGUAGES as readonly string[]).includes(l))
          throw new Error(`--lang takes en, es and/or tr (got "${l}")`);
      args.langs = [...new Set(langs as Language[])];
    } else if (a === '--voice' || a.startsWith('--voice=')) {
      const v = value('--voice');
      if (!voiceLanguage(v))
        throw new Error(
          `--voice takes a Deepgram Aura-2 EN/ES id (aura-2-<name>-en|es) or an Azure tr-TR neural voice (tr-TR-<Name>Neural); got "${v}"`,
        );
      args.extraVoices.push(v);
    } else if (a === '--out' || a.startsWith('--out=')) args.out = resolve(cwd, value('--out'));
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** The candidates per language: the spec's, `TTS_VOICE_*` when set, and `--voice`, in that order. */
export function candidateVoices(
  args: Pick<SamplesArgs, 'langs' | 'extraVoices'>,
  env: NodeJS.ProcessEnv,
): Record<Language, string[]> {
  const out = { en: [], es: [], tr: [] } as Record<Language, string[]>;
  const configured: Record<Language, string | undefined> = {
    en: env.TTS_VOICE_EN,
    es: env.TTS_VOICE_ES,
    tr: env.TTS_VOICE_TR,
  };
  for (const lang of SAMPLE_LANGUAGES) {
    const ids = [
      ...SPEC_VOICES[lang],
      ...(configured[lang]?.trim() && voiceLanguage(configured[lang]!.trim()) === lang
        ? [configured[lang]!.trim()]
        : []),
      ...args.extraVoices.filter((v) => voiceLanguage(v) === lang),
    ];
    out[lang] = args.langs.includes(lang) ? [...new Set(ids)] : [];
  }
  return out;
}

/** One line the candidates read. */
export interface SampleLine {
  key: 'disclosure' | 'readback' | 'readback_weather' | 'goodbye_filed';
  text: string;
}

/**
 * The reporter and site each language's lines name (spec §18.1 Marco Ruiz at Riverside, an EN/ES
 * reporter; §18.2 Emre Yıldız at Kartal, F6's TR example).
 */
export const SAMPLE_PEOPLE: Readonly<Record<Language, { first: string; site: string }>> = {
  en: { first: 'Marco', site: 'Riverside Lofts — Block B' },
  es: { first: 'Marco', site: 'Riverside Lofts — Block B' },
  tr: { first: 'Emre', site: 'Kartal Konutları — B Blok' },
};

/**
 * The drafts read back: `demo:riverside` is §18.1's hero report as filed by call on Fri Oct 9 (the
 * Kestrel demo's Riverside version 1: crew, weather, work, delivery, safety), the others golden
 * extractions (`fixtures/expected`): a rained-out day and, for TR, §18.2's Kartal and Ataşehir.
 */
export const SAMPLE_DRAFTS: Readonly<Record<Language, { report: string; weather: string }>> = {
  en: { report: 'demo:riverside', weather: 'hillcrest-weather-day' },
  es: { report: 'demo:riverside', weather: 'hillcrest-weather-day' },
  tr: { report: 'kartal-2026-10-09-tr', weather: 'atasehir-2026-10-08-rain-tr' },
};

/** §18.1's Riverside report of the demo day, version 1 (the call-filed hero). */
export function demoRiversideDraft(): DailyReportData {
  const ds = buildKestrelDemo();
  for (const v of ds.versions) {
    if (v.version !== 1) continue;
    const r = ds.reports.find((x) => x.id === v.report_id);
    const site = r && ds.sites.find((x) => x.id === r.site_id);
    const day = r && ds.siteDays.find((x) => x.id === r.site_day_id);
    if (site?.name.startsWith('Riverside') && day?.date === DEMO_TODAY)
      return readReportData(v.data as StoredReportData);
  }
  throw new Error('the Kestrel demo has no Riverside report on the demo day');
}

export function loadDraft(id: string, dir = EXPECTED_DIR): DailyReportData {
  if (id === 'demo:riverside') return demoRiversideDraft();
  return readReportData(
    JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as StoredReportData,
  );
}

/** The lines of one language, as code renders them on a call. Pure but for the drafts given. */
export function sampleLines(
  lang: Language,
  drafts: { report: DailyReportData; weather: DailyReportData },
): SampleLine[] {
  const who = SAMPLE_PEOPLE[lang];
  return [
    {
      key: 'disclosure',
      text: renderVoice('opening_inbound', lang, {
        first: who.first,
        site: who.site,
        recording_notice: renderVoice('recording_notice', lang),
      }),
    },
    { key: 'readback', text: readBack(drafts.report, lang) },
    { key: 'readback_weather', text: readBack(drafts.weather, lang) },
    { key: 'goodbye_filed', text: renderVoice('goodbye_filed', lang) },
  ];
}

export function linesFor(lang: Language, dir = EXPECTED_DIR): SampleLine[] {
  const d = SAMPLE_DRAFTS[lang];
  return sampleLines(lang, {
    report: loadDraft(d.report, dir),
    weather: loadDraft(d.weather, dir),
  });
}

/** Which keys are missing for the languages asked (empty when every request can be made). */
export function missingKeys(langs: readonly Language[], env: NodeJS.ProcessEnv): string[] {
  const providers = [...new Set(langs.map(providerOf))];
  return providers.flatMap((p) => PROVIDER_KEYS[p].filter((k) => !env[k]?.trim()));
}

export interface TtsRequest {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string };
}

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * The HTTP request for one line: Deepgram's `/v1/speak` (linear16 in a WAV container) or Azure's
 * REST TTS (SSML, `riff-<rate>-16bit-mono-pcm`). The key goes in a header, never in the URL.
 */
export function ttsRequest(
  voice: string,
  text: string,
  rate: SampleRate,
  env: NodeJS.ProcessEnv,
): TtsRequest {
  const lang = voiceLanguage(voice);
  if (!lang) throw new Error(`unknown voice ${voice}`);
  if (providerOf(lang) === 'deepgram') {
    const q = new URLSearchParams({
      model: voice,
      encoding: 'linear16',
      container: 'wav',
      sample_rate: String(rate),
    });
    return {
      url: `https://api.deepgram.com/v1/speak?${q}`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      },
    };
  }
  const region = env.AZURE_SPEECH_REGION?.trim() || 'westeurope';
  if (!/^[a-z0-9]+$/.test(region)) throw new Error(`AZURE_SPEECH_REGION is not a region name`);
  return {
    url: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    init: {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY ?? '',
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': `riff-${rate / 1000}khz-16bit-mono-pcm`,
        'User-Agent': 'sitelog-voice-samples',
      },
      body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="tr-TR"><voice name="${xml(voice)}">${xml(text)}</voice></speak>`,
    },
  };
}

export const sampleFile = (
  out: string,
  lang: Language,
  voice: string,
  key: string,
  rate: SampleRate,
) => join(out, lang, voice, `${key}-${rate / 1000}k.wav`);

export interface SamplesDeps {
  env: NodeJS.ProcessEnv;
  fetch: (
    url: string,
    init: TtsRequest['init'],
  ) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
  write: (path: string, bytes: Uint8Array | string) => void;
  log: (line: string) => void;
  expectedDir?: string;
}

/** Renders every candidate × line × rate; returns the exit code (0 done, 1 a request failed, 2 refused). */
export async function runVoiceSamples(argv: readonly string[], deps: SamplesDeps): Promise<number> {
  const args = parseSamplesArgs(argv);
  const voices = candidateVoices(args, deps.env);
  const lines = Object.fromEntries(
    args.langs.map((l) => [l, linesFor(l, deps.expectedDir)]),
  ) as Partial<Record<Language, SampleLine[]>>;

  const listing: string[] = [];
  for (const lang of args.langs) {
    listing.push(`[${lang}] voices: ${voices[lang].join(', ')}`);
    for (const line of lines[lang]!) listing.push(`  ${line.key}: ${line.text}`);
    if (voices[lang].length < WANTED_CANDIDATES[lang])
      listing.push(
        `  (${voices[lang].length} of ${WANTED_CANDIDATES[lang]} candidates: add the others with --voice, spec §19 Q225)`,
      );
  }
  if (args.dryRun) {
    for (const l of listing) deps.log(l);
    return 0;
  }
  const missing = missingKeys(args.langs, deps.env);
  if (missing.length) {
    deps.log(
      `voice:samples needs ${missing.join(' and ')} (in the shell or the root .env) for ${args.langs.join(', ')}; ` +
        'Deepgram for EN/ES, Azure Speech for TR. Use --lang to render one provider, or --dry-run to print the lines.',
    );
    return 2;
  }
  deps.write(join(args.out, 'lines.txt'), `${listing.join('\n')}\n`);
  let failed = 0;
  let written = 0;
  for (const lang of args.langs) {
    for (const voice of voices[lang]) {
      for (const line of lines[lang]!) {
        for (const rate of SAMPLE_RATES) {
          const req = ttsRequest(voice, line.text, rate, deps.env);
          const res = await deps.fetch(req.url, req.init);
          if (!res.ok) {
            failed += 1;
            // The status only: a provider's error body may echo the request.
            deps.log(`FAIL ${lang} ${voice} ${line.key} ${rate} Hz: HTTP ${res.status}`);
            continue;
          }
          const path = sampleFile(args.out, lang, voice, line.key, rate);
          deps.write(path, new Uint8Array(await res.arrayBuffer()));
          written += 1;
        }
      }
      deps.log(`${lang} ${voice}: done`);
    }
  }
  deps.log(
    `${written} file(s) in ${args.out}${failed ? `, ${failed} failed` : ''}; the texts are in lines.txt.`,
  );
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Keys from the shell first, then the root .env (never overriding the shell).
  const rootEnv = join(REPO_ROOT, '.env');
  if (existsSync(rootEnv)) loadDotenv({ path: rootEnv, quiet: true });
  runVoiceSamples(process.argv.slice(2), {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    write: (path, bytes) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
    log: (line) => console.log(line),
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`voice:samples: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
