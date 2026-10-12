/**
 * Glue between the pure simulator engine and the in-memory DemoStore: builds the engine's context
 * from the §18 Kestrel data and writes the engine's effects the way the worker writes them to the
 * database, so Overview, Sites and Reports update live.
 */
import type { RequiredFieldKey } from '@sitelog/shared/enums.ts';
import { formatDateInTz, formatTimeInTz } from '@sitelog/shared/format.ts';
import { ladderTimes } from '@sitelog/shared/schedule/reminders.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { toObserved, type SiteDayWeather } from '@sitelog/shared/weather/observed.ts';
import type { DemoStore } from '@/data/demo/store';
import type { ChatMessage, SimContext, SimEffect, SimEvent, SimFiledSnapshot } from './engine';
import type { Scenario } from './scenarios';

const REQUIRED: ReadonlySet<string> = new Set([
  'manpower',
  'hours',
  'weather',
  'work_performed',
  'safety',
  'photo',
]);

/** site_days.weather when it has been fetched (worker pipeline/compose.ts siteDayWeatherOf). */
function siteDayWeatherOf(weather: unknown): SiteDayWeather | null {
  if (!weather || typeof weather !== 'object') return null;
  const w = weather as Partial<SiteDayWeather>;
  if (!w.summary || !Array.isArray(w.hours)) return null;
  return w as SiteDayWeather;
}

/** The site, its primary reporter and today's state for a scenario; null if the site is gone. */
export function buildSimContext(
  store: DemoStore,
  scenario: Scenario,
  nonce: string,
): SimContext | null {
  const d = store.data;
  const site = d.sites.find((s) => s.project_code === scenario.siteCode);
  if (!site) return null;
  const link = d.siteReporters.find((sr) => sr.site_id === site.id && sr.is_primary);
  const reporter = d.reporters.find((r) => r.id === link?.reporter_id);
  if (!reporter) return null;
  const today = store.fieldDay(site.id);
  const settings = d.settings;
  const now = store.now.getTime();
  const ladder = ladderTimes(new Date(today.deadlineAt), {
    headsUpEnabled: settings.heads_up_enabled,
    headsUpOffsetMin: settings.heads_up_offset_min,
    reminder1Enabled: settings.reminder1_enabled,
    reminder1OffsetMin: settings.reminder1_offset_min,
    reminder2Enabled: settings.reminder2_enabled,
    reminder2OffsetMin: settings.reminder2_offset_min,
    missingEnabled: settings.missing_enabled,
    missingOffsetMin: settings.missing_offset_min,
  });
  // What the scheduler sent before now: enabled, not paused, and the day still unreported then.
  const reportedAt = today.receivedAt ? Date.parse(today.receivedAt) : Infinity;
  const reminders: SimContext['reminders'] = [];
  if (!today.remindersPaused) {
    const r1 = ladder.reminder1At.getTime();
    const r2 = ladder.reminder2At.getTime();
    if (settings.reminder1_enabled && now >= r1 && reportedAt > r1)
      reminders.push({ stage: 'reminder1', at: ladder.reminder1At.toISOString() });
    if (settings.reminder2_enabled && now >= r2 && reportedAt > r2)
      reminders.push({ stage: 'reminder2', at: ladder.reminder2At.toISOString() });
  }
  const weather = siteDayWeatherOf(today.weather);
  return {
    nonce,
    startAt: sessionStart(store, reporter.id, site.timezone, today.date),
    date: today.date,
    site: {
      id: site.id,
      name: site.name,
      projectCode: site.project_code,
      timezone: site.timezone,
      workingHours: site.working_hours,
      siteDayId: today.siteDayId,
    },
    reporter: { id: reporter.id, name: reporter.name },
    settings: {
      requiredFields: settings.required_fields.filter((f): f is RequiredFieldKey =>
        REQUIRED.has(f),
      ),
      maxQuestions: settings.max_questions_per_report,
      defaultShiftHours: Number(settings.default_shift_hours),
      noWorkPdf: settings.no_work_pdf,
      deadline: formatTimeInTz(today.deadlineAt, site.timezone),
      missingAt: formatTimeInTz(ladder.missingAt, site.timezone),
    },
    reminders,
    observedWeather: weather ? toObserved(weather) : null,
    companies: d.companies.map((c) => ({
      id: c.id,
      name: c.name,
      aliases: [...c.aliases],
      isSelfPerform: c.is_self_perform,
      unconfirmed: c.status === 'unconfirmed',
    })),
    today: {
      status: today.status,
      reportNo: today.reportNo,
      needsReset: today.needsReset,
      statusAfterReset: today.statusAfterReset,
      reportSeqAfterReset: today.reportSeqAfterReset,
      remindersPaused: today.remindersPaused,
      filed: filedSnapshot(store, today.reportId),
    },
  };
}

/** Today's filed daily report, so "edit Friday" works on it without replacing the day. */
function filedSnapshot(store: DemoStore, reportId: string | null): SimFiledSnapshot | null {
  const r = store.data.reports.find((x) => x.id === reportId);
  if (!r || (r.status !== 'filed' && r.status !== 'signed_off') || r.kind !== 'daily') return null;
  const v = store.data.versions.find(
    (x) => x.report_id === r.id && x.version === r.current_version,
  );
  if (!v || !r.filed_at) return null;
  return {
    id: r.id,
    reportNo: r.report_no,
    version: r.current_version,
    data: structuredClone(v.data) as unknown as DailyReportData,
    filedAt: r.filed_at,
  };
}

/** Prefix of every id a simulator session creates (see Page / controller newNonce). */
export const SIM_ID_PREFIX = 'try';

/**
 * The session clock starts at the demo's "now", or just after the latest message an earlier
 * simulator chat left in the reporter's thread today (so two chats never interleave).
 */
function sessionStart(store: DemoStore, reporterId: string, tz: string, date: string): string {
  const convo = store.data.conversations.find((c) => c.reporter_id === reporterId);
  let start = store.now.getTime();
  for (const m of store.data.messages) {
    if (m.conversation_id !== convo?.id || !m.id.startsWith(SIM_ID_PREFIX)) continue;
    if (formatDateInTz(m.created_at, tz) !== date) continue;
    start = Math.max(start, Date.parse(m.created_at) + 60_000);
  }
  return new Date(start).toISOString();
}

/** Peaks for the voice-note waveform in the panel (deterministic per message). */
function peaks(id: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return Array.from({ length: 64 }, (_, i) => {
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    return Math.round((0.15 + 0.85 * ((h % 1000) / 1000)) * 100) / 100;
  });
}

/** A chat message as the `messages` row the webhook / worker would have stored. */
function persistMessage(store: DemoStore, ctx: SimContext, m: ChatMessage): void {
  if (m.from === 'system' || m.history) return;
  const direction = m.from === 'reporter' ? 'in' : 'out';
  if (m.kind === 'voice') {
    store.recordFieldMessages(ctx.reporter.id, [
      {
        id: m.id,
        direction,
        type: 'audio',
        body: null,
        at: m.at,
        durationS: m.durationS ?? null,
        payload: { peaks: peaks(m.id) },
        transcript: {
          language: (m.languages ?? ['en']).join('+'),
          text: m.text,
          segments: m.segments ?? [],
        },
      },
    ]);
    return;
  }
  const type =
    m.kind === 'photo'
      ? 'image'
      : m.kind === 'document'
        ? 'document'
        : m.buttons?.length || m.buttonId
          ? 'interactive'
          : 'text';
  store.recordFieldMessages(ctx.reporter.id, [
    {
      id: m.id,
      direction,
      type,
      body:
        m.kind === 'photo'
          ? (m.caption ?? null)
          : m.kind === 'document'
            ? (m.fileName ?? null)
            : m.text,
      at: m.at,
      payload: m.buttons?.length
        ? { buttons: m.buttons }
        : m.buttonId
          ? { button_reply: { id: m.buttonId, title: m.text } }
          : null,
    },
  ]);
}

function applyEffect(store: DemoStore, ctx: SimContext, e: SimEffect): void {
  switch (e.type) {
    case 'reset_today':
      // The session's own messages (e.g. "help" before the note) stay in the day's thread.
      store.resetFieldDay(ctx.site.id, ctx.reporter.id, { keepMessageIdPrefix: `${ctx.nonce}-` });
      return;
    case 'report_status':
      store.setFieldReportStatus(e.reportId, e.status, e.at);
      return;
    case 'draft':
      store.storeFieldDraft({
        reportId: e.reportId,
        data: e.data,
        messageId: e.messageId,
        at: e.at,
      });
      return;
    case 'review_flag':
      store.flagFieldReview(e.reportId, e.reasons, e.at);
      return;
    case 'reminders_paused':
      store.pauseFieldReminders(ctx.site.id);
      return;
    case 'report_created':
      store.openFieldReport({
        id: e.reportId,
        siteId: ctx.site.id,
        reporterId: ctx.reporter.id,
        reportNo: e.reportNo,
        kind: e.kind,
        at: e.at,
      });
      return;
    case 'site_day':
      store.setFieldDayStatus(ctx.site.id, e.status);
      return;
    case 'audit':
      store.fieldAudit({
        actor: e.actor,
        actorId: e.actor === 'reporter' ? ctx.reporter.id : null,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        diff: e.diff,
        at: e.at,
      });
      return;
    case 'company_added':
      store.addFieldCompany({ id: e.companyId, name: e.name, at: e.at });
      return;
    case 'report_void':
      store.voidFieldReport(e.reportId, e.at);
      return;
    case 'file':
      store.fileFieldReport({
        reportId: e.reportId,
        kind: e.kind,
        data: e.data,
        trigger: e.trigger,
        reasons: e.reasons,
        confirmMessageId: e.confirmMessageId,
        at: e.at,
        sources: e.sources,
        questions: e.questions.map((q) => ({
          id: q.id,
          field: q.field,
          path: q.path,
          prompt: q.prompt,
          buttons: q.buttons,
          target: q.target as Record<string, unknown>,
          answer: q.answer,
          askedAt: q.askedAt,
          answeredAt: q.answeredAt,
        })),
      });
      return;
    case 'version':
      store.addFieldVersion({
        reportId: e.reportId,
        version: e.version,
        data: e.data,
        author: e.author,
        changeNote: e.changeNote,
        messageId: e.messageId,
        source: e.source,
        at: e.at,
      });
      return;
    case 'no_work':
      store.markFieldNoWork(ctx.site.id);
      return;
  }
}

/** Apply one engine event to the store (messages are recorded, effects written). */
export function applySimEvent(store: DemoStore, ctx: SimContext, event: SimEvent): void {
  if (event.kind === 'message') persistMessage(store, ctx, event.message);
  else applyEffect(store, ctx, event.effect);
}

export function applySimEvents(store: DemoStore, ctx: SimContext, events: SimEvent[]): void {
  for (const e of events) applySimEvent(store, ctx, e);
}
