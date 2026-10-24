import {
  ButtonIds,
  ButtonSets,
  deadlineInstant,
  isVoiceSourceKind,
  isWithinEditWindow,
  localDate,
  reportDateForInbound,
  truncateTitle,
  waCopy,
  weekdayName,
  type MessageRow,
  type ReportRow,
  type SiteRow,
} from '@sitelog/shared';
import { isUniqueViolation } from '../../db';
import { matchSiteByText, SITE_INFER_THRESHOLD } from '../../ai/site-guess';
import { currentData } from '../../pipeline/draft';
import { audioPending } from '../../pipeline/progress';
import { createReportVersion } from '../../pipeline/versions';
import { sendChoice } from '../../wa/send';
import { ensureMediaStored } from '../media';
import { deadlineFor, workingDaysOf, type Session } from '../session';
import { logNoWork, logWeatherDay } from './dayoff';
import { applyEdit } from './edit';

/**
 * §F5 intake, §F12 site picker, which-day prompt, merge rules (§7.2) and the ±10 min photo rule.
 */

export const LATE_PHOTO_WINDOW_MS = 10 * 60_000;

function contentText(s: Session): string {
  const i = s.inbound;
  if (i.kind === 'text') return i.text;
  if (i.kind === 'image' || i.kind === 'document') return i.caption ?? '';
  return '';
}

/** §F12 step 2 — infer the site from the message text; ≥ 0.85 or ask. */
export function inferSite(s: Session): SiteRow | null {
  const candidates = s.activeSites;
  if (candidates.length === 1) return candidates[0]!;
  const text = contentText(s);
  const guess = matchSiteByText(
    text,
    candidates.map((c) => ({
      id: c.id,
      name: c.name,
      projectCode: c.project_code,
      address: c.address,
    })),
  );
  if (guess.siteId && guess.confidence >= SITE_INFER_THRESHOLD)
    return candidates.find((c) => c.id === guess.siteId) ?? null;
  return null;
}

export function siteOptions(
  sites: SiteRow[],
): Array<{ id: string; title: string; description?: string }> {
  return sites.slice(0, 10).map((site) => ({
    id: ButtonIds.site(site.id),
    title: truncateTitle(site.name),
    description: site.project_code,
  }));
}

export async function sendSitePicker(
  s: Session,
  messageIds: string[],
  intent: 'report' | 'no_work' | 'weather_day' = 'report',
): Promise<void> {
  await s.setState('selecting_site', {
    pending: { message_ids: messageIds, awaiting: 'site', intent },
    candidate_site_ids: s.activeSites.map((x) => x.id),
  });
  await sendChoice(s.ctx, s.convo, waCopy.pickSite(), siteOptions(s.activeSites), {
    kind: 'pick_site',
  });
}

export async function askWhichDay(
  s: Session,
  site: SiteRow,
  messageIds: string[],
  info: { date: string; alternative: string },
): Promise<void> {
  await s.setState('idle', {
    pending: { message_ids: messageIds, site_id: site.id, awaiting: 'day' },
  });
  await s.reply(
    waCopy.whichDay(info.date, info.alternative),
    ButtonSets.whichDay(info.date, info.alternative, {
      today: 'Today',
      yesterday: weekdayName(info.alternative),
    }),
    { kind: 'which_day' },
  );
}

/** Idle: a voice note, photo, document or report-length text. */
export async function handleContent(s: Session): Promise<void> {
  if (s.activeSites.length === 0) {
    if (s.pausedSites.length) {
      await s.reply(waCopy.sitePaused(s.pausedSites[0]!.name), undefined, { kind: 'site_paused' });
    } else {
      await s.reply(waCopy.help(), undefined, { kind: 'help' });
    }
    return;
  }
  const pending = s.context.pending;
  if (pending) {
    // Still waiting for a site/day choice: park this message with the others.
    await s.setState(null, {
      pending: { ...pending, message_ids: [...pending.message_ids, s.message.id] },
    });
    return;
  }
  const site = inferSite(s);
  if (!site) {
    await sendSitePicker(s, [s.message.id]);
    return;
  }
  await continueWithSite(s, site, [s.message.id]);
}

/** After the site is known: decide the report date (which-day before noon) and start. */
export async function continueWithSite(
  s: Session,
  site: SiteRow,
  messageIds: string[],
): Promise<void> {
  const settings = await s.ctx.db.getOrgSettings(site.org_id);
  const info = reportDateForInbound(s.now, site.timezone, workingDaysOf(settings));
  if (info.ambiguous) {
    await askWhichDay(s, site, messageIds, info);
    return;
  }
  await startIntake(s, site, info.date, messageIds);
}

export async function handleSiteChoice(s: Session, siteId: string): Promise<void> {
  const site = s.activeSites.find((x) => x.id === siteId) ?? s.siteById(siteId);
  const pending = s.context.pending;
  if (!site) {
    await sendSitePicker(s, pending?.message_ids ?? []);
    return;
  }
  if (site.status !== 'active') {
    await s.setState('idle', { pending: null });
    await s.reply(waCopy.sitePaused(site.name), undefined, { kind: 'site_paused' });
    return;
  }
  const intent = (pending as { intent?: string } | null)?.intent;
  if (intent === 'no_work') {
    await s.setState('idle', { pending: null, last_site_id: site.id });
    await logNoWork(s, site, localDate(s.now, site.timezone));
    return;
  }
  if (intent === 'weather_day') {
    await s.setState('idle', { pending: null, last_site_id: site.id });
    await logWeatherDay(
      s,
      site,
      localDate(s.now, site.timezone),
      null,
      pending?.message_ids[0] ?? s.message.id,
    );
    return;
  }
  const ids = pending?.message_ids ?? [];
  if (ids.length === 0) {
    await s.setState('idle', { pending: null, last_site_id: site.id });
    return;
  }
  await continueWithSite(s, site, ids);
}

export async function handleDayChoice(s: Session, date: string): Promise<void> {
  const pending = s.context.pending;
  if (!pending || pending.awaiting !== 'day' || !pending.site_id) return;
  const site = s.siteById(pending.site_id);
  if (!site) {
    await s.setState('idle', { pending: null });
    return;
  }
  await startIntake(s, site, date, pending.message_ids);
}

/** Text answer to the which-day prompt ("today", "yesterday", "hoy", "ayer"). */
export function dayFromText(
  text: string,
  info: { date: string; alternative: string },
): string | null {
  const t = text.trim().toLowerCase();
  if (/^(today|hoy|this one|now)\b/.test(t)) return info.date;
  if (/^(yesterday|ayer)\b/.test(t)) return info.alternative;
  if (t === weekdayName(info.alternative).toLowerCase()) return info.alternative;
  return null;
}

async function loadMessages(s: Session, ids: string[]): Promise<MessageRow[]> {
  const rows: MessageRow[] = [];
  for (const id of ids) {
    const m = id === s.message.id ? s.message : await s.ctx.db.getMessage(id);
    if (m) rows.push(m);
  }
  return rows;
}

function sourceKindOf(m: MessageRow): 'audio' | 'photo' | 'text' | null {
  if (m.type === 'audio') return 'audio';
  if (m.type === 'image') return 'photo';
  if (m.type === 'document' && (m.media_mime ?? '').startsWith('image/')) return 'photo';
  if (m.type === 'text' && m.body?.trim()) return 'text';
  return null;
}

/** §F5 steps 1–3: site-day, report row, sources, ack, pipeline jobs. */
export async function startIntake(
  s: Session,
  site: SiteRow,
  date: string,
  messageIds: string[],
): Promise<void> {
  const { ctx } = s;
  const siteCtx = await ctx.db.siteContext(site.id);
  if (!siteCtx) throw new Error(`site ${site.id} has no context`);
  const deadlineAt = deadlineInstant(date, deadlineFor(site, siteCtx.settings), site.timezone);
  const siteDay = await ctx.db.getOrCreateSiteDay(site.id, date, deadlineAt);
  const messages = await loadMessages(s, messageIds);

  for (const m of messages) {
    await ensureMediaStored(ctx, m, {
      orgId: site.org_id,
      siteId: site.id,
      date: localDate(new Date(m.created_at), site.timezone),
    });
  }

  let report = await ctx.db.findOpenReportForSiteDay(siteDay.id);
  if (
    !report &&
    siteDay.status === 'no_work' &&
    messages.every((m) => sourceKindOf(m) === 'photo')
  ) {
    // Photos sent with (or after) "no work today": no report to start, but say what is on record.
    await s.setState(null, { last_site_id: site.id, pending: null });
    await s.reply(waCopy.photoOnNoWorkDay(site.name), undefined, { kind: 'no_work' });
    return;
  }
  if (!report) {
    const filed = await ctx.db.findReportForSiteDay(siteDay.id);
    if (filed && (filed.status === 'filed' || filed.status === 'signed_off')) {
      await handleContentForFiledDay(s, filed, site, messages);
      return;
    }
    const reportNo = await ctx.db.nextReportNo(site.id);
    try {
      report = await ctx.db.insertReport({
        org_id: site.org_id,
        site_id: site.id,
        site_day_id: siteDay.id,
        report_no: reportNo,
        reporter_id: s.reporters.find((r) => r.org_id === site.org_id)?.id ?? s.reporter.id,
        received_at: messages[0]?.created_at ?? s.now,
        kind: 'daily',
      });
      await ctx.db.logAudit({
        org_id: site.org_id,
        actor_type: 'reporter',
        actor_id: report.reporter_id,
        action: 'report.created',
        entity: 'report',
        entity_id: report.id,
        diff: { report_no: reportNo, date },
      });
    } catch (err) {
      // Another intake for this site-day got there first (reports_one_live_per_site_day): join it.
      if (!isUniqueViolation(err, 'reports_one_live_per_site_day')) throw err;
      const live = await ctx.db.findReportForSiteDay(siteDay.id);
      if (!live) throw err;
      if (live.status === 'filed' || live.status === 'signed_off') {
        await handleContentForFiledDay(s, live, site, messages);
        return;
      }
      report = live;
    }
  }

  const newAudio: MessageRow[] = [];
  let newPhotos = 0;
  for (const m of messages) {
    const kind = sourceKindOf(m);
    if (!kind) continue;
    await ctx.db.insertReportSource({
      report_id: report.id,
      message_id: m.id,
      kind,
      caption: kind === 'photo' ? m.body : null,
      taken_at: m.created_at,
    });
    if (kind === 'audio') newAudio.push(m);
    if (kind === 'photo') newPhotos++;
  }
  const sources = await ctx.db.listReportSources(report.id);
  const hasContent = sources.some((x) => isVoiceSourceKind(x.kind) || x.kind === 'text');
  await s.setState(null, { last_site_id: site.id, pending: null });
  if (!hasContent) {
    await s.reply(waCopy.photosOnly(), undefined, { kind: 'photos_only', reportId: report.id });
    return;
  }

  if (
    siteDay.status === 'pending' ||
    siteDay.status === 'reminded' ||
    siteDay.status === 'missing'
  ) {
    await ctx.db.updateSiteDay(siteDay.id, { status: 'processing' });
  }
  await s.setState('processing', { active_report_id: report.id, pending_question_id: null });
  const duration = newAudio.reduce((a, m) => a + (m.duration_s ?? 0), 0);
  await s.reply(
    waCopy.ackReceived(s.firstName, newAudio.length ? duration : null, newPhotos),
    undefined,
    { kind: 'ack', reportId: report.id },
  );
  await enqueuePipeline(s, report, newAudio, sources.length);
}

export async function enqueuePipeline(
  s: Session,
  report: ReportRow,
  audio: MessageRow[],
  sourceCount: number,
): Promise<void> {
  const { ctx } = s;
  const pendingAudio = [];
  for (const m of audio) {
    if (!(await ctx.db.getTranscript(m.id))) pendingAudio.push(m);
  }
  if (pendingAudio.length) {
    for (const m of pendingAudio) {
      await ctx.db.enqueueJob(
        'transcribe_audio',
        { messageId: m.id, reportId: report.id },
        { dedupeKey: `transcribe:${m.id}` },
      );
    }
    return;
  }
  // A photo or text next to a voice note still being transcribed: that transcription enqueues the
  // extraction once every note has its transcript (an earlier extraction saw an empty transcript).
  if (await audioPending(ctx, report.id)) return;
  await ctx.db.enqueueJob(
    'extract_report',
    { reportId: report.id, reason: `sources:${sourceCount}` },
    { dedupeKey: `extract:${report.id}:${sourceCount}` },
  );
}

/** Content for a day that is already filed: photos within 10 min attach, anything else is an edit. */
async function handleContentForFiledDay(
  s: Session,
  report: ReportRow,
  site: SiteRow,
  messages: MessageRow[],
): Promise<void> {
  const { ctx } = s;
  const photos = messages.filter((m) => sourceKindOf(m) === 'photo');
  const others = messages.filter((m) => sourceKindOf(m) === 'audio' || sourceKindOf(m) === 'text');
  if (photos.length && others.length === 0) {
    await attachLatePhotos(s, report, photos);
    return;
  }
  const today = localDate(s.now, site.timezone);
  const data = await currentData(ctx, report);
  if (!data || !isWithinEditWindow(data.reportDate, today)) {
    await s.reply(waCopy.lockedReport(), undefined, { kind: 'locked' });
    return;
  }
  await s.setState('editing', {
    editing: { report_id: report.id },
    last_site_id: site.id,
    pending: null,
  });
  for (const m of others) {
    if (m.type === 'audio') {
      await ctx.db.enqueueJob(
        'transcribe_audio',
        { messageId: m.id, reportId: report.id },
        { dedupeKey: `transcribe:${m.id}` },
      );
    } else if (m.body) {
      await applyEdit(s, report, m.body, m.id);
    }
  }
}

/** §7.2: photos within 10 minutes of the voice note attach to the same (already filed) report. */
export async function attachLatePhotos(
  s: Session,
  report: ReportRow,
  photos: MessageRow[],
): Promise<void> {
  const { ctx } = s;
  const filedAt = report.filed_at ? new Date(report.filed_at).getTime() : 0;
  const recent = photos.filter(
    (m) => Math.abs(new Date(m.created_at).getTime() - filedAt) <= LATE_PHOTO_WINDOW_MS,
  );
  if (recent.length === 0) {
    await s.reply(waCopy.editHint(weekdayName(localDate(s.now, s.tz))), undefined, {
      kind: 'edit_hint',
    });
    return;
  }
  const data = await currentData(ctx, report);
  if (!data) return;
  for (const m of recent) {
    await ctx.db.insertReportSource({
      report_id: report.id,
      message_id: m.id,
      kind: 'photo',
      caption: m.body,
      taken_at: m.created_at,
    });
  }
  const next = {
    ...data,
    photos: [
      ...data.photos,
      ...recent.map((m) => ({
        messageId: m.id,
        caption: m.body ?? undefined,
        takenAt: m.created_at,
      })),
    ],
  };
  await createReportVersion(ctx, report, next, {
    changeNote: `Photo${recent.length > 1 ? 's' : ''} added`,
    author: 'agent',
    authorMessageId: recent[0]!.id,
    emailRecipients: false,
  });
  await s.reply(waCopy.mergedMore(), undefined, { kind: 'merged', reportId: report.id });
}

/** New audio / photos / text while a report is open for the same site-day (§7.2 merge rule). */
export async function mergeIntoActive(s: Session, report: ReportRow): Promise<void> {
  const { ctx, message } = s;
  const site = s.siteById(report.site_id) ?? (await ctx.db.getSite(report.site_id));
  if (!site) throw new Error(`site ${report.site_id} not found`);
  await ensureMediaStored(ctx, message, {
    orgId: site.org_id,
    siteId: site.id,
    date: localDate(new Date(message.created_at), site.timezone),
  });
  const kind = sourceKindOf(message);
  if (!kind) return;
  await ctx.db.insertReportSource({
    report_id: report.id,
    message_id: message.id,
    kind,
    caption: kind === 'photo' ? message.body : null,
    taken_at: message.created_at,
  });
  const sources = await ctx.db.listReportSources(report.id);
  if (kind === 'photo') {
    // A photo answers an open photo question; otherwise it just rides along.
    const pendingId = s.context.pending_question_id;
    const q = pendingId ? await ctx.db.getQuestion(pendingId) : null;
    if (q && !q.answered_at && q.field === 'photo') {
      await ctx.db.updateQuestion(q.id, {
        answered_message_id: message.id,
        answered_at: s.now,
        answer: { photo: true },
      });
      await s.setState(null, { pending_question_id: null });
      await ctx.db.enqueueJob(
        'decide_next',
        { reportId: report.id },
        { dedupeKey: `decide:${report.id}:${message.id}` },
      );
    } else if (s.convo.state === 'awaiting_confirmation') {
      const data = await currentData(ctx, report);
      if (data) {
        await ctx.db.insertVersion({
          report_id: report.id,
          version: report.current_version || 1,
          data: {
            ...data,
            photos: [
              ...data.photos,
              {
                messageId: message.id,
                caption: message.body ?? undefined,
                takenAt: message.created_at,
              },
            ],
          },
          summary: data.summary || null,
          author: 'agent',
        });
      }
    }
    await s.reply(waCopy.mergedMore(), undefined, { kind: 'merged', reportId: report.id });
    return;
  }
  await s.reply(waCopy.mergedMore(), undefined, { kind: 'merged', reportId: report.id });
  if (s.convo.state !== 'processing')
    await s.setState('processing', { active_report_id: report.id });
  await enqueuePipeline(s, report, kind === 'audio' ? [message] : [], sources.length);
}

/** A report-length text in idle (§F5 edge case: text instead of audio). */
export async function handleTextReport(s: Session): Promise<void> {
  await handleContent(s);
}
