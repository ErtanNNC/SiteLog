import {
  applyAnswer,
  ButtonSets,
  deadlineInstant,
  emptyReportDataV1,
  localDate,
  waCopy,
  weatherDayData,
  weekdayName,
  type DayOffClassification,
  type ReportRow,
  type SiteRow,
  type SourceV1,
} from '@sitelog/shared';
import { classifyDayOff } from '../../ai/dayoff';
import { currentData, storeDraft } from '../../pipeline/draft';
import { fileReport } from '../../pipeline/file';
import { createReportVersion } from '../../pipeline/versions';
import { ensureMediaStored } from '../media';
import { deadlineFor, type Session } from '../session';

/** §F10 — weather day / no work today, and the follow-ups that make the delay record claim-ready. */

export { weatherDayData };

async function ensureReportForDay(
  s: Session,
  site: SiteRow,
  date: string,
  kind: 'weather_day' | 'no_work',
): Promise<{ report: ReportRow; filedAlready: boolean } | null> {
  const { ctx } = s;
  const siteCtx = await ctx.db.siteContext(site.id);
  if (!siteCtx) return null;
  const siteDay = await ctx.db.getOrCreateSiteDay(
    site.id,
    date,
    deadlineInstant(date, deadlineFor(site, siteCtx.settings), site.timezone),
  );
  const existing = await ctx.db.findReportForSiteDay(siteDay.id);
  if (existing && (existing.status === 'filed' || existing.status === 'signed_off'))
    return { report: existing, filedAlready: true };
  if (existing) return { report: existing, filedAlready: false };
  const report = await ctx.db.insertReport({
    org_id: site.org_id,
    site_id: site.id,
    site_day_id: siteDay.id,
    report_no: await ctx.db.nextReportNo(site.id),
    reporter_id: s.reporters.find((r) => r.org_id === site.org_id)?.id ?? s.reporter.id,
    received_at: s.now,
    kind,
  });
  await ctx.db.logAudit({
    org_id: site.org_id,
    actor_type: 'reporter',
    actor_id: report.reporter_id,
    action: 'report.created',
    entity: 'report',
    entity_id: report.id,
    diff: { kind, date },
  });
  return { report, filedAlready: false };
}

/** §F10 step 3. `cls` null → the R1 button "Site closed: weather" (full day, cause unknown). */
export async function logWeatherDay(
  s: Session,
  site: SiteRow,
  date: string,
  cls: DayOffClassification | null,
  sourceMessageId: string,
): Promise<void> {
  const { ctx } = s;
  const siteCtx = await ctx.db.siteContext(site.id);
  if (!siteCtx) return;
  const classification: DayOffClassification = cls ?? {
    kind: 'weather_day',
    fullDay: true,
    releasedAt: null,
    cause: 'weather',
    workersThisMorning: null,
    confidence: 1,
  };
  const ensured = await ensureReportForDay(s, site, date, 'weather_day');
  if (!ensured) return;
  if (ensured.filedAlready) {
    await s.reply(waCopy.editHint(weekdayName(date)), undefined, {
      kind: 'edit_hint',
      reportId: ensured.report.id,
    });
    return;
  }
  const report = ensured.report;
  const sourceMessage =
    sourceMessageId === s.message.id ? s.message : await ctx.db.getMessage(sourceMessageId);
  if (sourceMessage && (sourceMessage.type === 'audio' || sourceMessage.type === 'image')) {
    await ensureMediaStored(ctx, sourceMessage, {
      orgId: site.org_id,
      siteId: site.id,
      date: localDate(new Date(sourceMessage.created_at), site.timezone),
    });
  }
  const source: SourceV1 =
    sourceMessage?.type === 'audio'
      ? { type: 'audio', messageId: sourceMessageId, start: 0 }
      : { type: 'reply', messageId: sourceMessageId };
  await ctx.db.insertReportSource({
    report_id: report.id,
    message_id: sourceMessageId,
    kind: sourceMessage?.type === 'audio' ? 'audio' : 'reply',
    taken_at: sourceMessage?.created_at ?? s.now,
  });
  const data = weatherDayData(date, classification, {
    defaultShiftHours: Number(siteCtx.settings.default_shift_hours),
    workingHours: site.working_hours,
    source,
  });
  await storeDraft(ctx, report, data, { authorMessageId: sourceMessageId });
  await fileReport(ctx, report.id, { trigger: 'weather_day', silent: true });
  await s.setState('idle', {
    active_report_id: null,
    weather_report_id: report.id,
    weather_followup: null,
    last_site_id: site.id,
    pending: null,
  });
  await s.reply(
    waCopy.weatherDayLogged(
      classification.fullDay ? null : classification.releasedAt,
      classification.cause ?? 'weather',
    ),
    undefined,
    { kind: 'weather_day', reportId: report.id },
  );
  await s.reply(waCopy.weatherDayFollowup(), ButtonSets.weatherFollowup(report.id), {
    kind: 'weather_followup',
    reportId: report.id,
  });
}

/** §F10 step 4 — planned no-work day. */
export async function logNoWork(s: Session, site: SiteRow, date: string): Promise<void> {
  const { ctx } = s;
  const siteCtx = await ctx.db.siteContext(site.id);
  if (!siteCtx) return;
  const siteDay = await ctx.db.getOrCreateSiteDay(
    site.id,
    date,
    deadlineInstant(date, deadlineFor(site, siteCtx.settings), site.timezone),
  );
  if (siteDay.status === 'filed') {
    await s.reply(waCopy.editHint(weekdayName(date)), undefined, { kind: 'edit_hint' });
    return;
  }
  if (siteCtx.settings.no_work_pdf) {
    const ensured = await ensureReportForDay(s, site, date, 'no_work');
    if (ensured && !ensured.filedAlready) {
      const data = emptyReportDataV1(date);
      data.summary = `No work at ${site.name} — planned non-working day.`;
      data.weather.conditionsText = 'Not recorded (no work)';
      await storeDraft(ctx, ensured.report, data, { authorMessageId: s.message.id });
      await fileReport(ctx, ensured.report.id, { trigger: 'no_work', silent: true });
    }
  } else {
    await ctx.db.updateSiteDay(siteDay.id, { status: 'no_work' });
  }
  await ctx.db.logAudit({
    org_id: site.org_id,
    actor_type: 'reporter',
    actor_id: s.reporter.id,
    action: 'site_day.no_work',
    entity: 'site_day',
    entity_id: siteDay.id,
    diff: { message_id: s.message.id },
  });
  await s.setState('idle', { active_report_id: null, last_site_id: site.id, pending: null });
  await s.reply(waCopy.noWorkLogged(site.name), undefined, {
    kind: 'no_work',
    reportId: siteDay.report_id ?? undefined,
  });
}

/** Free text / voice: "rained out, sent the crew home at 11" → classify → weather day or no work. */
export async function handleDayOffText(
  s: Session,
  site: SiteRow,
  text: string,
  sourceMessageId: string,
  hint: 'weather_day' | 'no_work' | null,
): Promise<void> {
  const { ctx } = s;
  const settings = await ctx.db.getOrgSettings(site.org_id);
  const { result, call } = await classifyDayOff(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL_FAST,
    {
      text,
      workingHours: site.working_hours,
      defaultShiftHours: Number(settings?.default_shift_hours ?? 8),
    },
    ctx.log,
  );
  if (call) ctx.metrics.add({ tokens: call.usage, estCostUsd: call.estCostUsd });
  const kind = result.confidence >= 0.5 ? result.kind : (hint ?? result.kind);
  const date = localDate(s.now, site.timezone);
  if (kind === 'no_work') {
    await logNoWork(s, site, date);
    return;
  }
  await logWeatherDay(s, site, date, { ...result, kind: 'weather_day' }, sourceMessageId);
}

export async function handleWeatherButton(
  s: Session,
  reportId: string,
  action: 'photo' | 'voice',
): Promise<void> {
  await s.setState('idle', { weather_report_id: reportId, weather_followup: action });
  if (action === 'voice')
    await s.reply(waCopy.answerOther(), undefined, { kind: 'weather_voice', reportId });
}

/** A photo after a weather day goes into the delay record (photo_count → claim-ready). */
export async function handleWeatherFollowupPhoto(s: Session, report: ReportRow): Promise<void> {
  const { ctx, message } = s;
  const site = s.siteById(report.site_id) ?? (await ctx.db.getSite(report.site_id));
  if (!site) return;
  await ensureMediaStored(ctx, message, {
    orgId: site.org_id,
    siteId: site.id,
    date: localDate(new Date(message.created_at), site.timezone),
  });
  await ctx.db.insertReportSource({
    report_id: report.id,
    message_id: message.id,
    kind: 'photo',
    caption: message.body,
    taken_at: message.created_at,
  });
  const data = await currentData(ctx, report);
  if (!data) return;
  const next = {
    ...data,
    photos: [
      ...data.photos,
      { messageId: message.id, caption: message.body ?? undefined, takenAt: message.created_at },
    ],
  };
  await createReportVersion(ctx, report, next, {
    changeNote: 'Photo of conditions added',
    author: 'agent',
    authorMessageId: message.id,
    emailRecipients: false,
  });
  await s.setState('idle', { weather_followup: null });
  await s.reply(waCopy.weatherPhotoAck(), undefined, {
    kind: 'weather_photo_ack',
    reportId: report.id,
  });
}

/** "How many were on site this morning?" answered by text or voice. */
export async function handleWeatherFollowupAnswer(
  s: Session,
  report: ReportRow,
  text: string,
): Promise<void> {
  const { ctx } = s;
  const site = await ctx.db.siteContext(report.site_id);
  const data = await currentData(ctx, report);
  if (!site || !data) return;
  const { result, call } = await classifyDayOff(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL_FAST,
    {
      text,
      workingHours: site.site.working_hours,
      defaultShiftHours: Number(site.settings.default_shift_hours),
    },
    ctx.log,
  );
  if (call) ctx.metrics.add({ tokens: call.usage, estCostUsd: call.estCostUsd });
  const workers = result.workersThisMorning ?? Number(/\b(\d{1,3})\b/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(workers)) {
    await s.reply(waCopy.answerOther(), undefined, { kind: 'weather_voice', reportId: report.id });
    return;
  }
  const idx = data.manpower.findIndex((m) => m.companyName === 'Site crew');
  const applied = applyAnswer(
    data,
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
      defaultShiftHours: Number(site.settings.default_shift_hours),
      workingHours: site.site.working_hours,
      messageId: s.message.id,
    },
  );
  await createReportVersion(ctx, report, applied.data, {
    changeNote: `Crew on site this morning: ${workers}`,
    author: 'reporter',
    authorMessageId: s.message.id,
    emailRecipients: false,
  });
  await s.setState('idle', { weather_followup: null });
  await s.reply(applied.ackText ?? waCopy.weatherPhotoAck(), undefined, {
    kind: 'weather_answer_ack',
    reportId: report.id,
  });
}
