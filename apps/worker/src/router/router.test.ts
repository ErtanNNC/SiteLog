import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ButtonIds,
  deadlineInstant,
  type DailyReportDataV1,
  type ExtractionOutput,
} from '@sitelog/shared';
import { postProcessExtraction, type ExtractionInput } from '../ai/extract';
import { storeDraft } from '../pipeline/draft';
import {
  buttonPayload,
  createHarness,
  PHONE_JORGE,
  PHONE_UNKNOWN,
  reactionPayload,
  scriptedClaude,
  SITE_OAKMONT,
  SITE_RIVERSIDE,
  type Harness,
} from '../test/harness';
import { contextOf } from './context';
import { runTimeoutSweep } from './timeouts';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'fixtures');
const riversideInput = JSON.parse(
  readFileSync(join(FIXTURES, 'transcripts', 'riverside-2026-10-09.json'), 'utf8'),
) as ExtractionInput;
const riversideOutput = JSON.parse(
  readFileSync(join(FIXTURES, 'tool-outputs', 'riverside-2026-10-09.json'), 'utf8'),
) as ExtractionOutput;
const replies = JSON.parse(
  readFileSync(join(FIXTURES, 'tool-outputs', 'replies.json'), 'utf8'),
) as Record<string, Record<string, unknown>>;

/** A report for Marco at Riverside on Fri Oct 9 in the given state with the fixture draft. */
async function seedReport(
  h: Harness,
  status: 'awaiting_confirmation' | 'awaiting_answer' | 'filed' | 'signed_off',
  data?: DailyReportDataV1,
) {
  const date = '2026-10-09';
  const siteDay = await h.db.getOrCreateSiteDay(
    SITE_RIVERSIDE,
    date,
    deadlineInstant(date, '17:30', 'America/Chicago'),
  );
  const report = await h.db.insertReport({
    org_id: h.org.id,
    site_id: SITE_RIVERSIDE,
    site_day_id: siteDay.id,
    report_no: await h.db.nextReportNo(SITE_RIVERSIDE),
    reporter_id: h.marco.id,
    received_at: '2026-10-09T22:31:00Z',
    kind: 'daily',
    status: status === 'signed_off' ? 'filed' : status,
  });
  const draft = data ?? postProcessExtraction(riversideOutput, riversideInput).data;
  await storeDraft(h.ctx, report, draft);
  const convo = await h.conversation('idle');
  const audio = await h.inbound(convo, {
    type: 'audio',
    storage_path: `${h.org.id}/${SITE_RIVERSIDE}/${date}/a.ogg`,
    duration_s: 168,
    created_at: '2026-10-09T22:31:00Z',
  });
  await h.db.insertReportSource({
    report_id: report.id,
    message_id: audio.id,
    kind: 'audio',
    taken_at: audio.created_at,
  });
  const photo = await h.inbound(convo, {
    type: 'image',
    storage_path: `${h.org.id}/${SITE_RIVERSIDE}/${date}/p.jpg`,
    created_at: '2026-10-09T22:31:40Z',
  });
  await h.db.insertReportSource({
    report_id: report.id,
    message_id: photo.id,
    kind: 'photo',
    taken_at: photo.created_at,
  });
  if (status === 'filed' || status === 'signed_off') {
    await h.db.updateReport(report.id, {
      status,
      filed_at: '2026-10-09T22:43:00Z',
      confirmed_at: '2026-10-09T22:43:00Z',
      ...(status === 'signed_off'
        ? {
            signed_off_by: '00000000-0000-4000-8000-00000000e002',
            signed_off_at: '2026-10-10T01:10:00Z',
          }
        : {}),
    });
    await h.db.updateSiteDay(siteDay.id, { status: 'filed', report_id: report.id });
  }
  return { report: (await h.db.getReport(report.id))!, siteDay, convo, draft };
}

describe('router: unknown number (F11)', () => {
  it('holds the message, records the sender and replies once', async () => {
    const h = createHarness();
    const convo = await h.conversation('new', {}, PHONE_UNKNOWN);
    await h.send(convo, {
      type: 'text',
      body: 'this is Luis, covering Elm St. today, 4 guys on site',
    });
    expect(h.sentTexts()).toEqual([
      "Hi — this number isn't set up with SiteLog yet, so nothing was filed. Ask your office to add your number.",
    ]);
    const sender = await h.db.findPendingUnknownSender(PHONE_UNKNOWN);
    expect(sender?.snippet).toContain('Luis');
    expect(Array.from(h.db.data.reports.values())).toHaveLength(0);
    await h.send(convo, { type: 'text', body: 'hello?' });
    expect(h.wa.sent).toHaveLength(1);
  });

  it('guesses the site from the content and tells the office', async () => {
    const h = createHarness();
    const convo = await h.conversation('new', {}, PHONE_UNKNOWN);
    await h.send(convo, { type: 'text', body: 'Riverside Lofts report: Apex had 6 guys' });
    expect(h.sentTexts()[0]).toContain("I've let the office know");
    expect((await h.db.findPendingUnknownSender(PHONE_UNKNOWN))?.guessed_site_id).toBe(
      SITE_RIVERSIDE,
    );
    expect(h.db.data.notifications.map((n) => n.kind)).toContain('unknown_sender');
  });
});

describe('router: welcome and test mode (F3, F4)', () => {
  it('verifies the reporter on "Got it" and opens test mode', async () => {
    const h = createHarness();
    h.db.data.reporters.get(h.marco.id)!.status = 'invited';
    h.db.data.reporters.get(h.marco.id)!.verified_at = null;
    const convo = await h.conversation('welcome_sent');
    await h.send(convo, {
      type: 'interactive',
      body: 'Got it',
      payload: buttonPayload(ButtonIds.welcomeOk(), 'Got it'),
    });
    expect((await h.db.getReporter(h.marco.id))!.status).toBe('verified');
    expect((await h.db.getConversation(convo.id))!.state).toBe('test_mode');
    expect(h.sentTexts()[0]).toContain('Speak Spanish or English');
    expect(h.db.data.audit.map((a) => a.action)).toContain('reporter.verified');
  });

  it('"Wrong site" tells the office and parks the conversation', async () => {
    const h = createHarness();
    const convo = await h.conversation('welcome_sent');
    await h.send(convo, {
      type: 'interactive',
      body: 'Wrong site',
      payload: buttonPayload(ButtonIds.welcomeWrongSite(), 'Wrong site'),
    });
    expect(h.sentTexts()).toEqual(["Thanks — I've told the office."]);
    const c = (await h.db.getConversation(convo.id))!;
    expect(c.state).toBe('idle');
    expect(contextOf(c).site_disputed).toBe(true);
    expect(h.db.data.notifications[0]?.kind).toBe('reporter_wrong_site');
  });

  it('a text in test mode gets the voice nudge and moves to idle; audio is transcribed only', async () => {
    const h = createHarness();
    const convo = await h.conversation('test_mode');
    await h.send(convo, { type: 'text', body: 'testing' });
    expect(h.sentTexts()[0]).toContain('voice is faster');
    expect((await h.db.getConversation(convo.id))!.state).toBe('idle');
    const convo2 = await h.conversation('test_mode');
    await h.send(convo2, { type: 'audio' });
    const jobs = h.db.jobsOfType('transcribe_audio');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ testMode: true });
    expect(Array.from(h.db.data.reports.values())).toHaveLength(0);
  });
});

describe('router: intake (F5, F12)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('creates the report, acks with duration and photos, stores media and enqueues transcription', async () => {
    const convo = await h.conversation('idle');
    const audio = await h.send(convo, { type: 'audio' });
    const c = (await h.db.getConversation(convo.id))!;
    expect(c.state).toBe('processing');
    const report = Array.from(h.db.data.reports.values())[0]!;
    expect(report.report_no).toBe('RL-2041-0187');
    expect(report.status).toBe('collecting');
    expect(contextOf(c).active_report_id).toBe(report.id);
    expect(h.sentTexts()).toEqual(['Got it, Marco — 2 s.']);
    const stored = (await h.db.getMessage(audio.id))!;
    expect(stored.storage_path).toBe(`${h.org.id}/${SITE_RIVERSIDE}/2026-10-09/${audio.id}.ogg`);
    expect(stored.duration_s).toBe(2);
    expect((stored.payload as { peaks: number[] }).peaks).toHaveLength(64);
    expect(h.db.jobsOfType('transcribe_audio')[0]!.payload).toMatchObject({
      messageId: audio.id,
      reportId: report.id,
    });
    const day = await h.db.findSiteDay(SITE_RIVERSIDE, '2026-10-09');
    expect(day!.status).toBe('processing');
    await h.send(convo, { type: 'image', body: 'L4 pour done' });
    expect(h.sentTexts()[1]).toBe("Got it — adding that to today's report.");
    expect((await h.db.listReportSources(report.id)).map((s) => s.kind)).toEqual([
      'audio',
      'photo',
    ]);
  });

  it('a photo on a day already logged as no work says so instead of opening a report', async () => {
    const convo = await h.conversation('idle');
    await h.send(convo, { type: 'text', body: 'no work today' });
    expect(h.sentTexts().at(-1)).toMatch(/^Noted — no work today at /);
    await h.send(convo, { type: 'image' });
    expect(h.sentTexts().at(-1)).toMatch(
      /^Got the photo\. Today is logged as no work at .+; if the crew did work, send a quick voice note\.$/,
    );
    expect(
      Array.from(h.db.data.reports.values()).filter(
        (r) => r.status !== 'void' && r.kind === 'daily',
      ),
    ).toHaveLength(0);
  });

  it('photos only → asks for a voice note; the later voice note merges into the same report', async () => {
    const convo = await h.conversation('idle');
    await h.send(convo, { type: 'image' });
    expect(h.sentTexts()).toEqual([
      "Got the photos. Send a quick voice note with today's work, crew and weather.",
    ]);
    expect((await h.db.getConversation(convo.id))!.state).toBe('idle');
    await h.send(convo, { type: 'audio' });
    expect(Array.from(h.db.data.reports.values())).toHaveLength(1);
    expect(h.sentTexts()[1]).toContain('Got it, Marco');
  });

  it('asks "today or yesterday?" before noon and continues after the tap', async () => {
    h.setNow(new Date('2026-10-09T13:15:00Z')); // 08:15 Chicago
    const convo = await h.conversation('idle');
    const audio = await h.send(convo, { type: 'audio' });
    expect(h.sentTexts()).toEqual(['Is this for today (Oct 9) or yesterday (Oct 8)?']);
    expect(h.wa.sent[0]!.buttons!.map((b) => b.id)).toEqual(['day:2026-10-09', 'day:2026-10-08']);
    expect(Array.from(h.db.data.reports.values())).toHaveLength(0);
    await h.send(convo, {
      type: 'interactive',
      body: 'Thursday',
      payload: buttonPayload('day:2026-10-08', 'Thursday'),
    });
    const report = Array.from(h.db.data.reports.values())[0]!;
    expect((await h.db.getSiteDay(report.site_day_id))!.date).toBe('2026-10-08');
    expect((await h.db.listReportSources(report.id))[0]!.message_id).toBe(audio.id);
    expect(h.sentTexts()[1]).toContain('Got it, Marco');
  });

  it('multi-site reporter gets the picker unless the text names the site', async () => {
    const h2 = createHarness({ multiSiteForMarco: true });
    const convo = await h2.conversation('idle');
    await h2.send(convo, { type: 'audio' });
    expect(h2.sentTexts()).toEqual(['Which site is this for?']);
    expect(h2.wa.sent[0]!.buttons!.map((b) => b.id)).toEqual([
      `site:${SITE_RIVERSIDE}`,
      `site:${SITE_OAKMONT}`,
    ]);
    expect((await h2.db.getConversation(convo.id))!.state).toBe('selecting_site');
    await h2.send(convo, {
      type: 'interactive',
      body: 'Oakmont Medical',
      payload: buttonPayload(ButtonIds.site(SITE_OAKMONT), 'Oakmont Medical'),
    });
    const report = Array.from(h2.db.data.reports.values())[0]!;
    expect(report.site_id).toBe(SITE_OAKMONT);
    expect(report.report_no).toBe('OM-1187-0121');
    expect((await h2.db.getConversation(convo.id))!.state).toBe('processing');

    const h3 = createHarness({ multiSiteForMarco: true });
    const convo3 = await h3.conversation('idle');
    await h3.send(convo3, { type: 'image', body: 'Riverside, slab pour done on four' });
    expect(Array.from(h3.db.data.reports.values())[0]!.site_id).toBe(SITE_RIVERSIDE);
  });

  it('backup reporter linked to two sites of the same org also gets a list when > 3 sites', async () => {
    const convo = await h.conversation('idle', {}, PHONE_JORGE);
    await h.send(convo, { type: 'audio' });
    expect(h.wa.sent[0]!.kind).toBe('buttons');
    expect(h.wa.sent[0]!.buttons).toHaveLength(2);
  });

  it('paused site → site paused copy, nothing created', async () => {
    h.db.data.sites.get(SITE_RIVERSIDE)!.status = 'paused';
    const convo = await h.conversation('idle');
    await h.send(convo, { type: 'audio' });
    expect(h.sentTexts()).toEqual([
      'Riverside Lofts — Block B is paused in SiteLog. Ask the office to resume it.',
    ]);
    expect(Array.from(h.db.data.reports.values())).toHaveLength(0);
  });
});

describe('router: global commands', () => {
  it('help, stop and language work in idle', async () => {
    const h = createHarness();
    const convo = await h.conversation('idle');
    await h.send(convo, { type: 'text', body: 'help' });
    expect(h.sentTexts()[0]).toContain('Send one voice note a day');
    await h.send(convo, { type: 'text', body: 'stop' });
    expect(h.sentTexts()[1]).toBe('OK — no more reminders today.');
    const day = await h.db.findSiteDay(SITE_RIVERSIDE, '2026-10-09');
    expect(day!.reminders_paused).toBe(true);
    expect(h.db.data.audit.map((a) => a.action)).toContain('site_day.reminders_paused');
    await h.send(convo, { type: 'text', body: 'language es' });
    expect(h.sentTexts()[2]).toContain('Spanish');
  });

  it('"no work today" marks the site-day no_work', async () => {
    const h = createHarness();
    const convo = await h.conversation('idle');
    await h.send(convo, { type: 'text', body: 'no work today' });
    expect(h.sentTexts()).toEqual(['Noted — no work today at Riverside Lofts — Block B.']);
    const day = await h.db.findSiteDay(SITE_RIVERSIDE, '2026-10-09');
    expect(day!.status).toBe('no_work');
    expect(Array.from(h.db.data.reports.values())).toHaveLength(0);
    expect(h.db.data.audit.map((a) => a.action)).toContain('site_day.no_work');
  });
});

describe('router: reminder buttons (F9, F10)', () => {
  it('Recording now → listening; Site closed: weather → weather day report + follow-up', async () => {
    const h = createHarness();
    const convo = await h.conversation('idle');
    const day = await h.db.getOrCreateSiteDay(
      SITE_RIVERSIDE,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    await h.send(convo, {
      type: 'interactive',
      body: 'Recording now',
      payload: { button: { payload: ButtonIds.reminderRecording(day.id), text: 'Recording now' } },
    });
    expect(h.sentTexts()).toEqual(["Great — I'm listening."]);
    await h.send(convo, {
      type: 'interactive',
      body: 'Site closed: weather',
      payload: {
        button: { payload: ButtonIds.reminderWeather(day.id), text: 'Site closed: weather' },
      },
    });
    const texts = h.sentTexts();
    expect(texts[1]).toBe(
      "Logged as a weather day: no work because of weather. It's now in the delay record for extension claims.",
    );
    expect(texts[2]).toContain('How many were on site this morning?');
    expect(h.wa.sent[2]!.buttons!.map((b) => b.title)).toEqual(['Send photo', 'Answer by voice']);
    const report = Array.from(h.db.data.reports.values())[0]!;
    expect(report.kind).toBe('weather_day');
    expect(report.status).toBe('filed');
    expect((await h.db.getSiteDay(day.id))!.status).toBe('weather_day');
    const data = (await h.db.getVersion(report.id, 1))!.data as DailyReportDataV1;
    expect(data.weather.periods[0]).toMatchObject({ fullDay: true, lostHours: 8 });
    expect(h.db.data.denormalized).toContainEqual({ report_id: report.id, version: 1 });
    // The follow-up photo goes into the delay record as a new version.
    await h.send(convo, { type: 'image' });
    expect(h.sentTexts()[3]).toBe('Thanks — the photo is in the delay record.');
    expect((await h.db.getReport(report.id))!.current_version).toBe(2);
  });

  it('No work today from the reminder marks the day', async () => {
    const h = createHarness();
    const convo = await h.conversation('idle');
    const day = await h.db.getOrCreateSiteDay(
      SITE_RIVERSIDE,
      '2026-10-09',
      deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
    );
    await h.send(convo, {
      type: 'interactive',
      body: 'No work today',
      payload: { button: { payload: ButtonIds.reminderNoWork(day.id), text: 'No work today' } },
    });
    expect((await h.db.getSiteDay(day.id))!.status).toBe('no_work');
  });
});

describe('router: draft confirmation and filing (F7)', () => {
  it('OK button files the report: version frozen, PDF job, filed copy, idle', async () => {
    const h = createHarness();
    const { report, siteDay, convo } = await seedReport(h, 'awaiting_confirmation');
    await h.db.updateConversation(convo.id, {
      state: 'awaiting_confirmation',
      context: { active_report_id: report.id, draft_wa_message_id: 'wamid.draft' },
    });
    await h.send(convo, {
      type: 'interactive',
      body: 'OK, file it',
      payload: buttonPayload(ButtonIds.draftOk(report.id), 'OK, file it'),
    });
    const fileJobs = h.db.jobsOfType('file_report');
    expect(fileJobs).toHaveLength(1);
    expect(fileJobs[0]!.payload).toMatchObject({ reportId: report.id, trigger: 'confirm' });
    await h.drain(['file_report']);
    const filed = (await h.db.getReport(report.id))!;
    expect(filed.status).toBe('filed');
    expect(filed.filed_at).toBe(h.now.toISOString());
    expect(filed.confirmed_at).toBe(h.now.toISOString());
    expect(filed.is_late).toBe(true); // 17:31 > 17:30 deadline
    expect(filed.needs_review).toBe(true);
    expect(filed.review_reasons).toEqual([
      'missing:manpower.workers:Delta Mechanical',
      'missing:manpower.hours:Delta Mechanical',
    ]);
    expect((await h.db.getSiteDay(siteDay.id))!.status).toBe('filed');
    expect(h.db.data.denormalized).toEqual([{ report_id: report.id, version: 1 }]);
    const render = h.db.jobsOfType('render_pdf')[0]!;
    expect(render.payload).toMatchObject({
      reportId: report.id,
      version: 1,
      sendToWhatsApp: true,
      emailRecipients: true,
    });
    expect(render.dedupe_key).toBe(`render_pdf:${report.id}:1`);
    expect(h.sentTexts()).toEqual([
      "Filed. Daily Report RL-2041-0187 is with the office. Thanks, Marco — that's it for today.",
    ]);
    expect((await h.db.getConversation(convo.id))!.state).toBe('idle');
    expect(h.db.data.audit.map((a) => a.action)).toContain('report.filed');
    expect(h.db.data.notifications.some((n) => n.kind === 'needs_review')).toBe(true);
  });

  it('"ok" text and a thumbs-up reaction on the draft also file', async () => {
    const h = createHarness();
    const { report, convo } = await seedReport(h, 'awaiting_confirmation');
    await h.db.updateConversation(convo.id, {
      state: 'awaiting_confirmation',
      context: { active_report_id: report.id, draft_wa_message_id: 'wamid.draft' },
    });
    await h.send(convo, { type: 'reaction', payload: reactionPayload('👍', 'wamid.draft') });
    expect(h.db.jobsOfType('file_report')).toHaveLength(1);
    const h2 = createHarness();
    const s2 = await seedReport(h2, 'awaiting_confirmation');
    await h2.db.updateConversation(s2.convo.id, {
      state: 'awaiting_confirmation',
      context: { active_report_id: s2.report.id },
    });
    await h2.send(s2.convo, { type: 'text', body: 'dale' });
    expect(h2.db.jobsOfType('file_report')).toHaveLength(1);
  });

  it('a fix is parsed, patched and the draft resent (model mocked)', async () => {
    const h = createHarness({
      claude: scriptedClaude([
        { input: replies.classify_reply!['fix-apex'] },
        { input: replies.apply_correction!['apex-6-to-7'] },
      ]),
    });
    const { report, convo } = await seedReport(h, 'awaiting_confirmation');
    await h.db.updateConversation(convo.id, {
      state: 'awaiting_confirmation',
      context: { active_report_id: report.id },
    });
    await h.send(convo, { type: 'text', body: 'Apex had 7 not 6' });
    const data = (await h.db.getVersion(report.id, 1))!.data as DailyReportDataV1;
    expect(data.manpower[0]).toMatchObject({
      companyName: 'Apex Concrete',
      workers: 7,
      totalHours: 56,
    });
    const last = h.wa.sent[h.wa.sent.length - 1]!;
    expect(last.body).toContain('DRAFT · FRI OCT 9');
    expect(last.body).toContain('headcount pending'); // Delta is still unanswered
    expect(last.buttons!.map((b) => b.id)).toEqual([
      ButtonIds.draftOk(report.id),
      ButtonIds.draftFix(report.id),
    ]);
    expect((await h.db.getConversation(convo.id))!.state).toBe('awaiting_confirmation');
    expect(h.db.data.audit.map((a) => a.action)).toContain('report.draft_corrected');
  });

  it('Fix something button asks what to change', async () => {
    const h = createHarness();
    const { report, convo } = await seedReport(h, 'awaiting_confirmation');
    await h.db.updateConversation(convo.id, {
      state: 'awaiting_confirmation',
      context: { active_report_id: report.id },
    });
    await h.send(convo, {
      type: 'interactive',
      body: 'Fix something',
      payload: buttonPayload(ButtonIds.draftFix(report.id), 'Fix something'),
    });
    expect(h.sentTexts()).toEqual(['What should I change?']);
  });
});

describe('router: questions (F6)', () => {
  it('decide_next asks the Delta headcount; a button answer applies and acks; then the draft follows', async () => {
    const h = createHarness();
    const { report, convo } = await seedReport(h, 'awaiting_answer');
    await h.db.updateReport(report.id, { status: 'collecting' });
    await h.db.updateConversation(convo.id, {
      state: 'processing',
      context: { active_report_id: report.id },
    });
    await h.runJob('decide_next', { reportId: report.id });
    const q = (await h.db.listQuestions(report.id))[0]!;
    expect(q.field).toBe('manpower.workers');
    expect(h.sentTexts()[0]).toBe(
      "Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?",
    );
    expect(h.wa.sent[0]!.buttons!.map((b) => b.title)).toEqual([
      '4 · full day',
      '5 · full day',
      'Other…',
    ]);
    expect((await h.db.getConversation(convo.id))!.state).toBe('awaiting_answer');
    await h.send(convo, {
      type: 'interactive',
      body: '5 · full day',
      payload: buttonPayload(ButtonIds.question(q.id, 1), '5 · full day'),
    });
    expect(h.sentTexts()[1]).toBe('Thanks — Delta Mechanical: 5 workers × 8 h = 40 h.');
    const answered = (await h.db.getQuestion(q.id))!;
    expect(answered.answered_at).not.toBeNull();
    await h.drain(['decide_next']);
    const data = (await h.db.getVersion(report.id, 1))!.data as DailyReportDataV1;
    expect(data.manpower[2]).toMatchObject({
      workers: 5,
      totalHours: 40,
      hoursBasis: 'full_day_default',
    });
    expect(h.sentTexts()[2]).toContain('CREW      23 on site · 4 subs · 184 h');
    expect((await h.db.getConversation(convo.id))!.state).toBe('awaiting_confirmation');
  });

  it('"Other…" asks for a free answer; free text goes through parseQuickAnswer', async () => {
    const h = createHarness();
    const { report, convo } = await seedReport(h, 'awaiting_answer');
    await h.db.updateReport(report.id, { status: 'collecting' });
    await h.db.updateConversation(convo.id, {
      state: 'processing',
      context: { active_report_id: report.id },
    });
    await h.runJob('decide_next', { reportId: report.id });
    const q = (await h.db.listQuestions(report.id))[0]!;
    await h.send(convo, {
      type: 'interactive',
      body: 'Other…',
      payload: buttonPayload(ButtonIds.question(q.id, 'other'), 'Other…'),
    });
    expect(h.sentTexts()[1]).toBe('Tell me in a voice note or text.');
    await h.send(convo, { type: 'text', body: 'six guys till 3' });
    expect(h.sentTexts()[2]).toBe('Thanks — Delta Mechanical: 6 workers × 8 h = 48 h.');
  });

  it('unanswered after 60 minutes → draft with the gap flagged', async () => {
    const h = createHarness();
    const { report, convo } = await seedReport(h, 'awaiting_answer');
    await h.db.updateReport(report.id, { status: 'collecting' });
    await h.db.updateConversation(convo.id, {
      state: 'processing',
      context: { active_report_id: report.id },
    });
    await h.runJob('decide_next', { reportId: report.id });
    h.setNow(new Date(h.now.getTime() + 61 * 60_000));
    const r = await runTimeoutSweep(h.ctx);
    expect(r.answered).toBe(1);
    await h.drain(['decide_next']);
    expect((await h.db.getConversation(convo.id))!.state).toBe('awaiting_confirmation');
    expect(h.sentTexts()[1]).toContain('headcount pending');
    h.setNow(new Date(h.now.getTime() + 31 * 60_000));
    expect((await runTimeoutSweep(h.ctx)).nudged).toBe(1);
    expect(h.sentTexts()[2]).toContain('Still waiting on your OK');
    h.setNow(new Date(h.now.getTime() + 2 * 60 * 60_000));
    expect((await runTimeoutSweep(h.ctx)).filed).toBe(1);
    await h.drain(['file_report']);
    const filed = (await h.db.getReport(report.id))!;
    expect(filed.status).toBe('filed');
    expect(filed.review_reasons).toEqual(
      expect.arrayContaining(['unanswered:manpower.workers', 'unconfirmed']),
    );
    expect(h.sentTexts()[3]).toContain('without your OK');
  });

  it('auto_15min files 15 minutes after the draft', async () => {
    const h = createHarness({ settings: { filing_mode: 'auto_15min' } });
    const { report, convo } = await seedReport(h, 'awaiting_confirmation');
    await h.db.updateConversation(convo.id, {
      state: 'awaiting_confirmation',
      context: { active_report_id: report.id, draft_sent_at: h.now.toISOString() },
    });
    h.setNow(new Date(h.now.getTime() + 16 * 60_000));
    expect((await runTimeoutSweep(h.ctx)).filed).toBe(1);
    expect(h.db.jobsOfType('file_report')[0]!.payload).toMatchObject({ trigger: 'auto' });
  });
});

describe('router: edit after filing (F8)', () => {
  it('"edit Friday — Apex was 7 guys, not 6" creates version 2, re-renders and emails', async () => {
    const h = createHarness({
      claude: scriptedClaude([{ input: replies.apply_correction!['apex-6-to-7'] }]),
      now: new Date('2026-10-10T01:10:00Z'),
    });
    const { report, convo } = await seedReport(h, 'filed');
    await h.send(convo, { type: 'text', body: 'edit Friday — Apex was 7 guys, not 6' });
    const updated = (await h.db.getReport(report.id))!;
    expect(updated.current_version).toBe(2);
    const v2 = (await h.db.getVersion(report.id, 2))!;
    expect(v2.author).toBe('reporter_reply');
    expect(v2.change_note).toBe('Apex Concrete 6 → 7 workers');
    expect((v2.data as DailyReportDataV1).manpower[0]!.totalHours).toBe(56);
    expect(h.sentTexts()).toEqual([
      'Updated Friday: Apex Concrete 6 → 7 workers. Version 2 sent to the office · version 1 kept in history.',
    ]);
    expect(h.db.jobsOfType('render_pdf')[0]!.payload).toMatchObject({
      reportId: report.id,
      version: 2,
      emailRecipients: true,
      changeNote: 'Apex Concrete 6 → 7 workers',
    });
    expect(h.db.data.denormalized).toContainEqual({ report_id: report.id, version: 2 });
    expect((await h.db.getConversation(convo.id))!.state).toBe('idle');
  });

  it('reverts a signed-off report to filed and notifies the signer', async () => {
    const h = createHarness({
      claude: scriptedClaude([{ input: replies.apply_correction!['apex-6-to-7'] }]),
      now: new Date('2026-10-12T20:00:00Z'),
    });
    const { report, convo } = await seedReport(h, 'signed_off');
    await h.send(convo, { type: 'text', body: 'edit Friday Apex was 7' });
    const updated = (await h.db.getReport(report.id))!;
    expect(updated.status).toBe('filed');
    expect(updated.signed_off_by).toBeNull();
    expect(h.db.data.notifications.find((n) => n.kind === 'report_edited')?.user_id).toBe(
      '00000000-0000-4000-8000-00000000e002',
    );
    expect(
      h.db
        .jobsOfType('send_email')
        .some((j) => (j.payload as { kind: string }).kind === 'report_edited_after_signoff'),
    ).toBe(true);
    expect(h.db.data.audit.map((a) => a.action)).toContain('report.signoff_reverted');
  });

  it('reports older than 14 days are locked; unknown days get a question', async () => {
    const h = createHarness({ now: new Date('2026-10-30T20:00:00Z') });
    const { convo } = await seedReport(h, 'filed');
    await h.send(convo, { type: 'text', body: 'edit Oct 9 Apex was 7' });
    expect(h.sentTexts()).toEqual(['That report is locked. Ask the office to change it.']);
    await h.send(convo, { type: 'text', body: 'edit Tuesday Apex was 7' });
    expect(h.sentTexts()[1]).toBe("I couldn't find a report for that day. Which day do you mean?");
  });

  it('"edit Friday" alone asks what to change, then applies the next message', async () => {
    const h = createHarness({
      claude: scriptedClaude([
        { input: replies.classify_reply!['fix-apex'] },
        { input: replies.apply_correction!['apex-6-to-7'] },
      ]),
      now: new Date('2026-10-10T01:10:00Z'),
    });
    const { report, convo } = await seedReport(h, 'filed');
    await h.send(convo, { type: 'text', body: 'edit Friday' });
    expect(h.sentTexts()).toEqual(['What should I change?']);
    expect((await h.db.getConversation(convo.id))!.state).toBe('editing');
    await h.send(convo, { type: 'text', body: 'Apex had 7 not 6' });
    expect((await h.db.getReport(report.id))!.current_version).toBe(2);
  });
});

describe('router: weather day by text (F10)', () => {
  it('"rained out, sent the crew home at 11" logs a partial weather day with the headcount', async () => {
    const h = createHarness({
      claude: scriptedClaude([
        { input: replies.classify_reply!['rained-out'] },
        { input: replies.classify_day_off!['rained-out-11'] },
      ]),
    });
    const convo = await h.conversation('idle');
    await h.send(convo, {
      type: 'text',
      body: 'rained out, 9 guys this morning, sent the crew home at 11',
    });
    expect(h.sentTexts()[0]).toBe(
      "Logged as a weather day: crew released 11:00, cause rain. It's now in the delay record for extension claims.",
    );
    const report = Array.from(h.db.data.reports.values())[0]!;
    const data = (await h.db.getVersion(report.id, 1))!.data as DailyReportDataV1;
    expect(data.weather.periods[0]).toMatchObject({
      start: '11:00',
      end: '15:30',
      lostHours: 4.5,
      fullDay: false,
    });
    expect(data.manpower[0]).toMatchObject({
      companyName: 'Site crew',
      workers: 9,
      hoursPerWorker: 4,
      totalHours: 36,
    });
    expect((await h.db.findSiteDay(SITE_RIVERSIDE, '2026-10-09'))!.status).toBe('weather_day');
  });
});

describe('router: idempotency and dead jobs', () => {
  it('routes a message only once', async () => {
    const h = createHarness();
    const convo = await h.conversation('idle');
    const m = await h.send(convo, { type: 'text', body: 'help' });
    await h.runJob('inbound_message', { messageId: m.id });
    expect(h.sentTexts()).toHaveLength(1);
  });
});
