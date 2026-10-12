import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deadlineInstant,
  emptyReportData,
  type DailyReportData,
  type ExtractionOutput,
  type ManpowerEntry,
  type ReportRow,
} from '@sitelog/shared';
import type { MessagesClient } from '../ai/claude';
import type { ExtractionInput } from '../ai/extract';
import { contextOf } from '../router/context';
import { createHarness, scriptedClaude, SITE_RIVERSIDE, type Harness } from '../test/harness';
import { PROGRESS_AFTER_MS, progressSteps } from './progress';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'fixtures');
const riversideInput = JSON.parse(
  readFileSync(join(FIXTURES, 'transcripts', 'riverside-2026-10-09.json'), 'utf8'),
) as ExtractionInput;
const riversideOutput = JSON.parse(
  readFileSync(join(FIXTURES, 'tool-outputs', 'riverside-2026-10-09.json'), 'utf8'),
) as ExtractionOutput;

/** The riverside extraction with the Delta headcount answered (5 × 8 h), so the crew is known. */
function riversideComplete(): ExtractionOutput {
  const out = structuredClone(riversideOutput);
  for (const m of out.manpower) {
    if (m.workers === null) {
      m.workers = 5;
      m.totalHours = 40;
    }
  }
  out.missingRequired = [];
  out.proposedQuestions = [];
  out.lowConfidence = [];
  return out;
}

const RECEIVED = new Date('2026-10-09T22:31:00Z');
const at = (ms: number) => new Date(RECEIVED.getTime() + ms);

/** Marco's Riverside report in `processing` with a transcribed voice note + a photo (as after intake). */
async function seedProcessing(h: Harness): Promise<{ report: ReportRow; audioId: string }> {
  h.setNow(RECEIVED);
  const siteDay = await h.db.getOrCreateSiteDay(
    SITE_RIVERSIDE,
    '2026-10-09',
    deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
  );
  const report = await h.db.insertReport({
    org_id: h.org.id,
    site_id: SITE_RIVERSIDE,
    site_day_id: siteDay.id,
    report_no: 'RL-2041-0187',
    reporter_id: h.marco.id,
    received_at: RECEIVED.toISOString(),
    kind: 'daily',
  });
  const convo = await h.conversation('processing', { active_report_id: report.id });
  const audio = await h.inbound(convo, {
    type: 'audio',
    storage_path: 'x/a.ogg',
    duration_s: 168,
    created_at: RECEIVED.toISOString(),
  });
  await h.db.insertReportSource({
    report_id: report.id,
    message_id: audio.id,
    kind: 'audio',
    taken_at: audio.created_at,
  });
  const photo = await h.inbound(convo, {
    type: 'image',
    body: 'L4 pour done',
    storage_path: 'x/p.jpg',
    created_at: RECEIVED.toISOString(),
  });
  await h.db.insertReportSource({
    report_id: report.id,
    message_id: photo.id,
    kind: 'photo',
    caption: 'L4 pour done',
    taken_at: photo.created_at,
  });
  await h.db.upsertTranscript({
    message_id: audio.id,
    language: 'es+en',
    text: riversideInput.segments.map((s) => s.text).join(' '),
    segments: riversideInput.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
    model: 'whisper-1',
  });
  return { report, audioId: audio.id };
}

/** A Claude client that takes `latencyMs` on the fake clock per call (and can run a side effect). */
function slowClaude(
  h: Harness,
  output: ExtractionOutput,
  latencyMs: number,
  during?: (call: number) => Promise<void>,
): MessagesClient {
  const inner = scriptedClaude([{ input: output }]);
  let calls = 0;
  return {
    messages: {
      async create(params) {
        calls++;
        if (during) await during(calls);
        h.setNow(new Date(h.now.getTime() + latencyMs));
        return inner.messages.create(params);
      },
    },
  };
}

const progressMessages = (h: Harness) =>
  [...h.db.data.messages.values()].filter(
    (m) => m.direction === 'out' && (m.payload as { kind?: string } | null)?.kind === 'progress',
  );

async function convoContext(h: Harness) {
  return contextOf((await h.db.getConversationByPhone(h.marco.phone_e164))!);
}

describe('progress bubble (§F5 step 3)', () => {
  it('lists transcribed · crew · weather delay · checking hours, and only what is known', () => {
    const draft: DailyReportData = {
      ...emptyReportData('2026-10-09'),
      manpower: [
        manpower('Apex Concrete', 'd001', 6),
        manpower('Kestrel self-perform', 'd007', 4),
        manpower('Delta Mechanical', 'd003', 5),
      ],
      weather: {
        conditionsText: 'Light rain AM',
        periods: [
          { start: '07:00', end: '10:30', condition: 'light rain', lostHours: 3.5, source: [] },
        ],
      },
    };
    const self = new Set(['00000000-0000-4000-8000-00000000d007']);
    expect(progressSteps({ transcribed: true, draft, selfPerformCompanyIds: self })).toEqual([
      'Transcribed, site noise removed',
      '15 on site, 2 subcontractors',
      'Light rain 07:00–10:30 logged as delay',
      'Checking subcontractor hours…',
    ]);
    // Unknown headcount → no crew line (it would be wrong); no stoppage → no delay line.
    const partial: DailyReportData = {
      ...draft,
      manpower: [...draft.manpower, { ...manpower('Summit Drywall', 'd006', 1), workers: null }],
      weather: {
        conditionsText: 'Dry',
        periods: [{ condition: 'Overcast', lostHours: 0, source: [] }],
      },
    };
    expect(progressSteps({ transcribed: false, draft: partial })).toEqual([
      'Checking subcontractor hours…',
    ]);
  });

  it('sends nothing when the draft is ready within 10 s', async () => {
    const h = createHarness();
    const { report, audioId } = await seedProcessing(h);
    h.setNow(at(4_000)); // transcription done after 4 s
    await h.runJob('transcribe_audio', { messageId: audioId, reportId: report.id });
    expect(h.db.jobsOfType('extract_report')).toHaveLength(1);
    h.claude(slowClaude(h, riversideComplete(), 5_000)); // extraction done at 9 s
    await h.drain(['extract_report', 'decide_next']);
    expect(progressMessages(h)).toHaveLength(0);
    expect(h.sentTexts().some((t) => t.startsWith('Writing your report'))).toBe(false);
    expect((await h.db.getReport(report.id))!.status).toBe('awaiting_confirmation');
    expect((await convoContext(h)).progress_sent_for).toBeUndefined();
  });

  it('sends one bubble after a slow extraction, before the draft card, with what was found', async () => {
    const h = createHarness();
    const { report, audioId } = await seedProcessing(h);
    h.setNow(at(4_000));
    await h.runJob('transcribe_audio', { messageId: audioId, reportId: report.id });
    expect(progressMessages(h)).toHaveLength(0);
    h.claude(slowClaude(h, riversideComplete(), 21_000)); // extraction done at 25 s
    await h.drain(['extract_report']);

    expect(h.sentTexts()).toEqual([
      [
        'Writing your report…',
        '- Transcribed, site noise removed',
        '- 23 on site, 4 subcontractors',
        '- Rain 07:00–10:30 logged as delay',
        '- Checking subcontractor hours…',
      ].join('\n'),
    ]);
    expect((await convoContext(h)).progress_sent_for).toBe(report.id);

    await h.drain(['decide_next']);
    const texts = h.sentTexts();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('DRAFT · FRI OCT 9');
    expect(progressMessages(h)).toHaveLength(1);
  });

  it('sends it right after a slow transcription, then never again for the report', async () => {
    const h = createHarness();
    const { report, audioId } = await seedProcessing(h);
    // A second voice note still being transcribed: no bubble yet even though 12 s have passed.
    const convo = (await h.db.getConversationByPhone(h.marco.phone_e164))!;
    const second = await h.inbound(convo, { type: 'audio', storage_path: 'x/b.ogg' });
    await h.db.insertReportSource({ report_id: report.id, message_id: second.id, kind: 'audio' });
    h.setNow(at(12_000));
    await h.runJob('transcribe_audio', { messageId: audioId, reportId: report.id });
    expect(progressMessages(h)).toHaveLength(0);

    h.setNow(at(15_000));
    await h.db.upsertTranscript({
      message_id: second.id,
      language: 'en',
      text: 'Also the glazing crew from ClearView finished the north elevation on level three today, and the inspector signed off the level four pour before lunch.',
      segments: [{ start: 0, end: 9, text: 'Also the glazing crew…' }],
      model: 'whisper-1',
    });
    await h.runJob('transcribe_audio', { messageId: second.id, reportId: report.id });
    expect(h.sentTexts()).toEqual([
      'Writing your report…\n- Transcribed, site noise removed\n- Checking subcontractor hours…',
    ]);

    // Extraction is slow as well (and re-runs because a captioned photo arrived meanwhile): still
    // one bubble. A captionless photo would ride along without a re-run (syncDraftPhotos).
    let photoAdded = false;
    h.claude(
      slowClaude(h, riversideComplete(), 20_000, async () => {
        if (photoAdded) return;
        photoAdded = true;
        const photo = await h.inbound(convo, {
          type: 'image',
          body: 'L4 deck poured',
          storage_path: 'x/p.jpg',
        });
        await h.db.insertReportSource({
          report_id: report.id,
          message_id: photo.id,
          kind: 'photo',
          caption: 'L4 deck poured',
        });
      }),
    );
    const ran = await h.drain(['extract_report']);
    expect(ran).toHaveLength(2); // first run saw the photo arrive → re-extraction
    await h.drain(['decide_next']);
    expect(progressMessages(h)).toHaveLength(1);
    expect(h.sentTexts()[1]).toContain('DRAFT · FRI OCT 9');
  });

  it('never follows a question or the draft card already sent for the report', async () => {
    const h = createHarness();
    const { report, audioId } = await seedProcessing(h);
    h.setNow(at(3_000));
    await h.runJob('transcribe_audio', { messageId: audioId, reportId: report.id });
    h.claude(slowClaude(h, riversideOutput, 2_000)); // Delta headcount missing → question
    await h.drain(['extract_report', 'decide_next']);
    expect((await h.db.getReport(report.id))!.status).toBe('awaiting_answer');
    expect(progressMessages(h)).toHaveLength(0);

    // More content merged later (the router moves the conversation back to processing): the
    // re-extraction is slow, but the reporter has already seen a question, so no bubble.
    await h.db.updateConversation((await h.db.getConversationByPhone(h.marco.phone_e164))!.id, {
      state: 'processing',
    });
    h.claude(slowClaude(h, riversideComplete(), 30_000));
    await h.runJob('extract_report', { reportId: report.id, reason: 'sources:2' });
    expect(progressMessages(h)).toHaveLength(0);
    expect(PROGRESS_AFTER_MS).toBe(10_000);
  });
});

function manpower(name: string, idSuffix: string, workers: number): ManpowerEntry {
  return {
    companyId: `00000000-0000-4000-8000-00000000${idSuffix}`,
    companyNameHeard: name,
    companyName: name,
    workers,
    hoursPerWorker: 8,
    totalHours: workers * 8,
    hoursBasis: 'full_day_default',
    confidence: 0.95,
    source: [],
  };
}
