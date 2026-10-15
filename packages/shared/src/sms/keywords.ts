import { smsReplyAllowed } from '../channels.ts';
import type { TwoWaySmsKey } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import type { ContactPref, ReporterStatus } from '../enums.ts';

/**
 * §9.5 SMS keywords and F13/F15 (W1-08): what sms-webhook does with an inbound text. Pure, so the
 * Twilio route, the Demo phone's reply box (the same handler logic, spec §19 Q35) and the panel's
 * in-memory demo share it. `wa/replies.ts` keeps serving WhatsApp until step 22.
 *
 * Week 1 handles STOP, START, HELP, CALL and TEXT (and their synonyms, `SMS_KEYWORD_ALIASES`);
 * OK, NO WORK, WEATHER and EDIT come with the M6 reminder ladder, and every other text is stored
 * for it. Everything here runs only on a pack with
 * two-way SMS (`smsReplyAllowed`): a one-way pack's inbound texts are stored and nothing else.
 */

export const SMS_KEYWORDS = ['stop', 'start', 'help', 'call', 'text'] as const;
export type SmsKeyword = (typeof SMS_KEYWORDS)[number];

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
  const word = body
    .normalize('NFKC')
    .trim()
    .replace(/[\s.!?,;:]+$/u, '')
    .toLowerCase()
    .replace(/[\s_-]+/gu, ' ');
  if ((SMS_KEYWORDS as readonly string[]).includes(word)) return word as SmsKeyword;
  return SMS_KEYWORD_ALIASES[word] ?? null;
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
  /** The reply, sent by SMS outside the Notifier's order and consent (`smsReplyAllowed`). */
  reply: { key: TwoWaySmsKey; reporterId: string | null } | null;
  /** F13: record the number in `unknown_contacts` (channel 'sms'). */
  unknownContact: boolean;
  /**
   * The phone's own opt-out on this pack (`sms_opt_outs`), whoever it belongs to: `record` on
   * STOP, `clear` on START. sms-webhook applies it on the Twilio route only (a Demo phone STOP is
   * a demo org's and never stops a real number).
   */
  phoneOptOut: 'record' | 'clear' | null;
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
 * - any other text: stored for M6.
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
}): InboundSmsPlan {
  const ordered = orderInboundReporters(input.reporters);
  const disabled = input.reporters.filter((r) => r.status === 'disabled');
  const first = ordered[0] ?? null;
  const keyword = input.pack.twoWaySms ? keywordOf(input.body, input.optOutType) : null;
  const plan: InboundSmsPlan = {
    keyword,
    reporterId: first?.id ?? null,
    changes: [],
    reply: null,
    unknownContact: false,
    phoneOptOut: null,
  };
  if (!input.pack.twoWaySms) return plan;
  const providerReplies = Boolean(input.optOutType?.trim());
  const reply = (key: TwoWaySmsKey, reporterId: string | null) =>
    !providerReplies && smsReplyAllowed(input.pack, key) ? { key, reporterId } : null;
  const at = input.now.toISOString();

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
  if (keyword === 'start') {
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

  switch (keyword) {
    case 'help':
      plan.reply = reply('help', first.id);
      break;
    case 'call':
    case 'text': {
      const pref: ContactPref = keyword === 'call' ? 'call' : 'link';
      for (const r of ordered)
        if (r.status !== 'opted_out' && r.contactPref !== pref)
          plan.changes.push({
            reporterId: r.id,
            patch: { contact_pref: pref },
            action: 'reporter.preferences_changed',
          });
      if (first.status !== 'opted_out')
        plan.reply = reply(keyword === 'call' ? 'pref_call_ok' : 'pref_text_ok', first.id);
      break;
    }
    default:
      break;
  }
  return plan;
}
