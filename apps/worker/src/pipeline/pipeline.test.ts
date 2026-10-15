import { describe, expect, it } from 'vitest';
import {
  MASKED_CODE,
  SmsSendError,
  V12_ROW_DEFAULTS,
  deadlineInstant,
  deriveLinkCode,
  evidencePackStoragePath,
  linkCodeHash,
  readReportData,
  upgradeV1toV2,
  type DailyReportDataV1,
  type StoredReportData,
} from '@sitelog/shared';
import { buildEmail } from '../jobs/send_email';
import { PermanentJobError } from '../jobs/types';
import { buildReportPdfInput } from '../pdf/render';
import { postProcessExtraction } from '../ai/extract';
import { compareReport, loadFixture } from '../ai/eval';
import { createWorkerNotifier } from '../messaging';
import {
  createHarness,
  ORG_ID,
  PHONE_MARCO,
  scriptedClaude,
  SITE_OAKMONT,
  SITE_RIVERSIDE,
} from '../test/harness';
import { legacyExpected, legacyInput, legacyRecorded } from '../test/legacy-fixtures';
import { composeExtractionInput } from './compose';
import { currentData, draftCardFor, storeDraft } from './draft';
import { fileReport } from './file';
import { learnTerms } from './glossary';
import { selectNextQuestion, validateDraft } from './validate';

describe('pipeline: validate + question selection', () => {
  it('riverside: the only gap is the Delta headcount, asked with the model options', () => {
    const input = legacyInput('riverside-2026-10-09');
    const { data } = postProcessExtraction(legacyRecorded('riverside-2026-10-09'), input);
    const v = validateDraft(data, { required_fields: input.requiredFields }, 2);
    expect(v.isComplete).toBe(false);
    expect(v.missingRequired).toEqual([
      'manpower.workers:Delta Mechanical',
      'manpower.hours:Delta Mechanical',
    ]);
    const q = selectNextQuestion(data, v, [], { max_questions_per_report: 3 }, []);
    expect(q).toMatchObject({
      field: 'manpower.workers',
      path: 'manpower.workers:Delta Mechanical',
      options: [
        { id: 'o1', label: '4 · full day' },
        { id: 'o2', label: '5 · full day' },
      ],
    });
    expect(q!.prompt).toContain('the Delta guys');
  });

  it('oakmont: unknown company is flagged for review and asked with "Add"', () => {
    const input = legacyInput('oakmont-unknown-sub');
    const { data } = postProcessExtraction(legacyRecorded('oakmont-unknown-sub'), input);
    const v = validateDraft(data, { required_fields: input.requiredFields }, 1);
    expect(v.isComplete).toBe(true);
    expect(v.reviewReasons).toEqual(['unknown_company:Ridgeway']);
    const q = selectNextQuestion(
      data,
      v,
      [],
      { max_questions_per_report: 3 },
      input.companies.map((c) => ({
        ...c,
        is_self_perform: false,
        status: 'confirmed',
        org_id: 'o',
        created_at: '',
      })),
    );
    expect(q).toMatchObject({ field: 'company.unknown' });
    expect(q!.options[0]!.label).toBe('Add "Ridgeway"');
  });

  it('expected fixtures pass the eval comparison against themselves and fail when numbers change', () => {
    for (const id of ['riverside-2026-10-09', 'oakmont-unknown-sub', 'hillcrest-weather-day']) {
      const expected = loadFixture(id).expected;
      expect(compareReport(expected, expected).every((c) => c.ok)).toBe(true);
    }
    const expected = loadFixture('hillcrest-weather-day').expected;
    const wrong = structuredClone(expected);
    wrong.manpower[0]!.workers = 6;
    wrong.weather.periods[0]!.lostHours = 7;
    const failed = compareReport(wrong, expected)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toEqual(['manpower Apex Concrete: workers', 'weather lostHours ±0.5']);
  });

  it('draft card matches the §F7 format', () => {
    const input = legacyInput('riverside-2026-10-09');
    const { data } = postProcessExtraction(legacyRecorded('riverside-2026-10-09'), input);
    const h = createHarness();
    const card = draftCardFor(
      {
        ...data,
        manpower: data.manpower.map((m) =>
          m.companyName === 'Delta Mechanical' ? { ...m, workers: 5, totalHours: 40 } : m,
        ),
      },
      {
        site: h.riverside,
        org: h.org,
        settings: h.settings,
        companies: Array.from(h.db.data.companies.values()),
        glossary: [],
        recipients: [],
        reporters: [],
      },
    );
    expect(card).toContain('DRAFT · FRI OCT 9');
    expect(card).toContain('Riverside Lofts — Block B');
    expect(card).toContain('CREW      23 on site · 4 subs · 184 h');
    expect(card).toContain(
      'WEATHER   Rain 07:00–10:30 · exterior masonry on the south elevation… 3.5 h',
    );
    expect(card).toContain('SAFETY    Toolbox talk · no incidents');
    expect(card.endsWith('Reply OK to file it, or tell me what to fix.')).toBe(true);
  });
});

describe('pipeline: compose + extract job + filing', () => {
  it('composes the extraction input from sources, transcripts and answers, then stores the draft', async () => {
    const h = createHarness({
      claude: scriptedClaude([{ input: legacyRecorded('riverside-2026-10-09') }]),
    });
    const siteDay = await h.db.getOrCreateSiteDay(
      SITE_RIVERSIDE,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    await h.db.updateSiteDay(siteDay.id, {
      weather: legacyInput('riverside-2026-10-09').observedWeather as unknown as Record<
        string,
        unknown
      >,
    });
    const report = await h.db.insertReport({
      org_id: h.org.id,
      site_id: SITE_RIVERSIDE,
      site_day_id: siteDay.id,
      report_no: 'RL-2041-0187',
      reporter_id: h.marco.id,
      received_at: '2026-10-09T22:31:00Z',
      kind: 'daily',
    });
    const convo = await h.conversation('processing', { active_report_id: report.id });
    const audio = await h.inbound(convo, {
      type: 'audio',
      storage_path: 'x/a.ogg',
      duration_s: 168,
      created_at: '2026-10-09T22:31:00Z',
    });
    await h.db.insertReportSource({
      report_id: report.id,
      message_id: audio.id,
      kind: 'audio',
      taken_at: audio.created_at,
    });
    const fixture = legacyInput('riverside-2026-10-09');
    await h.db.upsertTranscript({
      message_id: audio.id,
      language: 'es+en',
      text: fixture.segments.map((s) => s.text).join(' '),
      segments: fixture.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      model: 'whisper-1',
    });
    const photo = await h.inbound(convo, {
      type: 'image',
      body: 'L4 pour done',
      storage_path: 'x/p.jpg',
      created_at: '2026-10-09T22:31:40Z',
    });
    await h.db.insertReportSource({
      report_id: report.id,
      message_id: photo.id,
      kind: 'photo',
      caption: 'L4 pour done',
      taken_at: photo.created_at,
    });

    const site = (await h.db.siteContext(SITE_RIVERSIDE))!;
    const input = await composeExtractionInput(h.ctx, report, site, h.marco, {
      reportDate: '2026-10-09',
      observedWeather: null,
    });
    expect(input.segments).toHaveLength(10);
    expect(input.segments[0]!.messageId).toBe(audio.id);
    expect(input.photos).toEqual([
      { messageId: photo.id, caption: 'L4 pour done', takenAt: photo.created_at },
    ]);
    expect(input.companies.map((c) => c.name)).toContain('Apex Concrete');
    expect(input.reporterFirstName).toBe('Marco');

    h.setNow(new Date('2026-10-09T22:31:30Z'));
    await h.runJob('extract_report', { reportId: report.id });
    const draft = await currentData(h.ctx, report);
    expect(draft!.photos[0]!.messageId).toBe(photo.id);
    expect(draft!.weather.observed?.precipIn).toBe(0.4);
    // Extraction started 30 s after the note: the §F5 progress bubble goes out at the start.
    expect(h.sentTexts()).toEqual([
      'Writing your report…\n- Transcribed, site noise removed\n- Checking subcontractor hours…',
    ]);
    expect(h.db.jobsOfType('decide_next')).toHaveLength(1);
    expect(h.db.data.audit.map((a) => a.action)).toContain('report.extracted');
  });

  it('a photo arriving during extraction rides along without another model call; a caption re-extracts', async () => {
    for (const caption of [null, 'L4 pour done']) {
      const scripted = scriptedClaude([{ input: legacyRecorded('riverside-2026-10-09') }]);
      const h = createHarness();
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
        received_at: '2026-10-09T22:31:00Z',
        kind: 'daily',
      });
      const convo = await h.conversation('processing', { active_report_id: report.id });
      const audio = await h.inbound(convo, {
        type: 'audio',
        storage_path: 'x/a.ogg',
        duration_s: 168,
      });
      await h.db.insertReportSource({ report_id: report.id, message_id: audio.id, kind: 'audio' });
      const fixture = legacyInput('riverside-2026-10-09');
      await h.db.upsertTranscript({
        message_id: audio.id,
        language: 'es+en',
        text: fixture.segments.map((x) => x.text).join(' '),
        segments: fixture.segments.map((x) => ({ start: x.start, end: x.end, text: x.text })),
        model: 'whisper-1',
      });
      // The photo lands while the model is working.
      let photoId = '';
      h.claude({
        ...scripted,
        messages: {
          async create(params) {
            const photo = await h.inbound(convo, {
              type: 'image',
              body: caption,
              storage_path: 'x/p.jpg',
            });
            photoId = photo.id;
            await h.db.insertReportSource({
              report_id: report.id,
              message_id: photo.id,
              kind: 'photo',
              caption,
              taken_at: photo.created_at,
            });
            return scripted.messages.create(params);
          },
        },
      });
      h.setNow(new Date('2026-10-09T22:31:05Z'));
      await h.runJob('extract_report', { reportId: report.id });
      if (caption) {
        expect(h.db.jobsOfType('extract_report')).toHaveLength(1); // re-extract with the caption
        expect(h.db.jobsOfType('decide_next')).toHaveLength(0);
        continue;
      }
      expect(h.db.jobsOfType('extract_report')).toHaveLength(0);
      expect(h.db.jobsOfType('decide_next')).toHaveLength(1);
      await h.runJob('decide_next', { reportId: report.id });
      const draft = await currentData(h.ctx, (await h.db.getReport(report.id))!);
      expect(draft!.photos.map((p) => p.messageId)).toEqual([photoId]);
    }
  });

  it('a long "no work today" note goes to the §F10 no-work flow instead of a headcount question', async () => {
    const h = createHarness();
    h.setNow(new Date('2026-10-08T12:05:00Z'));
    const siteDay = await h.db.getOrCreateSiteDay(
      SITE_RIVERSIDE,
      '2026-10-08',
      deadlineInstant('2026-10-08', '17:30', 'America/Chicago'),
    );
    const report = await h.db.insertReport({
      org_id: h.org.id,
      site_id: SITE_RIVERSIDE,
      site_day_id: siteDay.id,
      report_no: 'RL-2041-0190',
      reporter_id: h.marco.id,
      received_at: '2026-10-08T12:04:00Z',
      kind: 'daily',
    });
    const convo = await h.conversation('processing', { active_report_id: report.id });
    const audio = await h.inbound(convo, {
      type: 'audio',
      storage_path: 'x/n.ogg',
      duration_s: 24,
      created_at: '2026-10-08T12:04:00Z',
    });
    await h.db.insertReportSource({
      report_id: report.id,
      message_id: audio.id,
      kind: 'audio',
      taken_at: audio.created_at,
    });
    const fixture = legacyInput('elm-2026-10-08-no-work');
    await h.db.upsertTranscript({
      message_id: audio.id,
      language: 'en',
      text: fixture.segments.map((x) => x.text).join(' '),
      segments: fixture.segments.map((x) => ({ start: x.start, end: x.end, text: x.text })),
      model: 'whisper-1',
    });
    await storeDraft(h.ctx, report, legacyExpected('elm-2026-10-08-no-work'));

    await h.runJob('decide_next', { reportId: report.id });

    expect(await h.db.listQuestions(report.id)).toHaveLength(0);
    expect((await h.db.getReport(report.id))!.status).toBe('void');
    expect(h.sentTexts().at(-1)).toMatch(/^Noted — no work today at /);
    expect(h.db.data.audit.map((a) => a.action)).toContain('site_day.no_work');
  });

  it('fileReport is idempotent and writes everything once', async () => {
    const h = createHarness();
    const siteDay = await h.db.getOrCreateSiteDay(
      SITE_OAKMONT,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    const report = await h.db.insertReport({
      org_id: h.org.id,
      site_id: SITE_OAKMONT,
      site_day_id: siteDay.id,
      report_no: 'OM-1187-0121',
      reporter_id: h.jorge.id,
      received_at: '2026-10-09T22:00:00Z',
      kind: 'daily',
      status: 'awaiting_confirmation',
    });
    const input = legacyInput('oakmont-unknown-sub');
    const { data } = postProcessExtraction(legacyRecorded('oakmont-unknown-sub'), input);
    await storeDraft(h.ctx, report, data);
    await h.conversation(
      'awaiting_confirmation',
      { active_report_id: report.id },
      h.jorge.phone_e164,
    );
    h.setNow(new Date('2026-10-09T22:21:00Z')); // 17:21 Chicago — on time
    const first = await fileReport(h.ctx, report.id, { trigger: 'confirm' });
    expect(first.alreadyFiled).toBe(false);
    expect(first.report.is_late).toBe(false);
    expect(first.reasons).toEqual(['unknown_company:Ridgeway', 'missing:photo']);
    const again = await fileReport(h.ctx, report.id, { trigger: 'confirm' });
    expect(again.alreadyFiled).toBe(true);
    expect(h.db.data.denormalized).toHaveLength(1);
    expect(h.db.jobsOfType('render_pdf')).toHaveLength(1);
    expect(h.db.jobsOfType('notify').map((j) => j.dedupe_key)).toEqual([
      `notify:filed:${report.id}`,
    ]);
    expect((await h.db.getSiteDay(siteDay.id))!.report_id).toBe(report.id);
    // No `via` without a field-api confirm (the WhatsApp OK).
    expect(first.report.confirmed_via).toBeNull();

    // W1-15: a failure after `status = filed` lost the post-filing jobs: the retry enqueues them.
    for (const [id, j] of h.db.data.jobs) if (j.type !== 'file_report') h.db.data.jobs.delete(id);
    const retried = await fileReport(h.ctx, report.id, { trigger: 'confirm' });
    expect(retried.alreadyFiled).toBe(true);
    expect(h.db.jobsOfType('render_pdf')).toHaveLength(1);
    expect(h.db.jobsOfType('notify')).toHaveLength(1);
    expect(h.db.data.denormalized).toHaveLength(1);
    // A day later (past every retry of the filing), or once signed off, a filing enqueues nothing.
    for (const [id, j] of h.db.data.jobs) if (j.type !== 'file_report') h.db.data.jobs.delete(id);
    h.setNow(new Date('2026-10-10T22:22:00Z'));
    await fileReport(h.ctx, report.id, { trigger: 'timeout' });
    await h.db.updateReport(report.id, { status: 'signed_off' });
    h.setNow(new Date('2026-10-09T22:30:00Z'));
    await fileReport(h.ctx, report.id, { trigger: 'confirm' });
    expect(h.db.jobsOfType('render_pdf')).toHaveLength(0);
    expect(h.db.jobsOfType('notify')).toHaveLength(0);
  });

  it('fileReport stores the confirm channel (§10.1 `file_report(report_id, via)`)', async () => {
    const h = createHarness();
    const siteDay = await h.db.getOrCreateSiteDay(
      SITE_OAKMONT,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    const report = await h.db.insertReport({
      org_id: h.org.id,
      site_id: SITE_OAKMONT,
      site_day_id: siteDay.id,
      report_no: 'OM-1187-0123',
      reporter_id: h.jorge.id,
      received_at: '2026-10-09T22:00:00Z',
      kind: 'daily',
      status: 'awaiting_confirmation',
    });
    const input = legacyInput('oakmont-unknown-sub');
    const { data } = postProcessExtraction(legacyRecorded('oakmont-unknown-sub'), input);
    await storeDraft(h.ctx, report, data);
    h.setNow(new Date('2026-10-09T22:21:00Z'));
    const filed = await fileReport(h.ctx, report.id, {
      trigger: 'confirm',
      version: 1,
      via: 'web',
    });
    expect(filed.report).toMatchObject({ status: 'filed', confirmed_via: 'web' });
    expect(h.db.data.audit.find((a) => a.action === 'report.filed')!.diff).toMatchObject({
      via: 'web',
    });
    const [text] = h.db.jobsOfType('notify');
    expect(text!.payload).toMatchObject({
      reporterId: h.jorge.id,
      key: 'filed',
      vars: { report_no: 'OM-1187-0123' },
    });
  });

  it('fileReport files a field-api confirm only at the confirmed version and state', async () => {
    const h = createHarness();
    const siteDay = await h.db.getOrCreateSiteDay(
      SITE_OAKMONT,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    const report = await h.db.insertReport({
      org_id: h.org.id,
      site_id: SITE_OAKMONT,
      site_day_id: siteDay.id,
      report_no: 'OM-1187-0122',
      reporter_id: h.jorge.id,
      received_at: '2026-10-09T22:00:00Z',
      kind: 'daily',
      status: 'awaiting_confirmation',
    });
    const input = legacyInput('oakmont-unknown-sub');
    const { data } = postProcessExtraction(legacyRecorded('oakmont-unknown-sub'), input);
    await storeDraft(h.ctx, report, data);
    h.setNow(new Date('2026-10-09T22:21:00Z'));

    // More audio arrived after the confirm (a second reporter, a queued offline clip).
    await h.db.updateReport(report.id, { status: 'processing' });
    const moved = await fileReport(h.ctx, report.id, { trigger: 'confirm', version: 1 });
    expect([moved.stale, moved.alreadyFiled, moved.report.status]).toEqual([
      true,
      false,
      'processing',
    ]);
    // A newer draft than the one confirmed.
    await h.db.updateReport(report.id, { status: 'awaiting_confirmation' });
    const newer = await fileReport(h.ctx, report.id, { trigger: 'confirm', version: 2 });
    expect(newer.stale).toBe(true);
    expect(h.db.jobsOfType('render_pdf')).toHaveLength(0);
    expect(h.db.data.audit.filter((a) => a.action === 'report.confirm_stale')).toHaveLength(2);
    expect((await h.db.getReport(report.id))!.status).toBe('awaiting_confirmation');

    // The confirmed version, still awaiting confirmation: filed.
    const filed = await fileReport(h.ctx, report.id, { trigger: 'confirm', version: 1 });
    expect([filed.stale, filed.report.status]).toEqual([undefined, 'filed']);
  });

  it('render_pdf stores the PDF and enqueues the email, and sends nothing on WhatsApp (W1-15)', async () => {
    const h = createHarness();
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
      received_at: '2026-10-09T22:31:00Z',
      kind: 'daily',
      status: 'filed',
    });
    const input = legacyInput('riverside-2026-10-09');
    const { data } = postProcessExtraction(legacyRecorded('riverside-2026-10-09'), input);
    await storeDraft(h.ctx, report, data);
    await h.db.updateReport(report.id, { filed_at: h.now, confirmed_at: h.now });
    await h.conversation('idle');
    await h.runJob('render_pdf', {
      reportId: report.id,
      version: 1,
      sendToWhatsApp: true,
      emailRecipients: true,
    });
    const v = (await h.db.getVersion(report.id, 1))!;
    expect(v.pdf_path).toBe(`${h.org.id}/${SITE_RIVERSIDE}/RL-2041-0187_v1.pdf`);
    const pdf = await h.storage.download('pdfs', v.pdf_path!);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    // The v1.0 flag is accepted and ignored: the reporter's text is the Notifier's `filed`.
    expect(h.wa.sent).toEqual([]);
    expect(h.db.jobsOfType('send_email')).toHaveLength(1);
    expect(h.db.jobsOfType('send_email')[0]!.dedupe_key).toBe(`email:report_filed:${report.id}:1`);
    expect(h.db.jobsOfType('send_email')[0]!.payload).toMatchObject({
      kind: 'report_filed',
      reportId: report.id,
      version: 1,
    });
    await h.drain(['send_email']);
    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0]!.to).toEqual(['lena@kestrel.example']);
    expect(h.email.sent[0]!.subject).toBe(
      'Daily report · Riverside Lofts · Fri Oct 9 · RL-2041-0187',
    );
    expect(h.email.sent[0]!.attachments![0]!.filename).toBe('RL-2041-0187_2026-10-09_v1.pdf');
  }, 60_000);

  it('render_pdf and the filed email read a version stored as v2 like the v1 it upgrades from', async () => {
    const h = createHarness();
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
      received_at: '2026-10-09T22:31:00Z',
      kind: 'daily',
      status: 'filed',
    });
    const input = legacyInput('riverside-2026-10-09');
    const { data } = postProcessExtraction(legacyRecorded('riverside-2026-10-09'), input);
    await storeDraft(h.ctx, report, data);
    const filed = await h.db.updateReport(report.id, { filed_at: h.now, confirmed_at: h.now });
    const site = (await h.db.siteContext(SITE_RIVERSIDE))!;
    const emailPayload = { kind: 'report_filed' as const, reportId: report.id, version: 1 };
    const read = async () => {
      const version = (await h.db.getVersion(report.id, 1))!;
      const data = readReportData(version.data as unknown as StoredReportData);
      return {
        data,
        pdf: await buildReportPdfInput(h.ctx, { report: filed, version, site, data }),
        email: await buildEmail(h.ctx, emailPayload),
      };
    };
    const fromV1 = await read();
    expect(fromV1.data.schemaVersion).toBe(2); // the v2 view of the stored v1

    // The same version stored as v2 (as W1-06 seeds it): every reader gives the same result.
    const stored = (await h.db.getVersion(report.id, 1))!.data as unknown as DailyReportDataV1;
    expect(stored.schemaVersion).toBe(1);
    await h.db.updateVersion(report.id, 1, { data: upgradeV1toV2(stored) as never });
    const fromV2 = await read();
    expect(fromV2.data).toEqual(fromV1.data);
    expect(fromV2.pdf).toEqual(fromV1.pdf);
    expect(fromV2.email).toEqual(fromV1.email);

    await h.conversation('idle');
    await h.runJob('render_pdf', { reportId: report.id, version: 1, emailRecipients: true });
    const v = (await h.db.getVersion(report.id, 1))!;
    const pdf = await h.storage.download('pdfs', v.pdf_path!);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    await h.drain(['send_email']);
    expect(h.email.sent[0]!.attachments![0]!.filename).toBe('RL-2041-0187_2026-10-09_v1.pdf');
  }, 60_000);

  it('learns glossary terms with the §F17 statuses', async () => {
    const h = createHarness();
    const site = (await h.db.siteContext(SITE_RIVERSIDE))!;
    const rows = await learnTerms(h.ctx, {
      orgId: h.org.id,
      siteId: SITE_RIVERSIDE,
      terms: [
        { heard: 'colado', proposedOfficial: 'Concrete pour', kind: 'term', confidence: 0.95 },
        {
          heard: 'the Ridgeway crew',
          proposedOfficial: 'Ridgeway',
          kind: 'company',
          confidence: 0.85,
        },
        { heard: 'Apex', proposedOfficial: 'Apex Concrete', kind: 'company', confidence: 0.99 },
      ],
      companies: site.companies,
      glossary: site.glossary,
    });
    expect(rows.map((r) => [r.heard, r.status])).toEqual([
      ['colado', 'auto_learned'],
      ['the Ridgeway crew', 'needs_review'],
    ]);
    expect(h.db.data.notifications[0]?.kind).toBe('glossary_review');
    await learnTerms(h.ctx, {
      orgId: h.org.id,
      siteId: SITE_RIVERSIDE,
      terms: [
        { heard: 'colado', proposedOfficial: 'Concrete pour', kind: 'term', confidence: 0.95 },
      ],
      companies: [],
      glossary: [],
    });
    expect(
      Array.from(h.db.data.glossary.values()).find((g) => g.heard === 'colado')!.times_heard,
    ).toBe(2);
  });
});

describe('jobs: welcome, template, retention', () => {
  it('send_welcome texts the welcome with the personal link: a demo org through console', async () => {
    const h = createHarness();
    h.db.data.orgs.get(h.org.id)!.is_demo = true;
    const marco = h.db.data.reporters.get(h.marco.id)!;
    marco.status = 'invited';
    marco.invited_at = null;
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    // No WhatsApp any more (W1-08).
    expect(h.wa.sent).toHaveLength(0);
    const link = h.db.data.fieldLinks[0]!;
    const code = await deriveLinkCode('test-link-signing-secret', link.id);
    expect(link).toMatchObject({
      reporter_id: h.marco.id,
      kind: 'personal',
      code_hash: linkCodeHash(code),
    });
    expect(h.sms).toEqual([
      {
        driver: 'console',
        to: PHONE_MARCO,
        body: `Hi Marco, I'm SiteLog, the daily report assistant for Kestrel Build Group at Riverside Lofts — Block B. Each workday before 17:30, tap your link and talk for ~3 min: https://go.sitelog.app/r/${code} - Reply STOP to opt out, HELP for help`,
        sender: undefined,
      },
    ]);
    const [message] = [...h.db.data.messages.values()];
    expect(message).toMatchObject({
      channel: 'sms',
      direction: 'out',
      copy_key: 'welcome',
      provider: 'console',
      status: 'delivered',
      reporter_id: h.marco.id,
      org_id: h.org.id,
      body: h.sms[0]!.body,
    });
    expect(h.db.data.reporters.get(h.marco.id)!.invited_at).not.toBeNull();
    expect(h.db.data.audit.map((a) => a.action)).toEqual([
      'field_link.created',
      'sms.sent',
      'reporter.invited',
    ]);
    // A retry of the same job sends nothing more; a re-send reuses the same link.
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.sms).toHaveLength(1);
    expect(h.db.data.fieldLinks).toHaveLength(1);
  });

  it("send_welcome on a real org: the pack's provider and sender, the link masked in messages", async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.sms[0]).toMatchObject({ driver: 'twilio', sender: '+18885550142', to: PHONE_MARCO });
    expect(h.sms[0]!.body).toMatch(/https:\/\/go\.sitelog\.app\/r\/[A-Z0-9]{12} /);
    const [message] = [...h.db.data.messages.values()];
    expect(message!.provider).toBe('twilio');
    expect(message!.status).toBe('sent');
    expect(message!.body).toContain(`/r/${MASKED_CODE}`);
  });

  it('send_welcome sends nothing to a reporter who opted out, and says why', async () => {
    const h = createHarness();
    h.db.data.reporters.get(h.marco.id)!.status = 'opted_out';
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.sms).toHaveLength(0);
    expect(h.db.data.audit.find((a) => a.action === 'notify.skipped')).toMatchObject({
      diff: { copy_key: 'welcome', reason: 'opted_out' },
    });
    expect(h.db.data.audit.some((a) => a.action === 'reporter.invited')).toBe(false);
    // §13 "Message undeliverable / opted out": the office is told, with the reason.
    expect(h.db.data.notifications).toEqual([
      expect.objectContaining({
        kind: 'reporter_invite_failed',
        title: 'Marco Ruiz: the welcome text was not sent',
        body: expect.stringMatching(/opted out of texts/),
        target_path: '/team',
      }),
    ]);
  });

  it('send_welcome: a number the provider refuses for good is flagged for the office', async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    h.ctx.notifier = createWorkerNotifier(h.ctx.config, h.db, () => ({
      driver: 'twilio',
      send: () =>
        Promise.reject(
          new SmsSendError("twilio 400 21614: 'To' is not a mobile number", {
            driver: 'twilio',
            retryable: false,
            undeliverable: true,
            code: '21614',
          }),
        ),
    }));
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.db.data.reporters.get(h.marco.id)!.last_invite_error).toMatch(/21614/);
    expect(h.db.data.notifications[0]).toMatchObject({
      kind: 'reporter_invite_failed',
      target_path: '/team',
    });
    expect([...h.db.data.messages.values()][0]!.status).toBe('undeliverable');
    expect(h.db.data.audit.at(-1)).toMatchObject({
      action: 'reporter.invite_failed',
      diff: { undeliverable: true },
    });
    // A provider outage is retried by the queue instead.
    h.ctx.notifier = createWorkerNotifier(h.ctx.config, h.db, () => ({
      driver: 'twilio',
      send: () =>
        Promise.reject(new SmsSendError('twilio 503', { driver: 'twilio', retryable: true })),
    }));
    await expect(
      h.runJob('send_welcome', { reporterId: h.jorge.id, siteId: SITE_RIVERSIDE }),
    ).rejects.toThrow(/503/);
  });

  it("send_welcome: an account fault (bad credentials, no credit) is never the number's fault", async () => {
    // Twilio 21606: the From number is not a valid, SMS-capable number of the account.
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    h.ctx.notifier = createWorkerNotifier(h.ctx.config, h.db, () => ({
      driver: 'twilio',
      send: () =>
        Promise.reject(
          new SmsSendError("twilio 400 21606: The 'From' number is not valid", {
            driver: 'twilio',
            retryable: false,
            code: '21606',
          }),
        ),
    }));
    await expect(
      h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    const marco = h.db.data.reporters.get(h.marco.id)!;
    expect(marco.last_invite_error).toBeNull();
    expect(marco.invited_at).toBe('2026-03-01T00:00:00Z');
    expect(h.db.data.notifications).toEqual([
      expect.objectContaining({
        kind: 'reporter_invite_failed',
        title: 'Marco Ruiz: the welcome text failed at the SMS provider',
        body: expect.stringMatching(/Texts are failing for this account \(twilio 400 21606/),
      }),
    ]);
    expect(h.db.data.audit.at(-1)).toMatchObject({
      action: 'sms.provider_fault',
      diff: { code: '21606', driver: 'twilio', attempt: 1 },
    });
    expect([...h.db.data.messages.values()][0]!.status).toBe('failed');
    // İletimerkezi out of credit: the same, for the TR pack.
    const tr = createHarness();
    tr.db.data.orgs.get(tr.org.id)!.country = 'TR';
    tr.db.data.countries.find((c) => c.code === 'TR')!.sms_sender_id = 'SITELOG';
    const jorge = tr.db.data.reporters.get(tr.jorge.id)!;
    jorge.status = 'invited';
    jorge.locale = 'tr-TR';
    tr.ctx.notifier = createWorkerNotifier(tr.ctx.config, tr.db, () => ({
      driver: 'iletimerkezi',
      send: () =>
        Promise.reject(
          new SmsSendError('iletimerkezi 200 402: Bakiye yetersiz', {
            driver: 'iletimerkezi',
            retryable: false,
            code: '402',
          }),
        ),
    }));
    await expect(
      tr.runJob('send_welcome', { reporterId: tr.jorge.id, siteId: SITE_RIVERSIDE }),
    ).rejects.toThrow(/402/);
    expect(tr.db.data.reporters.get(tr.jorge.id)!.last_invite_error).toBeNull();
    expect(tr.db.data.notifications[0]!.body).toMatch(/iletimerkezi 200 402/);
  });

  it('sms_inbound: a stored Twilio text runs the keywords, the reply and the handled mark', async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    const inbound = (id: string, body: string, optOutType: string | null = null) => {
      h.db.data.messages.set(id, {
        ...V12_ROW_DEFAULTS.messages,
        id,
        conversation_id: null,
        org_id: h.org.id,
        direction: 'in',
        wa_message_id: null,
        type: null,
        body,
        payload: { to: '+18885550142', keyword: null, pack: 'US', opt_out_type: optOutType },
        media_id: null,
        media_mime: null,
        storage_path: null,
        duration_s: null,
        template_name: null,
        status: 'received',
        error: null,
        created_at: h.now.toISOString(),
        reporter_id: h.marco.id,
        phone_e164: PHONE_MARCO,
        provider: 'twilio',
        provider_message_id: `SM${id}`,
        copy_key: null,
        channel: 'sms',
      });
      return id;
    };
    await h.runJob('sms_inbound', {
      messageId: inbound('00000000-0000-4000-8000-00000000f001', 'STOP'),
    });
    const marco = h.db.data.reporters.get(h.marco.id)!;
    expect([marco.status, marco.opted_out_at]).toEqual(['opted_out', h.now.toISOString()]);
    expect(h.db.data.smsOptOuts).toEqual([
      expect.objectContaining({ phone_e164: PHONE_MARCO, country: 'US', method: 'sms_keyword' }),
    ]);
    expect(h.sms).toEqual([
      {
        driver: 'twilio',
        to: PHONE_MARCO,
        body: "You won't get more texts from SiteLog. Reply START to resume.",
        sender: '+18885550142',
      },
    ]);
    expect(h.db.data.notifications).toEqual([
      expect.objectContaining({ kind: 'reporter_opted_out', target_path: '/team' }),
    ]);
    expect(h.db.data.audit.map((a) => [a.action, a.actor_type])).toEqual([
      ['reporter.opted_out', 'reporter'],
      ['sms.sent', 'system'],
    ]);
    const handled = h.db.data.messages.get('00000000-0000-4000-8000-00000000f001')!;
    expect((handled.payload as { handled_at?: string }).handled_at).toBe(h.now.toISOString());
    // A second run of the same job (a redelivery) does nothing more.
    await h.runJob('sms_inbound', { messageId: '00000000-0000-4000-8000-00000000f001' });
    expect(h.sms).toHaveLength(1);

    // HELP: the personal link, created once, masked in the row (a real org).
    await h.runJob('sms_inbound', {
      messageId: inbound('00000000-0000-4000-8000-00000000f002', 'help'),
    });
    expect(h.db.data.fieldLinks).toHaveLength(1);
    expect(h.sms[1]!.body).toMatch(/Your link: https:\/\/go\.sitelog\.app\/r\/[A-Z0-9]{12} /);
    expect([...h.db.data.messages.values()].find((m) => m.copy_key === 'help')!.body).toContain(
      MASKED_CODE,
    );

    // A row the webhook never wrote, or one the Demo phone handled inline, is a dead job.
    await expect(
      h.runJob('sms_inbound', { messageId: '00000000-0000-4000-8000-00000000f0ff' }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    inbound('00000000-0000-4000-8000-00000000f003', 'STOP');
    h.db.data.messages.get('00000000-0000-4000-8000-00000000f003')!.provider = 'console';
    await expect(
      h.runJob('sms_inbound', { messageId: '00000000-0000-4000-8000-00000000f003' }),
    ).rejects.toThrow(/handled inline/);
  });

  it('sms_inbound: a STOP whose office notice fails is retried whole: one audit row, one notice', async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    const id = '00000000-0000-4000-8000-00000000f201';
    h.db.data.messages.set(id, {
      ...V12_ROW_DEFAULTS.messages,
      id,
      conversation_id: null,
      org_id: h.org.id,
      direction: 'in',
      wa_message_id: null,
      type: null,
      body: 'STOP',
      payload: { to: '+18885550142', keyword: 'stop', pack: 'US', opt_out_type: null },
      media_id: null,
      media_mime: null,
      storage_path: null,
      duration_s: null,
      template_name: null,
      status: 'received',
      error: null,
      created_at: h.now.toISOString(),
      reporter_id: h.marco.id,
      phone_e164: PHONE_MARCO,
      provider: 'twilio',
      provider_message_id: `SM${id}`,
      copy_key: null,
      channel: 'sms',
    });
    // The notice insert fails once (a database blip): the change rolls back with it.
    const notifyOrg = h.db.notifyOrg.bind(h.db);
    let failures = 1;
    h.db.notifyOrg = (...args) =>
      failures-- > 0 ? Promise.reject(new Error('connection lost')) : notifyOrg(...args);
    await expect(h.runJob('sms_inbound', { messageId: id })).rejects.toThrow(/connection lost/);
    expect(h.db.data.reporters.get(h.marco.id)!.status).not.toBe('opted_out');
    expect(h.db.data.audit.filter((a) => a.action === 'reporter.opted_out')).toEqual([]);
    expect(h.sms).toEqual([]);
    // The job's retry makes the change with its audit row and the office's notice.
    await h.runJob('sms_inbound', { messageId: id });
    expect(h.db.data.reporters.get(h.marco.id)!.status).toBe('opted_out');
    expect(h.db.data.audit.filter((a) => a.action === 'reporter.opted_out')).toHaveLength(1);
    expect(h.db.data.notifications.filter((n) => n.kind === 'reporter_opted_out')).toHaveLength(1);
    expect(h.sms.map((m) => m.body)).toEqual([
      "You won't get more texts from SiteLog. Reply START to resume.",
    ]);
  });

  it('sms_inbound: a STOP Twilio handled itself (OptOutType) is recorded with no reply of ours (§19 Q45)', async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    const id = '00000000-0000-4000-8000-00000000f301';
    h.db.data.messages.set(id, {
      ...V12_ROW_DEFAULTS.messages,
      id,
      conversation_id: null,
      org_id: h.org.id,
      direction: 'in',
      wa_message_id: null,
      type: null,
      body: 'STOP',
      payload: { to: '+18885550142', keyword: 'stop', pack: 'US', opt_out_type: 'STOP' },
      media_id: null,
      media_mime: null,
      storage_path: null,
      duration_s: null,
      template_name: null,
      status: 'received',
      error: null,
      created_at: h.now.toISOString(),
      reporter_id: h.marco.id,
      phone_e164: PHONE_MARCO,
      provider: 'twilio',
      provider_message_id: `SM${id}`,
      copy_key: null,
      channel: 'sms',
    });
    await h.runJob('sms_inbound', { messageId: id });
    expect(h.db.data.reporters.get(h.marco.id)!.status).toBe('opted_out');
    expect(h.db.data.smsOptOuts).toEqual([
      expect.objectContaining({ phone_e164: PHONE_MARCO, country: 'US', method: 'sms_keyword' }),
    ]);
    expect(h.sms).toEqual([]);
  });

  it('sms_inbound: a STOP never waits for the link secret; only a HELP needs it', async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    Object.assign(h.ctx.config, { LINK_SIGNING_SECRET: '' });
    const inbound = (id: string, body: string) => {
      h.db.data.messages.set(id, {
        ...V12_ROW_DEFAULTS.messages,
        id,
        conversation_id: null,
        org_id: h.org.id,
        direction: 'in',
        wa_message_id: null,
        type: null,
        body,
        payload: { to: '+18885550142', keyword: null, pack: 'US', opt_out_type: null },
        media_id: null,
        media_mime: null,
        storage_path: null,
        duration_s: null,
        template_name: null,
        status: 'received',
        error: null,
        created_at: h.now.toISOString(),
        reporter_id: h.marco.id,
        phone_e164: PHONE_MARCO,
        provider: 'twilio',
        provider_message_id: `SM${id}`,
        copy_key: null,
        channel: 'sms',
      });
      return id;
    };
    await h.runJob('sms_inbound', {
      messageId: inbound('00000000-0000-4000-8000-00000000f101', 'STOP'),
    });
    expect(h.db.data.reporters.get(h.marco.id)!.status).toBe('opted_out');
    expect(h.sms).toHaveLength(1);
    // HELP carries the personal link: without the secret the job fails (retried, then Sentry)
    // and the text stays unhandled for the next attempt.
    const help = inbound('00000000-0000-4000-8000-00000000f102', 'HELP');
    await expect(h.runJob('sms_inbound', { messageId: help })).rejects.toThrow(
      /LINK_SIGNING_SECRET is not set/,
    );
    expect((h.db.data.messages.get(help)!.payload as { handled_at?: string }).handled_at).toBe(
      undefined,
    );
  });

  it("send_welcome: a number on the provider's opt-out list (Twilio 21610) is recorded as an opt-out", async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    h.ctx.notifier = createWorkerNotifier(
      h.ctx.config,
      h.db,
      () => ({
        driver: 'twilio',
        send: () =>
          Promise.reject(
            new SmsSendError('twilio 400 21610: Attempt to send to unsubscribed recipient', {
              driver: 'twilio',
              retryable: false,
              undeliverable: true,
              optedOut: true,
              code: '21610',
            }),
          ),
      }),
      () => h.now,
    );
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    const marco = h.db.data.reporters.get(h.marco.id)!;
    expect([marco.status, marco.opted_out_at, marco.last_invite_error]).toEqual([
      'opted_out',
      '2026-10-09T22:31:00.000Z',
      null,
    ]);
    expect(h.db.data.smsOptOuts).toEqual([
      expect.objectContaining({
        phone_e164: PHONE_MARCO,
        country: 'US',
        method: 'provider_opt_out',
      }),
    ]);
    expect(h.db.data.notifications).toEqual([
      expect.objectContaining({
        kind: 'reporter_opted_out',
        title: 'Marco Ruiz opted out of texts',
        body: expect.stringMatching(/opt-out list/),
      }),
    ]);
    expect(h.db.data.audit.map((a) => a.action)).toEqual([
      'field_link.created',
      'sms.undeliverable',
      'reporter.opted_out',
      'reporter.invite_failed',
    ]);
    // The next welcome (a re-send) is skipped by the opt-out, with no provider call.
    h.db.data.notifications.length = 0;
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.db.data.notifications[0]!.body).toMatch(/opted out of texts/);
  });

  it('send_welcome: a real org whose pack has no sender here reaches no phone and says so', async () => {
    const h = createHarness();
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    h.db.data.reporters.get(h.marco.id)!.invited_at = null;
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.sms).toEqual([]);
    const [message] = [...h.db.data.messages.values()];
    expect(message).toMatchObject({ provider: 'console', status: 'failed' });
    expect(message!.body).toContain(MASKED_CODE);
    const marco = h.db.data.reporters.get(h.marco.id)!;
    // Not invited: the 48 h re-send clock never started.
    expect([marco.status, marco.invited_at]).toEqual(['invited', null]);
    expect(h.db.data.audit.some((a) => a.action === 'reporter.invited')).toBe(false);
    expect(h.db.data.notifications).toEqual([
      expect.objectContaining({
        kind: 'reporter_invite_failed',
        title: 'Marco Ruiz: the welcome text was not sent',
        body: expect.stringMatching(/no SMS sender is set for its country pack/),
      }),
    ]);
  });

  it('send_welcome: a reporter the office disabled meanwhile gets nothing and nobody is told', async () => {
    const h = createHarness();
    h.db.data.reporters.get(h.marco.id)!.status = 'disabled';
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.sms).toEqual([]);
    expect(h.db.data.notifications).toEqual([]);
    expect(h.db.data.audit).toEqual([]);
    expect(h.db.data.fieldLinks).toEqual([]);
  });

  it("send_welcome: a phone that sent STOP on the pack's sender gets nothing, whatever the row says", async () => {
    const h = createHarness();
    h.db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    h.db.data.smsOptOuts.push({
      phone_e164: PHONE_MARCO,
      country: 'US',
      method: 'sms_keyword',
      opted_out_at: '2026-10-01T00:00:00Z',
    });
    await h.runJob('send_welcome', { reporterId: h.marco.id, siteId: SITE_RIVERSIDE });
    expect(h.sms).toEqual([]);
    expect(h.db.data.audit.find((a) => a.action === 'notify.skipped')).toMatchObject({
      diff: { reason: 'opted_out', detail: 'phone_opted_out' },
    });
    expect(h.db.data.notifications[0]!.body).toMatch(/opted out of texts/);
  });

  it('send_template uses free-form inside the window and the template outside, bumping reminder_stage', async () => {
    const h = createHarness();
    const convo = await h.conversation('idle');
    const day = await h.db.getOrCreateSiteDay(
      SITE_RIVERSIDE,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    await h.runJob('send_template', {
      conversationId: convo.id,
      template: 'sitelog_reminder_1',
      vars: { '1': 'Marco', '2': 'Riverside Lofts — Block B' },
      siteDayId: day.id,
      stage: 2,
    });
    expect(h.wa.sent[0]!.kind).toBe('buttons');
    expect(h.wa.sent[0]!.buttons!.map((b) => b.id)).toEqual([
      `rem:${day.id}:recording`,
      `rem:${day.id}:no_work`,
      `rem:${day.id}:weather`,
    ]);
    expect((await h.db.getSiteDay(day.id))!.reminder_stage).toBe(2);
    await h.db.updateConversation(convo.id, {
      last_inbound_at: new Date(h.now.getTime() - 25 * 3600_000),
    });
    await h.runJob('send_template', {
      conversationId: convo.id,
      template: 'sitelog_reminder_2',
      vars: { '1': '19:00' },
    });
    expect(h.wa.sent[1]!.kind).toBe('template');
  });

  it('retention_cleanup removes old audio/photos and transcripts, keeps the rest', async () => {
    const h = createHarness();
    const convo = await h.conversation('idle');
    const old = await h.inbound(convo, {
      type: 'audio',
      storage_path: 'o/s/d/old.ogg',
      created_at: '2023-01-01T00:00:00Z',
    });
    await h.storage.upload('audio', 'o/s/d/old.ogg', Buffer.from('x'), 'audio/ogg');
    await h.db.upsertTranscript({
      message_id: old.id,
      language: 'en',
      text: 'old',
      segments: [],
      model: 'w',
    });
    const fresh = await h.inbound(convo, { type: 'audio', storage_path: 'o/s/d/new.ogg' });
    await h.runJob('retention_cleanup', {});
    expect((await h.db.getMessage(old.id))!.storage_path).toBeNull();
    expect(await h.db.getTranscript(old.id)).toBeNull();
    expect(h.storage.files.has('audio/o/s/d/old.ogg')).toBe(false);
    expect((await h.db.getMessage(fresh.id))!.storage_path).toBe('o/s/d/new.ogg');
  });

  it('retention_cleanup deletes office uploads no report attached after a day', async () => {
    const h = createHarness();
    const now = h.ctx.now().getTime();
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const office = (name: string) => `${h.org.id}/site-1/office/${name}.jpg`;
    const objects = [
      { name: office('orphan'), created_at: ago(30) },
      { name: office('attached'), created_at: ago(30) },
      { name: office('just-uploaded'), created_at: ago(2) },
      { name: `${h.org.id}/site-1/2026-10-01/wa.jpg`, created_at: ago(30) },
    ];
    for (const o of objects) {
      h.db.data.photoObjects.push(o);
      await h.storage.upload('photos', o.name, Buffer.from('x'), 'image/jpeg');
    }
    const convo = await h.conversation('idle');
    const attached = await h.inbound(convo, { type: 'image', storage_path: office('attached') });
    h.db.data.messages.set(attached.id, {
      ...h.db.data.messages.get(attached.id)!,
      conversation_id: null,
      org_id: h.org.id,
      created_at: ago(30),
    });

    await h.runJob('retention_cleanup', {});
    expect(h.storage.files.has(`photos/${office('orphan')}`)).toBe(false);
    for (const name of [office('attached'), office('just-uploaded'), objects[3]!.name])
      expect(h.storage.files.has(`photos/${name}`)).toBe(true);
    expect(h.db.data.audit.at(-1)).toMatchObject({
      action: 'retention.cleanup',
      diff: { orphan_photos_removed: 1 },
    });
  });

  it('retention_cleanup deletes done jobs after 30 days and keeps recent, dead and queued ones', async () => {
    const h = createHarness();
    const now = h.ctx.now().getTime();
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const make = async (status: 'done' | 'dead' | 'queued', finishedDaysAgo: number | null) => {
      const id = await h.db.enqueueJob('weekly_digest', {
        orgId: h.org.id,
        weekStart: '2026-09-07',
      });
      Object.assign(h.db.data.jobs.get(id)!, {
        status,
        finished_at: finishedDaysAgo === null ? null : ago(finishedDaysAgo),
      });
      return id;
    };
    const oldDone = await make('done', 45);
    const recentDone = await make('done', 3);
    const oldDead = await make('dead', 45);
    const queued = await make('queued', null);
    await h.runJob('retention_cleanup', {});
    expect(h.db.data.jobs.has(oldDone)).toBe(false);
    for (const id of [recentDone, oldDead, queued]) expect(h.db.data.jobs.has(id)).toBe(true);
  });
});

describe('send_email: evidence pack ready', () => {
  const pack = (pdf_path: string) => ({
    id: 'pack-1',
    org_id: ORG_ID,
    site_id: SITE_OAKMONT,
    period_start: '2026-10-01',
    period_end: '2026-10-09',
    status: 'ready' as const,
    pdf_path,
    sections: ['summary'],
    error: null,
    created_by: null,
    created_at: '2026-10-09T20:00:00Z',
    ready_at: '2026-10-09T20:05:00Z',
  });

  it('signs a pack stored under its own org and site', async () => {
    const h = createHarness();
    const path = evidencePackStoragePath(ORG_ID, SITE_OAKMONT, '2026-10-01', '2026-10-09');
    h.db.data.packs.set('pack-1', pack(path));
    const email = await buildEmail(h.ctx, {
      kind: 'evidence_pack_ready',
      packId: 'pack-1',
      to: ['pm@kestrel.example'],
    });
    expect(email!.rendered.html).toContain(`memory://exports/${path}?signed=1`);
  });

  it("refuses to sign a path outside the pack's org and site (a row forged before 20261014000001)", async () => {
    const h = createHarness();
    h.db.data.packs.set(
      'pack-1',
      pack('bbbbbbbb-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000003/eot.pdf'),
    );
    await expect(
      buildEmail(h.ctx, { kind: 'evidence_pack_ready', packId: 'pack-1', to: ['pm@x.example'] }),
    ).rejects.toThrow(/outside its org and site/);
  });
});
