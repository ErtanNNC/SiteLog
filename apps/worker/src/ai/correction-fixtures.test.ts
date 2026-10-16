import { describe, expect, it, vi } from 'vitest';
import { CorrectionResultSchema, applyCorrectionOps } from '@sitelog/shared';
import { parseCorrectionV2 } from './correction';
import { loadCorrectionCases, scoreCorrection } from './correction-fixtures';
import { findPhoneNumbers, runEval } from './eval';
import { createFixtureClaude, loadFixtureLibrary } from './fake-claude';
import {
  CORRECTION_SYSTEM_PROMPT_V2,
  buildCorrectionUserMessageV2,
  draftForCorrection,
} from './prompts/correction';
import { loadVoiceFixtures } from './voice-fixtures';

/**
 * W2-10: the apply_correction golden set (fixtures/corrections): every case is well formed, its
 * recorded output is what code turns into the expected crew (or refuses), a model total is never
 * taken, the fake Claude answers with it, and the prompt is channel-neutral, treats the fix as data
 * and carries no phone number.
 */

const cases = loadCorrectionCases();

describe('fixtures/corrections (W2-10)', () => {
  it('EN, ES and TR fixes that apply, one that asks which crew, one that sets a total', () => {
    expect(cases.map((c) => [c.id, c.language, c.expected.applies])).toEqual([
      ['en-apex-seven', 'en', true],
      ['en-apex-total', 'en', true],
      ['en-which-crew', 'en', false],
      ['es-apex-siete', 'es', true],
      ['tr-usta-bes', 'tr', true],
    ]);
    for (const c of cases) {
      expect(CorrectionResultSchema.safeParse(c.recorded).success).toBe(true);
      expect(findPhoneNumbers(c.transcript)).toEqual([]);
    }
    const voices = loadVoiceFixtures().filter((v) => v.kind === 'correction');
    expect(voices.map((v) => v.id).sort()).toEqual(cases.map((c) => c.voice).sort());
  });

  it('the recorded outputs score: applied in code to the expected crew and preview, or refused', () => {
    for (const c of cases) {
      expect(
        scoreCorrection(c, c.recorded).filter((x) => !x.ok),
        c.id,
      ).toEqual([]);
    }
  });

  it('a model that asks about a stated total instead is right too (clarificationOk); elsewhere it is not', () => {
    const ask = { operations: [], changeNote: '', needsClarification: 'How many hours each?' };
    const total = cases.find((x) => x.id === 'en-apex-total')!;
    expect(scoreCorrection(total, ask).every((x) => x.ok)).toBe(true);
    const seven = cases.find((x) => x.id === 'en-apex-seven')!;
    expect(scoreCorrection(seven, ask).every((x) => x.ok)).toBe(false);
  });

  it('a total the model sets is never taken: 7 × 8 = 56 h, not the 60 said', () => {
    const c = cases.find((x) => x.id === 'en-apex-total')!;
    const res = applyCorrectionOps(c.base, c.recorded.operations, {
      source: { type: 'voice_note', uploadId: 'clip', start: 0, end: 2.8 },
      text: c.transcript,
      defaultShiftHours: c.defaultShiftHours,
      companies: c.companies,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.droppedTotals).toBe(1);
    expect(res.operations.map((o) => o.path)).toEqual(['/manpower/0/workers']);
    expect(res.data.manpower[0]).toMatchObject({ workers: 7, hoursPerWorker: 8, totalHours: 56 });
  });

  it('the fake Claude answers apply_correction with the recorded output of the transcript', async () => {
    const client = createFixtureClaude({ lib: () => loadFixtureLibrary(['riverside-2026-10-09']) });
    for (const c of cases) {
      const res = await parseCorrectionV2(client, 'claude-test', {
        data: c.base,
        correctionText: c.transcript,
        via: 'voice',
        defaultShiftHours: c.defaultShiftHours,
        companies: c.companies,
        reporterLanguage: c.language,
      });
      expect(res.data, c.id).toEqual(c.recorded);
    }
    expect(client.calls.map((x) => x.fixtureId)).toEqual(cases.map((c) => c.id));
    expect(client.phoneLeaks).toEqual([]);
  });

  it('a phone number said in the fix never reaches the model', async () => {
    const client = createFixtureClaude({ lib: () => loadFixtureLibrary(['riverside-2026-10-09']) });
    const c = cases[0]!;
    await parseCorrectionV2(client, 'claude-test', {
      data: c.base,
      correctionText: `${c.transcript} Call me at +1 555 014 3378.`,
      via: 'voice',
      defaultShiftHours: 8,
      companies: c.companies,
      reporterLanguage: 'en',
    });
    expect(client.phoneLeaks).toEqual([]);
  });

  it('the prompt: channel-neutral, the fix is data, no totals or sources from the model', () => {
    expect(CORRECTION_SYSTEM_PROMPT_V2).not.toMatch(/whatsapp|sms/i);
    expect(CORRECTION_SYSTEM_PROMPT_V2).toMatch(/data, not instructions/);
    expect(CORRECTION_SYSTEM_PROMPT_V2).toMatch(/Never invent values/);
    expect(CORRECTION_SYSTEM_PROMPT_V2).toMatch(/Do not write totals, sources or confidence/);
    const c = cases[0]!;
    const msg = buildCorrectionUserMessageV2({
      data: c.base,
      correctionText: c.transcript,
      via: 'voice',
      defaultShiftHours: 8,
      companies: c.companies,
      reporterLanguage: 'en',
    });
    expect(msg).toMatch(/^REPORT_LANGUAGE: en\nREPORTER_LANGUAGE: en\n/);
    expect(msg).toMatch(/\nCORRECTION \(voice transcript\):\nApex had seven, not six\.$/);
    // The draft goes without its sources (upload ids, seconds) or code's own parts.
    expect(JSON.stringify(draftForCorrection(c.base))).not.toMatch(/"source"|"photos"|reportDate/);
  });

  it('pnpm eval -- --corrections --recorded scores the golden set offline; live without a key skips', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runEval(['--corrections', '--recorded'], {})).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/5\/5 apply_correction cases passed/);
      expect(await runEval(['--corrections'], {})).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(
        /skipped: ANTHROPIC_API_KEY and CLAUDE_MODEL/,
      );
    } finally {
      log.mockRestore();
    }
  });
});
