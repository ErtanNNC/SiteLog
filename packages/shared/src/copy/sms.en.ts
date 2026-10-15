import type { SmsCatalog, SmsKey } from './sms.ts';

/**
 * §9.2 SMS copy, English: verbatim from the spec table. A message with an "or call {number}"
 * clause has two texts: `withNumber` (verbatim) and `withoutNumber`, the same text with only
 * that clause removed, for orgs whose country pack has no voice number (§9.2 "No voice number").
 * The welcome's reply clause is `smsReplyHintEn`, which `renderSms` appends only for packs with
 * two-way SMS; catalogue text + hint is the §9.2 cell. Punctuation is GSM-7 only ("-", never "—"
 * or "·"; spec §19 Q15), so every English text is GSM-7.
 */
export const smsEn: SmsCatalog<SmsKey> = {
  welcome: {
    withNumber:
      "Hi {first}, I'm SiteLog, the daily report assistant for {company} at {site}. Each workday before {deadline}, tap your link and talk for ~3 min, or call {number}: {link}",
    withoutNumber:
      "Hi {first}, I'm SiteLog, the daily report assistant for {company} at {site}. Each workday before {deadline}, tap your link and talk for ~3 min: {link}",
  },
  verify_code: 'SiteLog code: {code}. It expires in 10 minutes.',
  daily_link: {
    withNumber: "Today's report for {site}: {link} - or just call {number}.",
    withoutNumber: "Today's report for {site}: {link}",
  },
  call_coming: "I'll call you at {time} for today's report. Prefer to do it now? {link}",
  weather_headsup:
    'Heads-up: report due at {deadline}. {weather_phrase} - mention the hours lost and what stopped.',
  reminder_1: 'No report yet for {site} today. A one-minute voice note is plenty: {link}',
  reminder_2: {
    withNumber:
      "Still nothing for today. I'll let the office know at {time}. {link} or call {number}.",
    withoutNumber: "Still nothing for today. I'll let the office know at {time}. {link}",
  },
  missed_call: {
    withNumber: "Missed you for today's report. Call {number} or tap {link}.",
    withoutNumber: "Missed you for today's report. Tap {link}.",
  },
  question_ready: "One quick question about today's report: {link}",
  draft_ready: 'Your report is ready to check: {link}',
  filed: 'Filed: Daily Report {report_no}. PDF: {pdf_link}',
  photos_link: "Add photos to today's report: {link}",
  edit_applied: 'Updated {weekday}: {change}. Version {v} sent to the office.',
  finish_report: 'Your call ended before filing. Finish in one tap: {link}',
  site_paused: '{site} is paused in SiteLog. Ask the office to resume it.',
  unknown_number: "This number isn't set up with SiteLog. Ask your office to add you.",
  help: {
    withNumber:
      'SiteLog daily reports for {company}. Your link: {link} - Call {number} - Text CALL or TEXT to switch - STOP to opt out. Msg & data rates may apply.',
    withoutNumber:
      'SiteLog daily reports for {company}. Your link: {link} - Text CALL or TEXT to switch - STOP to opt out. Msg & data rates may apply.',
  },
  stop_confirm: "You won't get more texts from SiteLog. Reply START to resume.",
  pref_call_ok: 'OK, your daily report is now set to a call. Reply TEXT to switch to a link.',
  pref_text_ok:
    'OK, your daily report is now set to a link by text. Reply CALL to switch to a call.',
};

/** The `welcome` reply clause for packs with two-way SMS (§9.2), appended by `renderSms`. */
export const smsReplyHintEn = ' - Reply STOP to opt out, HELP for help';
