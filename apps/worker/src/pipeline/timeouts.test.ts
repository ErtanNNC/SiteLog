import { describe, expect, it } from 'vitest';
import {
  ANSWER_TIMEOUT_MS,
  AUTO_FILE_MS,
  CONFIRM_FILE_MS,
  CONFIRM_NUDGE_MS,
  TIMEOUT_POLICY_DEFAULTS,
  answerTimedOut,
  answerTimeoutAt,
  autoFiles,
  confirmationSchedule,
  dueConfirmationStep,
} from './timeouts';

const shownAt = new Date('2026-10-13T18:00:00Z');
const at = (ms: number) => new Date(shownAt.getTime() + ms);

describe('§7.2 timeouts (W2-07, the channel-neutral module)', () => {
  it('keeps the spec’s numbers: 60 min, 30 min, 2 h, 15 min', () => {
    expect([ANSWER_TIMEOUT_MS, CONFIRM_NUDGE_MS, CONFIRM_FILE_MS, AUTO_FILE_MS]).toEqual([
      3_600_000, 1_800_000, 7_200_000, 900_000,
    ]);
  });

  it('times a question out at asked + 60 min, not a millisecond before', () => {
    expect(answerTimeoutAt(shownAt)).toEqual(at(ANSWER_TIMEOUT_MS));
    expect(answerTimedOut(shownAt, at(ANSWER_TIMEOUT_MS - 1))).toBe(false);
    expect(answerTimedOut(shownAt, at(ANSWER_TIMEOUT_MS))).toBe(true);
  });

  it('schedules the nudge at +30 min and the `timeout` filing at +2 h (the reporter confirms, Q11)', () => {
    for (const mode of ['confirm', null, undefined] as const) {
      expect(confirmationSchedule(shownAt, mode)).toEqual([
        { kind: 'nudge', at: at(CONFIRM_NUDGE_MS) },
        { kind: 'file', at: at(CONFIRM_FILE_MS), trigger: 'timeout' },
      ]);
    }
    expect(autoFiles('confirm')).toBe(false);
  });

  it('auto_15min files at +15 min with trigger `auto` and no nudge', () => {
    expect(autoFiles('auto_15min')).toBe(true);
    expect(confirmationSchedule(shownAt, 'auto_15min')).toEqual([
      { kind: 'file', at: at(AUTO_FILE_MS), trigger: 'auto' },
    ]);
  });

  it('answers the sweep: nothing, then the nudge once, then the filing (even with no nudge sent)', () => {
    const due = (ms: number, nudged = false, filingMode: 'confirm' | 'auto_15min' = 'confirm') =>
      dueConfirmationStep({ shownAt, now: at(ms), filingMode, nudged });
    expect(due(CONFIRM_NUDGE_MS - 1)).toBeNull();
    expect(due(CONFIRM_NUDGE_MS)).toMatchObject({ kind: 'nudge' });
    expect(due(CONFIRM_NUDGE_MS, true)).toBeNull();
    expect(due(CONFIRM_FILE_MS - 1, true)).toBeNull();
    expect(due(CONFIRM_FILE_MS, false)).toMatchObject({ kind: 'file', trigger: 'timeout' });
    expect(due(AUTO_FILE_MS - 1, false, 'auto_15min')).toBeNull();
    expect(due(AUTO_FILE_MS, false, 'auto_15min')).toMatchObject({ kind: 'file', trigger: 'auto' });
  });

  it('re-sends `draft_ready` as the nudge until spec §19 Q78 is answered', () => {
    expect(TIMEOUT_POLICY_DEFAULTS).toEqual({ nudgeKey: 'draft_ready' });
  });
});
