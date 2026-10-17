import { formatTimeInTz } from '@sitelog/shared/format.ts';
import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { makeSource } from '@/test/render';
import { applySimEvents, buildSimContext } from './adapter';
import {
  correctDraft,
  liveButtonIds,
  sendPhoto,
  sendScenarioNote,
  sendText,
  startSession,
  tapButton,
  type ChatMessage,
  type SimStep,
} from './engine';
import { SCENARIOS, scenarioById, type ScenarioId } from './scenarios';

/** A session over a fresh store; every step's effects are written to the store like the page does. */
function sim(id: ScenarioId, store = new DemoStore()) {
  const scenario = scenarioById(id)!;
  const ctx = buildSimContext(store, scenario, 'test')!;
  let current: SimStep = startSession(ctx, scenario);
  applySimEvents(store, ctx, current.events);
  const run = (next: SimStep) => {
    applySimEvents(store, ctx, next.events);
    current = next;
    return next.events
      .filter((e) => e.kind === 'message')
      .map((e) => (e as { message: ChatMessage }).message);
  };
  return {
    store,
    ctx,
    get state() {
      return current.state;
    },
    note: () => run(sendScenarioNote(current.state)),
    photo: () => run(sendPhoto(current.state)),
    text: (t: string) => run(sendText(current.state, t)),
    tap: (title: string) => {
      const live = liveButtonIds(current.state);
      const b = [...current.state.messages]
        .reverse()
        .filter((m) => live.has(m.id))
        .flatMap((m) => m.buttons ?? [])
        .find((x) => x.title === title);
      if (!b) throw new Error(`No live button "${title}"`);
      return run(tapButton(current.state, b.id));
    },
    liveTitles: () => {
      const live = liveButtonIds(current.state);
      return current.state.messages
        .filter((m) => live.has(m.id))
        .flatMap((m) => m.buttons ?? [])
        .map((b) => b.title);
    },
  };
}

const agentTexts = (msgs: ChatMessage[]) =>
  msgs.filter((m) => m.from === 'agent').map((m) => m.text);
const byTag = (msgs: ChatMessage[], tag: string) => msgs.find((m) => m.tag === tag);
const todayReport = (store: DemoStore, siteId: string) => {
  const info = store.fieldDay(siteId);
  return store.data.reports.find((r) => r.id === info.reportId);
};

describe('field simulator engine', () => {
  it('starts with an intro note and the scenario ready to send', () => {
    const s = sim('riverside-2026-10-09');
    expect(s.state.messages).toHaveLength(1);
    expect(s.state.messages[0]!.note?.key).toBe('intro');
    expect(s.ctx.today.needsReset).toBe(true);
    expect(s.ctx.today.reportNo).toBe('RL-2041-0187');
  });

  it('hero: ack, progress, Delta question, answer, draft, OK → filed RL-2041-0187 in the store', () => {
    const s = sim('riverside-2026-10-09');
    const first = s.note();
    expect(first[0]!.note?.key).toBe('replaced');
    // One inbound job per WhatsApp message (worker router): the note is acked alone, then each
    // photo merges into the report being processed.
    expect(byTag(first, 'ack')!.text).toBe('Got it, Marco — 2 min 48 s.');
    expect(
      agentTexts(first).filter((x) => x === "Got it — adding that to today's report."),
    ).toHaveLength(2);
    expect(byTag(first, 'progress')!.text).toBe(
      'Writing your report…\n- Transcribed, site noise removed\n- Rain 07:00–10:30 logged as delay\n- Checking subcontractor hours…',
    );
    const q = byTag(first, 'question')!;
    expect(q.text).toBe(
      "Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?",
    );
    expect(q.buttons!.map((b) => b.title)).toEqual(['4 · full day', '5 · full day', 'Other…']);
    // While the question is open the office sees the day as Awaiting.
    expect(s.store.fieldDay(s.ctx.site.id).status).toBe('processing');

    const answered = s.tap('5 · full day');
    expect(agentTexts(answered)[0]).toBe('Thanks — Delta Mechanical: 5 workers × 8 h = 40 h.');
    const draft = byTag(answered, 'draft')!;
    expect(draft.text).toContain('CREW      23 on site · 4 subs · 184 h');
    expect(draft.text).toContain('DRAFT · FRI OCT 9');
    expect(draft.text.endsWith('Reply OK to file it, or tell me what to fix.')).toBe(true);
    expect(draft.buttons!.map((b) => b.title)).toEqual(['OK, file it', 'Fix something']);

    const filed = s.tap('OK, file it');
    expect(agentTexts(filed)).toEqual([
      "Filed. Daily Report RL-2041-0187 is with the office. Thanks, Marco — that's it for today.",
      'Daily Report RL-2041-0187',
      'Need a change later? Reply "edit Friday" any time. The office gets a new version; the old one is kept.',
    ]);
    expect(byTag(filed, 'pdf')!.fileName).toBe('RL-2041-0187_2026-10-09_v1.pdf');

    const report = todayReport(s.store, s.ctx.site.id)!;
    expect(report.report_no).toBe('RL-2041-0187');
    expect(report.status).toBe('filed');
    expect(report.is_late).toBe(true);
    expect(report.confirmed_at).not.toBeNull();
    const v1 = s.store.data.versions.find((v) => v.report_id === report.id && v.version === 1)!;
    const data = v1.data as unknown as {
      manpower: Array<{ companyName: string; workers: number }>;
    };
    expect(data.manpower.find((m) => m.companyName === 'Delta Mechanical')!.workers).toBe(5);
    expect(s.store.fieldDay(s.ctx.site.id).status).toBe('filed');
    expect(s.store.data.questions.filter((x) => x.report_id === report.id)).toHaveLength(1);
    expect(
      s.store.data.sources.filter((x) => x.report_id === report.id).map((x) => x.kind),
    ).toEqual(['audio', 'photo', 'photo']);
    const actions = s.store.data.audit
      .filter((a) => a.entity_id === report.id)
      .map((a) => a.action);
    expect(actions).toEqual([
      'report.created',
      'report.extracted',
      'report.question_asked',
      'report.question_answered',
      'report.draft_sent',
      'report.filed',
      'report.pdf_rendered',
    ]);
    const filedAudit = s.store.data.audit.find(
      (a) => a.entity_id === report.id && a.action === 'report.filed',
    )!;
    const okMessage = s.state.messages.find(
      (m) => m.from === 'reporter' && m.text === 'OK, file it',
    );
    expect((filedAudit.diff as { confirm_message_id: string }).confirm_message_id).toBe(
      okMessage!.id,
    );
    // pipeline/file.ts notifies the panel only for review; "Report filed" is an email (§13).
    expect(
      s.store.data.notifications.filter((n) => n.target_path === `/reports/${report.id}`),
    ).toEqual(report.needs_review ? [expect.objectContaining({ kind: 'needs_review' })] : []);
    // The day's WhatsApp thread is on record for the report page.
    const transcript = s.store.data.transcripts.find((t) =>
      s.store.data.sources.some((x) => x.report_id === report.id && x.message_id === t.message_id),
    );
    expect(transcript?.language).toBe('en+es');
  });

  it.each(SCENARIOS.filter((sc) => sc.expectedQuestion && sc.outcome === 'question'))(
    '$id asks the fixture’s expected question first',
    (sc) => {
      const s = sim(sc.id);
      const out = s.note();
      const q = s.state.reports[0]!.questions[0]!;
      expect(byTag(out, 'question')).toBeDefined();
      expect({ field: q.field, path: q.path }).toEqual(sc.expectedQuestion);
    },
  );

  it.each(SCENARIOS.filter((sc) => sc.outcome === 'draft'))(
    '$id is complete: no question, draft straight away, OK files it',
    (sc) => {
      const s = sim(sc.id);
      const out = s.note();
      expect(byTag(out, 'question')).toBeUndefined();
      expect(byTag(out, 'draft')).toBeDefined();
      s.tap('OK, file it');
      expect(s.store.fieldDay(s.ctx.site.id).status).toBe('filed');
      expect(todayReport(s.store, s.ctx.site.id)!.status).toBe('filed');
    },
  );

  it('oakmont: two questions one at a time, typed and tapped answers update the totals', () => {
    const s = sim('oakmont-2026-10-08-missing-headcount');
    s.note();
    const a1 = s.text('4, full day');
    expect(agentTexts(a1)[0]).toBe('Thanks — Delta Mechanical: 4 workers × 8 h = 32 h.');
    expect(byTag(a1, 'question')!.text).toBe(
      'Quick check: How long was Summit Drywall on site today?',
    );
    const a2 = s.tap('Full day');
    expect(agentTexts(a2)[0]).toBe('Thanks — Summit Drywall: 4 workers × 8 h = 32 h.');
    // ClearView 3×8 + Delta 4×8 + Summit 4×8 + Kestrel 2×8 = 13 on site, 104 h.
    expect(byTag(a2, 'draft')!.text).toContain('13 on site · 3 subs · 104 h');
  });

  it('a low-confidence answer is re-asked once, then recorded as unanswered', () => {
    const s = sim('oakmont-2026-10-08-missing-headcount');
    s.note();
    const again = s.text('maybe later');
    expect(byTag(again, 'reask')!.text).toContain('a few of the Delta guys');
    const gaveUp = s.text('maybe later');
    expect(byTag(gaveUp, 'question')!.text).toContain('Summit Drywall');
    expect(s.state.legend.some((l) => l.kind === 'unanswered')).toBe(true);
  });

  it('pier 9: unknown roofer → Add → unconfirmed company, report flagged for review', () => {
    const s = sim('pier9-2026-10-09-rain-unknown-roofer');
    const out = s.note();
    expect(byTag(out, 'question')!.buttons!.map((b) => b.title)).toEqual([
      'Add as new sub',
      'Other…',
    ]);
    const added = s.tap('Add as new sub');
    expect(agentTexts(added)[0]).toBe('Thanks — logged as Prairie Roofing.');
    s.tap('OK, file it');
    const report = todayReport(s.store, s.ctx.site.id)!;
    expect(report.needs_review).toBe(true);
    expect(report.review_reasons).toContain('unknown_company:Prairie Roofing');
    expect(s.store.data.companies.find((c) => c.name === 'Prairie Roofing')?.status).toBe(
      'unconfirmed',
    );
  });

  it('hillcrest full weather day voice note → weather day filed, follow-up answer adds a version', () => {
    const s = sim('hillcrest-2026-10-06-full-weather-day');
    const out = s.note();
    expect(agentTexts(out)).toContain(
      "Logged as a weather day: no work because of rain. It's now in the delay record for extension claims.",
    );
    const follow = byTag(out, 'weather_followup')!;
    expect(follow.buttons!.map((b) => b.title)).toEqual(['Send photo', 'Answer by voice']);
    expect(s.store.fieldDay(s.ctx.site.id).status).toBe('weather_day');
    const report = todayReport(s.store, s.ctx.site.id)!;
    expect(report.kind).toBe('weather_day');
    expect(report.report_no).toBe('HS-0418-0050');
    expect(s.state.legend.some((l) => l.kind === 'voided')).toBe(true);

    expect(agentTexts(s.tap('Answer by voice'))).toEqual(['Tell me in a voice note or text.']);
    expect(agentTexts(s.text('9'))).toEqual(['Thanks — Site crew: 9 workers.']);
    expect(todayReport(s.store, s.ctx.site.id)!.current_version).toBe(2);
    expect(agentTexts(s.photo())).toEqual(['Thanks — the photo is in the delay record.']);
    expect(todayReport(s.store, s.ctx.site.id)!.current_version).toBe(3);
  });

  it('elm no-work voice note → no work today, site-day no_work', () => {
    const s = sim('elm-2026-10-08-no-work');
    // Elm has nothing today: the reminder ladder already went out.
    expect(s.state.messages.filter((m) => m.tag === 'reminder')).toHaveLength(2);
    const out = s.note();
    expect(agentTexts(out)).toContain('Noted — no work today at Elm St. Townhomes.');
    expect(s.store.fieldDay(s.ctx.site.id).status).toBe('no_work');
  });

  it('typed day-off commands: "no work today" and "rained out, sent everyone home at 11"', () => {
    const a = sim('riverside-2026-10-09');
    expect(agentTexts(a.text('no work today'))).toEqual([
      'Noted — no work today at Riverside Lofts — Block B.',
    ]);
    expect(a.store.fieldDay(a.ctx.site.id).status).toBe('no_work');

    const b = sim('northgate-2026-10-08-overtime-pour');
    const out = b.text('rained out, sent everyone home at 11');
    expect(agentTexts(out)[0]).toBe(
      "Logged as a weather day: crew released 11:00, cause rain. It's now in the delay record for extension claims.",
    );
    expect(b.store.fieldDay(b.ctx.site.id).status).toBe('weather_day');
  });

  it('R1 buttons: "Site closed: weather" logs a full weather day', () => {
    const s = sim('elm-2026-10-02-rain-morning');
    const out = s.tap('Site closed: weather');
    expect(agentTexts(out)[0]).toBe(
      "Logged as a weather day: no work because of weather. It's now in the delay record for extension claims.",
    );
    expect(s.store.fieldDay(s.ctx.site.id).status).toBe('weather_day');
  });

  it('Fix something → "Apex had 7 not 6" → corrected draft; unknown fixes get a system note', () => {
    const s = sim('riverside-2026-10-09');
    s.note();
    s.tap('5 · full day');
    expect(agentTexts(s.tap('Fix something'))).toEqual(['What should I change?']);
    const fixed = s.text('Apex had 7 not 6');
    expect(byTag(fixed, 'draft')!.text).toContain('24 on site · 4 subs · 192 h');
    const unsupported = s.text('the pour was bigger than that');
    expect(unsupported).toHaveLength(2);
    expect(unsupported[1]!.from).toBe('system');
    expect(unsupported[1]!.note?.key).toBe('unsupported_fix');
    s.text('ok');
    const report = todayReport(s.store, s.ctx.site.id)!;
    expect(report.status).toBe('filed');
  });

  it('edit after filing: "edit Friday — Apex was 7 guys, not 6" makes version 2', () => {
    const s = sim('riverside-2026-10-09');
    s.note();
    s.tap('5 · full day');
    s.tap('OK, file it');
    const out = s.text('edit Friday — Apex was 7 guys, not 6');
    expect(agentTexts(out)).toEqual([
      'Updated Friday: Apex Concrete 7 workers · 56 h (was 6 · 48 h). Version 2 sent to the office · version 1 kept in history.',
    ]);
    const report = todayReport(s.store, s.ctx.site.id)!;
    expect(report.current_version).toBe(2);
    expect(
      s.store.data.versions.find((v) => v.report_id === report.id && v.version === 2)?.author,
    ).toBe('reporter');
  });

  it('photos first, then the typed report; the photo question is answered by a photo', () => {
    const s = sim('elm-2026-10-07-text-report');
    const out = s.note();
    expect(byTag(out, 'ack')!.text).toBe('Got it, Priya.');
    expect(byTag(out, 'question')!.text).toBe(
      "Quick check: A photo of today's trusses would complete the report. Can you send one?",
    );
    const after = s.photo();
    expect(agentTexts(after)[0]).toBe("Got it — adding that to today's report.");
    expect(byTag(after, 'draft')).toBeDefined();
  });

  it('photos only → asks for the voice note', () => {
    const s = sim('elm-2026-10-02-rain-morning');
    expect(agentTexts(s.photo())).toEqual([
      "Got the photos. Send a quick voice note with today's work, crew and weather.",
    ]);
    const out = s.note();
    expect(byTag(out, 'ack')!.text).toBe('Got it, Priya — 33 s.');
  });

  it('free text the simulator cannot understand gets an honest system note', () => {
    const s = sim('riverside-2026-10-09');
    const out = s.text('hello, is this thing on');
    expect(out.at(-1)!.from).toBe('system');
    expect(out.at(-1)!.note?.key).toBe('unsupported_text');
    expect(agentTexts(s.text('help'))[0]).toContain('Send one voice note a day');
    expect(agentTexts(s.text('thanks'))).toEqual(["You're welcome."]);
  });

  it('never more questions than max_questions_per_report', () => {
    const store = new DemoStore();
    store.data.settings.max_questions_per_report = 1;
    const s = sim('oakmont-2026-10-08-missing-headcount', store);
    s.note();
    const out = s.text('4, full day');
    expect(byTag(out, 'question')).toBeUndefined();
    expect(byTag(out, 'draft')).toBeDefined();
  });

  it('start over: a second session replaces the simulator’s own report and reuses the number', () => {
    const store = new DemoStore();
    const a = sim('northgate-2026-10-08-overtime-pour', store);
    a.note();
    a.tap('OK, file it');
    expect(todayReport(store, a.ctx.site.id)!.report_no).toBe('NG-2210-0069');
    const b = sim('northgate-2026-10-06-correction-near-miss', store);
    expect(b.ctx.today.reportNo).toBe('NG-2210-0069');
    b.note();
    b.tap('OK, file it');
    const reports = store.data.reports.filter(
      (r) => r.site_id === a.ctx.site.id && r.report_no === 'NG-2210-0069',
    );
    expect(reports).toHaveLength(1);
  });

  it('correctDraft handles end times and leaves unknown phrasing alone', () => {
    const s = sim('oakmont-2026-10-08-missing-headcount');
    s.note();
    s.text('4, full day');
    s.tap('Full day');
    const data = s.state.reports[0]!.data!;
    const ctx = {
      companies: s.state.companies,
      defaultShiftHours: 8,
      workingHours: '07:00–15:30',
      messageId: 'm',
    };
    const res = correctDraft(data, 'Summit was only there till 1', ctx);
    expect(res.kind).toBe('patched');
    if (res.kind === 'patched')
      expect(res.changeNote).toBe('Summit Drywall 4 workers · 24 h (was 4 · 32 h)');
    expect(correctDraft(data, 'it was sunny', ctx).kind).toBe('none');
  });
});

/** Every page data method over the store, and every report link it offers must open. */
async function assertPanelConsistent(store: DemoStore) {
  const source = makeSource('admin', store);
  const overview = await source.getOverview();
  const ids = new Set<string>();
  for (const row of overview.sitesToday) if (row.reportId) ids.add(row.reportId);
  for (const card of await source.getSites()) {
    if (card.reportId) ids.add(card.reportId);
    const detail = await source.getSiteDetail(card.siteId, '2026-10');
    for (const c of detail.cells) if (c.reportId) ids.add(c.reportId);
  }
  for (const item of (await source.listReports({ pageSize: 200 })).items) ids.add(item.reportId);
  await source.getHours('2026-W41');
  await source.getWeather('2026-10');
  for (const id of ids) {
    const detail = await source.getReportDetail(id);
    expect(detail.version).toBeGreaterThan(0);
  }
}

/** Taps the first answer of each question, then OK, until the scenario is filed (or settles). */
function runToEnd(s: ReturnType<typeof sim>) {
  for (let i = 0; i < 6; i++) {
    const titles = s.liveTitles().filter((x) => x !== 'Other…' && !x.startsWith('Recording'));
    if (titles.includes('OK, file it')) s.tap('OK, file it');
    else if (s.state.convo === 'awaiting_answer') {
      const q = s.state.reports
        .flatMap((r) => r.questions)
        .find((x) => x.id === s.state.pendingQuestionId);
      if (q?.field === 'photo') s.photo();
      else if (titles[0]) s.tap(titles[0]);
      else break;
    } else break;
  }
}

describe('field simulator: what the office sees and what the reporter can do', () => {
  it.each(SCENARIOS.map((sc) => [sc.id]))(
    '%s: every Overview / Sites / Reports link opens, mid-flow and at the end',
    async (id) => {
      const s = sim(id as ScenarioId);
      s.note();
      await assertPanelConsistent(s.store);
      runToEnd(s);
      await assertPanelConsistent(s.store);
      const open = s.store.data.reports.filter(
        (r) =>
          r.site_day_id === s.ctx.site.siteDayId &&
          !['void', 'filed', 'signed_off'].includes(r.status),
      );
      expect(open).toHaveLength(0);
    },
  );

  it('help, stop, thanks and a reminder button do not touch today’s filed demo report', () => {
    const s = sim('riverside-2026-10-09');
    s.text('help');
    s.text('stop');
    s.text('stop');
    s.text('thanks');
    expect(s.state.messages.some((m) => m.note?.key === 'replaced')).toBe(false);
    const info = s.store.fieldDay(s.ctx.site.id);
    expect(info).toMatchObject({ status: 'filed', reportNo: 'RL-2041-0187' });
    // "stop" pauses today's reminders once; the audit row only when the flag changes.
    const sd = s.store.data.siteDays.find((d) => d.id === info.siteDayId)!;
    expect(sd.reminders_paused).toBe(true);
    expect(s.store.data.audit.filter((a) => a.action === 'site_day.reminders_paused')).toHaveLength(
      1,
    );
  });

  it('"edit Friday" in a new session edits the filed report instead of replacing it', () => {
    const store = new DemoStore();
    const a = sim('riverside-2026-10-09', store);
    a.note();
    a.tap('5 · full day');
    a.tap('OK, file it');
    const filedId = store.fieldDay(a.ctx.site.id).reportId;
    // Page remount or a new chat: a fresh session over the same store.
    const b = sim('riverside-2026-10-09', store);
    const out = b.text('edit Friday — Apex was 7 guys, not 6');
    expect(agentTexts(out)[0]).toMatch(/^Updated Friday: Apex Concrete 7 workers/);
    expect(store.fieldDay(b.ctx.site.id).reportId).toBe(filedId);
    expect(store.data.reports.find((r) => r.id === filedId)!.current_version).toBe(2);
    // The edit chip's correction a second time changes nothing.
    const again = b.text('edit Friday — Apex was 7 guys, not 6');
    expect(again.at(-1)!.note?.key).toBe('unchanged_fix');
    expect(b.state.convo).toBe('idle');
  });

  it('"edit Friday" with nothing filed today gets "I couldn\'t find a report"', () => {
    const elm = sim('elm-2026-10-02-rain-morning');
    expect(agentTexts(elm.text('edit Friday — Apex was 8 guys, not 6'))).toEqual([
      "I couldn't find a report for that day. Which day do you mean?",
    ]);
    const hero = sim('riverside-2026-10-09');
    hero.note();
    hero.tap('5 · full day');
    expect(agentTexts(hero.text('edit Friday — Apex was 8 guys, not 6'))).toEqual([
      "I couldn't find a report for that day. Which day do you mean?",
    ]);
    // The draft is still waiting for OK.
    expect(hero.liveTitles()).toContain('OK, file it');
  });

  it('buttons stay live while their question or draft is open', () => {
    const s = sim('oakmont-2026-10-08-missing-headcount');
    s.note();
    // A headcount question with no number in the reply: re-asked (question.ts), buttons live.
    expect(byTag(s.text('they were here all day'), 'reask')).toBeDefined();
    s.tap('4 · full day');
    const hint = s.text('hmm');
    expect(hint.at(-1)!.note).toEqual({
      key: 'unsupported_answer',
      params: { prompt: 'How long was Summit Drywall on site today?', field: 'manpower.hours' },
    });
    expect(s.liveTitles()).toContain('Full day');
    s.tap('Full day');
    s.photo();
    expect(s.liveTitles()).toEqual(['OK, file it', 'Fix something']);
    s.tap('Fix something');
    s.text('the pour was bigger than that');
    expect(s.liveTitles()).toEqual(['OK, file it', 'Fix something']);
    s.tap('OK, file it');
    expect(s.liveTitles()).toEqual([]);
  });

  it('Northgate: "which crew?" is answered with a crew name and the fix is applied', () => {
    const s = sim('northgate-2026-10-06-correction-near-miss');
    s.note();
    s.tap('Fix something');
    expect(agentTexts(s.text('it was 7 not 6'))).toEqual([
      'Quick check: Which crew do you mean — Apex Concrete or Ironclad Steel?',
    ]);
    const fixed = s.text('Apex');
    expect(byTag(fixed, 'draft')).toBeDefined();
    expect(
      s.state.reports[0]!.data!.manpower.find((m) => m.companyName === 'Apex Concrete')!.workers,
    ).toBe(7);
  });

  it('hero: a crew-less fix is not answered with the Northgate recording', () => {
    const s = sim('riverside-2026-10-09');
    s.note();
    s.tap('5 · full day');
    s.tap('Fix something');
    const out = s.text('make it 6, full day');
    expect(out.at(-1)!.note?.key).toBe('unsupported_fix');
    expect(byTag(out, 'fix_clarify')).toBeUndefined();
  });

  it('a day off typed mid-flow voids the open report and records the day off', async () => {
    const wx = sim('riverside-2026-10-09');
    wx.note();
    wx.text('rained out, sent everyone home at 11');
    const live = wx.store.data.reports.filter(
      (r) => r.site_day_id === wx.ctx.site.siteDayId && r.status !== 'void',
    );
    expect(live.map((r) => [r.kind, r.status])).toEqual([['weather_day', 'filed']]);
    expect(wx.store.fieldDay(wx.ctx.site.id).status).toBe('weather_day');
    // The note's photos go with the weather-day record.
    expect(
      wx.store.data.sources.filter((x) => x.report_id === live[0]!.id && x.kind === 'photo'),
    ).toHaveLength(2);
    await assertPanelConsistent(wx.store);

    const nw = sim('riverside-2026-10-09');
    nw.note();
    nw.text('no work today');
    expect(nw.store.fieldDay(nw.ctx.site.id).status).toBe('no_work');
    expect(
      nw.store.data.reports.filter(
        (r) => r.site_day_id === nw.ctx.site.siteDayId && r.status !== 'void',
      ),
    ).toHaveLength(0);
    expect(nw.state.convo).toBe('idle');
    expect(nw.state.pendingQuestionId).toBeNull();
    await assertPanelConsistent(nw.store);
  });

  it('Hillcrest: the photo sent with the note lands on the weather-day record', () => {
    const s = sim('hillcrest-2026-10-06-full-weather-day');
    s.note();
    const report = todayReport(s.store, s.ctx.site.id)!;
    expect(report.kind).toBe('weather_day');
    expect(
      s.store.data.sources.filter((x) => x.report_id === report.id).map((x) => x.kind),
    ).toEqual(['audio', 'photo']);
  });

  it('Pier 9: "Other…" then the roofer’s name; a re-run reuses the company', () => {
    const store = new DemoStore();
    const a = sim('pier9-2026-10-09-rain-unknown-roofer', store);
    a.note();
    a.tap('Other…');
    expect(agentTexts(a.text('Prairie Roofing'))[0]).toBe('Thanks — logged as Prairie Roofing.');
    // Flagged for review as soon as the company is added, not only at filing.
    expect(store.data.reports.find((r) => r.id === a.state.activeReportId)!.needs_review).toBe(
      true,
    );
    a.tap('OK, file it');
    const b = sim('pier9-2026-10-09-rain-unknown-roofer', store);
    b.note();
    b.tap('Add as new sub');
    b.tap('OK, file it');
    expect(store.data.companies.filter((c) => c.name === 'Prairie Roofing')).toHaveLength(1);
    expect(todayReport(store, b.ctx.site.id)!.review_reasons).toContain(
      'unknown_company:Prairie Roofing',
    );
  });

  it('the draft lives in version 1 with its status while the reporter is answering', () => {
    const s = sim('riverside-2026-10-09');
    s.note();
    const id = s.state.activeReportId!;
    expect(s.store.data.reports.find((r) => r.id === id)!.status).toBe('awaiting_answer');
    const v1 = s.store.data.versions.find((v) => v.report_id === id && v.version === 1)!;
    expect(v1.pdf_path).toBeNull();
    s.tap('5 · full day');
    expect(s.store.data.reports.find((r) => r.id === id)!.status).toBe('awaiting_confirmation');
  });

  it('observed weather comes from today’s site-day, not the recording’s day', () => {
    const s = sim('elm-2026-10-02-rain-morning');
    s.note();
    const data = s.state.reports[0]!.data!;
    expect(data.weather.observed ?? null).toEqual(s.ctx.observedWeather);
  });

  it('reminder history follows the ladder settings and comes before the intro', () => {
    const store = new DemoStore();
    store.data.settings.reminder2_enabled = false;
    const s = sim('elm-2026-10-02-rain-morning', store);
    expect(s.state.messages.map((m) => m.tag ?? m.note?.key)).toEqual(['reminder', 'intro']);
    expect(formatTimeInTz(s.state.messages[0]!.at, s.ctx.site.timezone)).toBe('17:45');
  });
});
