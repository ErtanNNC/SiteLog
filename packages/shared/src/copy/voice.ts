import type { Language } from '../locale.ts';
import { voiceEn } from './voice.en.ts';
import { voiceEs } from './voice.es.ts';
import { voiceTr } from './voice.tr.ts';

/**
 * The voice assistant's spoken lines (W3-01; spec §9.4, §7.3, F3, F6, F12, F13, F14): fixed
 * sentences the agent says itself, in the call language, so the openings, the disclosure, the
 * filing question and the goodbyes never depend on the model. The model speaks the rest within
 * §9.4's dialog policy; every number it reads back comes from code (§19 Q118).
 *
 * - EN is verbatim from the spec where the spec quotes the line (`VOICE_SPEC_QUOTES`, tested);
 *   the other EN lines and all ES and TR lines are listed for the native-speaker read (§19 Q63).
 *   TR uses formal "siz" and no exclamation marks (§9.7); ES uses "usted", as the SMS copy does.
 * - The disclosure is `recording_notice` (`voice.recording_notice.v1`) until counsel fills the
 *   pack's `legal_keys.recording_notice` (§19 Q28); the openings take it as `{recording_notice}`,
 *   so a pack's own notice drops in without touching the openings.
 * - Placeholders are `{name}` (Python's `str.format` reads the same files: `pnpm voice:contract`
 *   writes `apps/voice-agent/copy/{en,es,tr}.json`). Every language has every key with the same
 *   placeholders (tested).
 */
export const VOICE_KEYS = [
  // Disclosure and openings (§9.4; F6 step 2). Talk now uses the inbound wording (§9.4: "the same
  // disclosure, prompts and tools").
  'recording_notice',
  'opening_inbound',
  'opening_inbound_pick_site',
  'opening_outbound',
  'opening_talk_now',
  'go_ahead',
  // F14 on a call: ≤ 3 site names, joined with `or`; more, the name is asked for.
  'pick_site',
  'pick_site_by_name',
  'or',
  // While the reporter talks (§9.4 rules 1–2, F6 step 4).
  'backchannel',
  'filler',
  // §7.3 limits: silence 8 s, a second silence saves the draft; the 12-minute cap warns at 10.
  'silence_prompt',
  'silence_goodbye',
  'time_warning',
  // F6 failure handling (§9.4 rule 9).
  'fallback',
  // Read-back (§19 Q118: code writes it, numbers first) and the filing question (§19 Q119).
  'readback_crew',
  'readback_crew_one_company',
  'readback_weather',
  'readback_change',
  'confirm_ask',
  'confirm_repeat',
  // F12 on a call.
  'weather_day_crew_ask',
  'weather_photo_link',
  // F3 on a call (§19 Q120): consent, then the daily preference.
  'consent_ask',
  'preference_ask',
  'consent_declined',
  'consent_declined_link',
  // F13: an unknown caller.
  'unknown_greeting',
  'unknown_caller',
  'unknown_goodbye',
  // Goodbyes per outcome (§6.2 `call_outcome`; `not_reached` has nobody to say goodbye to).
  'goodbye_filed',
  'goodbye_draft_saved',
  'goodbye_no_work',
  'goodbye_weather_day',
  'goodbye_edit_applied',
  'goodbye_callback_requested',
  'goodbye_fallback_recording',
  'goodbye_abandoned',
  // Tool answers worded by code (W3-03): F15 on a call (`set_preference`, the spoken form of
  // §9.5's CALL / TEXT replies) and F10's `load_report` summary (numbers from code, §19 Q118).
  'pref_call_ok',
  'pref_text_ok',
  'load_report_summary',
  'load_report_found',
  // W3-09: the live draft on a call. A turn still running past the wait (§19 Q117); F7 on a call:
  // the confirmation after an answer from code's numbers (F7's spoken example), the unclear answer
  // asked once more, the second one left for the office.
  'still_working',
  'answer_crew',
  'answer_crew_workers',
  'answer_weather',
  'answer_no_stoppage',
  'answer_company_added',
  'answer_company_mapped',
  'answer_noted',
  'answer_again',
  'answer_skipped',
  // W3-10: the read-back's own lines (§19 Q118: the draft's work, deliveries and safety after the
  // numbers; Q161: counts only when the call language is not the report's) and the change read
  // back after a correction on the call (F8 call).
  'readback_work',
  'readback_work_complete',
  'readback_work_percent',
  'readback_work_count',
  'readback_deliveries',
  'readback_delivery_quantity',
  'readback_delivery_from',
  'readback_deliveries_count',
  'readback_toolbox',
  'readback_no_incidents',
  'readback_incident_one',
  'readback_incidents',
  'correction_crew_removed',
  'correction_unclear',
  'correction_nothing',
  // W3-14: the special requests on a call (F6, §9.4 rule 6). F12: code reads the day off back with
  // its lost hours (from code, never the model) and logs it only after the spoken yes (§19 Q136's
  // "No work today?"); a day whose report is under way is said in the report (§19 Q79).
  'day_off_confirm_no_work',
  'day_off_confirm_weather',
  'day_off_confirm_weather_crew',
  'day_off_confirm_never',
  'day_off_confirm_never_crew',
  'day_off_confirm_repeat',
  'day_off_logged_no_work',
  'day_off_logged_weather',
  'day_off_in_progress',
  'day_off_filed',
  'day_off_site_paused',
  // "Call me back" where no calls are placed (or without the reporter's auto_call consent), and
  // F15's "not today" (§19 Q129).
  'callback_unavailable',
  // W3-17 (§19 Q128): a callback asked for after the call window, or a second one the same day.
  'callback_outside_window',
  'callback_limit',
  'pref_not_today_ok',
  // F10 on a call: load_report's other answers, the change read back with "Save it?", the save.
  'edit_ask',
  'edit_save_ask',
  'edit_save_repeat',
  'edit_saved',
  'edit_changed_meanwhile',
  'edit_locked',
  'edit_not_found',
  'edit_ambiguous',
  'edit_pending',
  // F3 on a call (§19 Q120): the yes recorded; the question again after an unclear answer.
  'consent_given',
  'consent_repeat',
  // W3-12: a tool that failed on TalkOlog's side, said instead of the error (§9.4: tool errors are
  // spoken as a short line, never raw).
  'tool_error',
  // W4-05 (P12, §19 Q232, Q350): Settings' Call me now, the whole script of a test call: the
  // disclosure (the assistant, and that nothing is recorded), one line with the company, goodbye.
  'test_call_greeting',
  'test_call_line',
  'test_call_goodbye',
] as const;
export type VoiceKey = (typeof VOICE_KEYS)[number];

/** A language's spoken lines. */
export type VoiceCatalog = Readonly<Record<VoiceKey, string>>;

/** Call languages: the reporter's language (§9.6). */
export const VOICE_CATALOGS: Readonly<Record<Language, VoiceCatalog>> = {
  en: voiceEn,
  es: voiceEs,
  tr: voiceTr,
};

/**
 * EN lines the spec quotes, verbatim: `voice.test.ts` finds each one in the spec (a trailing full
 * stop the spec's quote leaves off aside), with an opening's `{recording_notice}` filled with
 * `recording_notice`. A copy edit or a spec edit that drifts fails there.
 */
export const VOICE_SPEC_VERBATIM_KEYS = [
  'recording_notice',
  'opening_outbound',
  'go_ahead',
  'pick_site_by_name',
  'backchannel',
  'filler',
  'silence_prompt',
  'fallback',
  'confirm_ask',
  'confirm_repeat',
  'consent_ask',
  'weather_photo_link',
  'unknown_caller',
  'goodbye_filed',
  'edit_locked',
] as const satisfies readonly VoiceKey[];

/** The `{name}` placeholders of a text, in order of first appearance. */
export function voicePlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!))];
}

/** Fills a line's placeholders; throws on a missing or empty value, as `renderSms` does. */
export function renderVoice(
  key: VoiceKey,
  language: Language,
  vars: Readonly<Record<string, string | number | null | undefined>> = {},
): string {
  const catalog = VOICE_CATALOGS[language];
  if (!catalog) throw new Error(`No voice copy for "${language}"`);
  if (!Object.hasOwn(catalog, key)) throw new Error(`Unknown voice key "${key}"`);
  return catalog[key].replace(/\{([a-z0-9_]+)\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`Voice "${key}" (${language}) needs {${name}}`);
    }
    return String(value);
  });
}

/** F14: up to three site names joined for `pick_site` ("Riverside or Pier 9"; "A, B or C"). */
export function voiceSiteList(names: readonly string[], language: Language): string {
  if (names.length === 0 || names.length > 3) throw new Error('voiceSiteList takes 1 to 3 names');
  if (names.length === 1) return names[0]!;
  const or = VOICE_CATALOGS[language].or;
  return `${names.slice(0, -1).join(', ')} ${or} ${names[names.length - 1]!}`;
}
