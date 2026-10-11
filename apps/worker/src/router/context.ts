import type { ConversationRow } from '@sitelog/shared';

/** conversations.context (jsonb) — everything the state machine remembers between messages. */
export interface ConvoContext {
  active_report_id?: string | null;
  pending_question_id?: string | null;
  /** Messages waiting for a site or day choice (§F5 which-day, §F12 picker). */
  pending?: {
    message_ids: string[];
    site_id?: string | null;
    awaiting: 'site' | 'day';
    date?: string | null;
    /** What the choice is for: a report, or a no-work / weather-day command (§F10). */
    intent?: 'report' | 'no_work' | 'weather_day' | null;
  } | null;
  candidate_site_ids?: string[] | null;
  site_disputed?: boolean;
  error_notified_for?: string | null;
  progress_sent_for?: string | null;
  nudged_for?: string | null;
  draft_message_id?: string | null;
  draft_wa_message_id?: string | null;
  draft_sent_at?: string | null;
  reask?: Record<string, number> | null;
  editing?: { report_id: string } | null;
  fix_requested_for?: string | null;
  language?: string | null;
  last_filed_report_id?: string | null;
  weather_report_id?: string | null;
  weather_followup?: 'photo' | 'voice' | null;
  last_site_id?: string | null;
  [k: string]: unknown;
}

export function contextOf(convo: Pick<ConversationRow, 'context'>): ConvoContext {
  const c = convo.context;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as ConvoContext) : {};
}
