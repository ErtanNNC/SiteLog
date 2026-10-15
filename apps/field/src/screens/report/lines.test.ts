import { describe, expect, it } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { fillCopy } from '@sitelog/shared/report/progress.ts';
import type { FieldLanguage } from '@/i18n/language';
import { confirmationLine, crewValue, formatNumberIn, heardAt, parseTypedNumber } from './lines';
import { pollsIn, reportPhase } from './phase';
import { draftView, questionView, reportView } from './test-views';

/** `t` over the shared copy, as `useFieldCopy` reads it. */
function tFor(lang: FieldLanguage) {
  return ((key: string, vars: Record<string, string | number> = {}) => {
    const text = key
      .split('.')
      .reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], UI_RESOURCES[lang].field);
    return fillCopy(text as string, vars);
  }) as Parameters<typeof confirmationLine>[1];
}

const crew = (workers: number | null, hours: number | null, total: number | null) =>
  ({
    kind: 'crew',
    company: 'Delta Mechanical',
    workers,
    hoursPerWorker: hours,
    totalHours: total,
  }) as const;

describe('report screen lines (W1-13)', () => {
  it('words F7’s confirmation line in each language, with code’s numbers', () => {
    expect(confirmationLine(crew(5, 8, 40), tFor('en'), 'en')).toBe(
      'Delta Mechanical: 5 workers, 8 hours each — 40 hours.',
    );
    expect(confirmationLine(crew(4, 6.5, 26), tFor('tr'), 'tr')).toBe(
      'Delta Mechanical: 4 çalışan, kişi başı 6,5 saat — toplam 26 saat.',
    );
    expect(confirmationLine(crew(5, 8, 40), tFor('es'), 'es')).toBe(
      'Delta Mechanical: 5 trabajadores, 8 horas cada uno — 40 horas.',
    );
    expect(confirmationLine(crew(1, 8, 8), tFor('en'), 'en')).toBe(
      'Delta Mechanical: 1 worker, 8 hours.',
    );
    expect(confirmationLine(crew(3, null, null), tFor('en'), 'en')).toBe(
      'Delta Mechanical: 3 workers.',
    );
    expect(confirmationLine(crew(null, 4, null), tFor('en'), 'en')).toBe(
      'Delta Mechanical: 4 hours each.',
    );
    expect(confirmationLine(crew(null, null, null), tFor('en'), 'en')).toBe('Got it.');
    expect(confirmationLine({ kind: 'weather', lostHours: 3.5 }, tFor('en'), 'en')).toBe(
      'Weather: 3.5 hours lost.',
    );
    expect(confirmationLine({ kind: 'weather', lostHours: 0 }, tFor('en'), 'en')).toBe(
      'Weather: no time lost.',
    );
    expect(confirmationLine({ kind: 'company_added', company: 'Ridgeway' }, tFor('en'), 'en')).toBe(
      'Ridgeway added for the office to confirm.',
    );
    expect(confirmationLine({ kind: 'noted' }, tFor('es'), 'es')).toBe('Entendido.');
  });

  it('finds the second the crew was heard, and shows unknown numbers as unknown', () => {
    expect(heardAt(questionView())).toBe('1:20');
    expect(
      heardAt({
        ...questionView(),
        question: { ...questionView().question!, manpowerIndex: null },
      }),
    ).toBeNull();
    expect(crewValue({ workers: null, hoursPerWorker: 8 }, 'en')).toBe('— × 8 h');
    expect(crewValue({ workers: 5, hoursPerWorker: 7.5 }, 'tr')).toBe('5 × 7,5 sa');
    expect(crewValue({ workers: 5, hoursPerWorker: null }, 'en')).toBe('5 × —');
    expect(formatNumberIn(1804, 'en')).toBe('1804');
  });

  it('reads a typed number with a dot or a comma, whole for a headcount', () => {
    expect(parseTypedNumber(' 5 ', { integer: true, max: 9999 })).toBe(5);
    expect(parseTypedNumber('4.5', { integer: true, max: 9999 })).toBeNull();
    expect(parseTypedNumber('6,5', { integer: false, max: 24 })).toBe(6.5);
    expect(parseTypedNumber('25', { integer: false, max: 24 })).toBeNull();
    expect(parseTypedNumber('-1', { integer: false, max: 24 })).toBeNull();
    expect(parseTypedNumber('', { integer: true, max: 9999 })).toBeNull();
    expect(parseTypedNumber('5 people', { integer: true, max: 9999 })).toBeNull();
  });

  it('picks the phase from the view and what this phone did, polling only for the worker', () => {
    const none = { answered: new Set<string>(), filing: false };
    expect(reportPhase(null, none)).toBe('processing');
    expect(reportPhase(reportView(), none)).toBe('processing');
    expect(reportPhase(questionView(), none)).toBe('question');
    expect(
      reportPhase(questionView(), { ...none, answered: new Set([questionView().question!.id]) }),
    ).toBe('processing');
    expect(reportPhase(reportView({ status: 'awaiting_answer' }), none)).toBe('processing');
    expect(reportPhase(draftView(), none)).toBe('draft');
    expect(reportPhase(draftView(), { ...none, filing: true })).toBe('filing');
    expect(reportPhase(reportView({ status: 'awaiting_confirmation' }), none)).toBe('ready');
    expect(reportPhase(reportView({ status: 'signed_off' }), none)).toBe('filed');
    expect(reportPhase(reportView({ status: 'void' }), none)).toBe('gone');
    expect(
      (['processing', 'question', 'draft', 'filing', 'filed', 'ready', 'gone'] as const).filter(
        pollsIn,
      ),
    ).toEqual(['processing', 'filing']);
  });
});
