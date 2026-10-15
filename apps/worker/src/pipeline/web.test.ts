import { describe, expect, it } from 'vitest';
import type { QuestionRow } from '@sitelog/shared';
import { loadFixture } from '../ai/eval';
import { validateDraft } from './validate';
import {
  DEVICE_ACTIVE_MS,
  deviceActive,
  planWebNext,
  reapplyAnswers,
  withReportPhotos,
} from './web';

const hero = loadFixture('riverside-2026-10-09');
const REQUIRED = { required_fields: hero.input.requiredFields };
const SETTINGS = { max_questions_per_report: 3 };

function question(over: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q1',
    report_id: 'r1',
    field: 'manpower.workers',
    target: {
      manpowerIndex: 2,
      companyName: 'Delta Mechanical',
      path: 'manpower.workers:Delta Mechanical',
    },
    prompt: 'How many?',
    options: [],
    asked_message_id: null,
    answered_message_id: null,
    answer: null,
    asked_at: '2026-10-09T22:40:00Z',
    answered_at: null,
    created_at: '2026-10-09T22:40:00Z',
    channel: 'web',
    call_id: null,
    answer_source: null,
    ...over,
  };
}

describe('D25: the 30 s device rule', () => {
  const now = new Date('2026-10-09T22:40:00Z');
  it('is active within 30 s of the last call, not at 30 s or without a device', () => {
    expect(deviceActive(new Date(now.getTime() - 29_999).toISOString(), now)).toBe(true);
    expect(deviceActive(new Date(now.getTime() - DEVICE_ACTIVE_MS).toISOString(), now)).toBe(false);
    expect(deviceActive(null, now)).toBe(false);
    expect(DEVICE_ACTIVE_MS).toBe(30_000);
  });
});

describe('planWebNext (decide_next, pure)', () => {
  const data = hero.expected;
  const validation = validateDraft(data, REQUIRED, 2);

  it('asks the Delta headcount first, with the model options, in the reporter language', () => {
    const plan = planWebNext({
      data,
      validation,
      questions: [],
      settings: SETTINGS,
      companies: [],
      language: 'es-US',
    });
    expect(plan).toMatchObject({
      kind: 'ask',
      resolve: null,
      spec: { field: 'manpower.workers', path: 'manpower.workers:Delta Mechanical' },
    });
    if (plan.kind === 'ask')
      expect(plan.spec.options.map((o) => o.label)).toEqual(['4 · full day', '5 · full day']);
  });

  it('waits while the open question still asks for its gap', () => {
    const open = question();
    expect(
      planWebNext({
        data,
        validation,
        questions: [open],
        settings: SETTINGS,
        companies: [],
        language: null,
      }),
    ).toEqual({ kind: 'wait', question: open });
  });

  it('resolves an open question a re-extraction answered and shows the draft', () => {
    const answered = structuredClone(data);
    answered.manpower[2]!.workers = 5;
    answered.manpower[2]!.totalHours = 40;
    const v = validateDraft(answered, REQUIRED, 2);
    expect(
      planWebNext({
        data: answered,
        validation: v,
        questions: [question()],
        settings: SETTINGS,
        companies: [],
        language: null,
      }),
    ).toEqual({ kind: 'draft', resolve: 'q1' });
  });

  it('shows the draft once the limit of questions is reached', () => {
    const asked = [1, 2, 3].map((n) =>
      question({
        id: `q${n}`,
        answered_at: '2026-10-09T22:41:00Z',
        target: { path: `other:${n}` },
      }),
    );
    expect(
      planWebNext({
        data,
        validation,
        questions: asked,
        settings: SETTINGS,
        companies: [],
        language: null,
      }),
    ).toEqual({ kind: 'draft', resolve: null });
  });
});

describe('reapplyAnswers (a re-extraction keeps the reporter’s answers)', () => {
  it('applies a stored answer again where its gap is back, finding the crew by name', () => {
    const data = structuredClone(hero.expected);
    // The new extraction lists Delta first.
    const [delta] = data.manpower.splice(2, 1);
    data.manpower.unshift(delta!);
    const gaps = new Set(validateDraft(data, REQUIRED, 2).gaps.map((g) => g.path));
    const q = question({
      answered_at: '2026-10-09T22:41:00Z',
      answer: {
        optionId: 'o2',
        text: '5 · full day',
        parsed: { workers: 5, fullDay: true },
        via: 'web',
      },
    });
    const { data: out, reapplied } = reapplyAnswers(data, [q], gaps, {
      defaultShiftHours: 8,
      workingHours: '07:00–15:30',
    });
    expect(reapplied).toEqual(['q1']);
    expect(out.manpower[0]).toMatchObject({
      companyName: 'Delta Mechanical',
      workers: 5,
      totalHours: 40,
    });
    expect(out.manpower[0]!.source.at(-1)).toEqual({ type: 'answer', questionId: 'q1' });
    // A gap the new draft does not have, an unanswered or a resolved question: nothing applied.
    expect(
      reapplyAnswers(out, [q], new Set(), { defaultShiftHours: 8, workingHours: null }).reapplied,
    ).toEqual([]);
    expect(
      reapplyAnswers(
        data,
        [question({ answered_at: '2026-10-09T22:41:00Z', answer: { resolved_by: 'extraction' } })],
        gaps,
        {
          defaultShiftHours: 8,
          workingHours: null,
        },
      ).reapplied,
    ).toEqual([]);
  });
});

describe('withReportPhotos', () => {
  it('appends the report photos the draft does not list, keyed by upload id', () => {
    const data = { ...hero.expected, photos: [hero.expected.photos[0]!] };
    const now = new Date('2026-10-09T22:45:00Z');
    const out = withReportPhotos(
      data,
      [
        {
          kind: 'photo',
          upload_id: hero.expected.photos[0]!.uploadId,
          message_id: null,
          caption: null,
          taken_at: null,
        },
        {
          kind: 'photo',
          upload_id: 'u-new',
          message_id: null,
          caption: 'L5 rebar',
          taken_at: null,
        },
        {
          kind: 'voice_note',
          upload_id: 'u-voice',
          message_id: null,
          caption: null,
          taken_at: null,
        },
      ],
      now,
    );
    expect(out!.photos).toEqual([
      hero.expected.photos[0],
      { uploadId: 'u-new', caption: 'L5 rebar', takenAt: now.toISOString() },
    ]);
    expect(withReportPhotos(out!, [], now)).toBeNull();
  });
});
