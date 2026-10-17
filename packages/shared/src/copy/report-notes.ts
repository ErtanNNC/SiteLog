import type { ReportLanguage } from '../locale.ts';

/**
 * Change notes the system writes on a report version (`report_versions.change_note`), in the
 * report's language (§9.6: the org locale decides it, EN or TR). The office types its own notes;
 * these are the reporter's changes made in code: F9's "2 photos added" (W2-04). The note goes
 * into the "Updated" email and the panel's version history as written.
 */
const PHOTOS_ADDED: Record<ReportLanguage, (count: number) => string> = {
  en: (n) => (n === 1 ? '1 photo added' : `${n} photos added`),
  // Turkish keeps the noun singular after a number.
  tr: (n) => `${n} fotoğraf eklendi`,
};

/** F9: the note of a version that adds `count` photos after filing ("2 photos added"). */
export function photosAddedNote(language: ReportLanguage, count: number): string {
  return (PHOTOS_ADDED[language] ?? PHOTOS_ADDED.en)(count);
}

/** A number of hours in the report's language (`6.5` / `6,5`). */
function hoursText(language: ReportLanguage, n: number): string {
  const v = String(Math.round(n * 100) / 100);
  return language === 'tr' ? v.replace('.', ',') : v;
}

/** The texts of a recorder day-off report (F12, W2-08) in the report language (§9.6: EN or TR). */
export interface DayOffText {
  condition: string;
  conditions: string;
  impactFullDay: string;
  impactStopped: (since: string) => string;
  crew: string;
  crewHeard: string;
  summaryFullDay: (workers: number | null, crewHoursLost: number | null) => string;
  summaryStopped: (
    since: string,
    lostHours: number,
    workers: number | null,
    crewHoursLost: number | null,
  ) => string;
  noWorkSummary: (site: string) => string;
  noWorkConditions: string;
}

const DAY_OFF: Record<ReportLanguage, DayOffText> = {
  en: {
    condition: 'Weather',
    conditions: 'Weather day: site closed',
    impactFullDay: 'Crew did not start; site closed for weather',
    impactStopped: (since) => `Work stopped at ${since}; site closed for weather`,
    crew: 'Site crew',
    crewHeard: 'on site before the stop',
    summaryFullDay: (w, lost) =>
      `Weather day: the crew never started and the site was closed for the day.` +
      (w ? ` ${w} on site; ${hoursText('en', lost ?? 0)} crew-hours lost.` : ''),
    summaryStopped: (since, h, w, lost) =>
      `Weather day: work stopped at ${since} and the site was closed; ${hoursText('en', h)} h lost.` +
      (w ? ` ${w} on site before the stop; ${hoursText('en', lost ?? 0)} crew-hours lost.` : ''),
    noWorkSummary: (site) => `No work at ${site} today.`,
    noWorkConditions: 'Not recorded (no work)',
  },
  tr: {
    condition: 'Hava koşulları',
    conditions: 'Hava muhalefeti: şantiye kapalı',
    impactFullDay: 'Ekip işe başlamadı; şantiye hava nedeniyle kapalı',
    impactStopped: (since) => `İş saat ${since} itibarıyla durdu; şantiye hava nedeniyle kapalı`,
    crew: 'Saha ekibi',
    crewHeard: 'durmadan önce sahadaki ekip',
    summaryFullDay: (w, lost) =>
      `Hava muhalefeti: ekip işe başlamadı, şantiye gün boyu kapalı kaldı.` +
      (w ? ` Sahada ${w} kişi vardı; ${hoursText('tr', lost ?? 0)} adam-saat kayıp.` : ''),
    summaryStopped: (since, h, w, lost) =>
      `Hava muhalefeti: iş saat ${since} itibarıyla durdu, şantiye kapandı; ${hoursText('tr', h)} saat kayıp.` +
      (w
        ? ` Durmadan önce sahada ${w} kişi vardı; ${hoursText('tr', lost ?? 0)} adam-saat kayıp.`
        : ''),
    noWorkSummary: (site) => `${site}: bugün çalışma yapılmadı.`,
    noWorkConditions: 'Kaydedilmedi (çalışma yok)',
  },
};

/** F12 (W2-08): the day-off report's texts in `language` (English for an unknown one). */
export function dayOffText(language: ReportLanguage): DayOffText {
  return DAY_OFF[language] ?? DAY_OFF.en;
}
