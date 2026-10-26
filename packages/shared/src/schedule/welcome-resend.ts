import { addDays, formatDateInTz } from '../format.ts';
import { insideWindow, type QuietWindow } from './remind.ts';
import { deadlineInstant } from './reminders.ts';

/**
 * W4-12 · F3's "no reaction in 48 h → one re-send" (spec §19 Q241's recommended default,
 * `WELCOME_RESEND`): one automatic re-send of the welcome, 48 h after the welcome that reached
 * the phone, inside the site's daytime. The worker's `send_welcome` (with `auto`) checks at run
 * time that nothing happened since (no consent, no link opened, still invited, the phone not
 * opted out); these are its clock rules.
 */

/** `WELCOME_RESEND`: `auto` (Q241's recommendation, the default) or `off` (the office's button only). */
export const WELCOME_RESEND_MODES = ['auto', 'off'] as const;
export type WelcomeResendMode = (typeof WELCOME_RESEND_MODES)[number];

/** Hours from the welcome that went to its automatic re-send (F3). */
export const WELCOME_RESEND_AFTER_HOURS = 48;

/** The site's daytime for the re-send (Q241: 09:00–18:00 site time; start in, end out). */
export const WELCOME_RESEND_WINDOW: QuietWindow = { start: '09:00', end: '18:00' };

/**
 * The first instant at or after `from` inside `window` at the site (a same-day window, start
 * before end): `from` itself when inside, else the window's next start (today's, or tomorrow's
 * once today's has passed). Wall-clock time in the site's zone, so a DST day moves nothing.
 */
export function nextInsideWindow(
  from: Date,
  tz: string,
  window: QuietWindow = WELCOME_RESEND_WINDOW,
): Date {
  if (insideWindow(from, tz, window)) return from;
  const today = formatDateInTz(from, tz);
  const start = deadlineInstant(today, window.start, tz);
  return start.getTime() > from.getTime()
    ? start
    : deadlineInstant(addDays(today, 1), window.start, tz);
}

/** When the automatic re-send of a welcome sent at `sentAt` is due at a site in `tz`. */
export function welcomeResendDueAt(sentAt: Date, tz: string): Date {
  return nextInsideWindow(
    new Date(sentAt.getTime() + WELCOME_RESEND_AFTER_HOURS * 3_600_000),
    tz,
    WELCOME_RESEND_WINDOW,
  );
}

/** Why an automatic re-send that came due sends nothing (audited `reporter.welcome_resend_skipped`). */
export type WelcomeResendSkip =
  /** No longer `invited` (active, opted out, disabled, or never invited). */
  | 'not_invited'
  /** A consent answer (given or refused) is on record: the reporter reacted. */
  | 'consent_answered'
  /** A link of theirs was opened (the recorder, a device check). */
  | 'link_opened'
  /** The phone is on the pack's opt-out list (STOP, or the provider's own list). */
  | 'phone_opted_out'
  /** A welcome went less than 48 h ago (the office re-sent it meanwhile). */
  | 'recent_welcome';

export interface WelcomeResendFacts {
  status: string;
  /** When the latest welcome reached the phone (`reporters.invited_at`). */
  invitedAt: string | null;
  /** Consent rows of the reporter, any type, given or revoked. */
  consents: number;
  linkOpened: boolean;
  phoneOptedOut: boolean;
}

/** The run-time check of a due automatic re-send: null to send, else why not. */
export function welcomeResendSkip(facts: WelcomeResendFacts, now: Date): WelcomeResendSkip | null {
  if (facts.status !== 'invited') return 'not_invited';
  if (facts.consents > 0) return 'consent_answered';
  if (facts.linkOpened) return 'link_opened';
  if (facts.phoneOptedOut) return 'phone_opted_out';
  if (
    facts.invitedAt &&
    now.getTime() < Date.parse(facts.invitedAt) + WELCOME_RESEND_AFTER_HOURS * 3_600_000
  )
    return 'recent_welcome';
  return null;
}
