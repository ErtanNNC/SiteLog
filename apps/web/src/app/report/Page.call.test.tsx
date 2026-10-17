import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { V12_ROW_DEFAULTS } from '@sitelog/shared/db/defaults.ts';
import { DemoStore } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
import { rememberLanguage } from '@/i18n/language';
import { renderWithProviders } from '@/test/render';
import ReportDetailPage from './Page';

/**
 * W3-05 · P7 for calls: the call player's two speaker lanes and filter, call evidence (source
 * links, provenance, Activity), the `call_mismatch` banner with both values (§19 Q74, Q123), and
 * a spoken answer's clip played from its answer (§19 Q93). In demo mode, on the §18.1 seed.
 */

vi.mock('@/lib/reportPdf', () => ({
  renderReportDetailPdf: async () => new Blob(['%PDF-1.3'], { type: 'application/pdf' }),
}));

const NORTHGATE = 'NG-2210-0069';

function northgate(store = new DemoStore()) {
  const report = store.data.reports.find((r) => r.report_no === NORTHGATE)!;
  const call = store.data.calls.find((c) => c.report_id === report.id)!;
  return { store, report, call };
}

function render(store: DemoStore, reportId: string) {
  renderWithProviders(<ReportDetailPage />, {
    store,
    route: `/reports/${reportId}`,
    path: '/reports/:reportId',
  });
}

async function turkish() {
  rememberLanguage('tr');
  await act(() => i18n.changeLanguage('tr'));
}

describe('ReportDetailPage: a call with two lanes (W3-05)', () => {
  it('plays Northgate’s call with a site manager lane and an assistant lane', async () => {
    const { store, report } = northgate();
    render(store, report.id);
    const player = await screen.findByTestId('media-player');
    expect(player).toHaveAttribute('data-kind', 'call');
    expect(player).toHaveAttribute('data-lanes', '2');
    expect(within(player).getByTestId('lane-reporter')).toHaveTextContent('Site manager');
    expect(within(player).getByTestId('lane-agent')).toHaveTextContent('SiteLog assistant');
    expect(screen.getByTestId('demo-tones')).toHaveTextContent('Demo recording: tones, no speech');
    expect(screen.getByTestId('provenance')).toHaveTextContent(
      "Reported by Kevin O'Brien · phone call 17:10 (2 min 41 s) · confirmed by voice",
    );
    const activity = screen.getByTestId('activity');
    expect(within(activity).getByText('Call received · 2 min 41 s · filed')).toBeInTheDocument();
  });

  it('filters the speakers: the other lane dims and its lines leave the excerpts and transcript', async () => {
    const { store, report } = northgate();
    render(store, report.id);
    const block = await screen.findByTestId('source-clip');
    const filter = within(block).getByRole('group', { name: 'Speaker' });
    expect(within(filter).getByRole('button', { name: 'Both' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Both: the assistant's opening (muted) before the first quote, and the quote.
    expect(within(block).getByText(/Hi Kevin, this is the SiteLog assistant/)).toBeInTheDocument();
    expect(within(block).getByText(/Apex, 3 guys, 8 hours/)).toBeInTheDocument();

    await userEvent.click(within(filter).getByRole('button', { name: 'Site manager' }));
    expect(within(filter).getByRole('button', { name: 'Site manager' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(block).getByTestId('lane-agent')).toHaveAttribute('data-dimmed', 'true');
    expect(within(block).getByTestId('lane-reporter')).not.toHaveAttribute('data-dimmed');
    expect(within(block).queryByText(/Hi Kevin/)).not.toBeInTheDocument();
    expect(within(block).getByText(/Apex, 3 guys, 8 hours/)).toBeInTheDocument();

    // The full transcript follows the filter.
    await userEvent.click(screen.getByRole('button', { name: 'Full transcript' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).queryByText(/Shall I file it\?/)).not.toBeInTheDocument();
    expect(within(drawer).getByText('Yes, file it.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(filter).getByRole('button', { name: 'Assistant' }));
    expect(within(block).getByTestId('lane-reporter')).toHaveAttribute('data-dimmed', 'true');
    expect(within(block).queryByText(/Apex, 3 guys, 8 hours/)).not.toBeInTheDocument();
    expect(within(block).getByText(/Hi Kevin/)).toBeInTheDocument();
  });

  it('seeks the call from a crew line’s “call 0:10”', async () => {
    const { store, report } = northgate();
    render(store, report.id);
    const manpower = await screen.findByRole('table', { name: 'Manpower' });
    const apex = within(manpower).getByText('Apex Concrete').closest('tr')!;
    await userEvent.click(within(apex).getByRole('button', { name: /^call 0:10/ }));
    const player = screen.getByTestId('media-player');
    expect(within(player).getByTestId('player-position')).toHaveAttribute(
      'aria-valuetext',
      expect.stringMatching(/^0:1\d$/),
    );
    expect(within(player).getByTestId('player-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps a v1 call row’s single peaks array as one lane, without a filter', async () => {
    const { store, report, call } = northgate();
    call.peaks = [0.2, 0.5, 0.3] as unknown as typeof call.peaks;
    render(store, report.id);
    const player = await screen.findByTestId('media-player');
    expect(player).toHaveAttribute('data-lanes', '1');
    expect(screen.queryByRole('group', { name: 'Speaker' })).not.toBeInTheDocument();
  });

  it('words a browser call, a call from SiteLog and the simple recording mode', async () => {
    const web = northgate();
    web.call.transport = 'web';
    render(web.store, web.report.id);
    expect(await screen.findByTestId('provenance')).toHaveTextContent(
      "Reported by Kevin O'Brien · browser call 17:10 (2 min 41 s) · confirmed by voice",
    );
    expect(
      within(screen.getByTestId('activity')).getByText('Browser call · 2 min 41 s · filed'),
    ).toBeInTheDocument();
  });

  it('words a call SiteLog placed that ended in the simple recording', async () => {
    const out = northgate();
    out.call.direction = 'outbound';
    out.call.outcome = 'fallback_recording';
    render(out.store, out.report.id);
    expect(await screen.findByTestId('provenance')).toHaveTextContent(
      "Reported by Kevin O'Brien · call from SiteLog 17:10 (2 min 41 s) · simple recording mode · confirmed by voice",
    );
    expect(
      within(screen.getByTestId('activity')).getByText(
        'Call placed · 2 min 41 s · simple recording',
      ),
    ).toBeInTheDocument();
  });

  it('speaks Turkish: lanes, filter, provenance and Activity', async () => {
    await turkish();
    const { store, report } = northgate();
    render(store, report.id);
    const player = await screen.findByTestId('media-player');
    expect(within(player).getByTestId('lane-reporter')).toHaveTextContent('Şantiye şefi');
    expect(within(player).getByTestId('lane-agent')).toHaveTextContent('SiteLog asistanı');
    const filter = screen.getByRole('group', { name: 'Konuşan' });
    expect(within(filter).getByRole('button', { name: 'İkisi de' })).toBeInTheDocument();
    expect(within(filter).getByRole('button', { name: 'Asistan' })).toBeInTheDocument();
    expect(screen.getByTestId('provenance')).toHaveTextContent(
      "Rapor veren: Kevin O'Brien · telefon araması 17:10 (2 dk 41 sn) · sesle onaylandı",
    );
    expect(
      within(screen.getByTestId('activity')).getByText('Gelen arama · 2 dk 41 sn · dosyalandı'),
    ).toBeInTheDocument();
  });
});

describe('ReportDetailPage: call_mismatch with both values (§19 Q74, Q123)', () => {
  function flagged(reasons: string[]) {
    const n = northgate();
    n.report.needs_review = true;
    n.report.review_reasons = reasons;
    return n;
  }

  it('reads “The call recording says 5 workers, the confirmed report says 4” with Play at', async () => {
    const { store, report } = flagged(['call_mismatch:manpower[0].workers:5:4']);
    render(store, report.id);
    const banner = await screen.findByRole('region', { name: /reasons? to review|İncelenecek/ });
    expect(banner).toHaveTextContent(
      'Apex Concrete: The call recording says 5 workers, the confirmed report says 4 — check',
    );
    await userEvent.click(within(banner).getByRole('button', { name: 'Play at 0:10' }));
    expect(within(screen.getByTestId('media-player')).getByTestId('player-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('words hours and lost hours, and keeps the generic line for an old code without values', async () => {
    const { store, report } = flagged([
      'call_mismatch:manpower[1].hoursPerWorker:8.5:8',
      'call_mismatch:weather.periods[0].lostHours:3:2',
      'call_mismatch:manpower[2].workers',
    ]);
    render(store, report.id);
    const banner = await screen.findByRole('region', { name: /reasons? to review|İncelenecek/ });
    expect(banner).toHaveTextContent(
      'Kestrel self-perform: The call recording says 8.5 h per worker, the confirmed report says 8 — check',
    );
    // Northgate's report has no weather period: the line stands without a "what".
    expect(banner).toHaveTextContent(
      'The call recording says 3 h lost, the confirmed report says 2 — check',
    );
    expect(banner).toHaveTextContent(
      'The call recording and the confirmed report differ on manpower[2].workers — check',
    );
  });

  it('reads one worker in the singular', async () => {
    const { store, report } = flagged(['call_mismatch:manpower[0].workers:1:2']);
    render(store, report.id);
    expect(
      await screen.findByRole('region', { name: /reasons? to review|İncelenecek/ }),
    ).toHaveTextContent('The call recording says 1 worker, the confirmed report says 2 — check');
  });

  it('speaks Turkish, numbers in Turkish', async () => {
    await turkish();
    const { store, report } = flagged([
      'call_mismatch:manpower[0].workers:5:4',
      'call_mismatch:manpower[1].hoursPerWorker:8.5:8',
    ]);
    render(store, report.id);
    const banner = await screen.findByRole('region', { name: /reasons? to review|İncelenecek/ });
    expect(banner).toHaveTextContent(
      'Apex Concrete: Arama kaydı 5 işçi diyor, onaylanan rapor 4 — kontrol edin',
    );
    expect(banner).toHaveTextContent(
      'Kestrel self-perform: Arama kaydı işçi başına 8,5 sa diyor, onaylanan rapor 8 — kontrol edin',
    );
  });
});

describe('ReportDetailPage: after the post-call reconcile (W3-11, §19 Q123, Q152, Q153)', () => {
  it('plays a value from the precise seconds the reconcile wrote', async () => {
    const { store, report, call } = northgate();
    store.data.sources.push({
      ...V12_ROW_DEFAULTS.report_sources,
      id: 'precise-apex',
      report_id: report.id,
      message_id: null,
      kind: 'call',
      caption: null,
      taken_at: null,
      call_id: call.id,
      value_path: 'manpower[0]',
      start_s: 42.4,
      end_s: 48,
    });
    render(store, report.id);
    const manpower = await screen.findByRole('table', { name: 'Manpower' });
    const apex = within(manpower).getByText('Apex Concrete').closest('tr')!;
    expect(within(apex).queryByRole('button', { name: /^call 0:10/ })).toBeNull();
    await userEvent.click(within(apex).getByRole('button', { name: /^call 0:42/ }));
    expect(
      within(screen.getByTestId('media-player')).getByTestId('player-position'),
    ).toHaveAttribute('aria-valuetext', expect.stringMatching(/^0:4\d$/));
  });

  it('words call_unreconciled, and a crew on one side only with the generic line (Q152)', async () => {
    const { store, report } = northgate();
    report.needs_review = true;
    report.review_reasons = ['call_unreconciled', 'call_mismatch:manpower[3]:Delta Mechanical 5:'];
    render(store, report.id);
    const banner = await screen.findByRole('region', { name: /reasons? to review|İncelenecek/ });
    expect(banner).toHaveTextContent(
      'The call recording could not be checked against the report; its seconds are live timestamps.',
    );
    expect(banner).toHaveTextContent(
      'The call recording and the confirmed report differ on manpower[3] — check',
    );
  });

  it('says call_unreconciled in Turkish', async () => {
    await turkish();
    const { store, report } = northgate();
    report.needs_review = true;
    report.review_reasons = ['call_unreconciled'];
    render(store, report.id);
    expect(
      await screen.findByRole('region', { name: /reasons? to review|İncelenecek/ }),
    ).toHaveTextContent(
      'Arama kaydı raporla karşılaştırılamadı; saniyeleri canlı zaman damgalarıdır.',
    );
  });
});

describe('ReportDetailPage: a spoken answer’s clip (§19 Q93)', () => {
  it('plays the clip from “answer 17:41” and shows it under the answer in Activity', async () => {
    const store = new DemoStore();
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const question = store.data.questions.find((q) => q.report_id === hero.id)!;
    const note = store.data.uploads.find((u) => u.report_id === hero.id && u.kind === 'audio')!;
    const clipId = '0b9f1a4e-6d1c-4b7a-9a59-0d7f0a3c5e11';
    store.data.uploads.push({
      ...note,
      id: clipId,
      report_id: null,
      storage_path: note.storage_path.replace(/[^/]+$/, `${clipId}.webm`),
      duration_s: 4,
      peaks: [0.3, 0.6, 0.4],
      recorded_at: question.answered_at,
      received_at: question.answered_at,
      question_id: question.id,
    });
    store.data.transcripts.push({
      ...V12_ROW_DEFAULTS.transcripts,
      id: '6f1c3d2e-9b8a-4c7d-8e6f-5a4b3c2d1e0f',
      message_id: null,
      upload_id: clipId,
      language: 'en',
      text: 'Five of them, full day.',
      segments: [{ start: 0, end: 3, text: 'Five of them, full day.' }],
      model: 'nova-3',
      created_at: question.answered_at!,
    });
    render(store, hero.id);
    const manpower = await screen.findByRole('table', { name: 'Manpower' });
    const delta = within(manpower).getByText('Delta Mechanical').closest('tr')!;
    // Not one of the report's recordings (it is not report material).
    expect(screen.getAllByTestId('source-clip')).toHaveLength(2);
    const answer = within(delta).getByRole('button', {
      name: /^answer 17:41 · Play the spoken answer and show it in Activity$/,
    });
    await userEvent.click(answer);
    const focused = screen.getByTestId('activity').querySelector('[data-focus]')!;
    expect(focused).toHaveAttribute('data-kind', 'question_answered');
    const clip = within(focused as HTMLElement).getByTestId('answer-clip');
    expect(clip).toHaveTextContent('Spoken answer');
    expect(clip).toHaveTextContent('“Five of them, full day.”');
    expect(within(clip).getByTestId('player-toggle')).toHaveAttribute('aria-pressed', 'true');
  });
});
