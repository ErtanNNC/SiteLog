import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { redactPhones } from '@sitelog/shared';
import type { Logger } from '../log';
import { estimateClaudeCostUsd, type TokenUsage } from './cost';
import { abortableFetch, currentSignal } from '../abort';

/**
 * Single forced-tool calls against Claude (§10.4): prompt caching on the system blocks,
 * deterministic sampling where the model accepts it, Zod validation with ONE retry that
 * feeds the validation error back as a tool_result.
 *
 * Model differences (current API): the 5.5 generation (Opus 5.5, Sonnet 5.5) and the
 * Fable/Mythos family reject forced `tool_choice` and non-default sampling, so for those
 * the helper uses `tool_choice: auto` + an explicit instruction and verifies that the tool
 * was called (one re-prompt if not). The model comes from CLAUDE_MODEL (default
 * claude-sonnet-5-5, GAP D23), so the §10.4 "forced tool_choice, temperature 0" is not what
 * the default model gets: README "Deliberate deviations", spec §19.
 *
 * No phone number reaches the model (CLAUDE.md; spec §10.12): `buildParams` runs every system
 * block and every text of every user turn, the corrective retry turns included, through
 * `redactPhones`.
 */

export type MessagesClient = {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
};

export interface ModelProfile {
  forcedToolChoice: boolean;
  sampling: boolean;
  effort: boolean;
}

export function modelProfile(model: string): ModelProfile {
  const m = model.toLowerCase();
  const family = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(m);
  if (!family) {
    // Legacy ids (claude-3-5-sonnet-…) accept everything; unknown ids get the conservative path.
    const legacy = /claude-3/.test(m);
    return { forcedToolChoice: legacy, sampling: legacy, effort: false };
  }
  const name = family[1]!;
  const version = Number(family[2]) + Number(family[3] ?? '0') / 10;
  if (name === 'fable' || name === 'mythos')
    return { forcedToolChoice: false, sampling: false, effort: true };
  const forcedToolChoice = !((name === 'opus' || name === 'sonnet') && version >= 5.5);
  const sampling = version <= 4.6 && !(name === 'opus' && version >= 4.7);
  const effort =
    (name === 'opus' && version >= 4.5) ||
    (name === 'sonnet' && version >= 4.6) ||
    (name === 'haiku' && version >= 5.5);
  return { forcedToolChoice, sampling, effort };
}

export interface SystemBlock {
  text: string;
  /** Mark as a prompt-cache breakpoint (max 4 per request). */
  cache?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest<T> {
  model: string;
  system: SystemBlock[];
  messages: Anthropic.MessageParam[];
  tool: ToolSpec;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Set false for calls where the retry-on-invalid is not wanted. Default true. */
  retryOnInvalid?: boolean;
  /**
   * A tool's own tidy-up of the input, after the generic one (`coerceToSchema`) and before Zod
   * validation, e.g. dropping an over-long suggestion that code would never show.
   */
  normalize?: (input: unknown) => unknown;
}

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
};

function schemaAllowsNull(s: JsonSchemaNode): boolean {
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const variants = [...(s.anyOf ?? []), ...(s.oneOf ?? [])];
  // An untyped schema (`{}`, e.g. a JSON-patch `value`) accepts anything, null included.
  if (types.length === 0 && variants.length === 0) return true;
  if (types.includes('null')) return true;
  return variants.some(schemaAllowsNull);
}

/**
 * The tool input as the JSON Schema the model was given describes it (Eval fixes, first live run):
 * - a value the schema types as an object or array but which arrived as a JSON string (models
 *   sometimes stringify a nested object, e.g. `"weather": "{\"conditionsText\":…}"`) is parsed;
 * - `null` on an OPTIONAL property whose schema does not allow null means "not stated" (the
 *   prompts say "unknown → null"): it is dropped, so the optional field is simply absent. A
 *   required property's null is kept and left to Zod. No value is ever made up here.
 * Pure: returns a new value and never mutates the input.
 */
export function coerceToSchema(value: unknown, schema: JsonSchemaNode | undefined): unknown {
  if (!schema) return value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  let v = value;
  if (typeof v === 'string' && (types.includes('object') || types.includes('array'))) {
    const t = v.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        const parsed: unknown = JSON.parse(t);
        const isArr = Array.isArray(parsed);
        const isObj = !isArr && parsed !== null && typeof parsed === 'object';
        if ((isArr && types.includes('array')) || (isObj && types.includes('object'))) v = parsed;
      } catch {
        // Not JSON: left for Zod to report.
      }
    }
  }
  if (Array.isArray(v)) return schema.items ? v.map((x) => coerceToSchema(x, schema.items)) : v;
  if (v && typeof v === 'object' && schema.properties) {
    const required = new Set(schema.required ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const prop = schema.properties[k];
      if (x === null && prop && !required.has(k) && !schemaAllowsNull(prop)) continue;
      out[k] = prop ? coerceToSchema(x, prop) : x;
    }
    return out;
  }
  return v;
}

/** `coerceToSchema` against the tool's input schema, then the tool's own `normalize`. */
export function normalizeToolInput(
  input: unknown,
  inputSchema: Record<string, unknown>,
  normalize?: (input: unknown) => unknown,
): unknown {
  const coerced = coerceToSchema(input, inputSchema as JsonSchemaNode);
  return normalize ? normalize(coerced) : coerced;
}

export interface ToolCallResult<T> {
  data: T;
  usage: TokenUsage;
  estCostUsd: number;
  latencyMs: number;
  apiCalls: number;
  retried: boolean;
  model: string;
}

export class ToolCallError extends Error {
  constructor(
    message: string,
    public readonly kind: 'no_tool_use' | 'invalid_input' | 'refusal' | 'truncated',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

function usageOf(msg: Anthropic.Message): TokenUsage {
  return {
    input: msg.usage.input_tokens ?? 0,
    output: msg.usage.output_tokens ?? 0,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
    cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function buildParams<T>(
  req: ToolCallRequest<T>,
  messages: Anthropic.MessageParam[],
): Anthropic.MessageCreateParamsNonStreaming {
  const profile = modelProfile(req.model);
  const system: Anthropic.TextBlockParam[] = req.system
    .filter((b) => b.text.trim().length > 0)
    .map((b) =>
      b.cache
        ? { type: 'text', text: redactPhones(b.text), cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: redactPhones(b.text) },
    );
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    system,
    messages: messages.map(redactUserTurn),
    tools: [
      {
        name: req.tool.name,
        description: req.tool.description,
        input_schema: req.tool.inputSchema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: profile.forcedToolChoice
      ? { type: 'tool', name: req.tool.name, disable_parallel_tool_use: true }
      : { type: 'auto', disable_parallel_tool_use: true },
  };
  if (profile.sampling) params.temperature = 0;
  if (profile.effort && req.effort) params.output_config = { effort: req.effort };
  return params;
}

/** A user turn with every text (string content, text blocks, tool_result text) redacted. */
export function redactUserTurn(m: Anthropic.MessageParam): Anthropic.MessageParam {
  if (m.role !== 'user') return m;
  if (typeof m.content === 'string') return { ...m, content: redactPhones(m.content) };
  return {
    ...m,
    content: m.content.map((b) => {
      if (b.type === 'text') return { ...b, text: redactPhones(b.text) };
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') return { ...b, content: redactPhones(b.content) };
        if (Array.isArray(b.content))
          return {
            ...b,
            content: b.content.map((c) =>
              c.type === 'text' ? { ...c, text: redactPhones(c.text) } : c,
            ),
          };
      }
      return b;
    }),
  };
}

function findToolUse(msg: Anthropic.Message, name: string): Anthropic.ToolUseBlock | null {
  for (const block of msg.content) {
    if (block.type === 'tool_use' && block.name === name) return block;
  }
  return null;
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 12)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/** The instruction appended to the last user message when the model cannot be forced to call the tool. */
export function toolInstruction(name: string): string {
  return `Respond only by calling the ${name} tool.`;
}

export async function callTool<T>(
  client: MessagesClient,
  req: ToolCallRequest<T>,
  log?: Logger,
): Promise<ToolCallResult<T>> {
  const profile = modelProfile(req.model);
  const started = Date.now();
  let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let apiCalls = 0;
  let retried = false;
  const messages: Anthropic.MessageParam[] = profile.forcedToolChoice
    ? [...req.messages]
    : withInstruction(req.messages, req.tool.name);
  let noToolRetry = !profile.forcedToolChoice;
  let invalidRetry = req.retryOnInvalid ?? true;

  for (;;) {
    const params = buildParams(req, messages);
    // The running job's signal (W1-10): a timed-out job's model call stops.
    const signal = currentSignal();
    const msg = await client.messages.create(params, signal ? { signal } : undefined);
    apiCalls++;
    usage = addUsage(usage, usageOf(msg));

    if (msg.stop_reason === 'refusal') {
      throw new ToolCallError('model declined the request', 'refusal', msg.stop_details ?? null);
    }
    const toolUse = findToolUse(msg, req.tool.name);
    if (!toolUse) {
      if (msg.stop_reason === 'max_tokens')
        throw new ToolCallError('response truncated before the tool call', 'truncated');
      if (noToolRetry) {
        noToolRetry = false;
        retried = true;
        log?.warn('model answered without calling the tool; re-prompting once', {
          model: req.model,
          tool: req.tool.name,
        });
        messages.push({ role: 'assistant', content: msg.content });
        messages.push({
          role: 'user',
          content: `You must call the ${req.tool.name} tool now. Do not answer in prose.`,
        });
        continue;
      }
      throw new ToolCallError('model did not call the tool', 'no_tool_use', msg.content);
    }

    const parsed = req.schema.safeParse(
      normalizeToolInput(toolUse.input, req.tool.inputSchema, req.normalize),
    );
    if (parsed.success) {
      return {
        data: parsed.data,
        usage,
        estCostUsd: estimateClaudeCostUsd(req.model, usage),
        latencyMs: Date.now() - started,
        apiCalls,
        retried,
        model: msg.model,
      };
    }
    const issues = formatZodIssues(parsed.error);
    if (invalidRetry) {
      invalidRetry = false;
      retried = true;
      log?.warn('tool input failed validation; retrying once with the error', {
        model: req.model,
        tool: req.tool.name,
        issues,
      });
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: `The tool input failed validation:\n${issues}\n\nCall ${req.tool.name} again with corrected input. Keep every other value unchanged.`,
          },
        ],
      });
      continue;
    }
    throw new ToolCallError(
      `tool input failed validation after retry: ${issues}`,
      'invalid_input',
      parsed.error.issues,
    );
  }
}

function withInstruction(
  messages: Anthropic.MessageParam[],
  toolName: string,
): Anthropic.MessageParam[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (!last || last.role !== 'user') return out;
  const instruction = toolInstruction(toolName);
  if (typeof last.content === 'string') {
    out[out.length - 1] = { role: 'user', content: `${last.content}\n\n${instruction}` };
  } else {
    out[out.length - 1] = {
      role: 'user',
      content: [...last.content, { type: 'text', text: instruction }],
    };
  }
  return out;
}

export function createAnthropicClient(apiKey: string): MessagesClient | null {
  if (!apiKey) return null;
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000, fetch: abortableFetch() });
}
