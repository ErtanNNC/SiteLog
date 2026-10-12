import { copy } from '@/copy/en';
import type { ChatMessage } from './engine';

const t = copy.try;

/** Copy for a simulator note (the engine only names the note and its parameters). */
export function noteText(n: NonNullable<ChatMessage['note']>): string {
  const p = n.params;
  switch (n.key) {
    case 'intro':
      return [
        t.notes.intro(p.first ?? '', p.name ?? '', p.site ?? '', p.kind === 'text'),
        p.late ? t.notes.introLate(p.clock ?? '', p.deadline ?? '') : '',
        p.replaces ? t.notes.introReplaces(p.replaces) : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'replaced':
      return t.notes.replaced(p.site ?? '', p.reportNo ?? '');
    case 'unsupported_answer':
      return t.notes.unsupported_answer(p.prompt ?? '', p.field ?? '');
    case 'voice_busy':
      return t.notes.voice_busy(p.first ?? '');
    case 'edit_other_day':
      return t.notes.edit_other_day(p.weekday ?? '', !!p.example);
    default:
      return t.notes[n.key];
  }
}
