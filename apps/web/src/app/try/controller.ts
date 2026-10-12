/**
 * The /try conversation outside React: one controller per DemoStore, so leaving the page (to open
 * the filed report, say) and coming back resumes the same chat, and agent messages still queued
 * keep landing in the store while the page is away.
 */
import type { DemoStore } from '@/data/demo/store';
import { sleep } from '@/lib/utils';
import { applySimEvent, buildSimContext, SIM_ID_PREFIX } from './adapter';
import {
  sendScenarioNote,
  startSession,
  type ChatMessage,
  type SimContext,
  type SimEvent,
  type SimState,
  type SimStep,
} from './engine';
import { scenarioById, type ScenarioId } from './scenarios';

export interface TrySession {
  ctx: SimContext;
  state: SimState;
}

export interface TryView {
  session: TrySession | null;
  /** Messages played so far (the engine's state already holds the ones still queued). */
  shown: ChatMessage[];
  typing: boolean;
  busy: boolean;
  /** While the agent is replying: the state the reply started from (what the screen shows). */
  resting: SimState | null;
}

let nonceSeq = 0;
function newNonce(): string {
  nonceSeq += 1;
  return `${SIM_ID_PREFIX}${Date.now().toString(36)}${nonceSeq}`;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** True while the session holds a daily report that was started but not filed. */
export function hasUnfinishedReport(state: SimState): boolean {
  return state.reports.some(
    (r) => !r.preexisting && r.status !== 'filed' && r.status !== 'void' && r.kind === 'daily',
  );
}

export class TryController {
  /** Multiplies the agent's typing delays (0 in tests). */
  private delayScale = 1;
  private view: TryView = {
    session: null,
    shown: [],
    typing: false,
    busy: false,
    resting: null,
  };
  private queue: SimEvent[] = [];
  private generation = 0;
  private running: number | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(readonly store: DemoStore) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): TryView => this.view;

  private set(patch: Partial<TryView>): void {
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Plays events in order: effects hit the store at once, agent messages after a typing pause. */
  private async pump(): Promise<void> {
    const gen = this.generation;
    if (this.running === gen) return;
    this.running = gen;
    this.set({ busy: true });
    const reduced = prefersReducedMotion();
    try {
      while (gen === this.generation && this.queue.length) {
        const e = this.queue[0]!;
        const ctx = this.view.session?.ctx;
        if (!ctx) break;
        if (e.kind === 'message') {
          const wait = e.delayMs * this.delayScale * (reduced ? 0.5 : 1);
          if (e.message.from !== 'reporter' && wait > 0) {
            this.set({ typing: e.message.from === 'agent' });
            await sleep(wait);
            if (gen !== this.generation) break;
            this.set({ typing: false });
          }
          this.queue.shift();
          applySimEvent(this.store, ctx, e);
          this.set({ shown: [...this.view.shown, e.message] });
        } else {
          this.queue.shift();
          applySimEvent(this.store, ctx, e);
        }
      }
    } finally {
      if (this.running === gen) this.running = null;
      if (gen === this.generation && !this.queue.length)
        this.set({ busy: false, typing: false, resting: null });
    }
  }

  /** Writes whatever is still queued straight into the store (leaving a session mid-reply). */
  private flush(): void {
    const ctx = this.view.session?.ctx;
    if (ctx) for (const e of this.queue) applySimEvent(this.store, ctx, e);
    this.queue = [];
  }

  private play(step: SimStep, ctx: SimContext): void {
    this.set({ session: { ctx, state: step.state } });
    this.queue.push(...step.events);
    void this.pump();
  }

  /**
   * The page (re)mounted: set the pacing, start the first chat or resume the current one (a pump
   * interrupted by a test's fake timers, say).
   */
  mount(opts: { delayScale: number; initialScenario: ScenarioId }): void {
    this.delayScale = opts.delayScale;
    if (!this.view.session) this.begin(opts.initialScenario);
    else if (this.queue.length) void this.pump();
  }

  /**
   * Leaves the current session. A report it started but did not file would sit in Awaiting for
   * good (production's §7.2 timeouts are not simulated), so that site's day is cleared; a session
   * that only exchanged messages takes them with it.
   */
  private leave(opts: { clearDay: boolean }): void {
    const prev = this.view.session;
    if (!prev) return;
    this.flush();
    const { ctx, state } = prev;
    if (opts.clearDay ? state.dirty || state.replaced : hasUnfinishedReport(state)) {
      this.store.resetFieldDay(ctx.site.id, ctx.reporter.id);
    } else if (!state.dirty) {
      this.store.removeFieldMessages(ctx.reporter.id, `${ctx.nonce}-`);
    }
  }

  /** A fresh conversation for a scenario (does not touch the store until something is sent). */
  begin(id: ScenarioId, opts: { clearDay?: boolean } = {}): TrySession | null {
    const scenario = scenarioById(id);
    if (!scenario) return null;
    this.leave({ clearDay: opts.clearDay ?? false });
    const ctx = buildSimContext(this.store, scenario, newNonce());
    if (!ctx) return null;
    this.generation += 1;
    this.queue = [];
    this.running = null;
    this.set({ shown: [], typing: false, busy: false, resting: null });
    this.play(startSession(ctx, scenario), ctx);
    return this.view.session;
  }

  act(fn: (s: SimState) => SimStep): void {
    const s = this.view.session;
    if (!s) return;
    if (!this.view.busy) this.set({ resting: s.state });
    this.play(fn(s.state), s.ctx);
  }

  /** "Start over": clears the chat and that site's day. */
  startOver(fallback: ScenarioId): void {
    this.begin(this.view.session?.state.scenario.id ?? fallback, { clearDay: true });
  }

  /** "Send" in the voice-note picker: this chat if nothing was sent yet, else a new one. */
  pickScenario(id: ScenarioId): void {
    const s = this.view.session;
    const fresh =
      s && s.state.scenario.id === id && !s.state.messages.some((m) => m.from === 'reporter');
    const target = fresh ? s : this.begin(id);
    if (!target) return;
    if (!this.view.busy) this.set({ resting: target.state });
    this.play(sendScenarioNote(target.state), target.ctx);
  }
}

const controllers = new WeakMap<DemoStore, TryController>();

export function tryControllerFor(store: DemoStore): TryController {
  let c = controllers.get(store);
  if (!c) {
    c = new TryController(store);
    controllers.set(store, c);
  }
  return c;
}
