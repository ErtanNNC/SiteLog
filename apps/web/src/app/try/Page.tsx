/**
 * /try — "Try it on WhatsApp": the field side of SiteLog in the browser, on the demo data.
 * The chat is driven by the pure engine (engine.ts) through a controller that outlives the page
 * (controller.ts); its effects land in the DemoStore, so the panel's Overview, Sites and Reports
 * update as the conversation goes.
 */
import { Camera, ExternalLink, Mic, RotateCcw, SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  formatDuration,
  formatMonthDay,
  formatTimeInTz,
  weekdayName,
} from '@sitelog/shared/format.ts';
import { siteDayChip } from '@sitelog/shared/status.ts';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { EmptyState } from '@/components/sitelog/States';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { copy } from '@/copy/en';
import { useOptionalDataSource } from '@/data/DataProvider';
import type { DemoSource } from '@/data/demo/DemoSource';
import type { DemoStore } from '@/data/demo/store';
import { assetUrl } from '@/lib/asset';
import { cn } from '@/lib/utils';
import { ChatBubble } from './ChatBubble';
import { hasUnfinishedReport, tryControllerFor } from './controller';
import {
  filedReport,
  liveButtonIds,
  sendPhoto,
  sendScenarioNote,
  sendText,
  tapButton,
  type LegendEntry,
  type SimContext,
  type SimState,
  type SimStep,
} from './engine';
import { ScenarioSheet } from './ScenarioSheet';
import { HERO_SCENARIO_ID, type ScenarioId } from './scenarios';

const t = copy.try;

export default function TryPage() {
  const source = useOptionalDataSource();
  const store = source?.mode === 'demo' ? (source as DemoSource).store : null;
  if (!store) {
    return (
      <>
        <PageHeader title={t.title} />
        <EmptyState title={t.title} body={copy.common.demoOnly} />
      </>
    );
  }
  return <TrySimulator store={store} />;
}

export function TrySimulator({
  store,
  delayScale = 1,
  initialScenario = HERO_SCENARIO_ID,
}: {
  store: DemoStore;
  /** Multiplies the agent's typing delays (0 in tests). */
  delayScale?: number;
  initialScenario?: ScenarioId;
}) {
  const controller = tryControllerFor(store);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [, setStoreTick] = useState(0);
  const phoneRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set by a tap or a chip: once the reply is in, focus goes to its buttons (or stays on the log). */
  const focusReply = useRef(false);

  useEffect(() => store.subscribe(() => setStoreTick((n) => n + 1)), [store]);

  // Start the chat on first visit; coming back to /try resumes it where it was.
  useEffect(() => {
    controller.mount({ delayScale, initialScenario });
  }, [controller, delayScale, initialScenario]);

  const { session, shown, typing, busy } = view;

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, typing]);

  // When the agent's reply is in, put the keyboard on its buttons (WCAG 2.4.3).
  useEffect(() => {
    if (busy || !focusReply.current) return;
    focusReply.current = false;
    const phone = phoneRef.current;
    const active = document.activeElement;
    if (!phone || (active && active !== document.body && !phone.contains(active))) return;
    if (active === inputRef.current) return;
    const groups = phone.querySelectorAll<HTMLElement>('[data-live-buttons="true"]');
    const target = groups[groups.length - 1]?.querySelector<HTMLButtonElement>('button');
    (target ?? logRef.current)?.focus({ preventScroll: true });
  }, [busy, shown.length]);

  if (!session) return null;
  const { ctx, state } = session;
  // While the agent is replying, the screen shows the state the reply started from.
  const resting = busy && view.resting ? view.resting : state;

  const act = (fn: (s: SimState) => SimStep) => {
    const active = document.activeElement;
    const fromInput = active === inputRef.current;
    if (!fromInput) {
      // The control just used may go away or be disabled: keep focus inside the chat.
      logRef.current?.focus({ preventScroll: true });
      focusReply.current = true;
    }
    controller.act(fn);
  };

  const startOver = () => {
    controller.startOver(initialScenario);
    setDraft('');
  };

  const pickScenario = (id: ScenarioId) => {
    setSheetOpen(false);
    focusReply.current = true;
    controller.pickScenario(id);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    act((s) => sendText(s, text));
  };

  const first = ctx.reporter.name.split(/\s+/)[0] ?? ctx.reporter.name;
  const shownIds = new Set(shown.map((m) => m.id));
  const live = new Set([...liveButtonIds(resting)].filter((id) => shownIds.has(id)));
  const lastShownAt = shown.at(-1)?.at ?? ctx.startAt;
  const legend = state.legend.filter((l) => l.at <= lastShownAt);
  const day = store.fieldDay(ctx.site.id);
  const chip = siteDayChip(
    day.status,
    day.reportStatus ? { status: day.reportStatus, needsReview: day.needsReview } : null,
  );
  const filed = filedReport(state);
  const filedShown = filed && legend.some((l) => l.kind === 'filed' || l.kind === 'weather_day');
  const reportLink =
    day.reportId && (day.reportStatus === 'filed' || day.reportStatus === 'signed_off')
      ? `/reports/${day.reportId}`
      : null;
  // The scenario's note is on offer until it is sent (or the day got another record).
  const canBegin =
    !resting.scenarioSent &&
    resting.convo === 'idle' &&
    !resting.reports.some((r) => !r.preexisting && r.status !== 'void');
  const suggestions = suggestionsFor(resting, ctx);
  const unfinishedSite = hasUnfinishedReport(state) ? ctx.site.name : null;

  const runSuggestion = (s: Suggestion) => {
    if (busy) return;
    if (s.kind === 'sheet') setSheetOpen(true);
    else if (s.kind === 'photo') act((x) => sendPhoto(x));
    else if (s.kind === 'text') {
      const text = s.text;
      act((x) => sendText(x, text));
    }
  };

  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} subtitle={t.subtitle} />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <section
          ref={phoneRef}
          aria-label={t.phone.region(ctx.reporter.name)}
          className="mx-auto w-full min-w-0 max-w-[440px] rounded-[26px] bg-asphalt p-1.5 sm:p-2.5"
          data-testid="try-phone"
        >
          <div className="flex h-[min(760px,calc(100dvh-120px))] min-h-[520px] flex-col overflow-hidden rounded-[20px] bg-concrete lg:h-[min(760px,calc(100dvh-215px))]">
            <header className="on-dark flex items-center gap-2 bg-steel py-1.5 pl-3 pr-1.5 text-chalk">
              {/* The circle is on a wrapper: a rounded <img> would clip the mark to the circle. */}
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-asphalt">
                <img
                  src={assetUrl('brand/logo-mark.svg')}
                  alt=""
                  width={24}
                  height={24}
                  className="size-6"
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold leading-5">{t.phone.title}</div>
                <div className="truncate text-[12px] leading-4 text-dust-light">
                  {t.phone.subtitle(ctx.reporter.name, ctx.site.name)}
                </div>
              </div>
              <span className="shrink-0 rounded-chip border border-iron px-1.5 font-mono text-[12px] uppercase tracking-[0.08em] text-dust-light">
                {t.phone.simulated}
              </span>
              <button
                type="button"
                onClick={startOver}
                title={t.startOverHint}
                aria-label={t.startOver}
                className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-btn text-dust-light hover:bg-iron hover:text-chalk"
                data-testid="try-start-over"
              >
                <RotateCcw className="size-5" aria-hidden="true" />
              </button>
            </header>

            <div
              ref={logRef}
              role="log"
              aria-live="polite"
              aria-label={t.phone.log}
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto px-3 py-3 scrollbar-thin focus-visible:outline-offset-[-3px]"
              data-testid="try-log"
            >
              <ol className="space-y-2.5">
                {shown.map((m) => (
                  <ChatBubble
                    key={m.id}
                    message={m}
                    first={first}
                    timezone={ctx.site.timezone}
                    liveButtons={live.has(m.id)}
                    busy={busy}
                    onTap={(id) => act((s) => tapButton(s, id))}
                  />
                ))}
                {typing ? (
                  <li className="flex items-start" data-testid="try-typing">
                    <span className="inline-flex items-center gap-1 rounded-bubble rounded-tl-chip border border-rebar bg-white px-3 py-2.5">
                      <span className="sr-only">{t.phone.typing}</span>
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-dust motion-safe:animate-sl-pulse"
                          style={{ animationDelay: `${i * 200}ms` }}
                        />
                      ))}
                    </span>
                  </li>
                ) : null}
              </ol>
              {canBegin ? (
                <div className="mt-3 flex flex-col gap-2" data-testid="try-begin">
                  <Button
                    variant="primary"
                    className="min-h-[44px] w-full"
                    onClick={() => act(sendScenarioNote)}
                  >
                    <Mic aria-hidden="true" />
                    {state.scenario.kind === 'text' ? t.begin.typed(first) : t.begin.note(first)}
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-[44px] w-full bg-white"
                    onClick={() => setSheetOpen(true)}
                    aria-haspopup="dialog"
                  >
                    {t.begin.pick}
                  </Button>
                </div>
              ) : null}
            </div>

            {suggestions.length ? (
              <div className="border-t border-rebar bg-chalk px-3 pb-1 pt-2">
                <div className="eyebrow text-dust" id="try-suggestions">
                  {t.composer.suggestions}
                </div>
                <ul
                  aria-labelledby="try-suggestions"
                  className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1.5 scrollbar-thin sm:flex-wrap"
                >
                  {suggestions.map((s) => (
                    <li key={s.label} className="shrink-0">
                      <button
                        type="button"
                        onClick={() => runSuggestion(s)}
                        aria-disabled={busy || undefined}
                        className={cn(
                          'min-h-[44px] rounded-full border px-3 text-[13px] font-semibold aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
                          s.primary
                            ? 'border-signal bg-signal text-asphalt hover:bg-signal-deep hover:text-chalk'
                            : 'border-rebar bg-white text-asphalt hover:bg-concrete',
                        )}
                      >
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <form
              onSubmit={onSubmit}
              className="flex items-center gap-1.5 border-t border-rebar bg-chalk px-2 py-2"
            >
              <Button
                type="button"
                variant="ghost"
                size="dense"
                className="min-h-[44px] px-2.5"
                onClick={() => setSheetOpen(true)}
                aria-label={t.composer.voiceLabel}
                aria-haspopup="dialog"
                data-testid="try-voice"
              >
                <Mic aria-hidden="true" />
                <span className="hidden sm:inline">{t.composer.voice}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="iconDense"
                className="size-[44px]"
                onClick={() => {
                  if (!busy) act((s) => sendPhoto(s));
                }}
                aria-disabled={busy || undefined}
                aria-label={t.composer.photo}
                title={t.composer.photo}
              >
                <Camera aria-hidden="true" />
              </Button>
              <label htmlFor="try-input" className="sr-only">
                {t.composer.input}
              </label>
              <Input
                id="try-input"
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t.composer.placeholder}
                autoComplete="off"
                className="h-[44px] min-w-0 flex-1 rounded-full bg-white"
              />
              <Button
                type="submit"
                variant="secondary"
                size="iconDense"
                className="size-[44px] rounded-full"
                disabled={busy || !draft.trim()}
                aria-label={busy ? t.composer.busy : t.composer.send}
              >
                <SendHorizontal aria-hidden="true" />
              </Button>
            </form>
          </div>
        </section>

        <div className="min-w-0 space-y-4">
          {filed && filedShown && reportLink ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-filed/40 bg-chip-filed-bg px-4 py-3 lg:hidden"
              data-testid="try-filed-callout"
            >
              <span className="font-semibold text-chip-filed-fg">
                {t.filedCallout(filed.reportNo)}
              </span>
              <Button asChild variant="secondary" size="dense" className="min-h-[44px]">
                <Link to={reportLink}>{t.office.open}</Link>
              </Button>
            </div>
          ) : null}

          <p className="rounded-card border border-rebar bg-chalk px-4 py-3 text-[14px] leading-5 text-steel">
            {t.honesty}
          </p>

          <Card data-testid="try-office">
            <CardHeader>
              <CardTitle>{t.office.title}</CardTitle>
              <span className="eyebrow text-dust">{t.office.today(formatMonthDay(ctx.date))}</span>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[14px]">
                <dt className="text-dust">{t.office.site}</dt>
                <dd className="m-0 font-semibold">
                  <Link to={`/sites/${ctx.site.id}`} className="underline-offset-4 hover:underline">
                    {ctx.site.name}
                  </Link>{' '}
                  <span className="font-mono text-[12px] font-normal text-dust">
                    {ctx.site.projectCode}
                  </span>
                </dd>
                <dt className="text-dust">{t.office.status}</dt>
                <dd className="m-0" data-testid="try-status">
                  <StatusChip variant={chip.variant} label={chip.label} />
                </dd>
                <dt className="text-dust">{t.office.report}</dt>
                <dd className="m-0 font-mono text-[13px]" data-testid="try-report-no">
                  {reportLink && day.reportNo ? day.reportNo : t.office.notFiled}
                </dd>
              </dl>
              {reportLink ? (
                <Button asChild variant="secondary" className="min-h-[44px] w-full sm:w-auto">
                  <Link to={reportLink} data-testid="try-open-report">
                    <ExternalLink aria-hidden="true" />
                    {t.office.open}
                  </Link>
                </Button>
              ) : null}
              <p className="text-caption text-dust">{t.office.live}</p>
              <div>
                <h3 className="eyebrow mb-2 text-dust">{t.office.legend}</h3>
                {legend.length === 0 ? (
                  <p className="text-[14px] text-dust">{t.office.empty}</p>
                ) : (
                  <ol className="space-y-1.5 text-[14px] leading-5" data-testid="try-legend">
                    {legend.map((l, i) => (
                      <li key={`${l.kind}-${i}`} className="flex gap-2">
                        <span className="w-11 shrink-0 font-mono text-[12px] leading-5 text-dust">
                          {formatTimeInTz(l.at, ctx.site.timezone)}
                        </span>
                        <span className="min-w-0">{legendText(l)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <ScenarioSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        store={store}
        currentId={state.scenario.id}
        currentReporterId={ctx.reporter.id}
        unfinishedSite={unfinishedSite}
        onPick={pickScenario}
      />
    </>
  );
}

function legendText(l: LegendEntry): string {
  const e = t.office.events;
  switch (l.kind) {
    case 'replaced':
      return e.replaced(l.reportNo);
    case 'received':
      return e.received(l.voice, l.durationS ? formatDuration(l.durationS) : '', l.photos);
    case 'question':
      return e.question(l.prompt);
    case 'answered':
      return e.answered(l.answer, l.ack);
    case 'photo_answered':
      return e.photo_answered;
    case 'unanswered':
      return e.unanswered(l.prompt);
    case 'draft':
      return e.draft;
    case 'corrected':
      return e.corrected(l.note);
    case 'filed':
      return e.filed(l.reportNo, l.needsReview);
    case 'weather_day':
      return e.weather_day(l.reportNo);
    case 'no_work':
      return e.no_work;
    case 'version':
      return e.version(l.reportNo, l.version, l.note);
    case 'company_added':
      return e.company_added(l.name);
    case 'voided':
      return e.voided(l.reportNo);
  }
}

type Suggestion =
  | { kind: 'sheet' | 'photo'; label: string; primary?: boolean }
  | { kind: 'text'; label: string; text: string; primary?: boolean };

const APEX = 'Apex Concrete';

/** Two or three useful next taps for where the conversation is. */
function suggestionsFor(state: SimState, ctx: SimContext): Suggestion[] {
  const s = t.suggestions;
  const typed = (text: string, primary = false): Suggestion => ({
    kind: 'text',
    label: s.typed(text),
    text,
    primary,
  });
  const sent = state.messages.some((m) => m.from === 'reporter');
  // Before anything is sent the chat itself offers the note; these are the typed alternatives.
  if (!sent) return [typed(s.noWork), typed(s.rainedOut)];
  const active = state.reports.find((r) => r.id === state.activeReportId);
  const apex = (data: SimState['reports'][number]['data'] | undefined) =>
    data?.manpower.find((m) => m.companyName === APEX);
  if (state.convo === 'awaiting_confirmation') {
    // "Apex had 7 not 6" only while Apex still has 6 (once applied it would change nothing).
    const fix = apex(active?.data)?.workers === 6 ? [typed(s.fix)] : [];
    return [typed(s.ok, true), ...fix];
  }
  if (state.convo === 'awaiting_answer') {
    const q = state.reports
      .flatMap((r) => r.questions)
      .find((x) => x.id === state.pendingQuestionId);
    return q?.field === 'photo' ? [{ kind: 'photo', label: s.photo, primary: true }] : [];
  }
  if (state.convo === 'idle' && state.weatherReportId) {
    const photo: Suggestion = { kind: 'photo', label: s.photo, primary: true };
    return [photo, { kind: 'sheet', label: s.pickAnother }];
  }
  const filed = state.reports.find((r) => r.id === state.lastFiledReportId);
  if (state.convo === 'idle' && filed?.kind === 'daily' && filed.status === 'filed') {
    const edit = apex(filed.data)?.workers === 6 ? [typed(s.edit(weekdayName(ctx.date)))] : [];
    return [...edit, { kind: 'photo', label: s.photo }, { kind: 'sheet', label: s.pickAnother }];
  }
  return [{ kind: 'sheet', label: s.pickAnother }];
}
