import { randomUUID } from 'node:crypto';
import {
  DAILY_LINK_TTL_HOURS_DEFAULT,
  MessageSendError,
  assertE164,
  correctionNote,
  dailyLinkExpiresAt,
  ensureDailyLink,
  fieldHistoryLinkUrl,
  fieldLinkUrl,
  fieldReportLinkUrl,
  formatDate,
  languageOf,
  orderInboundReporters,
  parseSmsEdit,
  parseSmsKeyword,
  readSmsEdit,
  resolveDayReference,
  replyAllowed,
  toCountryPack,
  type CorrectionChange,
  type CountryPack,
  type E164,
  type InboundReporterRow,
  type InboundScope,
  type MessageRow,
  type ReplyChannel,
  type ReplySmsKey,
  type SmsVars,
} from '@sitelog/shared';
import { classifyUtterance } from '../ai/utterance';
import type { Ctx } from '../context';
import { revokedProcessingConsents } from '../pipeline/consent';
import { personalLinkCode } from '../pipeline/web';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §9.5 report keywords on two-way packs (W2-12): `sms_keyword(messageId[, correctionId])`, queued by
 * `processInboundSms` (the worker's `sms_inbound` job for a Twilio text, sms-webhook's Demo phone
 * inline) for OK, NO WORK, WEATHER and EDIT from a reporter who is not opted out. One phone's texts
 * run one at a time (lock key `sms:<phone>`), and each answer goes back as a reply to the text
 * (`notifier.reply`, outside the Notifier's order: a two-way reply, spec §19 Q25), never on a pack
 * without two-way SMS, and never with a link where the pack forbids links (`smsReplyAllowed`).
 *
 * - **OK** (spec §19 Q82): confirms nothing; the reporter's open web draft gets its link
 *   (`draft_ready`, `/r/{code}/report/{id}`), where Confirm & send is. No draft: no reply (Q103).
 * - **NO WORK / WEATHER** (F12): the day sheet's link for each site of theirs whose day is still
 *   open today (no live report; pending, reminded or missing), `day_off_link` with the day's link
 *   (`ensureDailyLink`). The site-day changes only when the details are saved on Today (W2-08).
 *   No open day: no reply (Q104).
 * - **EDIT** (F10 by SMS): `classify_utterance` (the fast model) names the day as written, code
 *   resolves it; the change is the reporter's own words after the day (`readSmsEdit`), never the
 *   model's rewording; code resolves the day (`resolveDayReference`, else `readSmsEdit`), finds that day's
 *   filed report at a site of theirs and requests the change (`sms_request_filed_correction()`):
 *   apply_correction makes the preview in code, then queues this job again with `correctionId`,
 *   which texts the preview's lines and the confirm link (`edit_preview`, `/r/{code}/history/{id}`,
 *   the report's view with **Save change**). Nothing is applied until the reporter saves it on the
 *   recorder. No day, no report, several, locked, a paused site, a change pending, an unclear
 *   change, or a processing consent turned off (§19 Q95: nothing goes to the model): `edit_unclear`
 *   with the Past reports link (Q102).
 *
 * Every answer is audited `sms.keyword_answered` (actor the reporter, the outcome and the replies).
 * Each reply is keyed by the text and its target (`sms_reply:<message>:<key>:<target>`), so a
 * retry sends none twice.
 */
export const smsKeyword: JobHandler<'sms_keyword'> = async (ctx, payload) => {
  const message = await ctx.db.getMessage(payload.messageId);
  if (!message) throw new PermanentJobError(`message ${payload.messageId} not found`);
  // W2-16: a keyword sent on WhatsApp is answered on WhatsApp (two-way on every pack).
  const channel = message.channel;
  if (
    (channel !== 'sms' && channel !== 'whatsapp') ||
    message.direction !== 'in' ||
    !message.phone_e164
  ) {
    throw new PermanentJobError(`message ${message.id} is not an inbound text or WhatsApp message`);
  }
  const meta = (message.payload ?? {}) as { pack?: string };
  const packRow = meta.pack ? await ctx.db.getCountry(meta.pack) : null;
  if (!packRow) throw new PermanentJobError(`message ${message.id} names no country pack`);
  const pack = toCountryPack(packRow);
  const log = ctx.log.child({ message_id: message.id, pack: pack.code });
  // A one-way pack never acts on a keyword (§9.2), even if its pack changed after the text came in;
  // WhatsApp is two-way on every pack (spec §19 Q26).
  if (channel === 'sms' && !pack.twoWaySms) {
    log.info('sms_keyword: the pack has no two-way SMS; nothing answered');
    return;
  }
  // A Twilio text reaches real orgs only; a Demo phone reply (console) its demo org only.
  const scope: InboundScope | null =
    message.provider === 'twilio'
      ? { realOnly: true }
      : message.org_id
        ? { orgId: message.org_id }
        : null;
  if (!scope) throw new PermanentJobError(`message ${message.id} has no org to answer in`);
  const phone = assertE164(message.phone_e164);
  const reporters = orderInboundReporters(
    await ctx.db.listInboundReporters(phone, pack.code, scope),
    // An SMS opt-out stops texts only (§19 Q40): on WhatsApp it blocks no answer.
  ).filter((r) => channel === 'whatsapp' || r.status !== 'opted_out');
  const k: KeywordCtx = { ctx, message, pack, phone, reporters, log, channel };
  if (reporters.length === 0) {
    // Opted out (or removed) since the text came in: nothing goes to the phone.
    log.info('sms_keyword: no reporter to answer');
    return;
  }

  if (payload.correctionId) {
    await answerEditPreview(k, payload.correctionId);
    return;
  }
  const keyword = parseSmsKeyword(message.body ?? '');
  switch (keyword) {
    case 'ok':
      return answerOk(k);
    case 'no_work':
    case 'weather':
      return answerDayOff(k, keyword);
    case 'edit':
      return answerEdit(k);
    default:
      log.info('sms_keyword: not a report keyword', { keyword });
  }
};

interface KeywordCtx {
  ctx: Ctx;
  message: MessageRow;
  pack: CountryPack;
  phone: E164;
  /** The phone's reporters on the pack, not opted out, the one a reply speaks for first. */
  reporters: InboundReporterRow[];
  log: Ctx['log'];
  /** W2-16: the channel the keyword came in on; its replies go back on it. */
  channel: ReplyChannel;
}

/** Most answers a text gets (several sites, several drafts): enough for a backup's sites. */
const MAX_REPLIES = 3;

/**
 * A reply to the text in the reporter's language; null when the provider refused it for good.
 * Each reply is keyed by the text, the key and what it is about (`target`: a report, a site, a
 * correction), so a retried job sends each of its replies once (W2-12 review).
 */
async function reply<K extends ReplySmsKey>(
  k: KeywordCtx,
  reporter: InboundReporterRow,
  key: K,
  vars: SmsVars<K>,
  target: string,
): Promise<string | null> {
  try {
    const sent = await k.ctx.notifier.reply({
      pack: k.pack,
      org: { id: reporter.orgId, isDemo: reporter.orgIsDemo },
      reporterId: reporter.id,
      phone: k.phone,
      locale: reporter.locale,
      key,
      vars,
      dedupeKey: `sms_reply:${k.message.id}:${key}:${target}`,
      channel: k.channel,
    });
    return sent.messageId;
  } catch (err) {
    // Recorded on the reply's row by the Notifier (e.g. Twilio 21610); anything else retries.
    if (err instanceof MessageSendError && !err.retryable) return null;
    throw err;
  }
}

async function audit(
  k: KeywordCtx,
  reporter: InboundReporterRow,
  diff: Record<string, unknown>,
): Promise<void> {
  await k.ctx.db.logAudit({
    org_id: reporter.orgId,
    actor_type: 'reporter',
    actor_id: reporter.id,
    action: 'sms.keyword_answered',
    entity: 'message',
    entity_id: k.message.id,
    diff: { channel: k.channel, pack: k.pack.code, ...diff },
  });
}

function byId(k: KeywordCtx, id: string): InboundReporterRow {
  return k.reporters.find((r) => r.id === id) ?? k.reporters[0]!;
}

/** Spec §19 Q82: OK confirms nothing; the open web draft's link, where Confirm & send is. */
async function answerOk(k: KeywordCtx): Promise<void> {
  const first = k.reporters[0]!;
  const drafts = (await k.ctx.db.smsKeywordDrafts(k.reporters.map((r) => r.id))).slice(
    0,
    MAX_REPLIES,
  );
  if (drafts.length === 0 || !replyAllowed(k.pack, 'draft_ready', k.channel)) {
    await audit(k, first, {
      keyword: 'ok',
      outcome: drafts.length === 0 ? 'no_draft' : 'links_not_allowed',
      replies: [],
    });
    return;
  }
  const replies: Array<string | null> = [];
  for (const draft of drafts) {
    const reporter = byId(k, draft.reporter_id);
    const { base, code } = await personalLinkCode(k.ctx, reporter.id, reporter.orgId);
    replies.push(
      await reply(
        k,
        reporter,
        'draft_ready',
        { link: fieldReportLinkUrl(base, code, draft.report_id) },
        draft.report_id,
      ),
    );
  }
  await audit(k, first, {
    keyword: 'ok',
    outcome: 'draft_link',
    report_ids: drafts.map((d) => d.report_id),
    replies,
  });
}

/** F12 by SMS: the day sheet's link for each site whose day is still open today. */
async function answerDayOff(k: KeywordCtx, keyword: 'no_work' | 'weather'): Promise<void> {
  const first = k.reporters[0]!;
  const days = await k.ctx.db.smsKeywordDays(k.reporters.map((r) => r.id));
  const seen = new Set<string>();
  const open = days.filter((d) => {
    if (seen.has(d.site_id)) return false;
    seen.add(d.site_id);
    return (
      !d.has_report &&
      (d.day_status === null || ['pending', 'reminded', 'missing'].includes(d.day_status))
    );
  });
  const targets = open.slice(0, MAX_REPLIES);
  if (targets.length === 0 || !replyAllowed(k.pack, 'day_off_link', k.channel)) {
    await audit(k, first, {
      keyword,
      outcome: targets.length === 0 ? 'no_open_day' : 'links_not_allowed',
      replies: [],
    });
    return;
  }
  const secret = k.ctx.config.LINK_SIGNING_SECRET;
  const base = k.ctx.config.FIELD_APP_URL;
  if (!secret) throw new Error('LINK_SIGNING_SECRET is not set');
  if (!base) throw new Error('FIELD_APP_URL is not set');
  const replies: Array<string | null> = [];
  for (const day of targets) {
    const reporter = byId(k, day.reporter_id);
    const link = await ensureDailyLink(
      {
        listDailyLinks: (r, s, d) => k.ctx.db.listDailyLinks(r, s, d),
        orgDailyLinkTtlHours: (siteId) => k.ctx.db.orgDailyLinkTtlHours(siteId),
        insertDailyLink: (row) => k.ctx.db.insertDailyLink(row),
      },
      secret,
      {
        reporterId: reporter.id,
        siteId: day.site_id,
        reportDate: day.date,
        expiresAt: dailyLinkExpiresAt(k.ctx.now(), DAILY_LINK_TTL_HOURS_DEFAULT),
        now: k.ctx.now(),
      },
      randomUUID,
    );
    if (link.created) {
      await k.ctx.db.logAudit({
        org_id: reporter.orgId,
        actor_type: 'system',
        action: 'field_link.created',
        entity: 'reporter',
        entity_id: reporter.id,
        diff: { kind: 'daily', site_id: day.site_id, report_date: day.date, via: 'sms_keyword' },
      });
    }
    replies.push(
      await reply(
        k,
        reporter,
        'day_off_link',
        { site: day.site_name, link: fieldLinkUrl(base, link.code) },
        day.site_id,
      ),
    );
  }
  await audit(k, first, {
    keyword,
    outcome: 'day_off_link',
    site_ids: targets.map((d) => d.site_id),
    date: targets[0]!.date,
    replies,
  });
}

/** Why an EDIT made no preview (spec §19 Q102: the reply is `edit_unclear` either way). */
type EditMiss =
  | 'no_change'
  | 'consent_revoked'
  | 'no_site'
  | 'no_day'
  | 'no_report'
  | 'not_filed'
  | 'ambiguous'
  | 'report_locked'
  | 'site_inactive'
  | 'correction_pending'
  | 'wrong_state'
  | 'unclear'
  | 'stale';

/** `edit_unclear` with the Past reports link (one report's, when the EDIT named one). */
async function editUnclear(
  k: KeywordCtx,
  reporter: InboundReporterRow,
  outcome: EditMiss,
  extra: Record<string, unknown> = {},
  reportId: string | null = null,
): Promise<void> {
  let replyId: string | null = null;
  if (replyAllowed(k.pack, 'edit_unclear', k.channel)) {
    const { base, code } = await personalLinkCode(k.ctx, reporter.id, reporter.orgId);
    replyId = await reply(
      k,
      reporter,
      'edit_unclear',
      { link: fieldHistoryLinkUrl(base, code, reportId) },
      reportId ?? 'history',
    );
  }
  await audit(k, reporter, {
    keyword: 'edit',
    outcome,
    report_id: reportId,
    replies: [replyId],
    ...extra,
  });
}

/** F10 by SMS: the day and the change, then a change of that day's filed report. */
async function answerEdit(k: KeywordCtx): Promise<void> {
  const { ctx } = k;
  const first = k.reporters[0]!;
  const ids = k.reporters.map((r) => r.id);
  const rest = parseSmsEdit(k.message.body ?? '')?.rest ?? '';
  if (!rest) return editUnclear(k, first, 'no_change');
  // A retry after the change was requested: done. Resolving again could call the model again and
  // name another report (a dead job, a false office alert, a second reply) (W2-12 review).
  const requested = await ctx.db.getCorrectionByMessage(k.message.id);
  if (requested) {
    k.log.info('sms_keyword: the EDIT was requested before', { correction_id: requested.id });
    return;
  }
  // F15, spec §19 Q95: nothing goes to the model once a reporter of the phone turned a consent
  // off (the text is theirs too); a change of such a reporter's report is refused (W2-12 review).
  const revokedBy = new Map<string, Awaited<ReturnType<typeof revokedProcessingConsents>>>();
  for (const r of k.reporters) {
    const revoked = await revokedProcessingConsents(ctx, r.id);
    if (revoked.length > 0) revokedBy.set(r.id, revoked);
  }
  if (revokedBy.size === k.reporters.length)
    return editUnclear(k, first, 'consent_revoked', { consents: revokedBy.get(first.id) });

  const days = await ctx.db.smsKeywordDays(ids);
  // The day is read in each site's own time zone ("yesterday" in Istanbul is not Chicago's), and a
  // site's reports are looked up for its own date (W2-12 review).
  const zones = [...new Set(days.map((d) => d.timezone))];
  if (zones.length === 0) return editUnclear(k, first, 'no_site');
  const now = ctx.now();
  // §10.8: the fast model names the day as written; code resolves it. The change stored, cited
  // as `reporter_edit` and checked for numbers it does not state is the reporter's own words,
  // never the model's rewording of them (W2-12 review).
  let modelRef: string | null = null;
  if (ctx.ai.claude && revokedBy.size === 0) {
    const res = await classifyUtterance(
      ctx.ai.claude,
      ctx.config.CLAUDE_MODEL_FAST || ctx.config.CLAUDE_MODEL,
      // A WhatsApp EDIT is a written message too: the prompt's text channel.
      { channel: 'sms', keyword: 'EDIT', text: k.message.body ?? '' },
      k.log,
    );
    ctx.metrics.add({ tokens: res.usage, estCostUsd: res.estCostUsd });
    if (res.data.intent === 'edit_request' || res.data.intent === 'fix') {
      modelRef = res.data.entities?.dayReference?.trim().replace(/İ/gu, 'I') || null;
    }
  }
  const byZone = zones
    .map((tz) => {
      const fromModel = modelRef ? resolveDayReference(modelRef, now, tz) : null;
      return { tz, date: fromModel ?? readSmsEdit(rest, now, tz).date, fromModel: !!fromModel };
    })
    .filter((z): z is { tz: string; date: string; fromModel: boolean } => z.date !== null);
  const change = readSmsEdit(rest, now, zones[0]!).correction.trim();
  if (byZone.length === 0) return editUnclear(k, first, 'no_day');
  const date = byZone[0]!.date;
  const modelDay = byZone.some((z) => z.fromModel);
  if (!change) return editUnclear(k, first, 'no_change', { date });

  const reports = (
    await Promise.all(
      byZone.map(async (z) =>
        (await ctx.db.smsEditReports(ids, z.date)).filter((r) => r.timezone === z.tz),
      ),
    )
  ).flat();
  const filed = reports.filter((r) => r.status === 'filed' || r.status === 'signed_off');
  if (filed.length === 0)
    return editUnclear(k, first, reports.length ? 'not_filed' : 'no_report', { date });
  if (filed.length > 1)
    return editUnclear(k, first, 'ambiguous', {
      date,
      report_ids: filed.map((r) => r.report_id),
    });
  const target = filed[0]!;
  const reporter = byId(k, target.reporter_id);
  const revoked = revokedBy.get(reporter.id);
  if (revoked) {
    return editUnclear(
      k,
      reporter,
      'consent_revoked',
      { consents: revoked, date: target.date },
      target.report_id,
    );
  }
  try {
    const res = await ctx.db.requestSmsCorrection({
      reportId: target.report_id,
      reporterId: reporter.id,
      text: change,
      messageId: k.message.id,
    });
    // The preview comes from apply_correction, which queues the second step of this job.
    await audit(k, reporter, {
      keyword: 'edit',
      outcome: 'correction_requested',
      report_id: target.report_id,
      correction_id: res.id,
      date: target.date,
      day_from: modelDay ? 'model' : 'code',
      replies: [],
    });
  } catch (err) {
    const code = /\b(report_locked|site_inactive|correction_pending|wrong_state)\b/.exec(
      String((err as Error).message),
    )?.[1] as EditMiss | undefined;
    if (!code) throw err;
    return editUnclear(k, reporter, code, { date: target.date }, target.report_id);
  }
}

/** The EDIT's preview settled: its lines and the confirm link, or why there is none. */
async function answerEditPreview(k: KeywordCtx, correctionId: string): Promise<void> {
  const { ctx } = k;
  const correction = await ctx.db.getCorrection(correctionId);
  if (!correction || correction.message_id !== k.message.id)
    throw new PermanentJobError(`correction ${correctionId} is not of message ${k.message.id}`);
  const reporter = k.reporters.find((r) => r.id === correction.reporter_id);
  if (!reporter) {
    k.log.info('sms_keyword: the reporter of the change opted out since; no preview sent');
    return;
  }
  if (correction.status === 'listening') {
    throw new Error(`correction ${correction.id} is still being listened to`);
  }
  if (correction.status !== 'ready') {
    // Unclear (a question, a number the words do not state), or stale: Past reports instead.
    return editUnclear(
      k,
      reporter,
      correction.status === 'unclear' ? 'unclear' : 'stale',
      { correction_id: correction.id, reason: correction.reason },
      correction.report_id,
    );
  }
  const report = await ctx.db.getReport(correction.report_id);
  const day = report ? await ctx.db.getSiteDay(report.site_day_id) : null;
  const language = languageOf(reporter.locale);
  const changes = (Array.isArray(correction.changes)
    ? correction.changes
    : []) as unknown as CorrectionChange[];
  const lines = correctionNote(changes, language, { sms: true });
  if (!report || !day || !lines) {
    return editUnclear(
      k,
      reporter,
      'unclear',
      { correction_id: correction.id, reason: 'no_change' },
      correction.report_id,
    );
  }
  let replyId: string | null = null;
  if (replyAllowed(k.pack, 'edit_preview', k.channel)) {
    const { base, code } = await personalLinkCode(ctx, reporter.id, reporter.orgId);
    replyId = await reply(
      k,
      reporter,
      'edit_preview',
      {
        weekday: formatDate(day.date, 'weekday', language),
        change: lines,
        link: fieldHistoryLinkUrl(base, code, report.id),
      },
      correction.id,
    );
  }
  await audit(k, reporter, {
    keyword: 'edit',
    outcome: 'preview',
    report_id: report.id,
    correction_id: correction.id,
    replies: [replyId],
  });
}
