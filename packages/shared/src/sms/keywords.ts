import { replyAllowed, type ReplyChannel } from '../channels.ts';
import type { KeywordReplySmsKey, TwoWaySmsKey } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import type { ContactPref, ReporterStatus } from '../enums.ts';
import { resolveDayReference } from '../schedule/day.ts';
import { stripDayReference } from './replies.ts';

/**
 * §9.5 SMS keywords and F13/F15 (W1-08): what sms-webhook does with an inbound text. Pure, so the
 * Twilio route, the Demo phone's reply box (the same handler logic, spec §19 Q35) and the panel's
 * in-memory demo share it. `wa/replies.ts` keeps serving WhatsApp until step 22.
 *
 * W1-08 handles STOP, START, HELP, CALL and TEXT (and their synonyms, `SMS_KEYWORD_ALIASES`).
 * W2-12 adds the report keywords OK, NO WORK, WEATHER and EDIT (`SMS_REPORT_KEYWORDS`, words in
 * EN, ES and TR): `planInboundSms` only names them (`reportKeyword`), and the worker's
 * `sms_keyword` job answers them (a link; EDIT's preview), since EDIT needs the model and the
 * Demo phone's inline handler has none. Every other text is stored, with no reply. Everything
 * here runs only on a pack with two-way SMS (`smsReplyAllowed`): a one-way pack's inbound texts
 * are stored and nothing else.
 */

/** The account keywords (W1-08): opt-out, opt-in, help, and the call / link preference. */
export const SMS_ACCOUNT_KEYWORDS = ['stop', 'start', 'help', 'call', 'text'] as const;
/**
 * The report keywords (W2-12, §9.5): OK (spec §19 Q82: the draft link, never a confirmation),
 * NO WORK and WEATHER (F12: the day sheet's link), EDIT (F10: a preview and a link to confirm).
 */
export const SMS_REPORT_KEYWORDS = ['ok', 'no_work', 'weather', 'edit'] as const;
export const SMS_KEYWORDS = [...SMS_ACCOUNT_KEYWORDS, ...SMS_REPORT_KEYWORDS] as const;
export type SmsKeyword = (typeof SMS_KEYWORDS)[number];
export type SmsReportKeyword = (typeof SMS_REPORT_KEYWORDS)[number];

export function isSmsReportKeyword(k: SmsKeyword | null): k is SmsReportKeyword {
  return k !== null && (SMS_REPORT_KEYWORDS as readonly string[]).includes(k);
}

/**
 * The words of the report keywords that are a whole text (W2-12), in the field languages of the
 * packs (EN, ES for US; TR for a two-way TR pack or WhatsApp), after `normalizeKeywordText`
 * (lower case, Turkish dotted capital I folded, spaces, hyphens and underscores as one space).
 * The English words stay valid in every language, as STOP and HELP do. YES is not OK: it is
 * Twilio's opt-in word.
 */
export const SMS_REPORT_KEYWORD_WORDS: Readonly<
  Record<Exclude<SmsReportKeyword, 'edit'>, readonly string[]>
> = {
  ok: ['ok', 'okay', 'vale', 'listo', 'tamam'],
  no_work: [
    'no work',
    'no work today',
    'no trabajo',
    'no hay trabajo',
    'hoy no hay trabajo',
    'sin trabajo',
    'iş yok',
    'is yok',
    'bugün iş yok',
    'bugun is yok',
    'çalışma yok',
    'calisma yok',
    'bugün çalışma yok',
    'bugun calisma yok',
  ],
  weather: [
    'weather',
    'weather day',
    'rain',
    'rained out',
    'clima',
    'lluvia',
    'llueve',
    'hava',
    'hava durumu',
    'yağmur',
    'yagmur',
  ],
};

/** EDIT's first word (the rest is the day and the change, "EDIT FRI Apex was 7 not 6"). */
export const SMS_EDIT_WORDS = ['edit', 'editar', 'edita', 'corregir', 'düzelt', 'duzelt'] as const;

/**
 * Words that mean a keyword (spec §9.5): the US opt-out words a carrier and the FCC's 2025 TCPA
 * revocation rule expect to be honoured in reply to a text (STOPALL, UNSUBSCRIBE, CANCEL, END,
 * QUIT, REVOKE, OPTOUT, OPT OUT), UNSTOP for START and INFO for HELP, as Twilio's default
 * handling reads them. YES (Twilio's other opt-in word) is not START here: it answers the M6
 * ladder's questions, and a missed opt-in only keeps SiteLog quiet.
 */
export const SMS_KEYWORD_ALIASES: Readonly<Record<string, SmsKeyword>> = {
  stopall: 'stop',
  unsubscribe: 'stop',
  cancel: 'stop',
  end: 'stop',
  quit: 'stop',
  revoke: 'stop',
  optout: 'stop',
  'opt out': 'stop',
  unstop: 'start',
  info: 'help',
};

/**
 * The keyword a text is, or null: the whole message, any case, surrounding spaces and trailing
 * punctuation ignored, inner spaces, hyphens and underscores read as one space ("stop",
 * " Stop. ", "HELP!", "Opt-out"), and the synonyms of `SMS_KEYWORD_ALIASES`. A keyword inside a
 * sentence is not one ("please stop at 5" is a text).
 */
export function parseSmsKeyword(body: string): SmsKeyword | null {
  const word = normalizeKeywordText(body);
  if ((SMS_ACCOUNT_KEYWORDS as readonly string[]).includes(word)) return word as SmsKeyword;
  const alias = SMS_KEYWORD_ALIASES[word];
  if (alias) return alias;
  for (const [keyword, words] of Object.entries(SMS_REPORT_KEYWORD_WORDS))
    if (words.some((w) => normalizeKeywordText(w) === word)) return keyword as SmsReportKeyword;
  return parseSmsEdit(body) ? 'edit' : null;
}

/**
 * A text as the keywords read it: NFKC, trimmed, trailing punctuation dropped, lower case (the
 * Turkish "İ" without its combining dot, and "ı" as "i", since "I" lower-cases to "i"), and spaces, hyphens and underscores as one space.
 */
export function normalizeKeywordText(body: string): string {
  return body
    .normalize('NFKC')
    .trim()
    .replace(/[\s.!?,;:]+$/u, '')
    .toLowerCase()
    .replace(/\u0307/gu, '')
    .replace(/ı/gu, 'i')
    .replace(/[\s_-]+/gu, ' ');
}

/**
 * EDIT (W2-12, F10 by SMS): the text starts with an edit word (`SMS_EDIT_WORDS`, any case) and
 * then a space or the end; `rest` is what follows, as written ("FRI Apex was 7 not 6"), for the
 * worker to read the day and the change from. "EDITED" or "edit-friday" is not EDIT.
 */
export function parseSmsEdit(body: string): { rest: string } | null {
  const text = body.normalize('NFKC').trim();
  const m = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (!m) return null;
  const first = normalizeKeywordText(m[1]!);
  if (!SMS_EDIT_WORDS.some((w) => normalizeKeywordText(w) === first)) return null;
  return { rest: (m[2] ?? '').trim() };
}

/**
 * EDIT's day and change read by code (W2-12): the day reference at the start of `rest` ("FRI",
 * "viernes", "cuma", "Oct 9", "yesterday"), resolved to the most recent such date on or before
 * today in `tz`, and the words after it. The worker asks `classify_utterance` first and uses this
 * where the model named no day or no change. A day that is not at the start is not read here.
 */
export function readSmsEdit(
  rest: string,
  now: Date,
  tz: string,
): { date: string | null; dayText: string | null; correction: string } {
  // "İ" folds to "I" (same length), so the day words match case-insensitively.
  const folded = rest.replace(/İ/gu, 'I').trim();
  const correction = stripDayReference(folded);
  const dayText =
    correction !== folded && folded.endsWith(correction)
      ? folded.slice(0, folded.length - correction.length).trim() || null
      : null;
  return {
    date: dayText ? resolveDayReference(dayText, now, tz) : null,
    dayText,
    correction,
  };
}

/**
 * Twilio's Advanced Opt-Out names the keyword it recognised (`OptOutType`: STOP, START, HELP,
 * including its synonyms such as UNSUBSCRIBE or INFO); it wins over the text when present, so a
 * number Twilio has opted out is opted out here too.
 */
export function keywordOf(body: string, optOutType: string | null): SmsKeyword | null {
  switch (optOutType?.toUpperCase()) {
    case 'STOP':
      return 'stop';
    case 'START':
      return 'start';
    case 'HELP':
      return 'help';
    default:
      return parseSmsKeyword(body);
  }
}

/** A reporter whose phone sent the text, in an org of the pack that received it. */
export interface InboundReporter {
  id: string;
  orgId: string;
  status: ReporterStatus;
  contactPref: ContactPref;
  activatedAt: string | null;
  createdAt: string;
  /** `reporters.opted_out_at`: also set on a disabled reporter whose phone sent STOP. */
  optedOutAt: string | null;
}

export interface ReporterChange {
  reporterId: string;
  patch: {
    status?: ReporterStatus;
    opted_out_at?: string | null;
    contact_pref?: ContactPref;
  };
  /** The audit action, as the reporter (§15). */
  action: 'reporter.opted_out' | 'reporter.opted_in' | 'reporter.preferences_changed';
}

export interface InboundSmsPlan {
  keyword: SmsKeyword | null;
  /**
   * The reporter the text is filed under (`messages.reporter_id`, org): the first of `reporters`
   * after `orderInboundReporters`, or null for an unknown number.
   */
  reporterId: string | null;
  changes: ReporterChange[];
  /**
   * The reply, sent by SMS outside the Notifier's order and consent (`smsReplyAllowed`): the
   * account keywords' and the unknown number's (the report keywords' come from the worker).
   */
  reply: { key: Exclude<TwoWaySmsKey, KeywordReplySmsKey>; reporterId: string | null } | null;
  /** F13: record the number in `unknown_contacts` (channel 'sms'). */
  unknownContact: boolean;
  /**
   * The phone's own opt-out on this pack (`sms_opt_outs`), whoever it belongs to: `record` on
   * STOP, `clear` on START. sms-webhook applies it on the Twilio route only (a Demo phone STOP is
   * a demo org's and never stops a real number).
   */
  phoneOptOut: 'record' | 'clear' | null;
  /**
   * W2-12: a report keyword (OK, NO WORK, WEATHER, EDIT) from a reporter who is not opted out,
   * for the worker's `sms_keyword` job; null otherwise (and always on a one-way pack).
   */
  reportKeyword: SmsReportKeyword | null;
  /**
   * W2-16, WhatsApp only (spec §19 Q40, the first option): the `whatsapp` consent of each
   * reporter of the phone, revoked by STOP or given back by START (§19 Q112); SMS is untouched.
   */
  consentChanges: Array<{ reporterId: string; grant: boolean }>;
  /**
   * W2-16, WhatsApp only (spec §19 Q85): a voice note or photo from a reporter: stored, never
   * transcribed, and answered with `whatsapp_use_link` once a day.
   */
  mediaReply: boolean;
  /**
   * W2-16, WhatsApp only (spec §19 Q26): a text that is no keyword, from a reporter: the worker's
   * `whatsapp_answer` job reads it as the answer to their open web question, if one is open.
   */
  answer: boolean;
}

/**
 * Reporters of one phone on one pack, the one a reply speaks for first: not opted out before
 * opted out, active before invited, then the newest. A phone can be a reporter in two orgs on the
 * same pack (spec §19 Q44).
 */
export function orderInboundReporters<R extends InboundReporter>(reporters: readonly R[]): R[] {
  const rank = (r: InboundReporter) =>
    r.status === 'active' ? 0 : r.status === 'invited' ? 1 : r.status === 'opted_out' ? 2 : 3;
  return reporters
    .filter((r) => r.status !== 'disabled')
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * What to do with an inbound text (§9.5, F13, F15):
 * - one-way pack: store it, nothing else;
 * - STOP (or a synonym): every reporter of the phone on this pack → `opted_out` (`opted_out_at`),
 *   a disabled one keeps its status and gets `opted_out_at`, so re-enabling it later lands in
 *   `opted_out`; the phone's own opt-out is recorded (`phoneOptOut`), also for a number with no
 *   reporter; the `stop_confirm` reply for the first reporter, the one text after STOP, and
 *   nothing to a number with no reporter;
 * - START: the opt-outs undone: opted-out reporters → `active` if they had activated, else
 *   `invited`; disabled ones lose `opted_out_at`; the phone's opt-out cleared; no reply (§9.2 has
 *   no text for it);
 * - unknown number (no reporter that is not disabled): the F13 auto-reply and an
 *   `unknown_contacts` row, once while a pending row for the number exists (no reply loop with an
 *   automated sender), never for STOP;
 * - HELP: the `help` reply for the first reporter, also after an opt-out;
 * - CALL / TEXT: `contact_pref` → `call` / `link` for every reporter not opted out, and the
 *   `pref_call_ok` / `pref_text_ok` confirmation unless the first reporter is opted out (spec §19
 *   Q46: the change decides how SiteLog reaches the person);
 * - OK, NO WORK, WEATHER, EDIT (W2-12): named in `reportKeyword` for the worker's `sms_keyword`
 *   job, unless the phone opted out; no reply here;
 * - any other text: stored, no reply.
 *
 * Spec §19 Q45 (owner, 2026-10-15): when Twilio recognised the keyword itself (`OptOutType`
 * present: STOP, START or HELP on a Messaging Service with Advanced Opt-Out), Twilio sends
 * SiteLog's own `stop_confirm` / `help` texts, set as that service's opt-out replies (RUNBOOK), so
 * SiteLog sends no reply of its own and the reporter gets one answer; the opt-out and the other
 * changes are still recorded.
 */
export function planInboundSms(input: {
  pack: CountryPack;
  body: string;
  optOutType: string | null;
  reporters: readonly InboundReporter[];
  /** A pending `unknown_contacts` row already exists for the number. */
  pendingUnknown: boolean;
  now: Date;
  /** W2-16: the channel the message came in on (default SMS). */
  channel?: ReplyChannel;
  /** W2-16: the media the WhatsApp message carries (voice notes, photos). */
  numMedia?: number;
}): InboundSmsPlan {
  const channel = input.channel ?? 'sms';
  const whatsapp = channel === 'whatsapp';
  const ordered = orderInboundReporters(input.reporters);
  const disabled = input.reporters.filter((r) => r.status === 'disabled');
  const first = ordered[0] ?? null;
  // WhatsApp is two-way on every pack (spec §19 Q26), whatever the pack's SMS; Twilio's
  // `OptOutType` is SMS's (Advanced Opt-Out), never read for a WhatsApp message.
  const twoWay = whatsapp || input.pack.twoWaySms;
  const optOutType = whatsapp ? null : input.optOutType;
  const keyword = twoWay ? keywordOf(input.body, optOutType) : null;
  const plan: InboundSmsPlan = {
    keyword,
    reporterId: first?.id ?? null,
    changes: [],
    reply: null,
    unknownContact: false,
    phoneOptOut: null,
    reportKeyword: null,
    consentChanges: [],
    mediaReply: false,
    answer: false,
  };
  if (!twoWay) return plan;
  const providerReplies = Boolean(optOutType?.trim());
  const reply = (key: Exclude<TwoWaySmsKey, KeywordReplySmsKey>, reporterId: string | null) =>
    !providerReplies && replyAllowed(input.pack, key, channel) ? { key, reporterId } : null;
  const at = input.now.toISOString();
  // An SMS opt-out (`opted_out`) is about texts only (§19 Q40): on WhatsApp it blocks nothing.
  const stoppedHere = (r: InboundReporter) => !whatsapp && r.status === 'opted_out';

  if (whatsapp && keyword === 'stop') {
    // §19 Q40 (the first option): WhatsApp's opt-out is its consent, for every reporter of the
    // phone on the pack; texts go on. The confirmation names WhatsApp.
    for (const r of [...ordered, ...disabled])
      plan.consentChanges.push({ reporterId: r.id, grant: false });
    if (first) plan.reply = reply('whatsapp_stop_confirm', first.id);
    return plan;
  }
  if (whatsapp && keyword === 'start') {
    // §19 Q112: the WhatsApp consent back for those who had given it; no reply (as SMS START).
    for (const r of ordered) plan.consentChanges.push({ reporterId: r.id, grant: true });
  }

  if (keyword === 'stop') {
    plan.phoneOptOut = 'record';
    for (const r of ordered)
      if (r.status !== 'opted_out')
        plan.changes.push({
          reporterId: r.id,
          patch: { status: 'opted_out', opted_out_at: at },
          action: 'reporter.opted_out',
        });
    for (const r of disabled)
      if (r.optedOutAt === null)
        plan.changes.push({
          reporterId: r.id,
          patch: { opted_out_at: at },
          action: 'reporter.opted_out',
        });
    if (first) plan.reply = reply('stop_confirm', first.id);
    return plan;
  }
  if (keyword === 'start' && !whatsapp) {
    plan.phoneOptOut = 'clear';
    for (const r of ordered)
      if (r.status === 'opted_out')
        plan.changes.push({
          reporterId: r.id,
          patch: { status: r.activatedAt ? 'active' : 'invited', opted_out_at: null },
          action: 'reporter.opted_in',
        });
    for (const r of disabled)
      if (r.optedOutAt !== null)
        plan.changes.push({
          reporterId: r.id,
          patch: { opted_out_at: null },
          action: 'reporter.opted_in',
        });
  }

  if (!first) {
    if (input.pendingUnknown) return plan;
    plan.unknownContact = true;
    plan.reply = reply('unknown_number', null);
    return plan;
  }
  if (whatsapp && (input.numMedia ?? 0) > 0) {
    // §19 Q85: voice notes and photos go through the link; the message is stored, never read.
    plan.mediaReply = true;
    return plan;
  }

  switch (keyword) {
    case 'help':
      plan.reply = reply('help', first.id);
      break;
    case 'call':
    case 'text': {
      const pref: ContactPref = keyword === 'call' ? 'call' : 'link';
      for (const r of ordered)
        if (!stoppedHere(r) && r.contactPref !== pref)
          plan.changes.push({
            reporterId: r.id,
            patch: { contact_pref: pref },
            action: 'reporter.preferences_changed',
          });
      if (!stoppedHere(first))
        plan.reply = reply(keyword === 'call' ? 'pref_call_ok' : 'pref_text_ok', first.id);
      break;
    }
    case 'ok':
    case 'no_work':
    case 'weather':
    case 'edit':
      // W2-12: answered by the worker (`sms_keyword`), never for a phone that opted out (the
      // first reporter is opted out only when every one is). Twilio's `OptOutType` never names
      // these, so no provider reply competes with it.
      if (!stoppedHere(first)) plan.reportKeyword = keyword;
      break;
    case 'start':
      break;
    default:
      // W2-16 (spec §19 Q26): on WhatsApp any other text may answer an open web question.
      if (whatsapp && keyword === null && input.body.trim() !== '') plan.answer = true;
      break;
  }
  return plan;
}
