import { renderVoice } from './copy/voice.ts';
import type { ContactPref } from './enums.ts';
import type { Language } from './locale.ts';
import { computeTotals } from './report/hours.ts';
import { readReportData } from './report/upgrade.ts';
import type { StoredReportData } from './schemas/report.ts';
import { VOICE_CONSENT_TEXT_VERSION, VOICE_RECORDING_NOTICE_VERSION } from './voice.ts';

/**
 * Pure pieces of field-api's `/voice/tools/*` answers (W3-03; spec §9.4, Appendix B): the words a
 * tool hands the agent are code's, in the call language, with every number computed in code (§19
 * Q118, CLAUDE.md "never invent numbers"). Node, browser and Deno (Intl only).
 */

const INTL_LOCALE: Readonly<Record<Language, string>> = {
  en: 'en-US',
  es: 'es-US',
  tr: 'tr-TR',
};

/** A report day's weekday as spoken ("Friday", "viernes", "Cuma"); `date` is `YYYY-MM-DD`. */
export function voiceWeekday(date: string, language: Language): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[language], {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

/** A number as the call language writes it (TR "7,5"), at most two decimals. */
export function voiceNumber(n: number, language: Language): string {
  return new Intl.NumberFormat(INTL_LOCALE[language], { maximumFractionDigits: 2 }).format(n);
}

/**
 * `load_report`'s `summary` (F10 on a call): the day, the report number and, when the report
 * knows both, its crew and hours (`computeTotals`: recomputed in code, never the stored totals).
 * A report with no crew, or a crew line without its headcount or hours, says only which report
 * it found: the agent then asks what to change (§9.4 rule 6).
 */
export function loadReportSummary(input: {
  data: StoredReportData | null;
  date: string;
  reportNo: string;
  language: Language;
}): string {
  const day = voiceWeekday(input.date, input.language);
  const totals = input.data ? computeTotals(readReportData(input.data)).totals : null;
  if (totals && totals.crewOnSite > 0 && totals.headcountKnown && totals.hoursKnown) {
    return renderVoice('load_report_summary', input.language, {
      day,
      report_no: input.reportNo,
      workers: voiceNumber(totals.crewOnSite, input.language),
      hours: voiceNumber(totals.totalHours, input.language),
    });
  }
  return renderVoice('load_report_found', input.language, { day, report_no: input.reportNo });
}

/** `set_preference`'s sentence: the spoken form of §9.5's CALL / TEXT replies. */
export function preferenceConfirmation(pref: ContactPref, language: Language): string {
  return renderVoice(pref === 'call' ? 'pref_call_ok' : 'pref_text_ok', language);
}

/**
 * The wording versions a call stores (§19 Q28, Q120): the pack's `legal_keys` when counsel set
 * them, else the agent's own (`voice.recording_notice.v1`, `voice.consent.v1`).
 */
export function voiceTextVersions(
  legalKeys: { recording_notice?: string; consent?: string } | null | undefined,
): {
  recordingNoticeVersion: string;
  consentTextVersion: string;
} {
  return {
    recordingNoticeVersion: legalKeys?.recording_notice?.trim() || VOICE_RECORDING_NOTICE_VERSION,
    consentTextVersion: legalKeys?.consent?.trim() || VOICE_CONSENT_TEXT_VERSION,
  };
}

/** `calls/{org}/{call}.ogg` (§9.4 "Recording"): the one path a call's recording may take. */
export function callRecordingPath(orgId: string, callId: string): string {
  return `${orgId}/${callId}.ogg`;
}
