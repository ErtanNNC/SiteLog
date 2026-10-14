import { describe, expect, it } from 'vitest';
import {
  buildKestrelDemo,
  kestrelDemo,
  DEMO_SITELOG_NUMBER,
  DEMO_TODAY,
  DEMO_TZ,
  DEMO_USERS,
} from './kestrel.ts';
import { deriveTotals } from '../report/hours.ts';
import { readReportData } from '../report/upgrade.ts';
import { renderSms } from '../copy/sms.ts';
import { formatDateInTz, formatPhone, formatTimeInTz } from '../format.ts';
import { linkCodeHash } from '../links.ts';
import {
  DailyReportDataSchema,
  DailyReportDataV1Schema,
  StoredReportDataSchema,
  type DailyReportData,
} from '../schemas/report.ts';

const demo = kestrelDemo();
const byName = (n: string) => demo.companies.find((c) => c.name === n)!.id;
const reporter = (name: string) => demo.reporters.find((r) => r.name === name)!;
const site = (code: string) => demo.sites.find((s) => s.project_code === code)!;
const local = (iso: string) => formatTimeInTz(iso, DEMO_TZ);
const data = (reportId: string, version: number): DailyReportData =>
  readReportData(
    StoredReportDataSchema.parse(
      demo.versions.find((v) => v.report_id === reportId && v.version === version)!.data,
    ),
  );
/** Every ISO instant in the dataset's rows later than `now`, as `table.column = value`. */
function laterThan(d: ReturnType<typeof buildKestrelDemo>, now: string): string[] {
  const out: string[] = [];
  for (const [table, rows] of Object.entries(d)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<Record<string, unknown>>)
      for (const [col, v] of Object.entries(row ?? {}))
        if (
          typeof v === 'string' &&
          col !== 'deadline_at' &&
          col !== 'expires_at' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) &&
          v > now
        )
          out.push(`${table}.${col} = ${v}`);
  }
  return out;
}

const todayReport = (code: string) => {
  const sd = demo.siteDays.find((x) => x.site_id === site(code).id && x.date === DEMO_TODAY)!;
  return demo.reports.find((r) => r.site_day_id === sd.id);
};

describe('Kestrel demo data (§18.1)', () => {
  it('has the six sites, reporters and companies', () => {
    expect(demo.sites.map((s) => s.project_code)).toEqual([
      'RL-2041',
      'OM-1187',
      'P9-0932',
      'NG-2210',
      'HS-0418',
      'ES-0377',
    ]);
    expect(demo.reporters).toHaveLength(7);
    expect(reporter('Jorge Medina').status).toBe('invited');
    expect(demo.companies.map((c) => c.name)).toContain('Ridgeway');
    expect(demo.companies.find((c) => c.name === 'Ridgeway')!.status).toBe('unconfirmed');
    expect(demo.org).toMatchObject({
      name: 'Kestrel Build Group',
      timezone: 'America/Chicago',
      locale: 'en-US',
      country: 'US',
      units: 'imperial',
      currency: 'USD',
      is_demo: true,
    });
    expect(demo.settings.default_deadline).toBe('17:30:00');
    expect(demo.users.map((u) => u.email)).toEqual([
      'lena@kestrelbuild.example',
      'sam@kestrelbuild.example',
      'accounts@kestrelbuild.example',
    ]);
  });

  it('gives every reporter the §18.1 language and preference', () => {
    const prefs = Object.fromEntries(
      demo.reporters.map((r) => [r.name, [r.locale, r.contact_pref, r.status]]),
    );
    expect(prefs).toEqual({
      'Marco Ruiz': ['en-US', 'link', 'active'],
      'Dana Whitfield': ['en-US', 'link', 'active'],
      'Tomasz Nowak': ['en-US', 'link', 'active'],
      "Kevin O'Brien": ['en-US', 'call', 'active'],
      'Aisha Bello': ['en-US', 'call', 'active'],
      'Priya Raman': ['en-US', 'link', 'active'],
      'Jorge Medina': ['es-US', 'link', 'invited'],
    });
    // Marco speaks ES · EN (his notes are mixed); SiteLog texts him in English.
    expect(reporter('Marco Ruiz').languages).toEqual(['es', 'en']);
    for (const r of demo.reporters) expect(r.verified_at).toBeNull();
  });

  it('matches the Oct 5–9 hours table exactly', () => {
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const current = demo.manpower.filter((m) => {
      const r = demo.reports.find((x) => x.id === m.report_id)!;
      const sd = demo.siteDays.find((x) => x.id === r.site_day_id)!;
      return (
        r.current_version === m.version &&
        week.includes(sd.date) &&
        ['filed', 'signed_off'].includes(r.status)
      );
    });
    const perDay = (name: string) =>
      week.map((d) =>
        current
          .filter(
            (m) =>
              m.company_id === byName(name) &&
              demo.siteDays.find(
                (x) => x.id === demo.reports.find((r) => r.id === m.report_id)!.site_day_id,
              )!.date === d,
          )
          .reduce((a, m) => a + Number(m.hours), 0),
      );
    expect(perDay('Apex Concrete')).toEqual([88, 96, 96, 88, 104]);
    expect(perDay('BrightLine Electric')).toEqual([40, 40, 36, 40, 40]);
    expect(perDay('Delta Mechanical')).toEqual([72, 80, 80, 72, 80]);
    expect(perDay('Ironclad Steel')).toEqual([48, 40, 48, 48, 48]);
    expect(perDay('ClearView Glazing')).toEqual([32, 32, 32, 24, 32]);
    expect(perDay('Summit Drywall')).toEqual([64, 64, 72, 64, 56]);
    const ridgeway = current
      .filter((m) => m.company_name === 'Ridgeway')
      .reduce((a, m) => a + Number(m.hours), 0);
    expect(ridgeway).toBe(48);
    const subsTotal = current
      .filter((m) => m.company_id !== byName('Kestrel self-perform'))
      .reduce((a, m) => a + Number(m.hours), 0);
    expect(subsTotal).toBe(1804);
    // Invoice gaps: BrightLine +16, ClearView +8 (invoiced minus reported).
    const invoiced = (no: string) => demo.invoices.find((i) => i.invoice_no === no)!.total_hours!;
    const reported = (name: string) => perDay(name).reduce((a, h) => a + h, 0);
    expect(invoiced('BL-3381') - reported('BrightLine Electric')).toBe(16);
    expect(invoiced('CV-2210') - reported('ClearView Glazing')).toBe(8);
    expect(invoiced('AP-1097') - reported('Apex Concrete')).toBe(0);
    expect(invoiced('IC-0554') - reported('Ironclad Steel')).toBe(0);
  });

  it('keeps billing at 6 × $399 = $2,394/month', () => {
    expect(demo.billing.monthlyCents).toBe(239_400);
    expect(demo.sites.filter((s) => s.status === 'active')).toHaveLength(6);
  });

  it('has the hero report: v1 23/184 by the agent, v2 24/192 by Marco on the web', () => {
    const hero = demo.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    expect(hero).toMatchObject({
      current_version: 2,
      channel: 'web',
      confirmed_via: 'web',
      language: 'en',
    });
    expect(local(hero.received_at!)).toBe('17:38');
    expect(local(hero.confirmed_at!)).toBe('17:43');
    expect(local(hero.filed_at!)).toBe('17:44');
    const rows = demo.versions.filter((v) => v.report_id === hero.id);
    expect(rows.map((v) => [v.version, v.author, v.via, v.change_note])).toEqual([
      [1, 'agent', null, null],
      [2, 'reporter', 'web', 'Apex Concrete 6 → 7 workers'],
    ]);
    expect(local(rows[1]!.created_at)).toBe('20:10');
    for (const v of rows) {
      const parsed = DailyReportDataSchema.parse(v.data);
      expect(parsed.schemaVersion).toBe(2);
    }
    const self = new Set([byName('Kestrel self-perform')]);
    expect(deriveTotals(data(hero.id, 1), { selfPerformCompanyIds: self })).toMatchObject({
      crewOnSite: 23,
      totalHours: 184,
      subcontractors: 4,
      lostHours: 3.5,
    });
    expect(deriveTotals(data(hero.id, 2), { selfPerformCompanyIds: self })).toMatchObject({
      crewOnSite: 24,
      totalHours: 192,
    });

    // Sources point at the upload and the answered question (§10.3).
    const voice = demo.uploads.find((u) => u.report_id === hero.id && u.kind === 'audio')!;
    expect(voice).toMatchObject({ duration_s: 168, reporter_id: reporter('Marco Ruiz').id });
    expect(local(voice.received_at!)).toBe('17:38');
    const photos = demo.uploads.filter((u) => u.report_id === hero.id && u.kind === 'photo');
    expect(photos.map((p) => local(p.received_at!))).toEqual(['17:38', '17:38']);
    const v2 = data(hero.id, 2);
    expect(v2.photos.map((p) => p.uploadId)).toEqual(photos.map((p) => p.id));
    expect(v2.weather.periods[0]!.source).toEqual([
      { type: 'voice_note', uploadId: voice.id, start: 41, end: 52.3 },
    ]);
    const question = demo.questions.find((q) => q.report_id === hero.id)!;
    expect(question).toMatchObject({
      channel: 'web',
      field: 'manpower.workers',
      answer: { workers: 5, fullDay: true },
      asked_message_id: null,
      answered_message_id: null,
    });
    expect(local(question.answered_at!)).toBe('17:41');
    expect(question.options).toEqual([
      { id: '4-full-day', label: '4 · full day' },
      { id: '5-full-day', label: '5 · full day' },
    ]);
    const delta = v2.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    expect(delta).toMatchObject({ workers: 5, totalHours: 40, hoursBasis: 'answer' });
    expect(delta.source).toContainEqual({ type: 'answer', questionId: question.id });
    expect(
      demo.sources
        .filter((s) => s.report_id === hero.id)
        .map((s) => [s.kind, s.upload_id ? 'upload' : s.question_id ? 'question' : 'other']),
    ).toEqual([
      ['voice_note', 'upload'],
      ['photo', 'upload'],
      ['photo', 'upload'],
      ['answer', 'question'],
      ['voice_note', 'upload'],
    ]);
    // F10: "Apex was 7, not 6" is spoken at 20:09, a voice note of its own; v2's Apex count cites
    // it, v1's (6) the 17:38 note, whose seconds say six.
    const fix = demo.uploads.find(
      (u) => u.report_id === hero.id && u.kind === 'audio' && u.id !== voice.id,
    )!;
    expect(local(fix.received_at!)).toBe('20:09');
    expect(demo.transcripts.find((x) => x.upload_id === fix.id)).toMatchObject({
      text: 'Apex was 7, not 6.',
      language: 'en',
    });
    expect(demo.sources.find((x) => x.upload_id === fix.id)).toMatchObject({
      report_id: hero.id,
      kind: 'voice_note',
    });
    const apex = (version: number) =>
      data(hero.id, version).manpower.find((m) => m.companyName === 'Apex Concrete')!;
    expect(apex(2)).toMatchObject({ workers: 7, totalHours: 56 });
    expect(apex(2).source).toEqual([{ type: 'voice_note', uploadId: fix.id, start: 0, end: 2 }]);
    expect(apex(1)).toMatchObject({ workers: 6, totalHours: 48 });
    expect(apex(1).source).toEqual([
      { type: 'voice_note', uploadId: voice.id, start: 10, end: 18.1 },
    ]);
    const transcript = demo.transcripts.find((x) => x.upload_id === voice.id)!;
    expect(transcript).toMatchObject({ message_id: null, language: 'es+en' });
    expect(v2.newTerms).toEqual([
      {
        heard: 'colado',
        heardLanguage: 'es',
        proposedOfficial: 'Concrete pour',
        kind: 'term',
        confidence: 0.86,
      },
    ]);
  });

  it('keeps history in its stored v1 shape, its media as uploads with the same ids', () => {
    const history = demo.versions.filter(
      (v) => (v.data as { reportDate: string }).reportDate < DEMO_TODAY,
    );
    expect(history.length).toBeGreaterThan(60);
    for (const v of history) expect(() => DailyReportDataV1Schema.parse(v.data)).not.toThrow();
    const today = demo.versions.filter(
      (v) => (v.data as { reportDate: string }).reportDate === DEMO_TODAY,
    );
    expect(today).toHaveLength(6); // hero v1 + v2, Oakmont, Pier 9, Northgate, Hillcrest
    for (const v of today) expect(DailyReportDataSchema.safeParse(v.data).success).toBe(true);
    // Every voice note and photo a version cites is an upload of its report.
    const uploads = new Map(demo.uploads.map((u) => [u.id, u]));
    for (const v of history) {
      const d = DailyReportDataV1Schema.parse(v.data);
      for (const p of d.photos) expect(uploads.get(p.messageId)?.report_id).toBe(v.report_id);
      for (const m of d.manpower)
        for (const src of m.source)
          if (src.type === 'audio') expect(uploads.get(src.messageId)?.kind).toBe('audio');
    }
    expect(demo.messages.every((m) => m.conversation_id === null && m.type === null)).toBe(true);
    for (const r of demo.reports) expect(r.channel).not.toBeNull();
  });

  it('has the Oct 9 states and channels from §18.1', () => {
    const state = (code: string) => {
      const sd = demo.siteDays.find((x) => x.site_id === site(code).id && x.date === DEMO_TODAY)!;
      const r = demo.reports.find((x) => x.site_day_id === sd.id);
      return {
        status: sd.status,
        needsReview: r?.needs_review ?? null,
        reasons: r?.review_reasons ?? null,
        channel: r?.channel ?? null,
      };
    };
    expect(state('RL-2041')).toMatchObject({ status: 'filed', needsReview: false, channel: 'web' });
    expect(state('OM-1187')).toMatchObject({
      status: 'filed',
      needsReview: true,
      reasons: ['unknown_company:Ridgeway'],
      channel: 'web',
    });
    expect(state('P9-0932')).toMatchObject({ status: 'filed', channel: 'web' });
    expect(state('NG-2210')).toMatchObject({ status: 'filed', channel: 'voice' });
    expect(state('HS-0418')).toMatchObject({ status: 'weather_day', channel: 'voice' });
    expect(state('ES-0377')).toMatchObject({ status: 'missing', channel: null });
    expect(local(todayReport('OM-1187')!.filed_at!)).toBe('17:21');
    expect(local(todayReport('P9-0932')!.filed_at!)).toBe('16:58');
    // Northgate: Kevin called in at 17:10 (the report's start, its call source), filed 17:12.
    const ng = todayReport('NG-2210')!;
    expect([ng.received_at, ng.confirmed_at, ng.filed_at].map((x) => local(x!))).toEqual([
      '17:10',
      '17:12',
      '17:12',
    ]);
    expect(ng.is_late).toBe(false);
    // §18.1: 14 workers from 2 companies, 100.0 h.
    const self = new Set([byName('Kestrel self-perform')]);
    const ngData = data(ng.id, 1);
    expect(deriveTotals(ngData, { selfPerformCompanyIds: self })).toMatchObject({
      crewOnSite: 14,
      totalHours: 100,
    });
    expect(new Set(ngData.manpower.map((m) => m.companyId)).size).toBe(2);
    expect(demo.invoices.find((i) => i.invoice_no === 'BL-3381')!.total_hours).toBe(212);
    // Hillcrest's weather day: the summary says it once; the period keeps its own impact (5 h).
    const hs = data(todayReport('HS-0418')!.id, 1);
    expect(hs.summary).toBe('Rain stopped work; crew released at 11:00.');
    expect(hs.weather.periods).toMatchObject([
      { start: '11:00', impact: 'Rained out; crew released at 11:00', lostHours: 5 },
    ]);
  });

  it('has the §18.1 calls: Northgate, Hillcrest R1 and call-back, the unknown caller', () => {
    const call = (from: string, time: string) =>
      demo.calls.find(
        (c) => (c.from_e164 === from || c.to_e164 === from) && local(c.started_at!) === time,
      )!;
    const ng = call(reporter("Kevin O'Brien").phone_e164, '17:10');
    expect(ng).toMatchObject({
      direction: 'inbound',
      status: 'completed',
      outcome: 'filed',
      duration_s: 161,
      report_id: todayReport('NG-2210')!.id,
      to_e164: DEMO_SITELOG_NUMBER,
      disclosure_played: true,
    });
    const ngData = data(todayReport('NG-2210')!.id, 1);
    expect(ngData.manpower.every((m) => m.source.every((s) => s.type === 'call'))).toBe(true);
    expect(ngData.photos).toEqual([]);

    const aisha = reporter('Aisha Bello').phone_e164;
    const r1 = call(aisha, '17:45');
    expect(r1).toMatchObject({
      direction: 'outbound',
      purpose: 'reminder',
      status: 'no_answer',
      outcome: 'not_reached',
      answered_at: null,
      recording_path: null,
    });
    const back = call(aisha, '18:41');
    expect(back).toMatchObject({
      direction: 'inbound',
      status: 'completed',
      outcome: 'weather_day',
      report_id: todayReport('HS-0418')!.id,
    });

    const luis = call('+15550194410', '17:52');
    expect(luis).toMatchObject({ reporter_id: null, org_id: demo.org.id, duration_s: 41 });
    expect(formatDateInTz(luis.started_at!, DEMO_TZ)).toBe('2026-10-09'); // a Friday
    expect(demo.unknownContacts).toEqual([
      expect.objectContaining({
        phone_e164: '+15550194410',
        channel: 'voice',
        call_id: luis.id,
        message_id: null,
        guessed_site_id: site('ES-0377').id,
        status: 'pending',
      }),
    ]);
    expect(demo.unknownContacts[0]!.snippet).toMatch(/^this is Luis, covering Elm St\. today/);
    expect(demo.transcripts.find((x) => x.call_id === luis.id)!.text).toContain('this is Luis');
  });

  it('logs the §18.1 texts, rendered as the app sends them', () => {
    const texts = demo.messages.map((m) => [
      demo.reporters.find((r) => r.id === m.reporter_id)!.name,
      m.copy_key,
      formatDateInTz(m.created_at, DEMO_TZ) === DEMO_TODAY ? local(m.created_at) : 'invite',
    ]);
    expect(texts).toEqual([
      ['Marco Ruiz', 'welcome', 'invite'],
      ['Dana Whitfield', 'welcome', 'invite'],
      ['Tomasz Nowak', 'welcome', 'invite'],
      ["Kevin O'Brien", 'welcome', 'invite'],
      ['Aisha Bello', 'welcome', 'invite'],
      ['Priya Raman', 'welcome', 'invite'],
      ['Jorge Medina', 'welcome', 'invite'],
      ['Tomasz Nowak', 'filed', '16:58'],
      ['Marco Ruiz', 'daily_link', '17:00'],
      ['Dana Whitfield', 'daily_link', '17:00'],
      ['Priya Raman', 'daily_link', '17:00'],
      ["Kevin O'Brien", 'filed', '17:12'],
      ["Kevin O'Brien", 'photos_link', '17:12'],
      ['Dana Whitfield', 'filed', '17:21'],
      ['Marco Ruiz', 'filed', '17:44'],
      ['Priya Raman', 'reminder_1', '17:45'],
      ['Aisha Bello', 'missed_call', '17:46'],
      ['Priya Raman', 'reminder_2', '18:30'],
      ['Aisha Bello', 'filed', '18:42'],
      ['Aisha Bello', 'photos_link', '18:42'],
      ['Marco Ruiz', 'edit_applied', '20:10'],
    ]);
    for (const m of demo.messages) {
      expect(m).toMatchObject({ org_id: demo.org.id, direction: 'out', provider: 'console' });
      expect(m.phone_e164).toBe(demo.reporters.find((r) => r.id === m.reporter_id)!.phone_e164);
    }
    const marcoDaily = demo.messages.find(
      (m) => m.copy_key === 'daily_link' && m.reporter_id === reporter('Marco Ruiz').id,
    )!;
    const link = /https:\/\/go\.sitelog\.app\/r\/([A-Z0-9]{6})/.exec(marcoDaily.body!)![1]!;
    expect(marcoDaily.body).toBe(
      renderSms(
        'daily_link',
        'en',
        {
          site: 'Riverside Lofts — Block B',
          link: `https://go.sitelog.app/r/${link}`,
          number: formatPhone(DEMO_SITELOG_NUMBER),
        },
        { hasVoiceNumber: true },
      ),
    );
    // The link resolves: its hash is a daily field link of Marco's for Riverside today.
    expect(demo.fieldLinks.find((l) => l.code_hash === linkCodeHash(link))).toMatchObject({
      kind: 'daily',
      reporter_id: reporter('Marco Ruiz').id,
      site_id: site('RL-2041').id,
      report_date: DEMO_TODAY,
    });
    const jorge = demo.messages.find((m) => m.reporter_id === reporter('Jorge Medina').id)!;
    expect(jorge.body).toMatch(/^Hola Jorge, soy SiteLog/);
    expect(demo.messages.find((m) => m.copy_key === 'edit_applied')!.body).toBe(
      'Updated Friday: Apex Concrete 7 workers · 56 h (was 6 · 48 h). Version 2 sent to the office.',
    );
  });

  it('has a personal link per reporter and consents for the active ones', () => {
    const personal = demo.fieldLinks.filter((l) => l.kind === 'personal');
    expect(personal.map((l) => l.reporter_id).sort()).toEqual(
      demo.reporters.map((r) => r.id).sort(),
    );
    for (const l of personal) expect(l).toMatchObject({ site_id: null, expires_at: null });
    // Daily links: 72 h (§5.1). Photos links, texted after the two calls: 23:59 the next day (F9).
    for (const l of demo.fieldLinks.filter((x) => x.kind === 'daily')) {
      expect(Date.parse(l.expires_at!) - Date.parse(l.created_at!)).toBe(72 * 3_600_000);
    }
    const photos = demo.fieldLinks.filter((x) => x.kind === 'photos');
    expect(photos.map((l) => l.reporter_id).sort()).toEqual(
      [reporter("Kevin O'Brien").id, reporter('Aisha Bello').id].sort(),
    );
    for (const l of photos)
      expect(l).toMatchObject({
        report_date: DEMO_TODAY,
        expires_at: '2026-10-11T04:59:00.000Z', // Sat Oct 10, 23:59 CDT
      });
    expect(demo.fieldLinks).toHaveLength(12); // 7 personal, 3 daily, 2 photos
    expect(new Set(demo.fieldLinks.map((l) => l.code_hash)).size).toBe(demo.fieldLinks.length);
    for (const l of demo.fieldLinks) expect(l.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const types = (name: string) =>
      demo.consents
        .filter((c) => c.reporter_id === reporter(name).id)
        .map((c) => c.type)
        .sort();
    expect(types('Marco Ruiz')).toEqual(['data_processing', 'recording', 'sms']);
    expect(types("Kevin O'Brien")).toEqual(['auto_call', 'data_processing', 'recording', 'sms']);
    expect(types('Jorge Medina')).toEqual([]);
  });

  it('matches the weather log: 10 site-days, 36.5 h, 7 claim-ready', () => {
    const events = demo.weatherEvents.filter(
      (w) =>
        w.date >= '2026-10-01' &&
        demo.reports.find((r) => r.id === w.report_id)!.current_version === w.version,
    );
    expect(events).toHaveLength(10);
    expect(events.reduce((a, w) => a + Number(w.lost_hours), 0)).toBe(36.5);
    expect(events.filter((w) => w.claim_ready)).toHaveLength(7);
  });

  it('logs each office user’s membership, as Demir Yapı does (member.added)', () => {
    expect(demo.members.map((m) => m.user_id)).toEqual(DEMO_USERS.map((u) => u.id));
    // The org's first audit rows: the members join when the org is set up, before anything else.
    expect(demo.audit.filter((a) => a.entity === 'org_member')).toEqual(
      demo.members.map((m, i) => ({
        id: 9_000_000_000_000 + 1_000_000 + i + 1,
        org_id: demo.org.id,
        actor_type: 'system',
        actor_id: null,
        action: 'member.added',
        entity: 'org_member',
        entity_id: m.user_id,
        diff: { role: m.role },
        created_at: m.created_at,
      })),
    );
    expect(demo.audit.slice(0, 3).every((a) => a.action === 'member.added')).toBe(true);
  });

  it('uses valid, unique ids, audit ids included', () => {
    const ids = [
      ...demo.messages,
      ...demo.reports,
      ...demo.siteDays,
      ...demo.manpower,
      ...demo.uploads,
      ...demo.calls,
      ...demo.fieldLinks,
      ...demo.consents,
    ].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    const audit = demo.audit.map((a) => a.id);
    expect(new Set(audit).size).toBe(audit.length);
    expect(Math.min(...audit)).toBe(9_000_000_000_000 + 1_000_000 + 1);
    expect(audit).toEqual([...audit].sort((a, b) => a - b));
  });
});

describe('the live demo (--date, D36)', () => {
  it('ends history the day before and starts today with five sites awaiting', () => {
    const d = buildKestrelDemo({ date: '2026-10-14' }); // a Wednesday
    expect(d.now).toBe('2026-10-14T22:00:00.000Z'); // 17:00 CDT
    const today = d.siteDays.filter((s) => s.date === '2026-10-14');
    const status = (code: string) =>
      today.find((s) => s.site_id === d.sites.find((x) => x.project_code === code)!.id)!.status;
    expect(today).toHaveLength(6);
    expect(today.filter((s) => s.status === 'pending')).toHaveLength(5);
    expect(status('P9-0932')).toBe('filed');
    // Nothing after today, nothing at or after 17:00 today.
    expect(Math.max(...d.siteDays.map((s) => Date.parse(s.created_at)))).toBeLessThan(
      Date.parse(d.now),
    );
    const history = d.siteDays.filter((s) => s.date < '2026-10-14').map((s) => s.date);
    expect(history.sort().at(-1)).toBe('2026-10-13');
    for (const rows of [d.messages, d.calls, d.reports, d.notifications, d.audit, d.fieldLinks])
      for (const r of rows as Array<{ created_at: string | null }>)
        expect(Date.parse(r.created_at!), JSON.stringify(r).slice(0, 120)).toBeLessThan(
          Date.parse(d.now),
        );
    for (const u of d.uploads) expect(Date.parse(u.received_at!)).toBeLessThan(Date.parse(d.now));
    expect(d.calls).toEqual([]);
    expect(d.unknownContacts).toEqual([]);
    expect(d.invoices).toEqual([]);
    // Weekdays stay weekdays.
    for (const s of d.siteDays)
      expect([1, 2, 3, 4, 5]).toContain(new Date(`${s.date}T12:00:00Z`).getUTCDay());
    // The next report Marco files today is RL-2041-0187 again.
    expect(d.sites.find((s) => s.project_code === 'RL-2041')!.report_seq).toBe(186);
    expect(d.reports.some((r) => r.report_no === 'RL-2041-0187')).toBe(false);
    const p9 = d.reports.find(
      (r) => r.site_day_id === today.find((s) => s.status === 'filed')!.id,
    )!;
    expect(p9.report_no).toBe('P9-0932-0094');
    expect(local(p9.filed_at!)).toBe('16:58');
  });

  it('seeds no instant after now, in any row (D36)', () => {
    for (const date of ['2026-10-12', '2026-10-14', '2026-11-06', '2027-03-08']) {
      const d = buildKestrelDemo({ date });
      expect(laterThan(d, d.now), date).toEqual([]);
    }
  });

  it('moves the evidence pack with the history', () => {
    const d = buildKestrelDemo({ date: '2026-10-14' });
    expect(
      d.packs.map((p) => [p.period_start, p.period_end, p.pdf_path!.split('/').at(-1)]),
    ).toEqual([['2026-09-28', '2026-10-07', 'eot_2026-09-28_2026-10-07.pdf']]);
    expect(d.siteDays.some((s) => s.date === '2026-09-28')).toBe(true);
    expect(d.notifications.find((n) => n.kind === 'pack_ready')!.title).toBe(
      'EOT evidence pack ready — Riverside Lofts, Sep 28 – Oct 7',
    );
    expect(demo.packs[0]).toMatchObject({ period_start: '2026-09-01', period_end: '2026-09-30' });
  });

  it('stops at the clock when built on the target day before 17:00 (--date today)', () => {
    // Wed Oct 14, 08:00 CDT: nothing of today has happened yet, not even Pier 9 or the sign-off.
    const early = buildKestrelDemo({ date: '2026-10-14', clock: '2026-10-14T13:00:00.000Z' });
    expect(early.now).toBe('2026-10-14T13:00:00.000Z');
    expect(laterThan(early, early.now)).toEqual([]);
    const today = early.siteDays.filter((s) => s.date === '2026-10-14');
    expect(today.map((s) => s.status)).toEqual(Array(6).fill('pending'));
    const p9 = early.sites.find((s) => s.project_code === 'P9-0932')!;
    expect(p9.report_seq).toBe(93); // its report today will be §18.1's P9-0932-0094
    // Yesterday's Riverside report (signed off at 08:30 today) is still waiting for sign-off.
    const rl = early.sites.find((s) => s.project_code === 'RL-2041')!.id;
    const yesterday = early.reports.find(
      (r) =>
        r.site_id === rl &&
        r.site_day_id ===
          early.siteDays.find((s) => s.site_id === rl && s.date === '2026-10-13')!.id,
    )!;
    expect(yesterday).toMatchObject({ status: 'filed', signed_off_at: null, signed_off_by: null });
    // The glossary notification of 12:00 is not there yet.
    expect(early.notifications.map((n) => n.kind)).toEqual(['pack_ready']);

    // 16:59: Pier 9 is in (16:58) and nothing later is seeded.
    const late = buildKestrelDemo({ date: '2026-10-14', clock: '2026-10-14T21:59:30.000Z' });
    expect(laterThan(late, late.now)).toEqual([]);
    expect(
      late.siteDays.filter((s) => s.date === '2026-10-14' && s.status === 'filed'),
    ).toHaveLength(1);
    // From 17:00 on, and on any other day, the live day is as of 17:00.
    for (const clock of ['2026-10-14T23:30:00.000Z', '2026-10-20T12:00:00.000Z']) {
      expect(JSON.stringify(buildKestrelDemo({ date: '2026-10-14', clock }))).toBe(
        JSON.stringify(buildKestrelDemo({ date: '2026-10-14' })),
      );
    }
    // The clock only applies to a live day.
    expect(buildKestrelDemo({ clock: '2026-10-09T13:00:00.000Z' }).now).toBe(demo.now);
  });

  it('is deterministic for a date and keeps ids and content across dates', () => {
    expect(JSON.stringify(buildKestrelDemo({ date: '2026-10-16' }))).toBe(
      JSON.stringify(buildKestrelDemo({ date: '2026-10-16' })),
    );
    // A Friday: the whole canonical history, moved by one week.
    const fri = buildKestrelDemo({ date: '2026-10-16' });
    expect(fri.reports).toHaveLength(demo.reports.length - 4); // RL, OM, NG, HS of Oct 9
    const old = demo.reports.find((r) => r.report_no === 'NG-2210-0060')!;
    const moved = fri.reports.find((r) => r.id === old.id)!;
    expect(moved.report_no).toBe(old.report_no);
    expect(Date.parse(moved.received_at!) - Date.parse(old.received_at!)).toBe(7 * 86_400_000);
    expect(fri.versions.find((v) => v.report_id === old.id)!.summary).toBe(
      demo.versions.find((v) => v.report_id === old.id)!.summary,
    );
  });

  it('keeps the local wall-clock time across a DST change', () => {
    // Chicago leaves DST on Sun Nov 1, 2026: history before it is CDT, after it CST.
    const d = buildKestrelDemo({ date: '2026-11-06' });
    for (const r of d.reports) {
      const canonical = demo.reports.find((x) => x.id === r.id)!;
      expect(local(r.received_at!)).toBe(local(canonical.received_at!));
    }
    for (const s of d.siteDays) expect(local(s.deadline_at)).toBe('17:30');
    const offsets = new Set(d.siteDays.map((s) => (Date.parse(s.deadline_at) / 3_600_000) % 24));
    expect([...offsets].sort()).toEqual([22.5, 23.5]); // 17:30 CDT and 17:30 CST in UTC hours
    expect(d.now).toBe('2026-11-06T23:00:00.000Z'); // 17:00 CST
  });

  it('refuses weekends and malformed dates', () => {
    expect(() => buildKestrelDemo({ date: '2026-10-17' })).toThrow(/weekend/);
    expect(() => buildKestrelDemo({ date: '2026-02-30' })).toThrow(/YYYY-MM-DD/);
    expect(() => buildKestrelDemo({ date: 'today' })).toThrow(/YYYY-MM-DD/);
  });
});
