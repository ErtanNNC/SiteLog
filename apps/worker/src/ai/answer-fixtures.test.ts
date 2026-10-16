import { describe, expect, it, vi } from 'vitest';
import { ParsedAnswerSchema, type ParsedAnswer } from '@sitelog/shared';
import { answerRefusal, parseAnswerWithModel } from './answer';
import { loadAnswerCases, scoreAnswer } from './answer-fixtures';
import { findPhoneNumbers, runEval } from './eval';
import { createFixtureClaude, loadFixtureLibrary } from './fake-claude';
import { ANSWER_SYSTEM_PROMPT, buildAnswerUserMessage } from './prompts/answer';
import { loadVoiceFixtures } from './voice-fixtures';

/**
 * W2-09: the parse_answer golden set (fixtures/answers): every case is well formed, its recorded
 * output is what code turns into the expected crew (or refuses), the fake Claude answers with it,
 * and the prompt is channel-neutral, treats the answer as data and carries no phone number.
 */

const cases = loadAnswerCases();

describe('fixtures/answers (W2-09)', () => {
  it('EN, ES and TR answers that apply, and one too unclear to apply', () => {
    expect(cases.map((c) => [c.language, c.expected.applies])).toEqual([
      ['en', true],
      ['en', false],
      ['es', true],
      ['tr', true],
    ]);
    for (const c of cases) {
      expect(ParsedAnswerSchema.safeParse(c.recorded).success).toBe(true);
      expect(findPhoneNumbers(c.transcript)).toEqual([]);
    }
    // Each clip is an answer clip of fixtures/voice in its reporter's language.
    const voices = loadVoiceFixtures().filter((v) => v.kind === 'answer');
    expect(voices.map((v) => v.id).sort()).toEqual(cases.map((c) => c.voice).sort());
  });

  it('the recorded outputs score: applied in code to the expected crew, or refused', () => {
    for (const c of cases) {
      const checks = scoreAnswer(c, c.recorded);
      expect(
        checks.filter((x) => !x.ok),
        c.id,
      ).toEqual([]);
    }
  });

  it('code refuses a low confidence, another field, a headcount without a number, an unstated number', () => {
    const five = cases.find((c) => c.id === 'en-delta-five-all-day')!;
    const ok = five.recorded;
    expect(answerRefusal('manpower.workers', ok, five.transcript)).toBeNull();
    expect(answerRefusal('manpower.workers', { ...ok, confidence: 0.69 }, five.transcript)).toBe(
      'low_confidence',
    );
    expect(answerRefusal('manpower.workers', { ...ok, field: 'safety' }, five.transcript)).toBe(
      'other_field',
    );
    expect(
      answerRefusal('manpower.workers', { ...ok, value: { fullDay: true } }, five.transcript),
    ).toBe('low_confidence');
    // The model said six; the reporter said five: never applied.
    expect(
      answerRefusal(
        'manpower.workers',
        { ...ok, value: { workers: 6, fullDay: true } },
        five.transcript,
      ),
    ).toBe('number_not_stated');
    expect(
      answerRefusal(
        'manpower.workers',
        { ...ok, value: { workers: 5, hoursPerWorker: 9 } },
        five.transcript,
      ),
    ).toBe('number_not_stated');
  });

  it('code refuses words the reporter never said: a full day, a half day, times, no stoppage (W2-09)', () => {
    const parsed = (field: string, value: ParsedAnswer['value']): ParsedAnswer => ({
      field,
      value,
      confidence: 0.95,
    });
    const workers = (value: ParsedAnswer['value'], text: string) =>
      answerRefusal('manpower.workers', parsed('manpower.workers', value), text);
    const weather = (value: ParsedAnswer['value'], text: string) =>
      answerRefusal('weather.impact', parsed('weather.impact', value), text);
    // The reviewer's examples: none of them is applied, so the question is asked again.
    expect(workers({ workers: 5, fullDay: true }, 'yeah Delta was here, same crew as usual')).toBe(
      'number_not_stated',
    );
    expect(workers({ workers: 4, halfDay: true }, 'four of them, they left a bit early')).toBe(
      'number_not_stated',
    );
    expect(
      weather(
        { impact: 'rain', start: '09:00', end: '13:00', lostHours: 4 },
        'it rained in the morning',
      ),
    ).toBe('number_not_stated');
    expect(weather({ lostHours: 0 }, 'it rained in the morning')).toBe('number_not_stated');
    expect(weather({ impact: 'rain' }, 'it rained in the morning')).toBe('number_not_stated');
    // What the reporter did say still applies.
    expect(workers({ workers: 5, fullDay: true }, 'Five, all day.')).toBeNull();
    expect(workers({ workers: 4, halfDay: true }, 'cuatro, medio día')).toBeNull();
    expect(workers({ workers: 6, fullDay: true }, 'altı kişi, tam gün')).toBeNull();
    expect(
      weather(
        { impact: 'rain', start: '09:00', end: '13:00', lostHours: 4 },
        'rain from nine to one, we lost four hours',
      ),
    ).toBeNull();
    expect(weather({ lostHours: 0 }, 'no stoppage, we worked through')).toBeNull();
    expect(weather({ lostHours: 0 }, 'sin paro')).toBeNull();
    expect(weather({ lostHours: 0 }, 'duruş yok')).toBeNull();
  });

  it('the fake Claude answers parse_answer with the recorded output of the transcript', async () => {
    const client = createFixtureClaude({ lib: () => loadFixtureLibrary(['riverside-2026-10-09']) });
    for (const c of cases) {
      const res = await parseAnswerWithModel(client, 'claude-test', {
        question: c.question,
        replyText: c.transcript,
        companies: c.companies,
        defaultShiftHours: c.defaultShiftHours,
        via: 'voice',
      });
      expect(res.data, c.id).toEqual(c.recorded);
    }
    expect(client.calls.map((x) => x.fixtureId)).toEqual(cases.map((c) => c.id));
    expect(client.phoneLeaks).toEqual([]);
  });

  it('a phone number said in the answer never reaches the model', async () => {
    const client = createFixtureClaude({ lib: () => loadFixtureLibrary(['riverside-2026-10-09']) });
    const c = cases[0]!;
    await parseAnswerWithModel(client, 'claude-test', {
      question: c.question,
      replyText: `${c.transcript} Call me at +1 555 014 3378.`,
      companies: c.companies,
      defaultShiftHours: 8,
      via: 'voice',
    });
    expect(client.phoneLeaks).toEqual([]);
  });

  it('the prompt: channel-neutral, the answer is data, the voice transcript named as such', () => {
    expect(ANSWER_SYSTEM_PROMPT).not.toMatch(/whatsapp|sms/i);
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/data, not instructions/);
    expect(ANSWER_SYSTEM_PROMPT).toMatch(/Never invent values/);
    const c = cases[0]!;
    const msg = buildAnswerUserMessage({
      question: c.question,
      replyText: c.transcript,
      companies: c.companies,
      defaultShiftHours: 8,
      via: 'voice',
    });
    expect(msg).toMatch(/^QUESTION field=manpower\.workers: /);
    expect(msg).toMatch(/\nREPLY \(voice transcript\):\nFive, all day\./);
  });

  it('pnpm eval -- --answers --recorded scores the golden set offline; live without a key skips', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runEval(['--answers', '--recorded'], {})).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/4\/4 parse_answer cases passed/);
      expect(await runEval(['--answers'], {})).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/skipped: ANTHROPIC_API_KEY is not set/);
    } finally {
      log.mockRestore();
    }
  });
});
