import { describe, expect, it } from 'vitest';
import { countSmsSegments } from '../sms/segments.ts';
import { CHANGE_NOTE_MAX, correctionChangeLine, correctionNote } from './correction-note.ts';
import type { CorrectionChange } from './correction.ts';

const APEX: CorrectionChange = {
  kind: 'crew',
  company: 'Apex Concrete',
  change: 'changed',
  workers: [6, 7],
  hoursPerWorker: [8, 8],
  totalHours: [48, 56],
};

describe('correctionNote (W2-11, F10)', () => {
  it('words the preview lines in EN, ES and TR from code’s numbers', () => {
    expect(correctionNote([APEX], 'en')).toBe('Apex Concrete 6 → 7 workers, 48 → 56 h');
    expect(correctionNote([APEX], 'es')).toBe('Apex Concrete 6 → 7 trabajadores, 48 → 56 h');
    expect(correctionNote([APEX], 'tr')).toBe('Apex Concrete 6 → 7 çalışan, 48 → 56 saat');
    const lost: CorrectionChange = { kind: 'lost_hours', lostHours: [2, 3.5] };
    expect(correctionChangeLine(lost, 'tr')).toBe('Hava: 2 → 3,5 saat kayıp');
    expect(correctionNote([APEX, { kind: 'section', section: 'safety' }, lost], 'en')).toBe(
      'Apex Concrete 6 → 7 workers, 48 → 56 h; Safety changed; Weather: 2 → 3.5 h lost',
    );
    expect(
      correctionChangeLine(
        { ...APEX, change: 'added', workers: [null, 3], hoursPerWorker: [null, 8] },
        'en',
      ),
    ).toBe('Added Apex Concrete: 3 × 8 h');
    expect(correctionNote([], 'en')).toBeNull();
  });

  it('a text keeps to GSM-7 punctuation (§19 Q15) and stays short', () => {
    const sms = correctionNote([APEX], 'en', { sms: true })!;
    expect(sms).toBe('Apex Concrete 6 -> 7 workers, 48 -> 56 h');
    expect(countSmsSegments(sms).nonGsm).toEqual([]);
    const many = Array.from({ length: 12 }, () => APEX);
    const long = correctionNote(many, 'en', { sms: true })!;
    expect(long.length).toBe(CHANGE_NOTE_MAX);
    expect(long.endsWith('...')).toBe(true);
  });
});
