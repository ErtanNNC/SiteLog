import type { OrgSettingsRow } from '@sitelog/shared';

/**
 * The §7.2 timeouts, channel-neutral and pure (W2-07; GAP §4 "extract first: the timeout sweep").
 * The decisions the v1.0 WhatsApp sweep made inline (`router/timeouts.ts`, which calls this module
 * until step 22 retires it) and the web recorder's clock (`pipeline/web.ts`, delayed decide_next
 * and notify jobs keyed per question or per draft revision) both come from here:
 *
 * - a question unanswered for 60 min → recorded unanswered; the draft is built with the gap
 *   flagged `unanswered:<field>` (F7; on the web no text: the reporter sees it next time);
 * - a draft not confirmed → one nudge at +30 min, filed at +2 h with trigger `timeout` (reason
 *   `unconfirmed`); with `filing_mode = 'auto_15min'` filed at +15 min (trigger `auto`), no nudge;
 * - (WhatsApp only) processing for 10 min without a draft → "taking a little longer" once.
 *
 * Spec §19 Q11: the reporter confirms by default; the timeouts file only what nobody confirmed.
 */
export const ANSWER_TIMEOUT_MS = 60 * 60_000;
export const CONFIRM_NUDGE_MS = 30 * 60_000;
export const CONFIRM_FILE_MS = 2 * 60 * 60_000;
export const AUTO_FILE_MS = 15 * 60_000;
export const PROCESSING_DELAYED_MS = 10 * 60_000;

export type FilingMode = OrgSettingsRow['filing_mode'];

/**
 * Spec §19 Q78 (decided 2026-10-16: the default, as built) as a parameter: the copy key of the
 * 30-minute nudge. §9.2 has no nudge key; the nudge re-sends `draft_ready` ("Your report is ready
 * to check: {link}"), one segment and no new translation. A new key would be a copy-only change
 * (SMS_KEYS, §9.2).
 */
export interface TimeoutPolicy {
  nudgeKey: 'draft_ready';
}

export const TIMEOUT_POLICY_DEFAULTS: TimeoutPolicy = { nudgeKey: 'draft_ready' };

export type ConfirmationStep =
  { kind: 'nudge'; at: Date } | { kind: 'file'; at: Date; trigger: 'timeout' | 'auto' };

/** Whether the filing mode files an unconfirmed draft after 15 min (no nudge). */
export function autoFiles(filingMode: FilingMode | null | undefined): boolean {
  return filingMode === 'auto_15min';
}

/**
 * The confirmation clock of a draft shown at `shownAt`: the nudge (unless auto-filing) and the
 * filing, in time order. The web schedules each as a delayed job keyed per draft revision.
 */
export function confirmationSchedule(
  shownAt: Date,
  filingMode: FilingMode | null | undefined,
): ConfirmationStep[] {
  const t = shownAt.getTime();
  if (autoFiles(filingMode))
    return [{ kind: 'file', at: new Date(t + AUTO_FILE_MS), trigger: 'auto' }];
  return [
    { kind: 'nudge', at: new Date(t + CONFIRM_NUDGE_MS) },
    { kind: 'file', at: new Date(t + CONFIRM_FILE_MS), trigger: 'timeout' },
  ];
}

/** When a question asked at `askedAt` times out (F7). */
export function answerTimeoutAt(askedAt: Date): Date {
  return new Date(askedAt.getTime() + ANSWER_TIMEOUT_MS);
}

/** Whether a question asked at `askedAt` has timed out at `now`. */
export function answerTimedOut(askedAt: Date, now: Date): boolean {
  return now.getTime() >= answerTimeoutAt(askedAt).getTime();
}

/**
 * What the confirmation clock asks for at `now` for a draft shown at `shownAt` (the sweep's
 * question, asked every minute): the filing once due, else the nudge once due and not yet sent,
 * else nothing. A filing due wins over a nudge never sent (a worker that was down).
 */
export function dueConfirmationStep(input: {
  shownAt: Date;
  now: Date;
  filingMode: FilingMode | null | undefined;
  nudged: boolean;
}): ConfirmationStep | null {
  const due = confirmationSchedule(input.shownAt, input.filingMode).filter(
    (s) => s.at.getTime() <= input.now.getTime(),
  );
  const file = due.find((s) => s.kind === 'file');
  if (file) return file;
  const nudge = due.find((s) => s.kind === 'nudge');
  return nudge && !input.nudged ? nudge : null;
}
