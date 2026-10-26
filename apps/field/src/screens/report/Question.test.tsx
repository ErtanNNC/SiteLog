import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerResponse } from '@sitelog/shared/field-contract.ts';
import { i18n } from '@/i18n/i18n';
import { apiError, demoSession, fakeRoutes, renderApp } from '@/test/render';
import { fakeMediaRecorderDepsFor } from '@/screens/record/test-helpers';
import { OtherSheet } from './OtherSheet';
import { draftView, QUESTION_ID, questionView, reportView } from './test-views';

const answered: AnswerResponse = {
  status: 'processing',
  reportStatus: 'processing',
  confirmation: {
    kind: 'crew',
    company: 'Delta Mechanical',
    workers: 5,
    hoursPerWorker: 8,
    totalHours: 40,
  },
};

describe('Question (F7, Field-05)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(async () => {
    vi.useRealTimers();
    await act(() => i18n.changeLanguage('en'));
  });

  it('shows one question with its two answers, then the confirmation line and the draft', async () => {
    const routes = fakeRoutes({
      report: vi
        .fn()
        .mockResolvedValueOnce(questionView())
        // The poll right after the answer may still see the question: the screen waits.
        .mockResolvedValueOnce(questionView())
        .mockResolvedValue(draftView()),
      answer: vi.fn().mockResolvedValue(answered),
    });
    renderApp('/report/r1', { routes });

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'You said “the Delta guys” were on Level 2. How many, and for how long?',
    });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('banner')).toHaveTextContent('Riverside Lofts — Block B');
    expect(screen.getByText('Quick check')).toBeInTheDocument();
    expect(screen.getByText('Heard at 1:20 in your note')).toBeInTheDocument();
    // What is done so far (no crew count: the crew is the question).
    const progress = screen.getByRole('region', { name: 'Writing your report' });
    expect(progress).toHaveTextContent('Transcribed, site noise removed');
    expect(progress).toHaveTextContent('Rain 07:00–10:30 logged as delay');
    expect(
      screen.getByText('You can close this — I’ll text you when the draft is ready.'),
    ).toBeInTheDocument();
    // Two answers and Other — say it (W2-09), no polling while it is the reporter's turn.
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      '4 · full day',
      '5 · full day',
      'Other — say it',
    ]);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '5 · full day' }));
    expect(routes.answer).toHaveBeenCalledWith('K7Q2MX', 'r1', {
      questionId: QUESTION_ID,
      optionId: 'o2',
    });
    // F7's line, then Processing while decide_next runs, then the draft.
    expect(
      await screen.findByText('Delta Mechanical: 5 workers, 8 hours each — 40 hours.'),
    ).toHaveAttribute('role', 'status');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Writing your report…' }),
    ).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check today’s report' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Delta Mechanical: 5 workers, 8 hours each — 40 hours.'),
    ).toBeInTheDocument();
  });

  it('asks for the number when the question has no answers to tap (D28), full day by default', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValueOnce(questionView('none')).mockResolvedValue(reportView()),
      answer: vi.fn().mockResolvedValue(answered),
    });
    renderApp('/report/r1', { routes });
    const workers = await screen.findByLabelText('Workers');
    expect(workers).toHaveAttribute('inputmode', 'numeric');
    const group = screen.getByRole('group', { name: 'For how long?' });
    expect(within(group).getByRole('radio', { name: 'Full day' })).toBeChecked();

    // Not a whole number: refused here, nothing sent.
    fireEvent.change(workers, { target: { value: '4.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(screen.getByText('Enter a number.')).toBeInTheDocument();
    expect(workers).toHaveAttribute('aria-invalid', 'true');
    expect(routes.answer).not.toHaveBeenCalled();

    fireEvent.change(workers, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(routes.answer).toHaveBeenLastCalledWith('K7Q2MX', 'r1', {
      questionId: QUESTION_ID,
      value: 5,
      hours: 'full_day',
    });
  });

  it('sends the hours the reporter set, with a decimal comma', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValueOnce(questionView('none')).mockResolvedValue(reportView()),
      answer: vi.fn().mockResolvedValue(answered),
    });
    renderApp('/report/r1', { routes });
    fireEvent.change(await screen.findByLabelText('Workers'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Other hours' }));
    fireEvent.change(screen.getByLabelText('Hours each'), { target: { value: '6,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(routes.answer).toHaveBeenCalledWith('K7Q2MX', 'r1', {
      questionId: QUESTION_ID,
      value: 4,
      hours: 6.5,
    });
  });

  it('shows the latest view when the question was answered elsewhere', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValueOnce(questionView()).mockResolvedValue(draftView()),
      answer: vi.fn().mockRejectedValue(apiError(409, 'question_closed')),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: '4 · full day' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That question was already answered. Here is the latest.',
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check today’s report' }),
    ).toBeInTheDocument();
  });

  it('keeps the question and says so when the answer did not go through', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(questionView()),
      answer: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(apiError(400, 'answer_not_accepted')),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: '5 · full day' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No connection.');
    fireEvent.click(screen.getByRole('button', { name: '5 · full day' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('That answer didn’t work. Try again.'),
    );
    expect(screen.getByRole('button', { name: '5 · full day' })).toBeEnabled();
  });

  it('sends the phone through the link when field-api no longer takes it', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValue(questionView()),
      answer: vi.fn().mockRejectedValue(apiError(401, 'device_unverified')),
      resolve: vi.fn(() => new Promise<never>(() => undefined)),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: '5 · full day' }));
    await waitFor(() => expect(routes.resolve).toHaveBeenCalledWith('K7Q2MX'));
  });

  it('speaks Spanish and Turkish', async () => {
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(questionView('none')) });
    const as = (locale: 'tr-TR' | 'es-US') =>
      demoSession({ reporter: { ...demoSession().reporter, locale } });
    await act(() => i18n.changeLanguage('tr'));
    const { unmount } = renderApp('/report/r1', { routes, session: as('tr-TR') });
    expect(await screen.findByLabelText('Çalışan')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Tam gün' })).toBeChecked();
    expect(screen.getByText('Notunuzun 1:20 anında duyuldu')).toBeInTheDocument();
    unmount();
    await act(() => i18n.changeLanguage('es'));
    renderApp('/report/r1', { routes, session: as('es-US') });
    expect(await screen.findByLabelText('Trabajadores')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar respuesta' })).toBeInTheDocument();
  });
});

describe('Other… (F7, W2-09)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(async () => {
    vi.useRealTimers();
    await act(() => i18n.changeLanguage('en'));
  });

  const listening = () => {
    const v = questionView();
    return {
      ...v,
      question: { ...v.question!, voice: { state: 'listening' as const, unclear: 0 } },
    };
  };
  const retry = () => {
    const v = questionView();
    return { ...v, question: { ...v.question!, voice: { state: 'retry' as const, unclear: 1 } } };
  };

  it('polls while the answer is listened to; the retry says so and keeps the answers', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValueOnce(listening()).mockResolvedValue(retry()),
    });
    renderApp('/report/r1', { routes });
    expect(await screen.findByText('Listening to your answer…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4 · full day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Other — say it' })).toBeDisabled();
    // The worker has it: the screen polls until it settles.
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    expect(routes.report).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText('I didn’t catch that. Say it again, or pick an answer.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4 · full day' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Other — say it' })).toBeEnabled();
    // The reporter's turn again: no more polling.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(routes.report).toHaveBeenCalledTimes(2);
  });

  it('opens the sheet: say it, or type the number of a number field', async () => {
    const routes = fakeRoutes({
      report: vi.fn().mockResolvedValueOnce(questionView()).mockResolvedValue(draftView()),
      answer: vi.fn().mockResolvedValue(answered),
    });
    renderApp('/report/r1', { routes });
    fireEvent.click(await screen.findByRole('button', { name: 'Other — say it' }));
    const sheet = await screen.findByRole('dialog', { name: 'Say your answer' });
    expect(within(sheet).getByRole('button', { name: 'Record your answer' })).toBeInTheDocument();
    expect(
      within(sheet).getByText('Up to 30 seconds. Nothing else is recorded.'),
    ).toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText('Workers'), { target: { value: '6' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send answer' }));
    await waitFor(() =>
      expect(routes.answer).toHaveBeenCalledWith('K7Q2MX', 'r1', {
        questionId: QUESTION_ID,
        value: 6,
        hours: 'full_day',
      }),
    );
  });

  it('the sheet records at most 30 seconds and hands the clip over; no microphone: says so', async () => {
    const h = fakeMediaRecorderDepsFor();
    const onSay = vi.fn();
    const { unmount } = render(
      <OtherSheet
        open
        prompt="How many?"
        typed={null}
        onSay={onSay}
        onClose={() => undefined}
        recorderDeps={h.deps}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record your answer' }));
    expect(await screen.findByRole('button', { name: 'Stop & send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    act(() => h.tick(31_000));
    await waitFor(() =>
      expect(onSay).toHaveBeenCalledWith(
        expect.objectContaining({ mime: expect.stringMatching(/^audio\//) }),
      ),
    );
    unmount();

    const denied = fakeMediaRecorderDepsFor({
      getUserMedia: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))),
    });
    render(
      <OtherSheet
        open
        prompt="How many?"
        typed={null}
        onSay={vi.fn()}
        onClose={() => undefined}
        recorderDeps={denied.deps}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record your answer' }));
    expect(
      await screen.findByText(
        'The microphone is off. Allow it in your phone’s settings, or pick an answer.',
      ),
    ).toBeInTheDocument();
  });

  it('after a spoken answer applied, F7’s line from the worker’s numbers', async () => {
    const applied = draftView({
      lastVoiceAnswer: {
        questionId: QUESTION_ID,
        outcome: 'applied',
        confirmation: answered.confirmation!,
      },
    });
    const routes = fakeRoutes({ report: vi.fn().mockResolvedValue(applied) });
    renderApp('/report/r1', { routes });
    // Not this phone's answer (no clip sent from here): no line.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check today’s report' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Delta Mechanical: 5 workers, 8 hours each — 40 hours.')).toBeNull();
  });
});
