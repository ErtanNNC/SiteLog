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
