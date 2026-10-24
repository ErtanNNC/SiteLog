/**
 * "Try it on WhatsApp" — a pure, in-browser replay of the production WhatsApp conversation for one
 * reporter and one site-day. It mirrors apps/worker/src/router (inbound routing, intake, question,
 * draft, day-off handlers) and jobs (extract_report → decide_next → file_report → render_pdf) in
 * the same order, and says exactly what production says by calling the same shared code: waCopy,
 * validateReport / pickNextQuestion, parseQuickAnswer / applyAnswer, formatDraftCard, ButtonSets,
 * deriveTotals, progressSteps, quickClassify, quickDayOff, weatherDayData.
 *
 * Where production calls the AI (transcribing and extracting a free-form note, classifying or
 * parsing an arbitrary reply, understanding a correction) the simulator replays golden fixtures
 * (scenarios.ts, recorded.ts) or the deterministic parsers; anything else gets a system note.
 *
 * Pure: `(state, input) → { state, events }`. Events are chat messages (with a UI delay) and
 * effects that the adapter writes into the demo store (report, site-day, audit log, filing).
 */
import { waCopy } from '@sitelog/shared/copy/whatsapp.ts';
import type { RequiredFieldKey, SiteDayStatus } from '@sitelog/shared/enums.ts';
import { firstName, formatDuration, formatTimeInTz, weekdayName } from '@sitelog/shared/format.ts';
import { weatherDayData } from '@sitelog/shared/report/day-off.ts';
import { formatDraftCard } from '@sitelog/shared/report/draft-card.ts';
import { deriveTotals, round2 } from '@sitelog/shared/report/hours.ts';
import { formatReportNo, pdfFileName } from '@sitelog/shared/report/numbering.ts';
import { progressSteps } from '@sitelog/shared/report/progress.ts';
import {
  applyAnswer,
  LOW_CONFIDENCE_THRESHOLD,
  parseQuickAnswer,
  pickNextQuestion,
  validateReport,
  type QuestionSpec,
  type ValidationResult,
} from '@sitelog/shared/report/validate.ts';
import { resolveDayReference } from '@sitelog/shared/schedule/day.ts';
import type {
  AnswerValue,
  ClassifiedReply,
  DayOffClassification,
} from '@sitelog/shared/schemas/ai.ts';
import type {
  DailyReportDataV1,
  ObservedWeatherV1,
  QuestionField,
  SourceV1,
} from '@sitelog/shared/schemas/report.ts';
import { ButtonSets, parseButtonId, type Button } from '@sitelog/shared/wa/buttons.ts';
import { looksLikeDayOff, quickClassify, quickDayOff } from '@sitelog/shared/wa/replies.ts';
import { renderTemplateText } from '@sitelog/shared/wa/templates.ts';
import {
  recordedAmbiguousCorrection,
  recordedAnswer,
  recordedClassify,
  recordedDayOff,
} from './recorded';
import type { Scenario } from './scenarios';

// ───────────────────────────── Types ─────────────────────────────

export interface SimCompany {
  id: string;
  name: string;
  aliases: string[];
  isSelfPerform: boolean;
  /** Added from the field, not yet confirmed by the office. */
  unconfirmed?: boolean;
}

/** Today's filed daily report from the demo data: editable ("edit Friday") without replacing it. */
export interface SimFiledSnapshot {
  id: string;
  reportNo: string;
  version: number;
  data: DailyReportDataV1;
  filedAt: string;
}

export interface SimContext {
  /** Prefix for every id the session creates (messages, reports, questions). */
  nonce: string;
  /** The demo's "now" (ISO): the session's clock starts here. */
  startAt: string;
  /** Today in the site's time zone. */
  date: string;
  site: {
    id: string;
    name: string;
    projectCode: string;
    timezone: string;
    workingHours: string | null;
    siteDayId: string;
  };
  reporter: { id: string; name: string };
  settings: {
    requiredFields: RequiredFieldKey[];
    maxQuestions: number;
    defaultShiftHours: number;
    noWorkPdf: boolean;
    /** Today's report deadline, site time ("17:30"). */
    deadline: string;
    /** Site time of the missing escalation ("19:00"), quoted by R2. */
    missingAt: string;
  };
  /**
   * The reminders the §7.4 ladder had already sent today (from the org's offsets and enabled
   * flags, the site-day's pause and when its report came in), oldest first.
   */
  reminders: Array<{ stage: 'reminder1' | 'reminder2'; at: string }>;
  /** Today's observed weather at the site (extract_report adds it to the report in code). */
  observedWeather: ObservedWeatherV1 | null;
  companies: SimCompany[];
  today: {
    /** Today's site-day before the simulator touched it. */
    status: SiteDayStatus;
    reportNo: string | null;
    /** True when sending replaces something (a report, or a filed / weather / no-work day). */
    needsReset: boolean;
    statusAfterReset: SiteDayStatus;
    reportSeqAfterReset: number;
    remindersPaused: boolean;
    filed: SimFiledSnapshot | null;
  };
}

export type ChatFrom = 'agent' | 'reporter' | 'system';
export type ChatKind = 'text' | 'voice' | 'photo' | 'document' | 'note';

export type AgentTag =
  | 'ack'
  | 'progress'
  | 'question'
  | 'reask'
  | 'answer_ack'
  | 'answer_other'
  | 'draft'
  | 'fix_prompt'
  | 'fix_clarify'
  | 'filed'
  | 'pdf'
  | 'edit_hint'
  | 'edit_no_report'
  | 'edit_applied'
  | 'photos_only'
  | 'photo_no_work'
  | 'merged'
  | 'weather_day'
  | 'weather_followup'
  | 'weather_photo_ack'
  | 'no_work'
  | 'reminder'
  | 'help'
  | 'stop'
  | 'language'
  | 'recording'
  | 'you_are_welcome';

/** System notes are simulator commentary, never WhatsApp messages; the page renders their copy. */
export type NoteKey =
  | 'intro'
  | 'replaced'
  | 'unsupported_text'
  | 'unsupported_answer'
  | 'unsupported_fix'
  | 'unchanged_fix'
  | 'unsupported_report'
  | 'voice_busy'
  | 'edit_other_day'
  | 'silent';

export interface ChatMessage {
  id: string;
  from: ChatFrom;
  kind: ChatKind;
  /** ISO instant on the simulated clock. */
  at: string;
  /** Message body: agent/reporter text, transcript of a voice note, PDF caption. */
  text: string;
  tag?: AgentTag;
  buttons?: Button[];
  /** Reporter tapped this button id. */
  buttonId?: string;
  durationS?: number | null;
  languages?: string[];
  segments?: Array<{ start: number; end: number; text: string }>;
  caption?: string | null;
  fileName?: string;
  note?: { key: NoteKey; params: Record<string, string> };
  /** Sent before the simulation started (today's reminders): shown, never written to the store. */
  history?: boolean;
}

export type SimReportKind = 'daily' | 'weather_day' | 'no_work';
export type SimReportStatus =
  'collecting' | 'awaiting_answer' | 'awaiting_confirmation' | 'filed' | 'void';

export interface SimSource {
  messageId: string;
  kind: 'audio' | 'photo' | 'text' | 'reply';
  caption: string | null;
  at: string;
}

export interface SimQuestion {
  id: string;
  field: QuestionField;
  path: string;
  prompt: string;
  options: string[];
  buttons: Button[];
  target: QuestionSpec['target'];
  askedAt: string;
  answeredAt: string | null;
  answer: Record<string, unknown> | null;
  reasks: number;
}

export interface SimReport {
  id: string;
  reportNo: string;
  kind: SimReportKind;
  status: SimReportStatus;
  data: DailyReportDataV1 | null;
  sources: SimSource[];
  questions: SimQuestion[];
  reviewReasons: string[];
  version: number;
  receivedClock: number;
  filedAt: string | null;
  filedClock: number | null;
  /** Transcript / text the report was made from (the day-off check reads it). */
  sourceText: string;
  /** Today's demo report from before the session (dropped when the session replaces the day). */
  preexisting?: boolean;
}

export type SimEffect =
  | { type: 'reset_today'; at: string }
  | { type: 'report_created'; reportId: string; reportNo: string; kind: SimReportKind; at: string }
  | { type: 'site_day'; status: SiteDayStatus; at: string }
  | {
      type: 'audit';
      action: string;
      entity: 'report' | 'site_day' | 'company';
      entityId: string;
      actor: 'agent' | 'reporter';
      diff: Record<string, unknown>;
      at: string;
    }
  | { type: 'company_added'; companyId: string; name: string; reportId: string; at: string }
  | { type: 'report_void'; reportId: string; at: string }
  | {
      type: 'report_status';
      reportId: string;
      status: 'awaiting_answer' | 'awaiting_confirmation';
      at: string;
    }
  | {
      type: 'draft';
      reportId: string;
      data: DailyReportDataV1;
      messageId: string | null;
      at: string;
    }
  | { type: 'review_flag'; reportId: string; reasons: string[]; at: string }
  | { type: 'reminders_paused'; at: string }
  | {
      type: 'file';
      reportId: string;
      reportNo: string;
      kind: SimReportKind;
      data: DailyReportDataV1;
      trigger: 'confirm' | 'weather_day' | 'no_work';
      reasons: string[];
      questions: SimQuestion[];
      sources: SimSource[];
      confirmMessageId: string | null;
      at: string;
    }
  | {
      type: 'version';
      reportId: string;
      version: number;
      data: DailyReportDataV1;
      author: 'agent' | 'reporter';
      changeNote: string;
      messageId: string;
      source: SimSource | null;
      at: string;
    }
  | { type: 'no_work'; at: string };

export type SimEvent =
  | { kind: 'message'; message: ChatMessage; delayMs: number }
  | { kind: 'effect'; effect: SimEffect };

export type LegendEntry = { at: string } & (
  | { kind: 'replaced'; reportNo: string | null }
  | { kind: 'received'; voice: boolean; durationS: number | null; photos: number }
  | { kind: 'question'; prompt: string }
  | { kind: 'answered'; answer: string; ack: string | null }
  | { kind: 'photo_answered' }
  | { kind: 'unanswered'; prompt: string }
  | { kind: 'draft' }
  | { kind: 'corrected'; note: string }
  | { kind: 'filed'; reportNo: string; needsReview: boolean }
  | { kind: 'weather_day'; reportNo: string }
  | { kind: 'no_work' }
  | { kind: 'version'; reportNo: string; version: number; note: string }
  | { kind: 'company_added'; name: string }
  | { kind: 'voided'; reportNo: string }
);

export type SimConvoState =
  'idle' | 'processing' | 'awaiting_answer' | 'awaiting_confirmation' | 'editing';

export interface SimState {
  ctx: SimContext;
  scenario: Scenario;
  convo: SimConvoState;
  reports: SimReport[];
  activeReportId: string | null;
  pendingQuestionId: string | null;
  fixRequestedFor: string | null;
  editingReportId: string | null;
  weatherReportId: string | null;
  weatherFollowup: 'photo' | 'voice' | null;
  lastFiledReportId: string | null;
  dayStatus: SiteDayStatus;
  replaced: boolean;
  reportSeq: number;
  companies: SimCompany[];
  counter: number;
  /** Simulated milliseconds since ctx.startAt. */
  clock: number;
  messages: ChatMessage[];
  legend: LegendEntry[];
  scenarioSent: boolean;
  /** A crew-less correction waiting for "which crew?" to be answered. */
  pendingCorrection: string | null;
  remindersPaused: boolean;
  /** The session changed something in the store besides messages, audit rows and the pause flag. */
  dirty: boolean;
}

export interface SimStep {
  state: SimState;
  events: SimEvent[];
}

// ───────────────────────────── Timing ─────────────────────────────

/** UI pacing (ms) of agent messages; the page scales these (0 in tests). */
export const DELAYS = {
  ack: 900,
  progress: 1600,
  question: 1500,
  draft: 1800,
  reply: 900,
  filed: 1200,
  pdf: 1400,
  hint: 700,
  note: 250,
} as const;

/**
 * Simulated pipeline time (ms on the session clock): transcription scales with the note length,
 * extraction is a flat model call. The progress bubble goes out at the first checkpoint past 10 s
 * (§F5 step 3, worker pipeline/progress.ts).
 */
export const PROGRESS_AFTER_MS = 10_000;
export function transcriptionMs(durationS: number | null): number {
  return durationS ? Math.round((2 + durationS * 0.04) * 1000) : 0;
}
export const EXTRACTION_MS = 9_000;

/** Photos within 10 minutes of filing attach to the filed report (§7.2). */
const LATE_PHOTO_WINDOW_MS = 10 * 60_000;

// ───────────────────────────── Turn helper ─────────────────────────────

class Turn {
  readonly events: SimEvent[] = [];
  /** Where this turn's reporter message sits, so a reset can be put in front of it. */
  private anchor: { events: number; messages: number; at: string } | null = null;
  constructor(readonly s: SimState) {}

  get ctx(): SimContext {
    return this.s.ctx;
  }
  get first(): string {
    return firstName(this.ctx.reporter.name);
  }
  now(): string {
    return new Date(Date.parse(this.ctx.startAt) + this.s.clock).toISOString();
  }
  tick(ms: number): void {
    this.s.clock += ms;
  }
  id(prefix: string): string {
    this.s.counter += 1;
    return `${this.ctx.nonce}-${prefix}${this.s.counter}`;
  }
  private push(message: ChatMessage, delayMs: number): ChatMessage {
    this.s.messages.push(message);
    this.events.push({ kind: 'message', message, delayMs });
    return message;
  }
  say(
    text: string,
    tag: AgentTag,
    opts: {
      buttons?: Button[];
      delayMs?: number;
      kind?: ChatKind;
      fileName?: string;
      at?: string;
      history?: boolean;
    } = {},
  ): ChatMessage {
    const delayMs = opts.delayMs ?? DELAYS.reply;
    if (!opts.at) this.tick(Math.max(1000, delayMs));
    return this.push(
      {
        id: this.id('m'),
        from: 'agent',
        kind: opts.kind ?? 'text',
        at: opts.at ?? this.now(),
        text,
        tag,
        buttons: opts.buttons?.length ? opts.buttons : undefined,
        fileName: opts.fileName,
        history: opts.history,
      },
      delayMs,
    );
  }
  note(key: NoteKey, params: Record<string, string> = {}): ChatMessage {
    return this.push(
      {
        id: this.id('n'),
        from: 'system',
        kind: 'note',
        at: this.now(),
        text: '',
        note: { key, params },
      },
      DELAYS.note,
    );
  }
  inbound(m: Omit<ChatMessage, 'id' | 'from' | 'at'>, typingMs = 4000): ChatMessage {
    this.tick(typingMs);
    const at = this.now();
    this.anchor ??= { events: this.events.length, messages: this.s.messages.length, at };
    return this.push({ ...m, id: this.id('m'), from: 'reporter', at }, 0);
  }
  effect(effect: SimEffect): void {
    if (effect.type !== 'audit' && effect.type !== 'reminders_paused') this.s.dirty = true;
    this.events.push({ kind: 'effect', effect });
  }
  /**
   * The reset of today's demo data and its note, placed before the reporter's message of this
   * turn (the store clears the day's thread, so the message must be written after it).
   */
  resetBeforeInbound(reportNo: string | null): void {
    const at = this.anchor?.at ?? this.now();
    const note: ChatMessage = {
      id: this.id('n'),
      from: 'system',
      kind: 'note',
      at,
      text: '',
      note: { key: 'replaced', params: { site: this.ctx.site.name, reportNo: reportNo ?? '' } },
    };
    const events: SimEvent[] = [
      { kind: 'effect', effect: { type: 'reset_today', at } },
      { kind: 'message', message: note, delayMs: DELAYS.note },
    ];
    this.s.dirty = true;
    this.s.legend.push({ kind: 'replaced', reportNo, at });
    if (this.anchor) {
      this.events.splice(this.anchor.events, 0, ...events);
      this.s.messages.splice(this.anchor.messages, 0, note);
      this.anchor = {
        events: this.anchor.events + events.length,
        messages: this.anchor.messages + 1,
        at,
      };
    } else {
      this.events.push(...events);
      this.s.messages.push(note);
    }
  }
  audit(
    action: string,
    entity: 'report' | 'site_day' | 'company',
    entityId: string,
    actor: 'agent' | 'reporter',
    diff: Record<string, unknown> = {},
  ): void {
    this.effect({ type: 'audit', action, entity, entityId, actor, diff, at: this.now() });
  }
  legend(entry: DistributiveOmit<LegendEntry, 'at'>): void {
    this.s.legend.push({ ...entry, at: this.now() } as LegendEntry);
  }
  report(id: string | null): SimReport | undefined {
    return id ? this.s.reports.find((r) => r.id === id) : undefined;
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function step(state: SimState, fn: (t: Turn) => void): SimStep {
  const t = new Turn(structuredClone(state));
  fn(t);
  return { state: t.s, events: t.events };
}

// ───────────────────────────── Session ─────────────────────────────

export function startSession(ctx: SimContext, scenario: Scenario): SimStep {
  const filed = ctx.today.filed;
  const state: SimState = {
    ctx,
    scenario,
    convo: 'idle',
    reports: filed
      ? [
          {
            id: filed.id,
            reportNo: filed.reportNo,
            kind: 'daily',
            status: 'filed',
            data: structuredClone(filed.data),
            sources: [],
            questions: [],
            reviewReasons: [],
            version: filed.version,
            receivedClock: 0,
            filedAt: filed.filedAt,
            filedClock: Date.parse(filed.filedAt) - Date.parse(ctx.startAt),
            sourceText: '',
            preexisting: true,
          },
        ]
      : [],
    activeReportId: null,
    pendingQuestionId: null,
    fixRequestedFor: null,
    editingReportId: null,
    weatherReportId: null,
    weatherFollowup: null,
    lastFiledReportId: filed?.id ?? null,
    dayStatus: ctx.today.status,
    replaced: false,
    reportSeq: ctx.today.reportSeqAfterReset,
    companies: ctx.companies.map((c) => ({ ...c, aliases: [...c.aliases] })),
    counter: 0,
    clock: 0,
    messages: [],
    legend: [],
    scenarioSent: false,
    pendingCorrection: null,
    remindersPaused: ctx.today.remindersPaused,
    dirty: false,
  };
  return step(state, (t) => {
    // What the reminder ladder (§7.4) already sent today, in the order it went out.
    for (const r of ctx.reminders) {
      const r1 = r.stage === 'reminder1';
      t.say(
        r1
          ? renderTemplateText('sitelog_reminder_1', [t.first, ctx.site.name])
          : renderTemplateText('sitelog_reminder_2', [ctx.settings.missingAt]),
        'reminder',
        {
          buttons: r1 ? ButtonSets.reminder1(ctx.site.siteDayId) : undefined,
          delayMs: 0,
          at: r.at,
          history: true,
        },
      );
    }
    t.note('intro', {
      first: t.first,
      name: ctx.reporter.name,
      site: ctx.site.name,
      kind: scenario.kind,
      replaces: ctx.today.needsReset ? (ctx.today.reportNo ?? ctx.site.name) : '',
      // Every report filed here is late when the demo clock is past the deadline.
      late: formatTimeInTz(ctx.startAt, ctx.site.timezone) > ctx.settings.deadline ? 'yes' : '',
      clock: `${weekdayName(ctx.date)} ${formatTimeInTz(ctx.startAt, ctx.site.timezone)}`,
      deadline: ctx.settings.deadline,
    });
  });
}

/**
 * Today's demo data for the site is replaced by the first input that creates or replaces the
 * day's record (a report, a weather day, no work) — never by help, thanks or an edit.
 */
function ensureReset(t: Turn): void {
  if (t.s.replaced) return;
  t.s.replaced = true;
  // The store drops today's demo report; so does the session.
  t.s.reports = t.s.reports.filter((r) => !r.preexisting);
  if (t.s.lastFiledReportId && !t.report(t.s.lastFiledReportId)) t.s.lastFiledReportId = null;
  if (t.s.editingReportId && !t.report(t.s.editingReportId)) {
    t.s.editingReportId = null;
    if (t.s.convo === 'editing') t.s.convo = 'idle';
  }
  if (!t.ctx.today.needsReset) return;
  t.s.dayStatus = t.ctx.today.statusAfterReset;
  t.resetBeforeInbound(t.ctx.today.reportNo);
}

// ───────────────────────────── Inputs ─────────────────────────────

/**
 * The scenario's recorded voice note (or typed report), then its photos. Each WhatsApp message is
 * its own inbound job in production: the note starts the intake and is acked alone, the photos
 * that follow merge into the report being processed (router.test.ts "acks with duration…").
 */
export function sendScenarioNote(state: SimState): SimStep {
  return step(state, (t) => {
    const sc = t.s.scenario;
    const busy =
      t.s.convo !== 'idle' ||
      t.s.reports.some(
        (r) => !r.preexisting && r.status !== 'void' && r.sources.some((x) => x.kind !== 'photo'),
      );
    if (busy) {
      // Production would read this note as an answer, a fix or an edit (transcribe → parse_reply).
      t.note('voice_busy', { first: t.first });
      return;
    }
    ensureReset(t);
    const main =
      sc.kind === 'voice'
        ? t.inbound({
            kind: 'voice',
            text: sc.text,
            durationS: sc.durationS,
            languages: sc.languages,
            segments: sc.segments,
          })
        : t.inbound({ kind: 'text', text: sc.text });
    t.s.scenarioSent = true;
    const started = startIntake(t, { main, photos: [] }, { deferPipeline: true });
    for (const p of sc.photos) {
      const photo = t.inbound({ kind: 'photo', text: '', caption: p.caption }, 2000);
      handleMedia(t, photo);
    }
    if (started) runPipeline(t, started.report, started.durationS);
  });
}

export function sendPhoto(state: SimState, caption: string | null = null): SimStep {
  return step(state, (t) => {
    const photo = t.inbound({ kind: 'photo', text: '', caption });
    handleMedia(t, photo);
  });
}

export function sendText(state: SimState, raw: string): SimStep {
  const text = raw.trim();
  if (!text) return { state, events: [] };
  return step(state, (t) => {
    const msg = t.inbound({ kind: 'text', text });
    handleText(t, text, msg);
  });
}

export function tapButton(state: SimState, buttonId: string): SimStep {
  if (!liveButtonIds(state).has(buttonMessageId(state, buttonId) ?? '')) {
    return { state, events: [] };
  }
  const title = findButton(state, buttonId)?.title;
  if (!title) return { state, events: [] };
  return step(state, (t) => {
    const msg = t.inbound({ kind: 'text', text: title, buttonId }, 1500);
    handleButton(t, buttonId, title, msg);
  });
}

function buttonMessageId(state: SimState, id: string): string | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.buttons?.some((x) => x.id === id)) return m.id;
  }
  return undefined;
}

function findButton(state: SimState, id: string): Button | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const b = state.messages[i]!.buttons?.find((x) => x.id === id);
    if (b) return b;
  }
  return undefined;
}

/**
 * Which messages' buttons can still be tapped, from the conversation state (not message order):
 * a question's buttons while that question is the open one, the latest draft card while it waits
 * for OK, reminder and weather follow-up buttons whenever (production handles them any time).
 */
export function liveButtonIds(state: SimState): Set<string> {
  const live = new Set<string>();
  let questionSeen = false;
  let draftSeen = false;
  let weatherSeen = false;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.from !== 'agent' || !m.buttons?.length) continue;
    const p = parseButtonId(m.buttons[0]!.id);
    if (p.kind === 'reminder') {
      live.add(m.id);
    } else if (p.kind === 'weather') {
      if (!weatherSeen && p.reportId === state.weatherReportId) live.add(m.id);
      weatherSeen = true;
    } else if (p.kind === 'question') {
      if (!questionSeen && p.questionId === state.pendingQuestionId) {
        const q = state.reports.flatMap((r) => r.questions).find((x) => x.id === p.questionId);
        if (q && !q.answeredAt && state.convo === 'awaiting_answer') live.add(m.id);
      }
      questionSeen = true;
    } else if (p.kind === 'draft') {
      if (
        !draftSeen &&
        state.convo === 'awaiting_confirmation' &&
        p.reportId === state.activeReportId &&
        state.reports.find((r) => r.id === p.reportId)?.status === 'awaiting_confirmation'
      )
        live.add(m.id);
      draftSeen = true;
    }
  }
  return live;
}

// ───────────────────────────── Routing (router/index.ts) ─────────────────────────────

function handleButton(t: Turn, id: string, title: string, msg: ChatMessage): void {
  const p = parseButtonId(id);
  switch (p.kind) {
    case 'question': {
      const r = t.report(t.s.activeReportId);
      const q = r?.questions.find((x) => x.id === p.questionId);
      if (!r || !q || q.answeredAt) return;
      if (p.option === 'other') {
        t.s.convo = 'awaiting_answer';
        t.s.pendingQuestionId = q.id;
        t.say(waCopy.answerOther(), 'answer_other');
        return;
      }
      const label = q.buttons[p.option]?.title ?? title;
      handleAnswer(t, r, q, label, 'button', msg);
      return;
    }
    case 'draft':
      if (p.action === 'ok') confirmReport(t, p.reportId, msg);
      else requestFix(t, p.reportId);
      return;
    case 'reminder':
      if (p.action === 'recording') t.say(waCopy.recordingAck(), 'recording');
      else if (p.action === 'no_work') logNoWork(t);
      else logWeatherDay(t, null, msg);
      return;
    case 'weather':
      t.s.weatherReportId = p.reportId;
      t.s.weatherFollowup = p.action;
      if (p.action === 'voice') t.say(waCopy.answerOther(), 'answer_other');
      return;
    default:
      return;
  }
}

/** A text long enough to be a report rather than a reply (router/inbound.ts looksLikeReportText). */
function looksLikeReportText(text: string, minWords = 25): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= minWords;
}

function handleText(t: Turn, text: string, msg: ChatMessage): void {
  const quick = quickClassify(text, new Date(t.now()), t.ctx.site.timezone);
  if (
    quick &&
    (quick.intent === 'help' || quick.intent === 'stop' || quick.intent === 'language')
  ) {
    globalCommand(t, quick);
    return;
  }
  if (t.s.convo === 'idle' && !quick && looksLikeReportText(text) && !t.s.weatherFollowup) {
    // F5 edge case: a typed report is extracted like a transcript — by the AI in production.
    if (t.s.scenario.kind === 'text' && normalise(text) === normalise(t.s.scenario.text)) {
      ensureReset(t);
      t.s.scenarioSent = true;
      startIntake(t, { main: msg, photos: [] });
    } else {
      t.note('unsupported_report');
    }
    return;
  }
  handleReplyText(t, text, msg, quick);
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function globalCommand(t: Turn, cls: ClassifiedReply): void {
  if (cls.intent === 'help') {
    t.say(waCopy.help(), 'help');
  } else if (cls.intent === 'stop') {
    // commands.ts: pause today's reminders; the audit row only when the flag changes.
    if (!t.s.remindersPaused) {
      t.s.remindersPaused = true;
      t.effect({ type: 'reminders_paused', at: t.now() });
      t.audit('site_day.reminders_paused', 'site_day', t.ctx.site.siteDayId, 'reporter');
    }
    t.say(waCopy.stopAck(), 'stop');
  } else {
    const code = (cls.entities?.language ?? 'en').toLowerCase().slice(0, 2);
    t.say(waCopy.languageAck(LANGUAGE_NAMES[code] ?? code), 'language');
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pl: 'Polish',
  hi: 'Hindi',
  pt: 'Portuguese',
  fr: 'French',
};

/** handlers/reply.ts — classify (quick → recorded model output → state fallback), then dispatch. */
function handleReplyText(
  t: Turn,
  text: string,
  msg: ChatMessage,
  quick: ClassifiedReply | null,
): void {
  const s = t.s;
  if (s.convo === 'idle' && s.weatherReportId && s.weatherFollowup === 'voice') {
    const r = t.report(s.weatherReportId);
    if (r) {
      weatherFollowupAnswer(t, r, text, msg);
      return;
    }
  }
  if (
    s.pendingCorrection &&
    !quick &&
    (s.convo === 'awaiting_confirmation' || s.convo === 'editing')
  ) {
    // The answer to "which crew do you mean?": apply_correction gets it with the correction.
    const r = t.report(s.convo === 'editing' ? s.editingReportId : s.activeReportId);
    if (r) {
      if (s.convo === 'editing') applyEdit(t, r, text, msg);
      else applyFix(t, r, text, msg);
      return;
    }
  }
  let cls = quick ?? recordedClassify(text);
  const fromFallback = !cls;
  // Production without a model falls back on the state (reply.ts stateFallback).
  cls ??= stateFallback(s.convo);

  switch (cls.intent) {
    case 'help':
    case 'stop':
    case 'language':
      globalCommand(t, cls);
      return;
    case 'edit_request':
      handleEditRequest(
        t,
        cls.entities?.dayReference ?? null,
        cls.correctionText ?? null,
        text,
        msg,
      );
      return;
    case 'no_work':
    case 'weather_day':
      handleDayOffText(t, text, msg, cls.intent);
      return;
    case 'confirm': {
      if (s.convo === 'awaiting_confirmation' && s.activeReportId) {
        confirmReport(t, s.activeReportId, msg);
        return;
      }
      const q = openQuestion(t);
      if (s.convo === 'awaiting_answer' && q) {
        handleAnswer(t, q.r, q.q, text, 'text', msg);
        return;
      }
      t.note('silent');
      return;
    }
    case 'answer': {
      const q = openQuestion(t);
      if (q) {
        handleAnswer(t, q.r, q.q, text, 'text', msg);
        return;
      }
      if (s.convo === 'awaiting_confirmation' && s.activeReportId) {
        const r = t.report(s.activeReportId);
        if (r) applyFix(t, r, cls.correctionText ?? text, msg);
        return;
      }
      if (s.convo === 'editing') {
        handleEditingText(t, text, msg);
        return;
      }
      t.note('silent');
      return;
    }
    case 'fix': {
      if (s.convo === 'editing') {
        handleEditingText(t, text, msg);
        return;
      }
      const r = t.report(s.activeReportId);
      if (
        (s.convo === 'awaiting_confirmation' ||
          s.convo === 'awaiting_answer' ||
          s.convo === 'processing') &&
        r &&
        (r.status === 'awaiting_confirmation' ||
          r.status === 'awaiting_answer' ||
          r.status === 'collecting')
      ) {
        applyFix(t, r, cls.correctionText ?? text, msg);
        return;
      }
      if (s.convo === 'idle' && s.lastFiledReportId) {
        handleEditRequest(t, 'today', cls.correctionText ?? text, text, msg);
        return;
      }
      t.note(fromFallback ? 'unsupported_text' : 'silent');
      return;
    }
    default: {
      if (/\b(thanks|thank you|gracias|cheers|ta)\b/i.test(text)) {
        t.say(waCopy.youreWelcome(), 'you_are_welcome');
        return;
      }
      t.note('unsupported_text');
    }
  }
}

function stateFallback(convo: SimConvoState): ClassifiedReply {
  switch (convo) {
    case 'awaiting_answer':
      return { intent: 'answer', confidence: 0.5 };
    case 'awaiting_confirmation':
    case 'editing':
      return { intent: 'fix', confidence: 0.5 };
    default:
      return { intent: 'other', confidence: 0.5 };
  }
}

function openQuestion(t: Turn): { r: SimReport; q: SimQuestion } | null {
  const r = t.report(t.s.activeReportId);
  const q = r?.questions.find((x) => x.id === t.s.pendingQuestionId && !x.answeredAt);
  return r && q ? { r, q } : null;
}

function handleMedia(t: Turn, photo: ChatMessage): void {
  const s = t.s;
  if (s.convo === 'idle' && s.weatherReportId) {
    const r = t.report(s.weatherReportId);
    if (r && r.kind === 'weather_day') {
      weatherFollowupPhoto(t, r, photo);
      return;
    }
  }
  const active = t.report(s.activeReportId);
  if (
    (s.convo === 'processing' ||
      s.convo === 'awaiting_answer' ||
      s.convo === 'awaiting_confirmation') &&
    active &&
    active.status !== 'filed' &&
    active.status !== 'void'
  ) {
    mergeIntoActive(t, active, photo);
    return;
  }
  startIntake(t, { main: null, photos: [photo] });
}

// ───────────────────────────── Intake (handlers/intake.ts) ─────────────────────────────

function liveReport(t: Turn): SimReport | undefined {
  return t.s.reports.find((r) => r.status !== 'void');
}

function nextReportNo(t: Turn): string {
  t.s.reportSeq += 1;
  return formatReportNo(t.ctx.site.projectCode, t.s.reportSeq);
}

function createReport(t: Turn, kind: SimReportKind, sourceText: string): SimReport {
  ensureReset(t);
  const r: SimReport = {
    id: t.id('r'),
    reportNo: nextReportNo(t),
    kind,
    status: 'collecting',
    data: null,
    sources: [],
    questions: [],
    reviewReasons: [],
    version: 0,
    receivedClock: t.s.clock,
    filedAt: null,
    filedClock: null,
    sourceText,
  };
  t.s.reports.push(r);
  t.effect({ type: 'report_created', reportId: r.id, reportNo: r.reportNo, kind, at: t.now() });
  t.audit('report.created', 'report', r.id, 'reporter', {
    report_no: r.reportNo,
    date: t.ctx.date,
    ...(kind !== 'daily' ? { kind } : {}),
  });
  return r;
}

function sourceOf(m: ChatMessage): SimSource {
  return {
    messageId: m.id,
    kind: m.kind === 'voice' ? 'audio' : m.kind === 'photo' ? 'photo' : 'text',
    caption: m.kind === 'photo' ? (m.caption ?? null) : null,
    at: m.at,
  };
}

/** §F5 steps 1–3 (startIntake): site-day, report, sources, ack, pipeline. */
function startIntake(
  t: Turn,
  batch: { main: ChatMessage | null; photos: ChatMessage[] },
  opts: { deferPipeline?: boolean } = {},
): { report: SimReport; durationS: number | null } | null {
  const s = t.s;
  const onlyPhotos = !batch.main;
  let r = s.reports.find((x) => x.kind === 'daily' && x.status !== 'void' && x.status !== 'filed');
  if (!r && s.dayStatus === 'no_work' && onlyPhotos) {
    t.say(waCopy.photoOnNoWorkDay(t.ctx.site.name), 'photo_no_work');
    return null;
  }
  if (!r) {
    const filed = s.reports.find((x) => x.status === 'filed');
    if (filed) {
      if (onlyPhotos) attachLatePhotos(t, filed, batch.photos);
      else t.note('voice_busy', { first: t.first });
      return null;
    }
    r = createReport(t, 'daily', batch.main?.text ?? '');
  }
  if (batch.main) {
    r.sources.push(sourceOf(batch.main));
    r.sourceText = batch.main.text;
  }
  for (const p of batch.photos) r.sources.push(sourceOf(p));
  const hasContent = r.sources.some((x) => x.kind === 'audio' || x.kind === 'text');
  if (!hasContent) {
    t.say(waCopy.photosOnly(), 'photos_only');
    return null;
  }
  if (s.dayStatus === 'pending' || s.dayStatus === 'reminded' || s.dayStatus === 'missing') {
    s.dayStatus = 'processing';
    t.effect({ type: 'site_day', status: 'processing', at: t.now() });
  }
  s.convo = 'processing';
  s.activeReportId = r.id;
  s.pendingQuestionId = null;
  r.receivedClock = s.clock;
  const voice = batch.main?.kind === 'voice';
  const duration = voice ? (batch.main?.durationS ?? 0) : null;
  t.say(waCopy.ackReceived(t.first, duration, batch.photos.length), 'ack', {
    delayMs: DELAYS.ack,
  });
  t.legend({ kind: 'received', voice, durationS: duration, photos: batch.photos.length });
  const durationS = voice ? (duration ?? 0) : null;
  if (!opts.deferPipeline) runPipeline(t, r, durationS);
  return { report: r, durationS };
}

/** transcribe_audio → afterTranscription → extract_report → decide_next. */
function runPipeline(t: Turn, r: SimReport, durationS: number | null): void {
  const s = t.s;
  const text = r.sourceText;
  if (durationS !== null) {
    // router/continue.ts: a short "report" may really be a command ("rained out", "no work today").
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words > 0 && words < 25) {
      const intent =
        quickClassify(text, new Date(t.now()), t.ctx.site.timezone)?.intent ??
        recordedClassify(text)?.intent;
      if (intent === 'no_work' || intent === 'weather_day') {
        voidReport(t, r);
        s.convo = 'idle';
        s.activeReportId = null;
        const msg = s.messages.find(
          (m) => m.id === r.sources.find((x) => x.kind === 'audio')?.messageId,
        );
        if (msg) handleDayOffText(t, text, msg, intent, photoSources(r));
        return;
      }
    }
  }
  // The pipeline runs from the moment the note came in (photos sent meanwhile do not delay it):
  // each step finishes at its checkpoint on the session clock; the progress bubble goes out at
  // the first checkpoint more than 10 s after the note.
  let progressSent = false;
  let checkpoint = r.receivedClock;
  const reach = (ms: number) => {
    checkpoint += ms;
    s.clock = Math.max(s.clock, checkpoint);
  };
  const progress = (facts: Parameters<typeof progressSteps>[0]) => {
    if (progressSent || checkpoint - r.receivedClock <= PROGRESS_AFTER_MS) return;
    progressSent = true;
    t.say(waCopy.progressLines(progressSteps(facts)), 'progress', { delayMs: DELAYS.progress });
  };
  if (durationS !== null) {
    reach(transcriptionMs(durationS));
    progress({ transcribed: true });
  }
  reach(EXTRACTION_MS);
  const data = extractionFor(t, r);
  r.data = data;
  t.audit('report.extracted', 'report', r.id, 'agent', {
    sources: r.sources.length,
    languages: data.languageDetected,
    replayed_fixture: s.scenario.id,
  });
  storeDraft(t, r, null);
  progress({
    transcribed: durationS !== null,
    draft: data,
    selfPerformCompanyIds: selfPerformIds(s),
  });
  decideNext(t, r);
}

function selfPerformIds(s: SimState): Set<string> {
  return new Set(s.companies.filter((c) => c.isSelfPerform).map((c) => c.id));
}

/** The recorded extraction for the scenario, moved onto today and the demo org's ids. */
function extractionFor(t: Turn, r: SimReport): DailyReportDataV1 {
  const sc = t.s.scenario;
  const main = r.sources.find((x) => x.kind === 'audio' || x.kind === 'text');
  let json = JSON.stringify(sc.extraction);
  if (main) for (const id of sc.sourceMessageIds) json = json.split(id).join(main.messageId);
  const data = JSON.parse(json) as DailyReportDataV1;
  data.reportDate = t.ctx.date;
  data.manpower = data.manpower.map((m) => ({ ...m, companyId: mapCompany(t.s, sc, m.companyId) }));
  data.photos = photosOf(r);
  // Observed weather is added by code from today's site-day, not from the recording's day.
  if (t.ctx.observedWeather) data.weather.observed = { ...t.ctx.observedWeather };
  else delete data.weather.observed;
  return data;
}

function mapCompany(s: SimState, sc: Scenario, fixtureId: string | null): string | null {
  if (!fixtureId) return null;
  const name = sc.fixtureCompanies[fixtureId];
  if (!name) return null;
  return s.companies.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

function photoSources(r: SimReport): SimSource[] {
  return r.sources.filter((x) => x.kind === 'photo');
}

/** pipeline/draft.ts storeDraft: the working draft is kept in version 1 while it is open. */
function storeDraft(t: Turn, r: SimReport, messageId: string | null): void {
  if (!r.data || r.status === 'filed' || r.status === 'void') return;
  t.effect({ type: 'draft', reportId: r.id, data: r.data, messageId, at: t.now() });
}

function photosOf(r: SimReport): DailyReportDataV1['photos'] {
  return r.sources
    .filter((x) => x.kind === 'photo')
    .map((x) => ({ messageId: x.messageId, caption: x.caption ?? undefined, takenAt: x.at }));
}

function validate(t: Turn, data: DailyReportDataV1, photoCount: number): ValidationResult {
  return validateReport(data, { requiredFields: t.ctx.settings.requiredFields, photoCount });
}

/** jobs/decide_next.ts — one question at a time (§F6) or the draft card (§F7). */
function decideNext(t: Turn, r: SimReport): void {
  const s = t.s;
  if (r.status === 'filed' || r.status === 'void' || !r.data) return;
  // §F10: a long note saying nobody worked goes to the day-off flow (router/continue.ts).
  if (r.questions.length === 0 && looksLikeDayOff(r.data, r.sourceText)) {
    const msg = s.messages.find(
      (m) => m.id === r.sources.find((x) => x.kind !== 'photo')?.messageId,
    );
    voidReport(t, r);
    s.convo = 'idle';
    s.activeReportId = null;
    s.pendingQuestionId = null;
    const hint = r.data.weather.periods.some((p) => p.fullDay || (p.lostHours ?? 0) > 0)
      ? 'weather_day'
      : 'no_work';
    if (msg) handleDayOffText(t, r.sourceText, msg, hint, photoSources(r));
    return;
  }
  r.data = { ...r.data, photos: mergePhotos(r.data.photos, photosOf(r)) };
  const photoCount = r.sources.filter((x) => x.kind === 'photo').length;
  const validation = validate(t, r.data, photoCount);
  const open = r.questions.find((q) => !q.answeredAt);
  if (open) {
    if (validation.gaps.some((g) => g.path === open.path)) return;
    open.answeredAt = t.now();
    open.answer = { resolved_by: 'extraction' };
  }
  const spec = pickNextQuestion(r.data, validation, {
    askedPaths: r.questions.map((q) => q.path),
    askedCount: r.questions.length,
    maxQuestions: t.ctx.settings.maxQuestions,
    companies: s.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
  });
  if (spec) sendQuestion(t, r, spec);
  else sendDraft(t, r);
}

function mergePhotos(
  have: DailyReportDataV1['photos'],
  from: DailyReportDataV1['photos'],
): DailyReportDataV1['photos'] {
  const ids = new Set(have.map((p) => p.messageId));
  return [...have, ...from.filter((p) => !ids.has(p.messageId))];
}

function sendQuestion(t: Turn, r: SimReport, spec: QuestionSpec): void {
  const id = t.id('q');
  const labels = spec.options.map((o) => o.label);
  const buttons = ButtonSets.question(id, labels);
  const q: SimQuestion = {
    id,
    field: spec.field,
    path: spec.path,
    prompt: spec.prompt,
    options: labels,
    buttons,
    target: spec.target,
    askedAt: '',
    answeredAt: null,
    answer: null,
    reasks: 0,
  };
  const m = t.say(waCopy.questionGeneric(spec.prompt), 'question', {
    buttons,
    delayMs: DELAYS.question,
  });
  q.askedAt = m.at;
  r.questions.push(q);
  r.status = 'awaiting_answer';
  t.effect({ type: 'report_status', reportId: r.id, status: 'awaiting_answer', at: t.now() });
  t.s.convo = 'awaiting_answer';
  t.s.activeReportId = r.id;
  t.s.pendingQuestionId = q.id;
  t.audit('report.question_asked', 'report', r.id, 'agent', { question_id: q.id, field: q.field });
  t.legend({ kind: 'question', prompt: spec.prompt });
}

/** pipeline/draft.ts sendDraft — the §F7 card with OK / Fix buttons. */
function sendDraft(t: Turn, r: SimReport): void {
  const data = r.data!;
  const card = formatDraftCard(data, {
    siteName: t.ctx.site.name,
    totals: deriveTotals(data, { selfPerformCompanyIds: selfPerformIds(t.s) }),
  });
  t.say(card, 'draft', { buttons: ButtonSets.draft(r.id), delayMs: DELAYS.draft });
  r.status = 'awaiting_confirmation';
  t.effect({
    type: 'report_status',
    reportId: r.id,
    status: 'awaiting_confirmation',
    at: t.now(),
  });
  t.s.convo = 'awaiting_confirmation';
  t.s.activeReportId = r.id;
  t.s.pendingQuestionId = null;
  t.audit('report.draft_sent', 'report', r.id, 'agent');
  t.legend({ kind: 'draft' });
}

// ───────────────────────────── Answers (handlers/question.ts) ─────────────────────────────

function handleAnswer(
  t: Turn,
  r: SimReport,
  q: SimQuestion,
  text: string,
  via: 'button' | 'text',
  msg: ChatMessage,
): void {
  const s = t.s;
  if (!r.data) return;
  let value: AnswerValue | null = parseQuickAnswer(q.field, text);
  let confidence = 1;
  if (!value) {
    // parse_answer (model) in production; the simulator has its recorded outputs and, for the
    // two cases code can settle, the same outcome the model would reach.
    const rec = recordedAnswer(text);
    if (rec) {
      confidence = rec.confidence;
      value = rec.value;
      if (confidence < LOW_CONFIDENCE_THRESHOLD) {
        reaskOrGiveUp(t, r, q, text);
        return;
      }
    } else if (q.field === 'company.unknown') {
      value = companyFromText(s.companies, text);
    } else if (q.field === 'manpower.workers' && !NUMBER_RE.test(text)) {
      // No headcount in the reply: question.ts re-asks once, then gives up (no model needed).
      reaskOrGiveUp(t, r, q, text);
      return;
    }
    if (!value) {
      t.note('unsupported_answer', { prompt: q.prompt, field: q.field });
      return;
    }
  }
  if (q.field === 'manpower.workers' && value.workers == null) {
    reaskOrGiveUp(t, r, q, text);
    return;
  }
  const reasons: string[] = [];
  if (q.field === 'company.unknown' && value.companyAction === 'add') {
    const name = (
      value.companyName ??
      q.target.companyName ??
      q.target.companyNameHeard ??
      'Unknown company'
    ).trim();
    // The same name added before (a re-run of this scenario) is reused, not duplicated.
    const same = s.companies.find((c) => c.name.toLowerCase() === name.toLowerCase());
    let companyId = same?.id;
    if (!companyId) {
      companyId = t.id('c');
      s.companies.push({
        id: companyId,
        name,
        aliases: [],
        isSelfPerform: false,
        unconfirmed: true,
      });
      t.effect({ type: 'company_added', companyId, name, reportId: r.id, at: t.now() });
      t.audit('company.added_unconfirmed', 'company', companyId, 'reporter', { report_id: r.id });
      t.legend({ kind: 'company_added', name });
    }
    if (!same || same.unconfirmed) reasons.push(`unknown_company:${name}`);
    value = { ...value, companyAction: 'map', companyId, companyName: same?.name ?? name };
  }
  const applied = applyAnswer(r.data, { field: q.field, target: q.target }, value, {
    defaultShiftHours: t.ctx.settings.defaultShiftHours,
    workingHours: t.ctx.site.workingHours,
    source: { type: 'reply', messageId: msg.id },
    confidence,
    companies: s.companies,
  });
  const next = applied.data;
  if (
    q.field === 'company.unknown' &&
    value.companyAction === 'map' &&
    value.companyId !== undefined &&
    q.target.manpowerIndex !== undefined
  ) {
    const entry = next.manpower[q.target.manpowerIndex];
    if (entry) entry.companyId = value.companyId;
  }
  r.data = next;
  storeDraft(t, r, msg.id);
  q.answeredAt = msg.at;
  q.answer = { ...value, text, via };
  if (reasons.length) {
    // question.ts flags the report for review as soon as the company is added.
    r.reviewReasons = [...new Set([...r.reviewReasons, ...reasons])];
    t.effect({ type: 'review_flag', reportId: r.id, reasons, at: t.now() });
  }
  t.audit('report.question_answered', 'report', r.id, 'reporter', {
    question_id: q.id,
    field: q.field,
    via,
    answer: text,
  });
  s.convo = 'processing';
  s.pendingQuestionId = null;
  const ack =
    applied.ackText ??
    (q.field === 'company.unknown' && value.companyName
      ? `Thanks — logged as ${value.companyName}.`
      : null);
  if (ack) t.say(ack, 'answer_ack');
  t.legend({ kind: 'answered', answer: text, ack });
  decideNext(t, r);
}

const NUMBER_RE =
  /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/i;

/**
 * A typed answer to "who is {company}?": a known company by name or alias maps to it; a short
 * name is added as a new subcontractor (what parse_answer returns for these replies).
 */
function companyFromText(companies: ReadonlyArray<SimCompany>, raw: string): AnswerValue | null {
  const text = raw.trim().replace(/[.!]+$/, '');
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5 || !/\p{L}/u.test(text)) return null;
  for (const c of companies) {
    for (const n of [c.name, ...c.aliases]) {
      if (!n || n.length < 3) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
      if (re.test(text)) return { companyAction: 'map', companyId: c.id, companyName: c.name };
    }
  }
  // Only something that reads as a name ("Prairie Roofing", "ramirez drywall"), not a sentence.
  const looksLikeName =
    words.some((w) => /^\p{Lu}/u.test(w)) || COMPANY_SUFFIX.test(words.at(-1) ?? '');
  if (/\d/.test(text) || !looksLikeName || NOT_A_NAME.test(text)) return null;
  return { companyAction: 'add', companyName: text };
}

const NOT_A_NAME =
  /\b(i|we|you|they|he|she|it|was|were|is|are|think|know|not|no|don'?t|didn'?t|guys|left|maybe|later|sure)\b/i;

const COMPANY_SUFFIX =
  /^(roofing|electric|electrical|drywall|concrete|steel|glazing|mechanical|plumbing|construction|builders|framing|masonry|paving|co|inc|llc|ltd)$/i;

function reaskOrGiveUp(t: Turn, r: SimReport, q: SimQuestion, text: string): void {
  if (q.reasks < 1) {
    q.reasks += 1;
    t.say(waCopy.questionGeneric(q.prompt), 'reask', {
      buttons: q.buttons,
      delayMs: DELAYS.question,
    });
    t.s.convo = 'awaiting_answer';
    t.s.pendingQuestionId = q.id;
    return;
  }
  q.answeredAt = t.now();
  q.answer = { text, unanswered: true };
  t.legend({ kind: 'unanswered', prompt: q.prompt });
  t.s.convo = 'processing';
  t.s.pendingQuestionId = null;
  decideNext(t, r);
}

// ───────────────────────────── Draft, fix, file (handlers/draft.ts, pipeline/file.ts) ─────────────

function confirmReport(t: Turn, reportId: string, msg: ChatMessage): void {
  const r = t.report(reportId);
  if (!r || r.status === 'filed' || r.status === 'void') return;
  fileReport(t, r, 'confirm', false, msg.id);
}

function requestFix(t: Turn, reportId: string): void {
  if (t.report(reportId)?.status !== 'awaiting_confirmation') return;
  t.s.convo = 'awaiting_confirmation';
  t.s.fixRequestedFor = reportId;
  t.s.activeReportId = reportId;
  t.say(waCopy.fixPrompt(), 'fix_prompt');
}

/** The correction text, joined with a pending one when this reply answers "which crew?". */
function withPending(t: Turn, text: string): string {
  const pending = t.s.pendingCorrection;
  t.s.pendingCorrection = null;
  return pending ? `${text} ${pending}` : text;
}

function applyFix(t: Turn, r: SimReport, text: string, msg: ChatMessage): void {
  if (!r.data) return;
  const correction = withPending(t, text);
  const res = correctDraft(r.data, correction, {
    companies: t.s.companies,
    defaultShiftHours: t.ctx.settings.defaultShiftHours,
    workingHours: t.ctx.site.workingHours,
    messageId: msg.id,
  });
  if (res.kind === 'clarify') {
    t.s.convo = 'awaiting_confirmation';
    t.s.fixRequestedFor = r.id;
    t.s.pendingCorrection = correction;
    t.say(waCopy.questionGeneric(res.question), 'fix_clarify');
    return;
  }
  if (res.kind === 'none') {
    t.note('unsupported_fix');
    return;
  }
  if (res.kind === 'unchanged') {
    t.note('unchanged_fix');
    return;
  }
  r.data = res.data;
  storeDraft(t, r, msg.id);
  t.audit('report.draft_corrected', 'report', r.id, 'reporter', {
    change_note: res.changeNote,
    message_id: msg.id,
  });
  t.legend({ kind: 'corrected', note: res.changeNote });
  t.s.fixRequestedFor = null;
  sendDraft(t, r);
}

/** pipeline/validate.ts reviewReasons — validation + missing + unanswered + extras, deduplicated. */
function reviewReasonsOf(
  validation: ValidationResult,
  questions: SimQuestion[],
  extras: string[],
): string[] {
  const reasons = new Set<string>(validation.reviewReasons);
  for (const m of validation.missingRequired) reasons.add(`missing:${m}`);
  for (const q of questions) {
    if (!q.answeredAt || q.answer?.unanswered) reasons.add(`unanswered:${q.field}`);
  }
  for (const e of extras) if (e) reasons.add(e);
  return [...reasons];
}

function fileReport(
  t: Turn,
  r: SimReport,
  trigger: 'confirm' | 'weather_day' | 'no_work',
  silent: boolean,
  confirmMessageId: string | null = null,
): void {
  const s = t.s;
  const data = r.data!;
  const photos = photosOf(r);
  const validation =
    r.kind === 'daily'
      ? validate(t, data, photos.length)
      : { gaps: [], missingRequired: [], lowConfidence: [], reviewReasons: [], isComplete: true };
  const reasons = reviewReasonsOf(validation, r.questions, r.reviewReasons);
  const frozen: DailyReportDataV1 = {
    ...data,
    missingRequired: validation.missingRequired,
    lowConfidence: validation.lowConfidence,
    photos: data.photos.length ? data.photos : photos,
  };
  r.data = frozen;
  r.status = 'filed';
  r.version = 1;
  r.filedAt = t.now();
  r.filedClock = s.clock;
  r.reviewReasons = reasons;
  s.dayStatus =
    r.kind === 'weather_day' ? 'weather_day' : r.kind === 'no_work' ? 'no_work' : 'filed';
  t.effect({
    type: 'file',
    reportId: r.id,
    reportNo: r.reportNo,
    kind: r.kind,
    data: frozen,
    trigger,
    reasons,
    questions: r.questions,
    sources: r.sources,
    confirmMessageId,
    at: t.now(),
  });
  s.convo = 'idle';
  s.activeReportId = null;
  s.pendingQuestionId = null;
  s.fixRequestedFor = null;
  s.pendingCorrection = null;
  s.lastFiledReportId = r.id;
  if (r.kind === 'weather_day') t.legend({ kind: 'weather_day', reportNo: r.reportNo });
  else t.legend({ kind: 'filed', reportNo: r.reportNo, needsReview: reasons.length > 0 });
  if (!silent && r.kind === 'daily') {
    t.say(waCopy.filed(r.reportNo, t.first), 'filed', { delayMs: DELAYS.filed });
    // jobs/render_pdf.ts: the PDF as a document message, then the edit hint.
    t.say(`Daily Report ${r.reportNo}`, 'pdf', {
      kind: 'document',
      fileName: pdfFileName(r.reportNo, frozen.reportDate, 1),
      delayMs: DELAYS.pdf,
    });
    t.say(waCopy.editHint(weekdayName(frozen.reportDate)), 'edit_hint', { delayMs: DELAYS.hint });
  }
}

function voidReport(t: Turn, r: SimReport): void {
  r.status = 'void';
  t.effect({ type: 'report_void', reportId: r.id, at: t.now() });
  if (t.s.dayStatus === 'processing') {
    t.s.dayStatus = 'pending';
    t.effect({ type: 'site_day', status: 'pending', at: t.now() });
  }
  t.audit('report.voided', 'report', r.id, 'agent');
  t.legend({ kind: 'voided', reportNo: r.reportNo });
}

function mergeIntoActive(t: Turn, r: SimReport, photo: ChatMessage): void {
  r.sources.push(sourceOf(photo));
  const q = r.questions.find((x) => x.id === t.s.pendingQuestionId && !x.answeredAt);
  if (q && q.field === 'photo') {
    q.answeredAt = photo.at;
    q.answer = { photo: true };
    t.s.pendingQuestionId = null;
    t.s.convo = 'processing';
    t.say(waCopy.mergedMore(), 'merged');
    t.legend({ kind: 'photo_answered' });
    decideNext(t, r);
    return;
  }
  if (t.s.convo === 'awaiting_confirmation' && r.data) {
    r.data = { ...r.data, photos: mergePhotos(r.data.photos, photosOf(r)) };
    storeDraft(t, r, photo.id);
  }
  t.say(waCopy.mergedMore(), 'merged');
}

/** §7.2: photos within 10 minutes of filing attach to the filed report as a new version. */
function attachLatePhotos(t: Turn, r: SimReport, photos: ChatMessage[]): void {
  const withinWindow =
    r.filedClock !== null && Math.abs(t.s.clock - r.filedClock) <= LATE_PHOTO_WINDOW_MS;
  const recent = withinWindow ? photos : [];
  if (recent.length === 0 || !r.data) {
    t.say(waCopy.editHint(weekdayName(t.ctx.date)), 'edit_hint');
    return;
  }
  for (const p of recent) r.sources.push(sourceOf(p));
  newVersion(
    t,
    r,
    { ...r.data, photos: mergePhotos(r.data.photos, photosOf(r)) },
    'agent',
    `Photo${recent.length > 1 ? 's' : ''} added`,
    recent[0]!.id,
    sourceOf(recent[0]!),
  );
  t.say(waCopy.mergedMore(), 'merged');
}

function newVersion(
  t: Turn,
  r: SimReport,
  data: DailyReportDataV1,
  author: 'agent' | 'reporter',
  changeNote: string,
  messageId: string,
  source: SimSource | null,
): void {
  r.version += 1;
  r.data = data;
  t.effect({
    type: 'version',
    reportId: r.id,
    version: r.version,
    data,
    author,
    changeNote,
    messageId,
    source,
    at: t.now(),
  });
  t.legend({ kind: 'version', reportNo: r.reportNo, version: r.version, note: changeNote });
}

// ───────────────────────────── Edit after filing (handlers/edit.ts) ─────────────────────────────

function handleEditRequest(
  t: Turn,
  dayReference: string | null,
  correctionText: string | null,
  rawText: string,
  msg: ChatMessage,
): void {
  const date =
    dayReference && /^\d{4}-\d{2}-\d{2}$/.test(dayReference)
      ? dayReference
      : resolveDayReference(dayReference ?? rawText, new Date(t.now()), t.ctx.site.timezone);
  const filed = t.report(t.s.lastFiledReportId);
  const r = filed?.status === 'filed' ? filed : undefined;
  if (!date || (date === t.ctx.date && !r)) {
    // edit.ts: nothing filed for that day (findReportsByDate only returns filed reports).
    t.say(waCopy.noReportFound(), 'edit_no_report');
    return;
  }
  if (date !== t.ctx.date || !r || r.kind !== 'daily') {
    // Production edits any report of the last 14 days; the simulator only has today's.
    t.note('edit_other_day', {
      weekday: weekdayName(t.ctx.date),
      example: r?.kind === 'daily' ? 'yes' : '',
    });
    return;
  }
  const correction = (correctionText ?? '').trim();
  if (!correction) {
    t.s.convo = 'editing';
    t.s.editingReportId = r.id;
    t.say(waCopy.fixPrompt(), 'fix_prompt');
    return;
  }
  applyEdit(t, r, correction, msg);
}

function handleEditingText(t: Turn, text: string, msg: ChatMessage): void {
  const r = t.report(t.s.editingReportId);
  if (!r) {
    t.s.convo = 'idle';
    t.s.editingReportId = null;
    return;
  }
  applyEdit(t, r, text, msg);
}

function applyEdit(t: Turn, r: SimReport, text: string, msg: ChatMessage): void {
  if (!r.data) return;
  const correction = withPending(t, text);
  const res = correctDraft(r.data, correction, {
    companies: t.s.companies,
    defaultShiftHours: t.ctx.settings.defaultShiftHours,
    workingHours: t.ctx.site.workingHours,
    messageId: msg.id,
  });
  if (res.kind === 'clarify') {
    t.s.convo = 'editing';
    t.s.editingReportId = r.id;
    t.s.pendingCorrection = correction;
    t.say(waCopy.questionGeneric(res.question), 'fix_clarify');
    return;
  }
  if (res.kind === 'none') {
    t.s.convo = 'editing';
    t.s.editingReportId = r.id;
    t.note('unsupported_fix');
    return;
  }
  if (res.kind === 'unchanged') {
    t.s.convo = 'idle';
    t.s.editingReportId = null;
    t.note('unchanged_fix');
    return;
  }
  newVersion(t, r, res.data, 'reporter', res.changeNote, msg.id, null);
  t.s.convo = 'idle';
  t.s.editingReportId = null;
  t.say(
    waCopy.editApplied(weekdayName(res.data.reportDate), res.changeNote, r.version),
    'edit_applied',
  );
}

export interface CorrectionContext {
  companies: ReadonlyArray<SimCompany>;
  defaultShiftHours: number;
  workingHours: string | null;
  messageId: string;
}

export type CorrectionOutcome =
  | { kind: 'patched'; data: DailyReportDataV1; changeNote: string }
  | { kind: 'clarify'; question: string }
  /** The crew and the numbers were understood, and the report already says that. */
  | { kind: 'unchanged' }
  | { kind: 'none' };

/**
 * The deterministic part of apply_correction: "Apex had 7 not 6", "Summit was there till 3",
 * "BrightLine 4 guys full day". Finds the crew by name or alias, parses the numbers with the same
 * parser as button/text answers (parseQuickAnswer) and applies them with applyAnswer, so totals
 * are recomputed in code. Anything else is the model's job in production.
 */
export function correctDraft(
  data: DailyReportDataV1,
  text: string,
  ctx: CorrectionContext,
): CorrectionOutcome {
  const idx = findCrew(data, text, ctx.companies);
  if (idx === null) {
    const subcontractors = data.manpower
      .filter((m) => !ctx.companies.find((c) => c.id === m.companyId)?.isSelfPerform)
      .map((m) => m.companyName);
    const rec = recordedAmbiguousCorrection(text, subcontractors);
    return rec?.needsClarification
      ? { kind: 'clarify', question: rec.needsClarification }
      : { kind: 'none' };
  }
  const before = data.manpower[idx.index]!;
  const rest = text.replace(idx.matched, ' ');
  const value =
    parseQuickAnswer('manpower.workers', rest) ?? parseQuickAnswer('manpower.hours', rest);
  if (!value) return { kind: 'none' };
  const applied = applyAnswer(
    data,
    {
      field: 'manpower.workers',
      target: {
        manpowerIndex: idx.index,
        companyName: before.companyName,
        companyNameHeard: before.companyNameHeard,
      },
    },
    value,
    {
      defaultShiftHours: ctx.defaultShiftHours,
      workingHours: ctx.workingHours,
      source: { type: 'reply', messageId: ctx.messageId },
    },
  );
  const after = applied.data.manpower[idx.index]!;
  if (
    after.workers === before.workers &&
    after.hoursPerWorker === before.hoursPerWorker &&
    after.totalHours === before.totalHours
  )
    return { kind: 'unchanged' };
  const fmt = (n: number | null) => (n === null ? '?' : String(round2(n)));
  const changeNote = `${after.companyName} ${fmt(after.workers)} workers · ${fmt(after.totalHours)} h (was ${fmt(before.workers)} · ${fmt(before.totalHours)} h)`;
  return { kind: 'patched', data: applied.data, changeNote };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findCrew(
  data: DailyReportDataV1,
  text: string,
  companies: ReadonlyArray<SimCompany>,
): { index: number; matched: string } | null {
  let best: { index: number; matched: string } | null = null;
  data.manpower.forEach((m, index) => {
    const company = m.companyId ? companies.find((c) => c.id === m.companyId) : undefined;
    const names = [m.companyName, m.companyNameHeard, ...(company?.aliases ?? [])];
    const firstWord = m.companyName.split(/\s+/)[0] ?? '';
    if (firstWord.length >= 4) names.push(firstWord);
    for (const n of names) {
      if (!n || n.length < 3) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(n)})(?=$|[^\\p{L}\\p{N}])`, 'iu');
      const hit = re.exec(text);
      if (hit && (!best || hit[2]!.length > best.matched.length))
        best = { index, matched: hit[2]! };
    }
  });
  return best;
}

// ───────────────────────────── Day off (handlers/dayoff.ts) ─────────────────────────────

function handleDayOffText(
  t: Turn,
  text: string,
  msg: ChatMessage,
  hint: 'weather_day' | 'no_work',
  photos: SimSource[] = [],
): void {
  // classify_day_off is a model call in production; offline the worker uses quickDayOff.
  const cls = recordedDayOff(text) ?? quickDayOff(text);
  const kind = cls.confidence >= 0.5 ? cls.kind : hint;
  if (kind === 'no_work') logNoWork(t);
  else logWeatherDay(t, { ...cls, kind: 'weather_day' }, msg, photos);
}

/**
 * A day-off command while a daily report is still open: that report is voided (its photos go
 * with the day-off record) instead of being overwritten or left open. Known gap: the worker's
 * ensureReportForDay (handlers/dayoff.ts) still reuses the open report; it should do the same.
 */
function voidOpenDaily(t: Turn): SimSource[] {
  const open = t.s.reports.filter(
    (r) => r.kind === 'daily' && r.status !== 'filed' && r.status !== 'void',
  );
  const photos: SimSource[] = [];
  for (const r of open) {
    photos.push(...photoSources(r));
    voidReport(t, r);
  }
  if (open.length) {
    t.s.activeReportId = null;
    t.s.pendingQuestionId = null;
    t.s.fixRequestedFor = null;
    t.s.pendingCorrection = null;
  }
  return photos;
}

/** §F10 step 3. `cls` null → the R1 button "Site closed: weather" (full day, cause unknown). */
function logWeatherDay(
  t: Turn,
  cls: DayOffClassification | null,
  msg: ChatMessage,
  photos: SimSource[] = [],
): void {
  const s = t.s;
  ensureReset(t);
  const classification: DayOffClassification = cls ?? {
    kind: 'weather_day',
    fullDay: true,
    releasedAt: null,
    cause: 'weather',
    workersThisMorning: null,
    confidence: 1,
  };
  if (liveReport(t)?.status === 'filed') {
    t.say(waCopy.editHint(weekdayName(t.ctx.date)), 'edit_hint');
    return;
  }
  const carried = [...photos, ...voidOpenDaily(t)];
  const r = createReport(t, 'weather_day', msg.text);
  const source: SourceV1 =
    msg.kind === 'voice'
      ? { type: 'audio', messageId: msg.id, start: 0 }
      : { type: 'reply', messageId: msg.id };
  r.sources.push({
    messageId: msg.id,
    kind: msg.kind === 'voice' ? 'audio' : 'reply',
    caption: null,
    at: msg.at,
  });
  for (const p of carried)
    if (!r.sources.some((x) => x.messageId === p.messageId)) r.sources.push(p);
  r.data = weatherDayData(t.ctx.date, classification, {
    defaultShiftHours: t.ctx.settings.defaultShiftHours,
    workingHours: t.ctx.site.workingHours,
    source,
  });
  r.data.photos = mergePhotos(r.data.photos, photosOf(r));
  fileReport(t, r, 'weather_day', true);
  s.convo = 'idle';
  s.activeReportId = null;
  s.weatherReportId = r.id;
  s.weatherFollowup = null;
  t.say(
    waCopy.weatherDayLogged(
      classification.fullDay ? null : classification.releasedAt,
      classification.cause ?? 'weather',
    ),
    'weather_day',
  );
  t.say(waCopy.weatherDayFollowup(), 'weather_followup', {
    buttons: ButtonSets.weatherFollowup(r.id),
  });
}

/** §F10 step 4 — planned no-work day. */
function logNoWork(t: Turn): void {
  const s = t.s;
  ensureReset(t);
  if (s.dayStatus === 'filed') {
    t.say(waCopy.editHint(weekdayName(t.ctx.date)), 'edit_hint');
    return;
  }
  voidOpenDaily(t);
  if (t.ctx.settings.noWorkPdf) {
    const live = liveReport(t);
    if (!live) {
      const r = createReport(t, 'no_work', '');
      r.data = {
        schemaVersion: 1,
        reportDate: t.ctx.date,
        languageDetected: [],
        summary: `No work at ${t.ctx.site.name} — planned non-working day.`,
        weather: { conditionsText: 'Not recorded (no work)', periods: [] },
        manpower: [],
        workPerformed: [],
        deliveries: [],
        equipment: [],
        safety: { incidents: [], noIncidentsStated: false, visitors: [], source: [] },
        issues: [],
        nextWorkday: [],
        photos: [],
        newTerms: [],
        missingRequired: [],
        lowConfidence: [],
        proposedQuestions: [],
      };
      fileReport(t, r, 'no_work', true);
    }
  } else {
    s.dayStatus = 'no_work';
    t.effect({ type: 'no_work', at: t.now() });
  }
  t.audit('site_day.no_work', 'site_day', t.ctx.site.siteDayId, 'reporter');
  s.convo = 'idle';
  s.activeReportId = null;
  t.legend({ kind: 'no_work' });
  t.say(waCopy.noWorkLogged(t.ctx.site.name), 'no_work');
}

/** A photo after a weather day goes into the delay record. */
function weatherFollowupPhoto(t: Turn, r: SimReport, photo: ChatMessage): void {
  if (!r.data) return;
  const src = sourceOf(photo);
  r.sources.push(src);
  newVersion(
    t,
    r,
    { ...r.data, photos: mergePhotos(r.data.photos, photosOf(r)) },
    'agent',
    'Photo of conditions added',
    photo.id,
    src,
  );
  t.s.weatherFollowup = null;
  t.say(waCopy.weatherPhotoAck(), 'weather_photo_ack');
}

/** "How many were on site this morning?" answered after "Answer by voice". */
function weatherFollowupAnswer(t: Turn, r: SimReport, text: string, msg: ChatMessage): void {
  if (!r.data) return;
  const workers =
    quickDayOff(text).workersThisMorning ?? Number(/\b(\d{1,3})\b/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(workers)) {
    t.say(waCopy.answerOther(), 'answer_other');
    return;
  }
  const idx = r.data.manpower.findIndex((m) => m.companyName === 'Site crew');
  const applied = applyAnswer(
    r.data,
    {
      field: 'manpower.workers',
      target: {
        manpowerIndex: idx >= 0 ? idx : undefined,
        companyNameHeard: 'crew on site this morning',
        companyName: 'Site crew',
      },
    },
    { workers },
    {
      defaultShiftHours: t.ctx.settings.defaultShiftHours,
      workingHours: t.ctx.site.workingHours,
      source: { type: 'reply', messageId: msg.id },
    },
  );
  newVersion(t, r, applied.data, 'reporter', `Crew on site this morning: ${workers}`, msg.id, null);
  t.s.weatherFollowup = null;
  t.say(applied.ackText ?? waCopy.weatherPhotoAck(), 'answer_ack');
}

// ───────────────────────────── Selectors ─────────────────────────────

export function activeReport(state: SimState): SimReport | undefined {
  return state.reports.find((r) => r.id === state.activeReportId);
}

/** The report the office can open: the filed (or weather-day) report of this session. */
export function filedReport(state: SimState): SimReport | undefined {
  return [...state.reports].reverse().find((r) => r.status === 'filed');
}

export function voiceLabel(durationS: number | null | undefined): string {
  return durationS ? formatDuration(durationS) : '';
}
