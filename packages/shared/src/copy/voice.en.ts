import type { VoiceCatalog } from './voice.ts';

/**
 * The voice assistant's lines, English (W3-01). Verbatim from the spec where it quotes them
 * (`VOICE_SPEC_VERBATIM_KEYS`); the rest written for W3-01 and listed for review with ES and TR.
 * Spoken, so short: one or two sentences a turn (§9.4), no jokes, first names only (§9.7).
 */
export const voiceEn: VoiceCatalog = {
  recording_notice: 'This call is recorded to write your daily report.',
  opening_inbound:
    "SiteLog, hi {first}. {recording_notice} Go ahead with today's report for {site}.",
  opening_inbound_pick_site: 'SiteLog, hi {first}. {recording_notice}',
  opening_outbound:
    "Hi {first}, it's the SiteLog assistant for {company}. {recording_notice} Ready to give me today's report for {site}?",
  opening_talk_now:
    "SiteLog, hi {first}. {recording_notice} Go ahead with today's report for {site}.",
  go_ahead: 'Go ahead — what got done, who was on site, weather, deliveries, anything else.',
  pick_site: 'Which site is this for — {sites}?',
  pick_site_by_name: 'Say the site name.',
  or: 'or',
  backchannel: 'Mm-hm, go on.',
  filler: 'Got it, one moment.',
  silence_prompt: 'Are you still there?',
  silence_goodbye:
    "I've saved what you told me and I'll send you a link to finish the report. Goodbye.",
  time_warning: 'We have about two minutes left on this call.',
  fallback:
    "Let's do it the simple way — tell me everything after the tone and hang up when you're done.",
  readback_crew:
    "Here's what I've got: {workers} on site from {companies} companies, {hours} hours.",
  readback_crew_one_company:
    "Here's what I've got: {workers} on site from one company, {hours} hours.",
  readback_weather: 'Weather stopped work for {hours} hours.',
  readback_change: 'Changed: {change}.',
  confirm_ask: 'Shall I file it?',
  confirm_repeat: 'Shall I file it? Say yes or no.',
  weather_day_crew_ask:
    'Weather day from {time}, crew sent home — how many were on site this morning?',
  weather_photo_link: "A photo of the conditions makes the record stronger — I've sent you a link.",
  consent_ask: 'Is it OK if I record these calls and text you report links? Say yes or no.',
  preference_ask: 'Each workday, would you rather get a call or a text with your link?',
  consent_declined: 'Understood. Nothing from this call is kept. Goodbye.',
  consent_declined_link:
    "Understood. Nothing from this call is kept. I'll text you your link so you can report on the web. Goodbye.",
  unknown_greeting: "Hi, it's the SiteLog assistant.",
  unknown_caller:
    "This number isn't set up with SiteLog yet. Tell me your name, your company and the site, and I'll pass it to the office.",
  unknown_goodbye: "Thanks, I'll pass it to the office. Goodbye.",
  goodbye_filed: "Filed. I've sent you the PDF and a link to add photos. Have a good evening.",
  goodbye_draft_saved: "I've saved your draft and I'll send you a link to finish it. Goodbye.",
  goodbye_no_work: 'Noted: no work today at {site}. Have a good evening.',
  goodbye_weather_day: 'Noted: weather day at {site}. Have a good evening.',
  goodbye_edit_applied: 'Done. The updated report goes to the office. Goodbye.',
  goodbye_callback_requested: "OK, I'll call you back at {time}. Goodbye.",
  goodbye_fallback_recording: "Thanks. I'll send you a link to check the draft. Goodbye.",
  goodbye_abandoned: 'Goodbye.',
  pref_call_ok: 'OK, your daily report is now set to a call.',
  pref_text_ok: 'OK, your daily report is now set to a link by text.',
  load_report_summary: "{day}'s report, {report_no}: {workers} on site, {hours} hours.",
  load_report_found: "I've found {day}'s report, {report_no}.",
  still_working: 'Still working on it, one moment.',
  answer_crew: '{company}: {workers} workers, {hours_each} hours each — {hours} hours.',
  answer_crew_workers: '{company}: {workers} workers.',
  answer_weather: 'Noted: {hours} hours lost to weather.',
  answer_no_stoppage: 'Noted: no weather stoppage.',
  answer_company_added: 'Noted: {company}, a new subcontractor for the office to confirm.',
  answer_company_mapped: 'Noted: {company}.',
  answer_noted: 'Noted.',
  answer_again: "Sorry, I didn't catch that.",
  answer_skipped: "I couldn't make that out, so I've left it for the office to check.",
  readback_work: 'Done: {items}.',
  readback_work_complete: '{item} complete',
  readback_work_percent: '{item} about {percent} percent',
  readback_work_count: 'Work items noted: {count}.',
  readback_deliveries: 'Delivered: {items}.',
  readback_delivery_quantity: '{quantity} of {item}',
  readback_delivery_from: '{item} from {supplier}',
  readback_deliveries_count: 'Deliveries noted: {count}.',
  readback_toolbox: 'Toolbox talk.',
  readback_no_incidents: 'No incidents.',
  readback_incident_one: 'One incident reported.',
  readback_incidents: '{count} incidents reported.',
  correction_crew_removed: '{company} taken off the report.',
  correction_unclear: "Sorry, I couldn't make that change. What should I change?",
  correction_nothing: "That's what I have already.",
  day_off_confirm_no_work: 'No work today at {site}? Say yes or no.',
  day_off_confirm_weather:
    'Weather day at {site}: work stopped at {time}, {hours} hours lost. Shall I log it?',
  day_off_confirm_weather_crew:
    'Weather day at {site}: work stopped at {time}, {workers} on site before, {hours} hours lost. Shall I log it?',
  day_off_confirm_never:
    'Weather day at {site}: the crew never started, {hours} hours lost. Shall I log it?',
  day_off_confirm_never_crew:
    'Weather day at {site}: a crew of {workers} never started, {hours} hours lost. Shall I log it?',
  day_off_confirm_repeat: 'Shall I log it? Say yes or no.',
  day_off_logged_no_work: 'Logged: no work today at {site}.',
  day_off_logged_weather: 'Logged: weather day at {site}.',
  day_off_in_progress:
    "Today's report has already started, so say it in the report: what stopped work and for how long.",
  day_off_filed: "Today's report for {site} is already filed.",
  day_off_site_paused: '{site} is paused in SiteLog. Ask the office to resume it.',
  callback_unavailable:
    "I can't call you back yet. Call again or use your link whenever you're ready.",
  pref_not_today_ok: 'OK, no more calls from me today.',
  edit_ask: 'What should I change?',
  edit_save_ask: 'Save it?',
  edit_save_repeat: 'Save it? Say yes or no.',
  edit_saved: 'Saved. Version {version} goes to the office.',
  edit_changed_meanwhile: 'The report changed while we talked. Say the change again.',
  edit_locked: 'That report is locked. Ask the office to change it.',
  edit_not_found: "I can't find a filed report for that day.",
  edit_ambiguous: 'There are two reports that day. Which site is it?',
  edit_pending: "I'm still working on the last change, one moment.",
  consent_given: 'Thank you.',
  consent_repeat:
    'Sorry, is it OK if I record these calls and text you report links? Say yes or no.',
  tool_error: "Sorry, that didn't work on my side. Let's try again.",
};
