import { renderVoice } from './copy/voice.ts';
import type { ContactPref, RequiredFieldKey } from './enums.ts';
import type { AnswerConfirmation } from './field-contract.ts';
import type { Language } from './locale.ts';
import { computeTotals } from './report/hours.ts';
import { readReportData } from './report/upgrade.ts';
import type { QuestionSpec } from './report/validate.ts';
import type { DailyReportData, StoredReportData } from './schemas/report.ts';
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

// ───────────────────────────── The live draft on a call (W3-09) ─────────────────────────────

/**
 * §10.5 step 2 on a call: the photo requirement is deferred (never asked on the call; the photos
 * link is texted after filing and `no_photo` flags the report at 23:59 if none arrive, W3-11), so
 * a call's questions and `missing` list leave `photo` out. Pure.
 */
export function callRequiredFields<F extends string>(fields: readonly F[]): F[] {
  const photo: RequiredFieldKey = 'photo';
  return fields.filter((f) => f !== photo);
}

/** The longest spoken question and choice the voice contract carries (`VoiceDraftStateSchema`). */
const QUESTION_MAX = 400;
const CHOICE_MAX = 80;

/**
 * F7 on a call (§10.5 step 5: "Call: choices spoken"): the question code picked, as the agent says
 * it: the model's question in the reporter's language (or code's fallback question), and at most
 * two choices worded for the ear ("5 · full day" → "5, full day"). The choices are what the
 * reporter may say; any other answer is parsed (`parse_answer`). Pure.
 */
export function spokenQuestion(spec: Pick<QuestionSpec, 'prompt' | 'options'>): {
  text: string;
  choices: string[];
} {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  return {
    text: clip(spec.prompt.trim(), QUESTION_MAX),
    choices: spec.options
      .slice(0, 2)
      .map((o) => clip(o.label.replace(/\s*·\s*/g, ', ').trim(), CHOICE_MAX))
      .filter((c) => c.length > 0),
  };
}

/**
 * F7's spoken confirmation after an answer ("Delta Mechanical: 5 workers, 8 hours each — 40
 * hours."), in the call language, from the numbers of the draft the answer made
 * (`answerConfirmation`): every number is code's. Pure.
 */
export function voiceAnswerConfirmation(c: AnswerConfirmation, language: Language): string {
  const n = (x: number) => voiceNumber(x, language);
  switch (c.kind) {
    case 'crew':
      if (c.workers !== null && c.hoursPerWorker !== null && c.totalHours !== null)
        return renderVoice('answer_crew', language, {
          company: c.company,
          workers: n(c.workers),
          hours_each: n(c.hoursPerWorker),
          hours: n(c.totalHours),
        });
      if (c.workers !== null)
        return renderVoice('answer_crew_workers', language, {
          company: c.company,
          workers: n(c.workers),
        });
      return renderVoice('answer_noted', language);
    case 'company_added':
      return renderVoice('answer_company_added', language, { company: c.company });
    case 'company_mapped':
      return renderVoice('answer_company_mapped', language, { company: c.company });
    case 'weather':
      return c.lostHours > 0
        ? renderVoice('answer_weather', language, { hours: n(c.lostHours) })
        : renderVoice('answer_no_stoppage', language);
    case 'noted':
      return renderVoice('answer_noted', language);
  }
}

/**
 * The call's read-back (§19 Q118: code writes it, in the call language, numbers first): the crew
 * count, the companies and the total hours, then the hours weather stopped work, then "Shall I
 * file it?". Every number is `computeTotals`' (recomputed, never the stored totals). A crew line
 * without its headcount or hours leaves the crew sentence out rather than speak a partial total.
 *
 * W3-09 builds the numbers; W3-10 adds the draft's own work, delivery and safety lines, the
 * ~75-word cut and the golden texts (EN/ES/TR) on this function. Pure.
 */
export function readBack(data: DailyReportData, language: Language): string {
  const { totals } = computeTotals(data);
  const n = (x: number) => voiceNumber(x, language);
  const parts: string[] = [];
  if (totals.crewOnSite > 0 && totals.headcountKnown && totals.hoursKnown) {
    parts.push(
      totals.companies === 1
        ? renderVoice('readback_crew_one_company', language, {
            workers: n(totals.crewOnSite),
            hours: n(totals.totalHours),
          })
        : renderVoice('readback_crew', language, {
            workers: n(totals.crewOnSite),
            companies: n(totals.companies),
            hours: n(totals.totalHours),
          }),
    );
  }
  if (totals.lostHours > 0)
    parts.push(renderVoice('readback_weather', language, { hours: n(totals.lostHours) }));
  parts.push(renderVoice('confirm_ask', language));
  return parts.join(' ');
}
