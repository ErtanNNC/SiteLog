import { uiEn } from '../copy/ui/en.ts';
import { uiEs } from '../copy/ui/es.ts';
import { uiTr } from '../copy/ui/tr.ts';
import type { Language } from '../locale.ts';
import type { CorrectionChange } from './correction.ts';

/**
 * F10 (W2-11): the words of a change of a filed report, from the preview's lines (code's numbers,
 * `CorrectionChange`), never the model's own note: the version's change note (the report language:
 * the panel's history, the "Updated" email, the PDF) and `{change}` of the reporter's
 * `edit_applied` text (their language). The same wording as the preview the reporter saved (the
 * field app's `draft.fix.lines`, EN/ES/TR). For a text (`sms`), the arrow and the dash become
 * GSM-7 characters (spec §19 Q15: producers of `{change}` use GSM-7 punctuation). Pure.
 */

const FIX = { en: uiEn, es: uiEs, tr: uiTr } as const;

/** Change notes and texts stay short: the panel's list, the email subject line, one SMS. */
export const CHANGE_NOTE_MAX = 200;

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

function num(n: number | null, language: Language): string {
  if (n === null) return '—';
  const v = String(Math.round(n * 100) / 100);
  return language === 'tr' ? v.replace('.', ',') : v;
}

/** "Apex Concrete 6 → 7 workers, 48 → 56 h" (one preview line). */
export function correctionChangeLine(change: CorrectionChange, language: Language): string {
  const copy = FIX[language].field.draft.fix;
  const pair = (p: readonly [number | null, number | null]) => ({
    from: num(p[0], language),
    to: num(p[1], language),
  });
  switch (change.kind) {
    case 'crew': {
      if (change.change === 'removed') return fill(copy.lines.removed, { company: change.company });
      if (change.change === 'added') {
        const workers = num(change.workers[1], language);
        const hours = num(change.hoursPerWorker[1], language);
        return fill(copy.lines.added, {
          company: change.company,
          value: `${workers} × ${hours} ${language === 'tr' ? 'sa' : 'h'}`,
        });
      }
      const parts: string[] = [];
      if (change.workers[0] !== change.workers[1])
        parts.push(fill(copy.lines.workers, pair(change.workers)));
      if (change.hoursPerWorker[0] !== change.hoursPerWorker[1])
        parts.push(fill(copy.lines.hoursEach, pair(change.hoursPerWorker)));
      if (change.totalHours[0] !== change.totalHours[1])
        parts.push(fill(copy.lines.total, pair(change.totalHours)));
      return `${change.company} ${parts.join(', ')}`.trim();
    }
    case 'lost_hours':
      return fill(copy.lines.lostHours, pair(change.lostHours));
    case 'section':
      return fill(copy.lines.section, { section: copy.sections[change.section] });
  }
}

/** Only GSM-7 punctuation in a text (§19 Q15): "→" → "->", "×" → "x", "—" → "-", "…" → "...". */
export function gsmPunctuation(text: string): string {
  return text.replace(/→/g, '->').replace(/×/g, 'x').replace(/[—–]/g, '-').replace(/…/g, '...');
}

/**
 * The note of a change: its lines joined with "; ", at most `CHANGE_NOTE_MAX` characters. Null
 * when there are no lines (a preview always has one).
 */
export function correctionNote(
  changes: readonly CorrectionChange[],
  language: Language,
  opts: { sms?: boolean } = {},
): string | null {
  if (changes.length === 0) return null;
  let note = changes.map((c) => correctionChangeLine(c, language)).join('; ');
  if (opts.sms) note = gsmPunctuation(note);
  if (note.length > CHANGE_NOTE_MAX) {
    const ellipsis = opts.sms ? '...' : '…';
    note = `${note.slice(0, CHANGE_NOTE_MAX - ellipsis.length).trimEnd()}${ellipsis}`;
  }
  return note;
}
