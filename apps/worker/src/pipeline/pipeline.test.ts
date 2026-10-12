import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deadlineInstant, type DailyReportData, type ExtractionOutput } from '@sitelog/shared';
import { postProcessExtraction, type ExtractionInput } from '../ai/extract';
import { compareReport } from '../ai/eval';
import { createHarness, scriptedClaude, SITE_OAKMONT, SITE_RIVERSIDE } from '../test/harness';
import { composeExtractionInput } from './compose';
import { currentData, draftCardFor, storeDraft } from './draft';
import { fileReport } from './file';
import { learnTerms } from './glossary';
import { selectNextQuestion, validateDraft } from './validate';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'fixtures');
const load = <T>(dir: string, id: string) =>
  JSON.parse(readFileSync(join(FIXTURES, dir, `${id}.json`), 'utf8')) as T;

describe('pipeline: validate + question selection', () => {
  it('riverside: the only gap is the Delta headcount, asked with the model options', () => {
    const input = load<ExtractionInput>('transcripts', 'riverside-2026-10-09');
    const { data } = postProcessExtraction(
      load<ExtractionOutput>('tool-outputs', 'riverside-2026-10-09'),
      input,
    );
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
      options: ['4 · full day', '5 · full day'],
    });
    expect(q!.prompt).toContain('the Delta guys');
  });

  it('oakmont: unknown company is flagged for review and asked with "Add"', () => {
    const input = load<ExtractionInput>('transcripts', 'oakmont-unknown-sub');
    const { data } = postProcessExtraction(
      load<ExtractionOutput>('tool-outputs', 'oakmont-unknown-sub'),
      input,
    );
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
    expect(q!.options[0]).toBe('Add "Ridgeway"');
  });

  it('expected fixtures pass the eval comparison against themselves and fail when numbers change', () => {
    for (const id of ['riverside-2026-10-09', 'oakmont-unknown-sub', 'hillcrest-weather-day']) {
      const expected = load<DailyReportData>('expected', id);
      expect(compareReport(expected, expected).every((c) => c.ok)).toBe(true);
    }
    const expected = load<DailyReportData>('expected', 'hillcrest-weather-day');
    const wrong = structuredClone(expected);
    wrong.manpower[0]!.workers = 6;
    wrong.weather.periods[0]!.lostHours = 7;
    const failed = compareReport(wrong, expected)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toEqual(['manpower Apex Concrete: workers', 'weather lostHours ±0.5']);
  });

  it('draft card matches the §F7 format', () => {
    const input = load<ExtractionInput>('transcripts', 'riverside-2026-10-09');
    const { data } = postProcessExtraction(
      load<ExtractionOutput>('tool-outputs', 'riverside-2026-10-09'),
      input,
    );
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
      claude: scriptedClaude([
        { input: load<ExtractionOutput>('tool-outputs', 'riverside-2026-10-09') },
      ]),
    });
    const siteDay = await h.db.getOrCreateSiteDay(
      SITE_RIVERSIDE,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    await h.db.updateSiteDay(siteDay.id, {
      weather: load<ExtractionInput>('transcripts', 'riverside-2026-10-09')
        .observedWeather as unknown as Record<string, unknown>,
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
    const fixture = load<ExtractionInput>('transcripts', 'riverside-2026-10-09');
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
      const scripted = scriptedClaude([
        { input: load<ExtractionOutput>('tool-outputs', 'riverside-2026-10-09') },
      ]);
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
      const fixture = load<ExtractionInput>('transcripts', 'riverside-2026-10-09');
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
    const fixture = load<ExtractionInput>('transcripts', 'elm-2026-10-08-no-work');
    await h.db.upsertTranscript({
      message_id: audio.id,
      language: 'en',
      text: fixture.segments.map((x) => x.text).join(' '),
      segments: fixture.segments.map((x) => ({ start: x.start, end: x.end, text: x.text })),
      model: 'whisper-1',
    });
    await storeDraft(h.ctx, report, load<DailyReportData>('expected', 'elm-2026-10-08-no-work'));

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
    const input = load<ExtractionInput>('transcripts', 'oakmont-unknown-sub');
    const { data } = postProcessExtraction(
      load<ExtractionOutput>('tool-outputs', 'oakmont-unknown-sub'),
      input,
    );
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
    expect((await h.db.getSiteDay(siteDay.id))!.report_id).toBe(report.id);
  });

  it('render_pdf stores the PDF, sends it on WhatsApp with the edit hint and enqueues the email', async () => {
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
    const input = load<ExtractionInput>('transcripts', 'riverside-2026-10-09');
    const { data } = postProcessExtraction(
      load<ExtractionOutput>('tool-outputs', 'riverside-2026-10-09'),
      input,
    );
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
    expect(h.wa.sent.map((s) => s.kind)).toEqual(['document', 'text']);
    expect(h.wa.sent[0]!.filename).toBe('RL-2041-0187_2026-10-09_v1.pdf');
    expect(h.wa.sent[1]!.body).toBe(
      'Need a change later? Reply "edit Friday" any time. The office gets a new version; the old one is kept.',
    );
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
  it('send_welcome sends the approved template and opens welcome_sent', async () => {
    const h = createHarness();
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    await h.runJob('send_welcome', { reporterId: h.marco.id, reinvite: false });
    expect(h.wa.sent[0]!.kind).toBe('template');
    const t = h.wa.sent[0]!.template as {
      name: string;
      components: Array<{ type: string; parameters: Array<{ text?: string; payload?: string }> }>;
    };
    expect(t.name).toBe('sitelog_welcome');
    expect(t.components[0]!.parameters.map((p) => p.text)).toEqual([
      'Marco',
      'Kestrel Build Group',
      'Riverside Lofts — Block B',
      '17:30',
    ]);
    expect(t.components[1]!.parameters[0]!.payload).toBe('welcome:ok');
    const convo = (await h.db.getConversationByPhone(h.marco.phone_e164))!;
    expect(convo.state).toBe('welcome_sent');
    expect(h.db.data.messages.size).toBe(1);
    expect(Array.from(h.db.data.messages.values())[0]!.template_name).toBe('sitelog_welcome');
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
