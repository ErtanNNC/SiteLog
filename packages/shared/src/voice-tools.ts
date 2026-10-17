import { uiEn } from './copy/ui/en.ts';
import { uiEs } from './copy/ui/es.ts';
import { uiTr } from './copy/ui/tr.ts';
import { renderVoice } from './copy/voice.ts';
import { REQUIRED_FIELD_KEYS, type ContactPref, type RequiredFieldKey } from './enums.ts';
import type { AnswerConfirmation } from './field-contract.ts';
import type { Language } from './locale.ts';
import { computeTotals } from './report/hours.ts';
import { readReportData } from './report/upgrade.ts';
import type { CorrectionChange, CorrectionSection } from './report/correction.ts';
import { validateReport, type QuestionSpec } from './report/validate.ts';
import type { DailyReportData, StoredReportData } from './schemas/report.ts';
import {
  VOICE_CONSENT_TEXT_VERSION,
  VOICE_RECORDING_NOTICE_VERSION,
  type VoiceDraftState,
} from './voice.ts';

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

/** §19 Q118: the read-back is cut at about 75 words (≤ 30 seconds spoken). */
export const READ_BACK_MAX_WORDS = 75;

/** A draft string the read-back speaks is at most this long (a longer line is left out). */
const READ_BACK_ITEM_MAX = 120;

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * A draft string inside a sentence ("Level 4 slab pour"): its first letter in lower case, unless
 * the first word is an acronym or a name written in capitals ("CMU blockwork" stays).
 */
function lowerFirst(text: string, language: Language): string {
  const [first = '', second = ''] = Array.from(text);
  if (!first || second.toLocaleUpperCase(INTL_LOCALE[language]) === second) return text;
  return first.toLocaleLowerCase(INTL_LOCALE[language]) + text.slice(first.length);
}

/**
 * The call's read-back (§19 Q118: code writes it, in the call language, numbers first): the crew
 * count, the companies and the total hours, then the hours weather stopped work, then the draft's
 * own work, delivery and safety lines, then "Shall I file it?". Every number is `computeTotals`'
 * (recomputed, never the stored totals). A crew line without its headcount or hours leaves the
 * crew sentence out rather than speak a partial total.
 *
 * - The numbers (crew, weather) and the question are always said; the work, deliveries and
 *   safety follow while the whole stays within `READ_BACK_MAX_WORDS` (an item that does not fit
 *   ends its list; a list with no item that fits is left out).
 * - Work: "{area} {activity}", "complete" for finished work, "about N percent" for a percentage
 *   the reporter said. Deliveries: "{quantity} of {item} from {supplier}" as said. Safety: the
 *   toolbox talk, "no incidents" only when the reporter said so, else the incidents' count.
 * - §19 Q161 (recommended default): the work and delivery lines are the draft's own words, in the
 *   report language; when the call language differs (an ES call on an EN report) only their
 *   counts are said, in the call language, until a translation step exists. Safety is code's own
 *   copy, said in the call language either way.
 *
 * Pure.
 */
export function readBack(data: DailyReportData, language: Language): string {
  const { totals } = computeTotals(data);
  const n = (x: number) => voiceNumber(x, language);
  const head: string[] = [];
  if (totals.crewOnSite > 0 && totals.headcountKnown && totals.hoursKnown) {
    head.push(
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
    head.push(renderVoice('readback_weather', language, { hours: n(totals.lostHours) }));
  const ask = renderVoice('confirm_ask', language);
  let budget = READ_BACK_MAX_WORDS - wordCount(ask) - head.reduce((s, p) => s + wordCount(p), 0);
  const body: string[] = [];
  const add = (sentence: string | null): void => {
    if (!sentence) return;
    const w = wordCount(sentence);
    if (w > budget) return;
    body.push(sentence);
    budget -= w;
  };
  /** As many items as fit, in order, in the list's sentence; null when none fits. */
  const list = (
    key: 'readback_work' | 'readback_deliveries',
    items: readonly string[],
  ): string | null => {
    const kept: string[] = [];
    let best: string | null = null;
    for (const item of items) {
      if (item.length > READ_BACK_ITEM_MAX) break;
      const candidate = renderVoice(key, language, { items: [...kept, item].join(', ') });
      if (wordCount(candidate) > budget) break;
      kept.push(item);
      best = candidate;
    }
    return best;
  };
  const sameLanguage = data.reportLanguage === language;

  const work = data.workPerformed.map((w) => {
    const area = w.area.trim();
    const activity = w.activity.trim();
    const item = area ? `${area} ${lowerFirst(activity, language)}` : activity;
    if (w.percentComplete !== undefined && w.status !== 'complete')
      return renderVoice('readback_work_percent', language, {
        item,
        percent: n(w.percentComplete),
      });
    if (w.status === 'complete') return renderVoice('readback_work_complete', language, { item });
    return item;
  });
  if (work.length > 0)
    add(
      sameLanguage
        ? list('readback_work', work)
        : renderVoice('readback_work_count', language, { count: n(work.length) }),
    );

  const deliveries = data.deliveries.map((d) => {
    const quantity = d.quantity?.trim();
    const supplier = d.supplier?.trim();
    const item = quantity
      ? renderVoice('readback_delivery_quantity', language, {
          quantity,
          item: lowerFirst(d.item.trim(), language),
        })
      : d.item.trim();
    return supplier ? renderVoice('readback_delivery_from', language, { item, supplier }) : item;
  });
  if (deliveries.length > 0)
    add(
      sameLanguage
        ? list('readback_deliveries', deliveries)
        : renderVoice('readback_deliveries_count', language, { count: n(deliveries.length) }),
    );

  const safety: string[] = [];
  if (data.safety.toolboxTalk?.trim()) safety.push(renderVoice('readback_toolbox', language));
  const incidents = data.safety.incidents.length;
  if (incidents === 1) safety.push(renderVoice('readback_incident_one', language));
  else if (incidents > 1)
    safety.push(renderVoice('readback_incidents', language, { count: n(incidents) }));
  else if (data.safety.noIncidentsStated)
    safety.push(renderVoice('readback_no_incidents', language));
  if (safety.length > 0) add(safety.join(' '));

  return [...head, ...body, ask].join(' ');
}

/**
 * F8 on a call (§9.4 rule 5: "read back only the changed part and ask again"): the changed lines
 * of a correction as the agent says them, in the call language, from code's numbers (the
 * preview's `CorrectionChange`, new values only): a crew as F7's confirmation ("Apex Concrete: 7
 * workers, 8 hours each — 56 hours."), a crew taken off, the weather's lost hours, or another
 * section by its name ("Changed: Delivered."). Pure.
 */
export function voiceCorrectionLines(
  changes: readonly CorrectionChange[],
  language: Language,
): string[] {
  const n = (x: number) => voiceNumber(x, language);
  return changes.map((c) => {
    switch (c.kind) {
      case 'crew': {
        if (c.change === 'removed')
          return renderVoice('correction_crew_removed', language, { company: c.company });
        const [, workers] = c.workers;
        const [, each] = c.hoursPerWorker;
        const [, total] = c.totalHours;
        if (workers !== null && each !== null && total !== null)
          return renderVoice('answer_crew', language, {
            company: c.company,
            workers: n(workers),
            hours_each: n(each),
            hours: n(total),
          });
        if (workers !== null)
          return renderVoice('answer_crew_workers', language, {
            company: c.company,
            workers: n(workers),
          });
        return renderVoice('readback_change', language, { change: c.company });
      }
      case 'lost_hours': {
        const lost = c.lostHours[1] ?? 0;
        return lost > 0
          ? renderVoice('answer_weather', language, { hours: n(lost) })
          : renderVoice('answer_no_stoppage', language);
      }
      case 'section':
        return renderVoice('readback_change', language, {
          change: SECTION_NAMES[language][c.section],
        });
    }
  });
}

/** The draft's section names as the field app's fix preview says them (EN/ES/TR UI copy). */
const SECTION_NAMES: Readonly<Record<Language, Readonly<Record<CorrectionSection, string>>>> = {
  en: uiEn.field.draft.fix.sections,
  es: uiEs.field.draft.fix.sections,
  tr: uiTr.field.draft.fix.sections,
};

/**
 * A call's draft state (`VoiceDraftStateSchema`) built by code from what is stored: what
 * field-api answers when `file_report` names a revision the draft has left (`draft_changed`,
 * §19 Q119), so the agent reads back the draft as it is now. The call's open question when there
 * is one (spoken as `spokenQuestion` words it), else the read-back of a draft awaiting
 * confirmation; `missing` is code's validation with the org's required fields, the photo left out
 * (never asked on a call), as the worker's `voice_turn` answers it. Pure.
 */
export function voiceDraftStateOf(input: {
  reportId: string;
  draftRev: number;
  data: DailyReportData;
  /** `org_settings.required_fields` (unknown keys are ignored). */
  requiredFields: readonly string[];
  /** The open question this call asked, if any. */
  question: { id: string; prompt: string; options: Array<{ id: string; label: string }> } | null;
  /** Whether the report awaits confirmation (a read-back is due). */
  awaitingConfirmation: boolean;
  language: Language;
}): VoiceDraftState {
  const known = new Set<string>(REQUIRED_FIELD_KEYS);
  const required = callRequiredFields(
    input.requiredFields.filter((f): f is RequiredFieldKey => known.has(f)),
  );
  const missing = validateReport(input.data, { requiredFields: required })
    .missingRequired.slice(0, 20)
    .map((m) => m.slice(0, 100));
  return {
    reportId: input.reportId,
    draftRev: input.draftRev,
    missing,
    question: input.question ? { id: input.question.id, ...spokenQuestion(input.question) } : null,
    readBack:
      !input.question && input.awaitingConfirmation ? readBack(input.data, input.language) : null,
  };
}
