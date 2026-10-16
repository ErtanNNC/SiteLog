import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import {
  ExtractionOutputSchema,
  ReportExtractionSchema,
  downgradeExtractionV2,
  type ClassifiedReply,
  type CorrectionResult,
  type DayOffClassification,
  type ExtractionOutput,
  type ParsedAnswer,
  type ReportExtraction,
} from '@sitelog/shared';
import type { Config } from '../config';
import type { Logger } from '../log';
import { loadAnswerCases, type AnswerCase } from './answer-fixtures';
import { createAnthropicClient, type MessagesClient } from './claude';
import { FIXTURES_DIR, findPhoneNumbers, loadFixtures, type EvalFixture } from './eval';

/**
 * The fake extraction provider (`EXTRACT_PROVIDER=fake`): a Messages client that answers every
 * tool the worker calls (submit_daily_report, classify_reply, parse_answer, apply_correction,
 * classify_day_off, guess_site) from the golden set, with no network and no key. parse_answer
 * answers from fixtures/answers (W2-09) when the reply is one of its transcripts. It mirrors the
 * fake transcriber (`TRANSCRIBE_PROVIDER=fake`): the integration harness and the load test use it
 * with simulated latency, and a keyless worker outside production uses it so the whole field flow
 * (record → transcript → draft → question → answer → filed) runs without Anthropic. The
 * extraction is the recorded tool output (fixtures/tool-outputs, generated from fixtures/expected)
 * of the case whose transcript is in the request, which is the case the fake transcriber's
 * fixtures/voice note is the script of; any other transcript gets the hero case (Riverside,
 * the Delta crew without a headcount, so one question is asked).
 */

// ───────────────────────────── Fixtures ─────────────────────────────

export interface FixtureCase {
  id: string;
  fixture: EvalFixture;
  /** The tool output in v1 terms, for the WhatsApp worker's extraction (until step 22). */
  recorded: ExtractionOutput;
  /** The tool output as the golden set holds it (v2, W1-12), for the web recorder's extraction. */
  recordedV2: ReportExtraction;
  /** The (first) voice note of the case: its fixture message id and segments. */
  voiceMessageId: string;
  segments: Array<{ start: number; end: number; text: string }>;
  photoIds: string[];
  /** Note length in seconds (last segment end, rounded up). */
  durationS: number;
  language: string;
}

export interface FixtureLibrary {
  ids: string[];
  get(id: string): FixtureCase;
  /** The case whose transcript appears in `text` (first segment match), if any. */
  findInText(text: string): FixtureCase | null;
  replies: RecordedReplies;
}

export interface RecordedReplies {
  apply_correction: Record<string, CorrectionResult>;
  parse_answer: Record<string, ParsedAnswer>;
  classify_reply: Record<string, ClassifiedReply>;
  classify_day_off: Record<string, DayOffClassification>;
}

/**
 * The golden cases (fixtures/transcripts + tool-outputs) that are ONE voice note: those are what a
 * single webhook audio message can replay. `filter` narrows by id substring.
 */
export function loadFixtureLibrary(filter: string[] = []): FixtureLibrary {
  const cases = new Map<string, FixtureCase>();
  for (const f of loadFixtures(FIXTURES_DIR, filter)) {
    if (!f.recorded) continue;
    const voiceIds = Array.from(new Set(f.input.segments.map((s) => s.uploadId)));
    if (voiceIds.length !== 1 || f.whatsappText) continue;
    const voiceMessageId = voiceIds[0]!;
    const segments = f.input.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
    const lang = f.recorded.languageDetected.includes('es')
      ? f.recorded.languageDetected.includes('en')
        ? 'english'
        : 'spanish'
      : 'english';
    cases.set(f.id, {
      id: f.id,
      fixture: f,
      // v1 is US English imperial only; a Turkish case replays on the web path only.
      recorded: downgradeExtractionV2(f.recorded),
      recordedV2: f.recorded,
      voiceMessageId,
      segments,
      photoIds: f.input.photos.map((p) => p.uploadId),
      durationS: Math.max(5, Math.ceil(Math.max(...segments.map((s) => s.end)))),
      language: lang,
    });
  }
  const replies = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'tool-outputs', 'replies.json'), 'utf8'),
  ) as RecordedReplies;
  return {
    ids: Array.from(cases.keys()),
    get(id) {
      const c = cases.get(id);
      if (!c) throw new Error(`fixture ${id} is not a single-voice-note case`);
      return c;
    },
    findInText(text) {
      for (const c of cases.values()) {
        const first = c.segments[0]?.text.trim();
        if (first && text.includes(first)) return c;
      }
      return null;
    },
    replies,
  };
}

// ───────────────────────────── Claude ─────────────────────────────

export interface FakeClaudeCall {
  tool: string;
  fixtureId?: string;
  /** Extraction requested while no transcript or text was in the input. */
  noContent?: boolean;
  /** No golden case matched the transcript: the default case answered. */
  fallback?: boolean;
}

export interface FakeClaude extends MessagesClient {
  calls: FakeClaudeCall[];
  /** Phone numbers found in any request (must stay empty, §15 privacy). */
  phoneLeaks: string[];
}

/** The kind of model call, for a harness that simulates latency per kind. */
export type FakeClaudeCallKind = 'claude' | 'claudeFast' | 'claudeCorrection';

export interface FixtureClaudeOptions {
  /** The fixture library, or a loader called on the first request (keyless runs load lazily). */
  lib: FixtureLibrary | (() => FixtureLibrary);
  /** Runs before each answer (the integration harness's latency and transient failures). */
  beforeCall?: (kind: FakeClaudeCallKind) => Promise<void>;
  /**
   * submit_daily_report for a transcript no golden case matches: this case's recorded output
   * (remapped to the request's first voice note). Unset: an empty extraction (the tests).
   */
  defaultCase?: string;
  /** Adjust the recorded extraction of a case before it is returned (v1, WhatsApp). */
  extraction?: (fixtureId: string, out: ExtractionOutput) => ExtractionOutput;
  /** The same for the web recorder's v2 extraction (W1-12). */
  extractionV2?: (fixtureId: string, out: ReportExtraction) => ReportExtraction;
  /** classify_reply by reply text; falls back to replies.json, then a state-based guess. */
  classify?: (text: string) => ClassifiedReply | null;
  /** parse_answer by reply text; falls back to replies.json "delta-5-full-day" for headcounts. */
  parseAnswer?: (text: string, field: string) => ParsedAnswer | null;
}

function userText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const first = params.messages[0];
  if (!first) return '';
  const raw =
    typeof first.content === 'string'
      ? first.content
      : first.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .filter(Boolean)
          .join('\n');
  // Drop the "Respond only by calling the … tool." suffix models without forced tool_choice get.
  return raw.replace(/\n+Respond only by calling the \w+ tool\.$/, '');
}

/** The reporter's words in a classify_reply / parse_answer / day-off request (after the REPLY / MESSAGE line). */
function replyOf(text: string): string {
  const m = /^(?:REPLY(?: \([^)]*\))?|MESSAGE):\n([\s\S]*)$/m.exec(text);
  return (m?.[1] ?? text).trim();
}

function toolMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  name: string,
  input: unknown,
  usage: { input: number; output: number; cacheRead: number },
  n: number,
): Anthropic.Message {
  return {
    id: `msg_fake_${n}`,
    type: 'message',
    role: 'assistant',
    model: params.model,
    content: [{ type: 'tool_use', id: `toolu_fake_${n}`, name, input, caller: { type: 'direct' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usage.cacheRead,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      output_tokens_details: null,
      iterations: null,
      speed: null,
    } as unknown as Anthropic.Usage,
  } as Anthropic.Message;
}

/** What Claude returns for an input without a voice note or text: nothing stated. */
/** An empty v2 extraction (a web report whose note the library does not know). */
export function emptyExtractionV2(): ReportExtraction {
  return ReportExtractionSchema.parse({
    languageDetected: [],
    summary: '',
    weather: { conditionsText: '', periods: [] },
    manpower: [],
    workPerformed: [],
    deliveries: [],
    equipment: [],
    safety: { incidents: [], noIncidentsStated: false, visitors: [], source: [] },
    issues: [],
    nextWorkday: [],
    newTerms: [],
    missingRequired: [],
    lowConfidence: [],
    proposedQuestions: [],
  });
}

export function emptyExtraction(): ExtractionOutput {
  return ExtractionOutputSchema.parse({
    languageDetected: [],
    summary: '',
    weather: { conditionsText: '', periods: [] },
    manpower: [],
    workPerformed: [],
    deliveries: [],
    equipment: [],
    safety: { incidents: [], noIncidentsStated: false, visitors: [], source: [] },
    issues: [],
    nextWorkday: [],
    newTerms: [],
    missingRequired: ['manpower'],
    lowConfidence: [],
    proposedQuestions: [],
  });
}

/** Swap the case's fixture message ids for the ids of the rows the worker actually sent. */
function remapIds<T>(value: T, map: Map<string, string>): T {
  if (typeof value === 'string') return (map.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => remapIds(v, map)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, remapIds(v, map)]),
    ) as T;
  }
  return value;
}

/**
 * Claude by tool name: submit_daily_report replays fixtures/tool-outputs/<case>.json for the case
 * whose transcript is in the request (else `defaultCase`, else an empty extraction); the small
 * tools answer from fixtures/tool-outputs/replies.json. Unknown tools throw, so an unexpected model
 * call fails. Only the model's answer is faked: `callTool` still validates it and the caller still
 * post-processes it (totals, schemaVersion, photos, sources) as it does Claude's.
 */
export function createFixtureClaude(opts: FixtureClaudeOptions): FakeClaude {
  let loaded: FixtureLibrary | null = typeof opts.lib === 'function' ? null : opts.lib;
  const library = (): FixtureLibrary => (loaded ??= (opts.lib as () => FixtureLibrary)());
  const wait = (kind: FakeClaudeCallKind) => opts.beforeCall?.(kind) ?? Promise.resolve();
  const calls: FakeClaudeCall[] = [];
  const phoneLeaks: string[] = [];
  let n = 0;
  return {
    calls,
    phoneLeaks,
    messages: {
      async create(params) {
        n++;
        const lib = library();
        const r = lib.replies;
        const tool = (params.tools?.[0] as { name: string } | undefined)?.name ?? '';
        const serialized = JSON.stringify({ system: params.system, messages: params.messages });
        phoneLeaks.push(...findPhoneNumbers(serialized));
        const text = userText(params);
        const fast = { input: 900, output: 120, cacheRead: 600 };
        switch (tool) {
          case 'submit_daily_report': {
            // v2 (the web recorder, W1-12) names voice notes by uploadId; v1 (WhatsApp) by messageId.
            const v2 = /VOICE NOTE uploadId=|^CHANNEL: /m.test(text);
            const idKey = v2 ? 'uploadId' : 'messageId';
            const voiceIds = Array.from(
              text.matchAll(new RegExp(`VOICE NOTE ${idKey}=([0-9a-f-]{36})`, 'g')),
            ).map((m) => m[1]!);
            const hasText = /TEXT MESSAGE messageId=/.test(text);
            const photosLine = /^PHOTOS: (.*)$/m.exec(text)?.[1] ?? '[]';
            const photos = JSON.parse(photosLine) as Array<Record<string, string>>;
            const matched = lib.findInText(text);
            const c = matched ?? (opts.defaultCase ? lib.get(opts.defaultCase) : null);
            await wait('claude');
            if (!c) {
              calls.push({ tool, noContent: voiceIds.length === 0 && !hasText });
              return toolMessage(
                params,
                tool,
                v2 ? emptyExtractionV2() : emptyExtraction(),
                { input: 3000, output: 400, cacheRead: 2500 },
                n,
              );
            }
            calls.push({ tool, fixtureId: c.id, ...(matched ? {} : { fallback: true }) });
            const map = new Map<string, string>();
            if (voiceIds[0]) map.set(c.voiceMessageId, voiceIds[0]);
            c.photoIds.forEach((id, i) => {
              const actual = photos[i]?.[idKey];
              if (actual) map.set(id, actual);
            });
            if (v2) {
              let out2 = remapIds(structuredClone(c.recordedV2), map);
              if (opts.extractionV2) out2 = opts.extractionV2(c.id, out2);
              return toolMessage(
                params,
                tool,
                out2,
                { input: 7000, output: 1800, cacheRead: 5200 },
                n,
              );
            }
            let out = remapIds(structuredClone(c.recorded), map);
            if (opts.extraction) out = opts.extraction(c.id, out);
            return toolMessage(
              params,
              tool,
              out,
              { input: 7000, output: 1800, cacheRead: 5200 },
              n,
            );
          }
          case 'classify_reply': {
            const reply = replyOf(text);
            const state = /^CONVERSATION STATE: (\w+)/m.exec(text)?.[1] ?? '';
            calls.push({ tool });
            await wait('claudeFast');
            const known =
              opts.classify?.(reply) ??
              Object.values(r.classify_reply).find(
                (c) => c.correctionText && reply.includes(c.correctionText),
              ) ??
              (/rained out/i.test(reply) ? r.classify_reply['rained-out']! : null) ??
              (/thank/i.test(reply) ? r.classify_reply.thanks! : null);
            const guess: ClassifiedReply = known ?? {
              intent: state === 'awaiting_answer' ? 'answer' : 'other',
              confidence: 0.8,
            };
            return toolMessage(params, tool, guess, fast, n);
          }
          case 'parse_answer': {
            await wait('claudeFast');
            const field = /^QUESTION field=([\w.]+)/m.exec(text)?.[1] ?? 'manpower.workers';
            const reply = replyOf(text);
            // W2-09: the golden set's recorded output for an answer whose transcript it holds.
            const golden = goldenAnswers().find((c) => c.transcript.trim() === reply);
            calls.push({ tool, ...(golden ? { fixtureId: golden.id } : {}) });
            const parsed = opts.parseAnswer?.(reply, field) ??
              golden?.recorded ??
              (field.startsWith('manpower') ? r.parse_answer['delta-5-full-day']! : null) ?? {
                field,
                value: { text: 'n/a' },
                confidence: 0.2,
              };
            return toolMessage(params, tool, parsed, fast, n);
          }
          case 'apply_correction': {
            calls.push({ tool });
            await wait('claudeCorrection');
            return toolMessage(params, tool, r.apply_correction['apex-6-to-7'], fast, n);
          }
          case 'classify_day_off': {
            calls.push({ tool });
            await wait('claudeFast');
            const out = /rain|weather|wind/i.test(text)
              ? r.classify_day_off['rained-out-11']
              : r.classify_day_off.holiday;
            return toolMessage(params, tool, out, fast, n);
          }
          case 'guess_site': {
            calls.push({ tool });
            await wait('claudeFast');
            return toolMessage(params, tool, { siteId: null, confidence: 0 }, fast, n);
          }
          default:
            throw new Error(`fake Claude: unexpected tool "${tool}"`);
        }
      },
    },
  };
}

// ───────────────────────────── Choice (EXTRACT_PROVIDER) ─────────────────────────────

let answerCases: AnswerCase[] | null = null;
/** fixtures/answers (W2-09), loaded on the first parse_answer. */
function goldenAnswers(): AnswerCase[] {
  return (answerCases ??= loadAnswerCases());
}

/** The case a transcript no golden case matches gets: the hero report, one open question (D27). */
export const DEFAULT_FAKE_EXTRACTION_CASE = 'riverside-2026-10-09';

export type ExtractProvider = Config['EXTRACT_PROVIDER'];

export interface ExtractorChoice {
  provider: ExtractProvider;
  /** Why the choice differs from EXTRACT_PROVIDER, for the boot log. */
  note: string | null;
}

/** EXTRACT_PROVIDER=fake under NODE_ENV=production: the worker refuses to start. */
export const FAKE_EXTRACTION_IN_PRODUCTION =
  'EXTRACT_PROVIDER=fake is refused in production: a fake extraction is invented report content. Unset it (Claude) or run with NODE_ENV=development.';

/**
 * EXTRACT_PROVIDER (default `claude`) with its key. The fake answers only when EXTRACT_PROVIDER=fake
 * is set explicitly, never as a fallback: Claude without ANTHROPIC_API_KEY leaves no client, so
 * every model call fails (the jobs retry, then fail) until the key is set, with a warning at boot.
 * In production `fake` is refused (throws): a fake extraction would be invented report content.
 */
export function resolveExtractorChoice(
  config: Pick<Config, 'EXTRACT_PROVIDER' | 'ANTHROPIC_API_KEY' | 'NODE_ENV'>,
): ExtractorChoice {
  if (config.EXTRACT_PROVIDER === 'fake') {
    if (config.NODE_ENV === 'production') throw new Error(FAKE_EXTRACTION_IN_PRODUCTION);
    return {
      provider: 'fake',
      note: 'EXTRACT_PROVIDER=fake: the fake extractor (fixtures/tool-outputs) answers every model call',
    };
  }
  if (!config.ANTHROPIC_API_KEY) {
    return {
      provider: 'claude',
      note: 'ANTHROPIC_API_KEY is not set: extraction fails until it is (EXTRACT_PROVIDER=fake for fixture answers outside production)',
    };
  }
  return { provider: 'claude', note: null };
}

/** `ctx.ai.claude`: Anthropic, the fixture fake (EXTRACT_PROVIDER=fake), or null (no key). */
export function createExtractionClient(
  config: Pick<Config, 'EXTRACT_PROVIDER' | 'ANTHROPIC_API_KEY' | 'NODE_ENV'>,
  log: Logger,
): MessagesClient | null {
  const choice = resolveExtractorChoice(config);
  // Always at boot: which provider answers, so a fake or a keyless worker is never a surprise.
  (choice.note ? log.warn : log.info)('extraction provider', {
    provider: choice.provider,
    ...(choice.note ? { note: choice.note } : {}),
  });
  if (choice.provider === 'fake')
    return createFixtureClaude({
      lib: () => loadFixtureLibrary(),
      defaultCase: DEFAULT_FAKE_EXTRACTION_CASE,
    });
  return createAnthropicClient(config.ANTHROPIC_API_KEY);
}
