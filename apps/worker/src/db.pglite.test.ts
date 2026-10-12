import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Sql } from 'postgres';
import { emptyReportData, type DailyReportData } from '@sitelog/shared';
// The @sitelog/db harness (supabase/db-tests) boots PGlite with the Supabase stubs, every
// migration and the demo seed. Imported by path so the worker image does not need that package.
import { bootDatabase } from '../../../supabase/db-tests/src/harness.ts';
import { connectSql, createDb, type Db } from './db';

/**
 * The real `createDb` (postgres.js) against PGlite through @electric-sql/pglite-socket: every
 * migration in supabase/migrations plus supabase/seed.sql (Kestrel demo, §18). Covers the SQL
 * the in-memory fake (src/test/fake-db.ts) cannot: casts, enums, jsonb, arrays, joins, RPCs,
 * triggers and the custom type parsers in `connectSql`.
 *
 * One PGlite session backs both the postgres.js connection (max: 1) and the direct `q()`
 * helper used for setup and assertions, so tests run sequentially and share state; tests that
 * write use their own rows (Oct 12, new phones) so the read-only seed checks stay valid.
 */

let pg: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let db: Db;

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pg.query<T>(text, params)).rows;
const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
  const rows = await q<T>(text, params);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

// Seed ids, looked up by natural keys.
let ORG = '';
let RIVERSIDE = '';
let OAKMONT = '';
let ELM = '';
let MARCO = '';
let LENA = '';
const MARCO_PHONE = '+15550143378';
const company: Record<string, string> = {};

beforeAll(async () => {
  pg = await bootDatabase({ seed: true });
  server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 0 });
  await server.start();
  sql = connectSql(`postgres://postgres:postgres@${server.getServerConn()}/postgres`, { max: 1 });
  db = createDb(sql);

  ORG = (await one<{ id: string }>(`select id from orgs where name = 'Kestrel Build Group'`)).id;
  const sites = await q<{ id: string; project_code: string }>(`select id, project_code from sites`);
  const site = (code: string) => sites.find((s) => s.project_code === code)!.id;
  RIVERSIDE = site('RL-2041');
  OAKMONT = site('OM-1187');
  ELM = site('ES-0377');
  MARCO = (
    await one<{ id: string }>(`select id from reporters where phone_e164 = $1`, [MARCO_PHONE])
  ).id;
  LENA = (
    await one<{ id: string }>(`select id from auth.users where email = 'lena@kestrelbuild.example'`)
  ).id;
  for (const c of await q<{ id: string; name: string }>(`select id, name from companies`))
    company[c.name] = c.id;
});

afterAll(async () => {
  await db?.close();
  await server?.stop();
  await pg?.close();
});

describe('PostgresDb on PGlite: seed reads and type parsing', () => {
  it('reads orgs, settings, sites and people with JS-friendly types', async () => {
    const org = (await db.getOrg(ORG))!;
    expect(org.name).toBe('Kestrel Build Group');
    expect(org.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await db.listOrgs()).map((o) => o.id)).toEqual([ORG]);

    const settings = (await db.getOrgSettings(ORG))!;
    expect(settings.working_days).toEqual([1, 2, 3, 4, 5]); // smallint[] → number[]
    expect(settings.default_shift_hours).toBe(8); // numeric(4,2) → number
    expect(settings.default_deadline).toBe('17:30:00'); // time stays a string
    expect(settings.required_fields).toContain('manpower');
    expect(await db.getOrgSettings('00000000-0000-4000-8000-000000000000')).toBeNull();

    const riverside = (await db.getSite(RIVERSIDE))!;
    expect(riverside.project_code).toBe('RL-2041');
    expect(typeof riverside.lat).toBe('number');
    expect(riverside.active_since).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date stays YYYY-MM-DD
    const counts = await one<{ sites: number; companies: number }>(
      `select (select count(*)::int from sites where org_id = $1) as sites,
              (select count(*)::int from companies where org_id = $1) as companies`,
      [ORG],
    );
    const byOrg = await db.listSitesByOrg(ORG);
    expect(byOrg).toHaveLength(counts.sites);
    expect(byOrg.map((s) => s.name)).toEqual([...byOrg.map((s) => s.name)].sort());
    const active = await db.listActiveSites();
    expect(active.length).toBeGreaterThan(0);
    expect(Object.keys(active[0]!).sort()).toEqual(
      ['address', 'id', 'name', 'org_id', 'project_code'].sort(),
    );

    const marco = await db.listReportersByPhone(MARCO_PHONE);
    expect(marco.map((r) => r.id)).toEqual([MARCO]);
    expect(marco[0]!.languages).toEqual(['es', 'en']);
    expect((await db.getReporter(MARCO))!.name).toBe('Marco Ruiz');
    const sitesForMarco = await db.listSitesForReporter(MARCO);
    expect(sitesForMarco[0]!.id).toBe(RIVERSIDE);
    const reporters = await db.listReportersForSite(RIVERSIDE);
    expect(reporters[0]!.id).toBe(MARCO);

    const companies = await db.listCompanies(ORG);
    expect(companies).toHaveLength(counts.companies);
    expect(companies.find((c) => c.name === 'Delta Mechanical')!.aliases).toContain(
      'the Delta guys',
    );
    expect((await db.getCompany(company['Apex Concrete']!))!.name).toBe('Apex Concrete');

    const recipients = await q<{ email: string }>(
      `select email from site_recipients where site_id = $1 order by email`,
      [RIVERSIDE],
    );
    expect(recipients.length).toBeGreaterThan(0);
    expect(await db.listSiteRecipients(RIVERSIDE)).toEqual(recipients.map((r) => r.email));
    const admins = await db.listMemberEmails(ORG, ['admin', 'pm']);
    expect(admins.map((m) => m.email)).toEqual([
      'lena@kestrelbuild.example',
      'sam@kestrelbuild.example',
    ]);
    expect(await db.getUserContact(LENA)).toEqual({
      email: 'lena@kestrelbuild.example',
      display_name: 'Lena Ortiz',
    });

    const ctx = (await db.siteContext(RIVERSIDE))!;
    expect(ctx.site.id).toBe(RIVERSIDE);
    expect(ctx.org.id).toBe(ORG);
    expect(ctx.companies).toHaveLength(counts.companies);
    expect(ctx.reporters.map((r) => r.id)).toContain(MARCO);
    expect(ctx.glossary.length).toBeGreaterThan(0);
    expect(await db.siteContext('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('lists the weather log through current_weather (filed reports only, ordered)', async () => {
    const events = await db.listWeatherEvents(RIVERSIDE, '2026-10-01', '2026-10-09');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.date >= '2026-10-01' && e.date <= '2026-10-09').toBe(true);
      expect(typeof e.lost_hours).toBe('number');
      expect(typeof e.claim_ready).toBe('boolean');
      expect((e as unknown as { report_no: string }).report_no).toMatch(/^RL-2041-\d{4}$/);
    }
    const keys = events.map((e) => `${e.date} ${e.start_local ?? ''}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('summarises a sub invoice against reported hours (BrightLine +16 h)', async () => {
    const inv = await one<{ id: string }>(
      `select id from sub_invoices where invoice_no = 'BL-3381'`,
    );
    const summary = (await db.getInvoiceSummary(inv.id))!;
    expect(summary).toMatchObject({
      company_name: 'BrightLine Electric',
      invoice_no: 'BL-3381',
      period_start: '2026-10-05',
      period_end: '2026-10-09',
      invoiced_hours: 212,
      reported_hours: 196,
    });
    expect(summary.lines).toHaveLength(5);
    expect(summary.lines[0]).toEqual({ date: '2026-10-05', hours: 40 });
    expect(await db.getInvoiceSummary('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('computes the weekly digest for Oct 5–9', async () => {
    const stats = await db.digestStats(ORG, '2026-10-05', '2026-10-09');
    const days = await one<{ n: number; filed: number; on_time: number }>(
      `select count(*)::int as n,
              count(*) filter (where sd.status = 'filed')::int as filed,
              count(*) filter (where sd.status = 'filed' and not coalesce(r.is_late, sd.is_late))::int as on_time
       from site_days sd join sites s on s.id = sd.site_id left join reports r on r.id = sd.report_id
       where s.org_id = $1 and sd.date between '2026-10-05' and '2026-10-09'`,
      [ORG],
    );
    expect(stats.siteDays).toBe(days.n);
    expect(stats.filed).toBe(days.filed);
    expect(stats.onTime).toBe(days.on_time);
    expect(stats.siteDays).toBeGreaterThan(stats.filed);
    const lost = stats.weatherHoursBySite.reduce((a, w) => a + w.hours, 0);
    const expectedLost = await one<{ h: string }>(
      `select coalesce(sum(lost_hours), 0)::text as h from current_weather where org_id = $1 and date between '2026-10-05' and '2026-10-09'`,
      [ORG],
    );
    expect(lost).toBeCloseTo(Number(expectedLost.h), 5);
    const hours = stats.weatherHoursBySite.map((w) => w.hours);
    expect(hours).toEqual([...hours].sort((a, b) => b - a));
    for (const u of stats.unsigned) {
      expect(u.reportNo).toMatch(/^[A-Z0-9]+-\d{4}-\d{4}$/);
      expect(u.date >= '2026-10-05' && u.date <= '2026-10-09').toBe(true);
    }
    expect(stats.invoiceGaps.sort((a, b) => a.companyName.localeCompare(b.companyName))).toEqual([
      { companyName: 'BrightLine Electric', gap: 16 },
      { companyName: 'ClearView Glazing', gap: 8 },
    ]);
  });
});

describe('PostgresDb on PGlite: conversations and messages', () => {
  it('looks up, ensures and updates conversations by phone', async () => {
    const marco = (await db.getConversationByPhone(MARCO_PHONE))!;
    expect(marco.reporter_id).toBe(MARCO);
    expect(marco.state).toBe('idle');
    expect(marco.context).toEqual({});
    expect((await db.getConversation(marco.id))!.phone_e164).toBe(MARCO_PHONE);
    expect(await db.getConversationByPhone('+15550000001')).toBeNull();

    // ensure: insert for a new phone, plain read for an existing one with an empty patch
    const fresh = await db.ensureConversation('+15550000001', { org_id: ORG });
    expect(fresh).toMatchObject({ phone_e164: '+15550000001', org_id: ORG, state: 'new' });
    expect(fresh.context).toEqual({});
    expect((await db.ensureConversation('+15550000001', {})).id).toBe(fresh.id);
    const patched = await db.ensureConversation('+15550000001', {
      state: 'test_mode',
      context: { language: 'es' },
    });
    expect(patched).toMatchObject({
      id: fresh.id,
      state: 'test_mode',
      context: { language: 'es' },
    });
    // Fixed: a patch of only undefined values is a plain read (was "empty patch"), and the insert
    // keeps last_inbound_at / last_outbound_at (were dropped for new phones).
    expect((await db.ensureConversation('+15550000001', { state: undefined })).id).toBe(fresh.id);
    const withTimes = await db.ensureConversation('+15550000003', {
      state: 'welcome_sent',
      last_outbound_at: new Date('2026-10-12T13:00:00Z'),
      last_inbound_at: '2026-10-12T08:01:00-05:00',
    });
    expect(withTimes).toMatchObject({
      state: 'welcome_sent',
      last_outbound_at: '2026-10-12T13:00:00.000Z',
      last_inbound_at: '2026-10-12T13:01:00.000Z',
    });

    // update: enum state, nested jsonb context, Date → timestamptz, state_changed_at trigger
    await q(
      `update conversations set state_changed_at = '2026-10-01T00:00:00Z', updated_at = '2026-10-01T00:00:00Z' where id = $1`,
      [marco.id],
    );
    const at = new Date('2026-10-12T14:00:05.123Z');
    const context = {
      active_report_id: '00000000-0000-4000-8000-0000000000aa',
      pending: { message_ids: ['a', 'b'], awaiting: 'site', site_id: null },
      reask: { 'manpower.workers': 1 },
      note: 'He said "hola" — it\'s fine',
    };
    const updated = await db.updateConversation(marco.id, {
      state: 'processing',
      context,
      last_inbound_at: at,
      last_outbound_at: null,
    });
    expect(updated.state).toBe('processing');
    expect(updated.context).toEqual(context);
    expect(updated.last_inbound_at).toBe('2026-10-12T14:00:05.123Z');
    expect(updated.last_outbound_at).toBeNull();
    expect(updated.state_changed_at > '2026-10-02').toBe(true);
    expect(updated.updated_at > '2026-10-02').toBe(true);
    // Same state again → state_changed_at is kept.
    const again = await db.updateConversation(marco.id, { state: 'processing', context: {} });
    expect(again.state_changed_at).toBe(updated.state_changed_at);
    await expect(db.updateConversation(marco.id, {})).rejects.toThrow('empty patch');
    await expect(
      db.updateConversation('00000000-0000-4000-8000-000000000000', { state: 'idle' }),
    ).rejects.toThrow('not found');

    const processing = await db.listConversationsByState(['processing', 'test_mode']);
    expect(processing.map((c) => c.id).sort()).toEqual([fresh.id, marco.id].sort());
    expect(await db.listConversationsByState([])).toEqual([]);
    expect(await db.listConversationsByState(['processing'], new Date('2026-01-01'))).toEqual([]);
    const old = await db.listConversationsByState(
      ['welcome_sent', 'idle'],
      new Date('2026-10-08T00:00:00Z'),
    );
    expect(old.map((c) => c.phone_e164)).toEqual(['+15550143390']);
    await db.updateConversation(marco.id, { state: 'idle', context: {} });
  });

  it('stores outbound messages, updates media fields and lists inbound ones in a window', async () => {
    const convo = (await db.getConversationByPhone(MARCO_PHONE))!;
    const out = await db.insertOutboundMessage({
      conversation_id: convo.id,
      type: 'interactive',
      body: 'Quick check: how many?',
      payload: { kind: 'question', buttons: [{ id: 'q:1', title: '4 · full day' }] },
      wa_message_id: 'wamid.out.test.1',
      status: 'sent',
    });
    expect(out).toMatchObject({ direction: 'out', type: 'interactive', status: 'sent' });
    expect(out.payload).toEqual({
      kind: 'question',
      buttons: [{ id: 'q:1', title: '4 · full day' }],
    });
    expect((await db.getMessageByWaId('wamid.out.test.1'))!.id).toBe(out.id);
    const failed = await db.insertOutboundMessage({
      conversation_id: convo.id,
      type: 'text',
      body: 'x',
      status: 'failed',
      error: 'boom',
    });
    expect(failed).toMatchObject({ status: 'failed', error: 'boom', payload: null });

    // Inbound rows as the webhook writes them.
    const ins = await q<{ id: string }>(
      `insert into messages (conversation_id, direction, wa_message_id, type, body, media_id, media_mime, created_at) values
         ($1, 'in', 'wamid.in.t1', 'audio', null, 'media-1', 'audio/ogg', '2026-10-12T21:00:00Z'),
         ($1, 'in', 'wamid.in.t2', 'image', 'L5 pour', 'media-2', 'image/jpeg', '2026-10-12T21:00:30Z'),
         ($1, 'in', 'wamid.in.t3', 'text', 'and 4 from Ridgeway', null, null, '2026-10-12T21:01:00Z')
       returning id`,
      [convo.id],
    );
    const [audio, image, text] = ins.map((r) => r.id) as [string, string, string];
    await db.updateMessage(audio, {
      storage_path: `${ORG}/${RIVERSIDE}/2026-10-12/a.ogg`,
      duration_s: 168.4,
      status: 'received',
      payload: { voice: true },
    });
    const a = (await db.getMessage(audio))!;
    expect(a.duration_s).toBe(168.4); // numeric → number
    expect(a.payload).toEqual({ voice: true });
    expect(a.created_at).toBe('2026-10-12T21:00:00.000Z');

    const window = await db.listMessagesBetween(
      convo.id,
      new Date('2026-10-12T20:59:00Z'),
      new Date('2026-10-12T21:00:30Z'),
    );
    expect(window.map((m) => m.id)).toEqual([audio, image]); // inclusive, inbound only, ordered
    const typed = await db.listMessagesBetween(
      convo.id,
      new Date('2026-10-12T20:00:00Z'),
      new Date('2026-10-12T22:00:00Z'),
      ['audio', 'text'],
    );
    expect(typed.map((m) => m.id)).toEqual([audio, text]);

    // transcripts
    expect(await db.listTranscripts([])).toEqual([]);
    const t1 = await db.upsertTranscript({
      message_id: audio,
      language: 'es',
      text: 'Hoy colamos el nivel cinco',
      segments: [{ start: 0, end: 2.5, text: 'Hoy colamos' }],
      model: 'whisper-1',
    });
    const t2 = await db.upsertTranscript({
      message_id: audio,
      language: 'es+en',
      text: 'Hoy colamos el nivel cinco, then rain',
      segments: [
        { start: 0, end: 2.5, text: 'Hoy colamos' },
        { start: 2.5, end: 4, text: 'then rain' },
      ],
      model: 'gpt-4o-transcribe',
    });
    expect(t2.id).toBe(t1.id);
    expect((await db.getTranscript(audio))!.segments).toHaveLength(2);
    expect(await db.getTranscript(image)).toBeNull();
    const listed = await db.listTranscripts([audio, image, text]);
    expect(listed.map((t) => t.message_id)).toEqual([audio]);

    // Fixed: results follow the caller's (chronological) order, not heap/index order. The later
    // note is transcribed first and sorts first by uuid, so either physical order is wrong.
    const [early, late] = [
      'ffffffff-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-0000000000e1',
    ];
    await q(
      `insert into messages (id, conversation_id, direction, type, created_at) values
         ($1, $3, 'in', 'audio', '2026-10-12T20:00:00Z'), ($2, $3, 'in', 'audio', '2026-10-12T20:05:00Z')`,
      [early, late, convo.id],
    );
    for (const id of [late, early]) {
      await db.upsertTranscript({
        message_id: id,
        language: 'en',
        text: id,
        segments: [],
        model: null,
      });
    }
    expect((await db.listTranscripts([early, late])).map((t) => t.message_id)).toEqual([
      early,
      late,
    ]);
    await q(`delete from messages where id in ($1, $2)`, [early, late]);
  });
});

describe('PostgresDb on PGlite: glossary and unknown senders', () => {
  it('lists org, global and scoped glossary terms', async () => {
    const orgWide = await db.listGlossary(ORG);
    expect(orgWide.some((t) => t.org_id === null && t.status === 'built_in')).toBe(true);
    expect(orgWide.every((t) => t.scope_site_id === null && t.scope_reporter_id === null)).toBe(
      true,
    );
    const riverside = await db.listGlossary(ORG, RIVERSIDE);
    expect(riverside.some((t) => t.heard === 'pour on four')).toBe(true);
    expect(riverside.some((t) => t.heard === 'mud')).toBe(false); // scoped to another site
    const heard = riverside.map((t) => t.times_heard);
    expect(heard).toEqual([...heard].sort((a, b) => b - a));
  });

  it('upserts learned terms case-insensitively per scope', async () => {
    const first = await db.upsertGlossaryTerm({
      org_id: ORG,
      scope_site_id: RIVERSIDE,
      heard: 'Losa',
      official: null,
      kind: 'term',
      status: 'needs_review',
      language: 'es',
    });
    expect(first).toMatchObject({ times_heard: 1, status: 'needs_review', official: null });
    expect(first.last_seen_at).not.toBeNull();
    const second = await db.upsertGlossaryTerm({
      org_id: ORG,
      scope_site_id: RIVERSIDE,
      heard: 'losa',
      official: 'Concrete slab',
      kind: 'term',
      status: 'auto_learned',
    });
    expect(second).toMatchObject({ id: first.id, times_heard: 2, official: 'Concrete slab' });
    const third = await db.upsertGlossaryTerm({
      org_id: ORG,
      scope_site_id: RIVERSIDE,
      heard: 'LOSA',
      official: 'Something else',
      kind: 'term',
      status: 'auto_learned',
    });
    expect(third).toMatchObject({ id: first.id, times_heard: 3, official: 'Concrete slab' });
    // Another scope (org-wide) and another kind are different terms.
    const orgWide = await db.upsertGlossaryTerm({
      org_id: ORG,
      heard: 'losa',
      official: null,
      kind: 'term',
      status: 'needs_review',
    });
    expect(orgWide.id).not.toBe(first.id);
    const asCompany = await db.upsertGlossaryTerm({
      org_id: ORG,
      heard: 'losa',
      official: null,
      kind: 'company',
      status: 'needs_review',
      company_id: company['Apex Concrete']!,
    });
    expect(asCompany.id).not.toBe(orgWide.id);
    expect(asCompany.company_id).toBe(company['Apex Concrete']);
  });

  it('records unknown senders', async () => {
    const seeded = (await db.findPendingUnknownSender('+15550194410'))!;
    expect(seeded.guessed_site_id).toBe(ELM);
    expect((await db.getUnknownSender(seeded.id))!.snippet).toMatch(/^this is Luis/);

    const convo = await db.ensureConversation('+15550000002', {});
    const msg = await db.insertOutboundMessage({
      conversation_id: convo.id,
      type: 'text',
      body: 'unknownNumber',
      status: 'sent',
    });
    const row = await db.insertUnknownSender({
      org_id: null,
      phone_e164: '+15550000002',
      first_message_id: msg.id,
      snippet: 'Hi, this is Dana from the Pier 9 site',
    });
    expect(row).toMatchObject({ status: 'pending', org_id: null, guessed_site_id: null });
    await db.updateUnknownSender(row.id, { org_id: ORG, guessed_site_id: OAKMONT });
    expect(await db.getUnknownSender(row.id)).toMatchObject({
      org_id: ORG,
      guessed_site_id: OAKMONT,
    });
    await q(`update unknown_senders set status = 'linked' where id = $1`, [row.id]);
    expect(await db.findPendingUnknownSender('+15550000002')).toBeNull();
  });
});

/** A complete draft for Riverside on Mon Oct 12 that touches every denormalised column. */
function draftFor(date: string, audioId: string, photoId: string): DailyReportData {
  return {
    ...emptyReportData(date),
    summary: 'Level 5 slab poured after a wet start; 11 on site.',
    languageDetected: ['es', 'en'],
    manpower: [
      {
        companyId: company['Apex Concrete']!,
        companyNameHeard: 'Apex',
        companyName: 'Apex Concrete',
        trade: 'Concrete',
        area: 'Level 5',
        workers: 7,
        hoursPerWorker: 8,
        totalHours: 56,
        hoursBasis: 'full_day_default',
        confidence: 0.95,
        source: [{ type: 'audio', messageId: audioId, start: 12.5, end: 18 }],
      },
      {
        companyId: null,
        companyNameHeard: 'the Ridgeway crew',
        companyName: 'Ridgeway',
        workers: 4,
        hoursPerWorker: 6.5,
        totalHours: 26,
        hoursBasis: 'stated',
        confidence: 0.8,
        source: [],
      },
      {
        companyId: company['Delta Mechanical']!,
        companyNameHeard: 'the Delta guys',
        companyName: 'Delta Mechanical',
        workers: null,
        hoursPerWorker: 8,
        totalHours: null,
        hoursBasis: 'unknown',
        confidence: 0.6,
        source: [],
      },
    ],
    workPerformed: [
      {
        area: 'Level 5',
        activity: 'Slab pour',
        status: 'complete',
        percentComplete: 100,
        quantity: { value: 68, unit: 'yd³', heardAs: 'sixty-eight yards' },
        source: [{ type: 'audio', messageId: audioId, start: 3, end: 9 }],
      },
      { area: 'Level 3', activity: 'Electrical rough-in', status: 'in_progress', source: [] },
    ],
    weather: {
      conditionsText: 'Rain 07:00–10:30, dry afterwards',
      observed: { precipIn: 0.4, tempMinF: 52, tempMaxF: 61, windMph: 9, provider: 'Open-Meteo' },
      periods: [
        {
          start: '07:00',
          end: '10:30',
          condition: 'Rain',
          impact: 'Exterior masonry stopped',
          lostHours: 3.5,
          source: [
            { type: 'text', messageId: audioId },
            { type: 'audio', messageId: audioId, start: 1, end: 3 },
          ],
        },
        { condition: 'Overcast', lostHours: 0, source: [] },
      ],
    },
    photos: [{ messageId: photoId, caption: 'L5 pour', takenAt: '2026-10-12T21:00:30.000Z' }],
  };
}

describe('PostgresDb on PGlite: site days, reports, versions', () => {
  let siteDayId = '';
  let reportId = '';
  let audioId = '';
  let photoId = '';

  it('gets or creates the site day and updates it', async () => {
    const deadline = new Date('2026-10-12T22:30:00Z');
    expect(await db.findSiteDay(RIVERSIDE, '2026-10-12')).toBeNull();
    const day = await db.getOrCreateSiteDay(RIVERSIDE, '2026-10-12', deadline);
    expect(day).toMatchObject({
      site_id: RIVERSIDE,
      date: '2026-10-12',
      status: 'pending',
      deadline_at: '2026-10-12T22:30:00.000Z',
      reminder_stage: 0,
      weather: null,
    });
    const again = await db.getOrCreateSiteDay(RIVERSIDE, '2026-10-12', new Date());
    expect(again.id).toBe(day.id);
    expect(again.deadline_at).toBe(day.deadline_at); // conflict keeps the original deadline
    expect((await db.findSiteDay(RIVERSIDE, '2026-10-12'))!.id).toBe(day.id);
    expect((await db.getSiteDay(day.id))!.id).toBe(day.id);

    const weather = { date: '2026-10-12', summary: { precipIn: 0.4, provider: 'Open-Meteo' } };
    const updated = await db.updateSiteDay(day.id, {
      status: 'reminded',
      reminder_stage: 2,
      reminders_paused: true,
      weather,
      deadline_at: new Date('2026-10-12T23:00:00Z'),
    });
    expect(updated).toMatchObject({
      status: 'reminded',
      reminder_stage: 2,
      reminders_paused: true,
      weather,
      deadline_at: '2026-10-12T23:00:00.000Z',
    });
    expect(updated.updated_at > day.updated_at).toBe(true);
    await db.updateSiteDay(day.id, { status: 'processing', weather: null });
    expect((await db.getSiteDay(day.id))!.weather).toBeNull();
    siteDayId = day.id;
  });

  it('numbers and creates the report, then finds it as the open report of the day', async () => {
    const seq = await one<{ report_seq: number }>(`select report_seq from sites where id = $1`, [
      RIVERSIDE,
    ]);
    const no = await db.nextReportNo(RIVERSIDE);
    expect(no).toBe(`RL-2041-${String(seq.report_seq + 1).padStart(4, '0')}`);
    expect(await db.nextReportNo(RIVERSIDE)).toBe(
      `RL-2041-${String(seq.report_seq + 2).padStart(4, '0')}`,
    );
    await expect(db.nextReportNo('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      'site not found',
    );
    const report = await db.insertReport({
      org_id: ORG,
      site_id: RIVERSIDE,
      site_day_id: siteDayId,
      report_no: no,
      reporter_id: MARCO,
      received_at: new Date('2026-10-12T21:00:00Z'),
      kind: 'daily',
    });
    expect(report).toMatchObject({
      status: 'collecting',
      current_version: 1,
      received_at: '2026-10-12T21:00:00.000Z',
      review_reasons: [],
      needs_review: false,
    });
    await expect(
      db.insertReport({
        ...report,
        kind: 'daily',
        report_no: no,
        received_at: report.received_at!,
      }),
    ).rejects.toThrow(/duplicate key/);
    expect((await db.findOpenReportForSiteDay(siteDayId))!.id).toBe(report.id);
    expect((await db.findReportForSiteDay(siteDayId))!.id).toBe(report.id);
    reportId = report.id;

    const convo = (await db.getConversationByPhone(MARCO_PHONE))!;
    const msgs = await q<{ id: string; type: string }>(
      `select id, type::text from messages where conversation_id = $1 and wa_message_id in ('wamid.in.t1','wamid.in.t2')`,
      [convo.id],
    );
    audioId = msgs.find((m) => m.type === 'audio')!.id;
    photoId = msgs.find((m) => m.type === 'image')!.id;
  });

  it('links sources and lists them with their message columns', async () => {
    await db.insertReportSource({
      report_id: reportId,
      message_id: photoId,
      kind: 'photo',
      caption: 'L5 pour',
      taken_at: '2026-10-12T21:00:30Z',
    });
    await db.insertReportSource({ report_id: reportId, message_id: audioId, kind: 'audio' });
    await db.insertReportSource({ report_id: reportId, message_id: audioId, kind: 'audio' }); // dedupe
    const sources = await db.listReportSources(reportId);
    expect(sources.map((s) => [s.kind, s.message_type])).toEqual([
      ['audio', 'audio'],
      ['photo', 'image'],
    ]);
    expect(sources[0]).toMatchObject({
      duration_s: 168.4,
      message_created_at: '2026-10-12T21:00:00.000Z',
      media_mime: 'audio/ogg',
      taken_at: null,
    });
    expect(sources[1]).toMatchObject({
      caption: 'L5 pour',
      body: 'L5 pour',
      taken_at: '2026-10-12T21:00:30.000Z',
    });
    await expect(
      db.insertReportSource({ report_id: reportId, message_id: audioId, kind: 'voice' as never }),
    ).rejects.toThrow(/check constraint/);
  });

  it('stores the draft version, overwrites it while collecting, and updates fields', async () => {
    const data = draftFor('2026-10-12', audioId, photoId);
    const v1 = await db.insertVersion({
      report_id: reportId,
      version: 1,
      data,
      summary: data.summary,
      author: 'agent',
    });
    expect(v1).toMatchObject({ version: 1, author: 'agent', change_note: null, pdf_path: null });
    expect(v1.data).toEqual(data); // jsonb round-trip, including "yd³" and nulls
    const corrected = { ...data, summary: 'Corrected summary' };
    const v1b = await db.insertVersion({
      report_id: reportId,
      version: 1,
      data: corrected,
      summary: corrected.summary,
      author: 'agent',
      author_message_id: audioId,
      change_note: 'reporter fix',
    });
    expect(v1b).toMatchObject({
      summary: 'Corrected summary',
      author_message_id: audioId,
      change_note: 'reporter fix',
    });
    await db.updateVersion(reportId, 1, { data, summary: data.summary, change_note: null });
    expect((await db.getVersion(reportId, 1))!.data).toEqual(data);
    expect(await db.getVersion(reportId, 2)).toBeNull();
    expect((await db.listVersions(reportId)).map((v) => v.version)).toEqual([1]);
    // Drafts are not denormalised: nothing in the aggregate tables yet.
    const n = await one<{ n: number }>(
      `select count(*)::int as n from manpower_entries where report_id = $1`,
      [reportId],
    );
    expect(n.n).toBe(0);
  });

  it('asks and answers questions with jsonb targets, options and answers', async () => {
    const qn = await db.insertQuestion({
      report_id: reportId,
      field: 'manpower.workers',
      target: { companyId: company['Delta Mechanical'], path: 'manpower[2].workers' },
      prompt: 'How many from Delta Mechanical?',
      options: null,
    });
    expect(qn).toMatchObject({ options: null, asked_at: null, answer: null });
    expect(qn.target).toEqual({
      companyId: company['Delta Mechanical'],
      path: 'manpower[2].workers',
    });
    const buttons = [
      { id: `q:${qn.id}:0`, title: '4 · full day' },
      { id: `q:${qn.id}:other`, title: 'Other…' },
    ];
    const asked = new Date('2026-10-12T21:02:00Z');
    await db.updateQuestion(qn.id, {
      options: buttons,
      asked_message_id: audioId,
      asked_at: asked,
    });
    await db.updateQuestion(qn.id, {
      answer: { workers: 4, hoursPerWorker: 8 },
      answered_message_id: audioId,
      answered_at: new Date('2026-10-12T21:03:00Z'),
    });
    const got = (await db.getQuestion(qn.id))!;
    expect(got.options).toEqual(buttons);
    expect(got.answer).toEqual({ workers: 4, hoursPerWorker: 8 });
    expect(got.asked_at).toBe('2026-10-12T21:02:00.000Z');
    expect(got.answered_at).toBe('2026-10-12T21:03:00.000Z');
    const second = await db.insertQuestion({
      report_id: reportId,
      field: 'photo',
      target: null,
      prompt: 'Send a photo?',
      options: [{ id: 'x', title: 'Later' }],
      asked_at: '2026-10-12T21:04:00Z',
    });
    expect(second.options).toEqual([{ id: 'x', title: 'Later' }]);
    expect((await db.listQuestions(reportId)).map((x) => x.id)).toEqual([qn.id, second.id]);
  });

  it('files: denormalises the version into the aggregate tables and the current_* views', async () => {
    await db.denormalizeVersion(reportId, 1);
    await db.denormalizeVersion(reportId, 1); // idempotent
    const mp = await q<{
      company_id: string | null;
      company_name: string;
      company_name_heard: string;
      workers: number;
      hours: string;
      hours_basis: string;
      confidence: string;
      source: unknown;
    }>(
      `select company_id, company_name, company_name_heard, workers, hours::text, hours_basis, confidence::text, source
       from manpower_entries where report_id = $1 and version = 1 order by company_name`,
      [reportId],
    );
    expect(mp.map((m) => [m.company_name, m.company_id, m.workers, Number(m.hours)])).toEqual([
      ['Apex Concrete', company['Apex Concrete'], 7, 56],
      ['Delta Mechanical', company['Delta Mechanical'], 0, 0],
      ['Ridgeway', null, 4, 26],
    ]);
    expect(mp[0]!.source).toEqual({ type: 'audio', messageId: audioId, start: 12.5, end: 18 });
    expect(mp[0]!.confidence).toBe('0.95');
    const work = await q<{
      activity: string;
      percent: number | null;
      quantity: string | null;
      status: string;
    }>(
      `select activity, percent, quantity, status from work_items where report_id = $1 order by activity`,
      [reportId],
    );
    expect(work).toEqual([
      { activity: 'Electrical rough-in', percent: null, quantity: null, status: 'in_progress' },
      { activity: 'Slab pour', percent: 100, quantity: '68 yd³', status: 'complete' },
    ]);
    const wx = await q<{
      start_local: string | null;
      condition: string;
      lost_hours: string;
      photo_count: number;
      audio_source: unknown;
      observed: unknown;
      claim_ready: boolean;
      date: string;
    }>(
      `select start_local::text, condition, lost_hours::text, photo_count, audio_source, observed, claim_ready, date::text
       from weather_events where report_id = $1 order by condition desc`,
      [reportId],
    );
    expect(
      wx.map((w) => [w.condition, w.start_local, Number(w.lost_hours), w.claim_ready]),
    ).toEqual([
      ['Rain', '07:00:00', 3.5, true],
      ['Overcast', null, 0, false],
    ]);
    expect(wx[0]).toMatchObject({
      date: '2026-10-12',
      photo_count: 1,
      audio_source: { type: 'audio', messageId: audioId, start: 1, end: 3 },
      observed: { precipIn: 0.4, tempMinF: 52, tempMaxF: 61, windMph: 9, provider: 'Open-Meteo' },
    });

    // Not visible in the current_* views until the report is filed.
    expect(await db.listWeatherEvents(RIVERSIDE, '2026-10-12', '2026-10-12')).toEqual([]);
    const filedAt = new Date('2026-10-12T21:10:00Z');
    const report = await db.updateReport(reportId, {
      status: 'filed',
      current_version: 1,
      filed_at: filedAt,
      confirmed_at: filedAt,
      is_late: false,
      needs_review: true,
      review_reasons: ['unknown_company:Ridgeway', 'low_confidence:manpower[2].workers'],
    });
    expect(report).toMatchObject({
      status: 'filed',
      filed_at: '2026-10-12T21:10:00.000Z',
      needs_review: true,
      review_reasons: ['unknown_company:Ridgeway', 'low_confidence:manpower[2].workers'],
    });
    const cleared = await db.updateReport(reportId, { review_reasons: [], needs_review: false });
    expect(cleared.review_reasons).toEqual([]);
    await db.updateReport(reportId, {
      review_reasons: ['unknown_company:Ridgeway'],
      needs_review: true,
    });
    await db.updateSiteDay(siteDayId, { status: 'filed', report_id: reportId, is_late: false });
    expect(await db.findOpenReportForSiteDay(siteDayId)).toBeNull();
    expect((await db.findReportForSiteDay(siteDayId))!.id).toBe(reportId);
    expect(
      (await db.findReportsByDate([RIVERSIDE, OAKMONT], '2026-10-12')).map((r) => r.id),
    ).toEqual([reportId]);
    expect(await db.findReportsByDate([], '2026-10-12')).toEqual([]);
    const period = await db.listReportsForSitePeriod(RIVERSIDE, '2026-10-08', '2026-10-12');
    expect(period.at(-1)!.id).toBe(reportId);
    expect(period.length).toBeGreaterThanOrEqual(2);

    const events = await db.listWeatherEvents(RIVERSIDE, '2026-10-12', '2026-10-12');
    expect(events.map((e) => [e.condition, e.lost_hours, e.start_local])).toEqual([
      ['Rain', 3.5, '07:00:00'],
      ['Overcast', 0, null],
    ]);
    const hours = await one<{ h: string }>(
      `select sum(hours)::text as h from current_manpower where report_id = $1`,
      [reportId],
    );
    expect(Number(hours.h)).toBe(82);
  });

  it('create_report_version (office edit RPC) builds v2 on the worker-filed report', async () => {
    const v1 = (await db.getVersion(reportId, 1))!.data as DailyReportData;
    const edited: DailyReportData = {
      ...v1,
      manpower: v1.manpower.map((m) =>
        m.companyName === 'Apex Concrete' ? { ...m, workers: 8, totalHours: 64 } : m,
      ),
    };
    // As Lena (admin), the way PostgREST calls it.
    await sql`select set_config('request.jwt.claim.sub', ${LENA}, false)`;
    try {
      const [res] = await sql<Array<{ r: { version: number } }>>`
        select create_report_version(${reportId}, ${sql.json(edited as never)}, 'Apex 7 → 8 workers') as r`;
      expect(res!.r).toEqual({ version: 2 });
    } finally {
      await sql`select set_config('request.jwt.claim.sub', '', false)`;
    }
    const report = (await db.getReport(reportId))!;
    expect(report).toMatchObject({ current_version: 2, status: 'filed' });
    const versions = await db.listVersions(reportId);
    expect(versions.map((v) => [v.version, v.author, v.change_note, v.author_user_id])).toEqual([
      [1, 'agent', null, null],
      [2, 'office_user', 'Apex 7 → 8 workers', LENA],
    ]);
    const current = await q<{ company_name: string; workers: number }>(
      `select company_name, workers from current_manpower where report_id = $1 order by company_name`,
      [reportId],
    );
    expect(current.map((c) => [c.company_name, c.workers])).toEqual([
      ['Apex Concrete', 8],
      ['Delta Mechanical', 0],
      ['Ridgeway', 4],
    ]);
    // v1 rows are kept (versions are immutable), only v2 is "current".
    const all = await one<{ n: number }>(
      `select count(*)::int as n from manpower_entries where report_id = $1`,
      [reportId],
    );
    expect(all.n).toBe(6);
    const job = await one<{ id: number; payload: Record<string, unknown> }>(
      `select id, payload from jobs where dedupe_key = $1`,
      [`render_pdf:${reportId}:2`],
    );
    expect(job.payload).toMatchObject({ reportId, version: 2, changeNote: 'Apex 7 → 8 workers' });
    const audit = await q<{ action: string; actor_id: string }>(
      `select action, actor_id from audit_log where entity_id = $1 order by id`,
      [reportId],
    );
    expect(audit.map((a) => a.action)).toContain('report.version_created');
    await q(`delete from jobs where id = $1`, [job.id]);

    // Fixed: a WhatsApp edit that computed "v2" before the office committed v2 must not overwrite
    // it (insertVersion used to upsert unconditionally on filed reports).
    await expect(
      db.insertVersion({
        report_id: reportId,
        version: 2,
        data: v1,
        summary: v1.summary,
        author: 'reporter_reply',
        change_note: 'Apex 7 → 9 workers',
      }),
    ).rejects.toThrow('already exists and is immutable');
    expect((await db.getVersion(reportId, 2))!.change_note).toBe('Apex 7 → 8 workers');
    // A version left above current_version by a failed attempt is still retried in place.
    const dangling = { report_id: reportId, version: 3, summary: null, author: 'agent' as const };
    await db.insertVersion({ ...dangling, data: v1, change_note: 'first try' });
    const retried = await db.insertVersion({ ...dangling, data: edited, change_note: 'retry' });
    expect(retried.change_note).toBe('retry');
    await q(`delete from report_versions where report_id = $1 and version = 3`, [reportId]);
  });

  // Regression for 20261012000002_rpc_fixes.sql: unknown company ids are stored as null.
  it('a draft whose companyId is not a known company still denormalises', async () => {
    const day = await db.getOrCreateSiteDay(
      OAKMONT,
      '2026-10-12',
      new Date('2026-10-12T22:30:00Z'),
    );
    const report = await db.insertReport({
      org_id: ORG,
      site_id: OAKMONT,
      site_day_id: day.id,
      report_no: await db.nextReportNo(OAKMONT),
      reporter_id: null,
      received_at: '2026-10-12T21:30:00Z',
      kind: 'daily',
    });
    const data = draftFor('2026-10-12', audioId, photoId);
    data.manpower[0] = { ...data.manpower[0]!, companyId: '00000000-0000-4000-8000-0000000000ff' };
    await db.insertVersion({
      report_id: report.id,
      version: 1,
      data,
      summary: null,
      author: 'agent',
    });
    await db.denormalizeVersion(report.id, 1);
    const rows = await q<{ company_id: string | null; company_name: string }>(
      `select company_id, company_name from manpower_entries where report_id = $1 order by company_name`,
      [report.id],
    );
    expect(rows[0]).toEqual({ company_id: null, company_name: 'Apex Concrete' });
  });

  it('report numbers keep growing past 9999 instead of truncating', async () => {
    const { report_seq: before } = await one<{ report_seq: number }>(
      `select report_seq from sites where id = $1`,
      [OAKMONT],
    );
    await q(`update sites set report_seq = 9999 where id = $1`, [OAKMONT]);
    try {
      expect(await db.nextReportNo(OAKMONT)).toMatch(/-10000$/);
    } finally {
      await q(`update sites set report_seq = $2 where id = $1`, [OAKMONT, before]);
    }
  });
});

describe('PostgresDb on PGlite: notifications, audit, job queue', () => {
  it('notifies the org and writes the audit log', async () => {
    const id = await db.notifyOrg(ORG, 'needs_review', 'RL-2041 needs review', null, '/reports/x');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const n = await one<{
      kind: string;
      title: string;
      body: string | null;
      user_id: string | null;
    }>(`select kind, title, body, user_id from notifications where id = $1`, [id]);
    expect(n).toEqual({
      kind: 'needs_review',
      title: 'RL-2041 needs review',
      body: null,
      user_id: null,
    });
    const forLena = await db.notifyOrg(
      ORG,
      'pack_ready',
      'Pack ready',
      'September',
      '/weather',
      LENA,
    );
    expect(
      (await one<{ user_id: string }>(`select user_id from notifications where id = $1`, [forLena]))
        .user_id,
    ).toBe(LENA);

    await db.logAudit({
      org_id: ORG,
      actor_type: 'reporter',
      actor_id: MARCO,
      action: 'report.created',
      entity: 'report',
      entity_id: '00000000-0000-4000-8000-0000000000aa',
      diff: { report_no: 'RL-2041-0999', reasons: ['a', 'b'], nested: { ok: true } },
    });
    await db.logAudit({ org_id: null, actor_type: 'system', action: 'retention.cleanup' });
    const rows = await q<{
      actor_type: string;
      actor_id: string | null;
      diff: unknown;
      entity: string | null;
    }>(`select actor_type, actor_id, diff, entity from audit_log order by id desc limit 2`);
    expect(rows).toEqual([
      { actor_type: 'system', actor_id: null, diff: null, entity: null },
      {
        actor_type: 'reporter',
        actor_id: MARCO,
        diff: { report_no: 'RL-2041-0999', reasons: ['a', 'b'], nested: { ok: true } },
        entity: 'report',
      },
    ]);
    await expect(
      db.logAudit({ org_id: ORG, actor_type: 'robot' as never, action: 'x' }),
    ).rejects.toThrow(/check constraint/);
  });

  it('enqueues with dedupe keys, claims, completes and records metrics', async () => {
    await q(`delete from jobs`);
    const a = await db.enqueueJob(
      'extract_report',
      { reportId: 'r1' },
      { dedupeKey: 'extract:r1:2' },
    );
    expect(typeof a).toBe('number');
    expect(
      await db.enqueueJob('extract_report', { reportId: 'r1' }, { dedupeKey: 'extract:r1:2' }),
    ).toBe(a);
    const later = await db.enqueueJob(
      'send_template',
      { conversationId: 'c', template: 'sitelog_reminder_1' },
      { runAfter: new Date(Date.now() + 3_600_000) },
    );
    const plain = await db.enqueueJob('weekly_digest', { orgId: ORG, weekStart: '2026-10-05' });
    expect(await db.queueStats()).toEqual({ queued: 3, running: 0, dead: 0 });

    const claimed = await db.claimJobs('worker-a', 10);
    expect(claimed.map((j) => j.id).sort()).toEqual([a, plain].sort()); // not the future one
    for (const j of claimed) {
      expect(j).toMatchObject({ status: 'running', attempts: 1, locked_by: 'worker-a' });
      expect(typeof j.id).toBe('number');
      expect(j.locked_at).toMatch(/Z$/);
    }
    expect(claimed.find((j) => j.id === a)!.payload).toEqual({ reportId: 'r1' });
    expect(await db.claimJobs('worker-b', 10)).toEqual([]);
    // While running, the same dedupe key still maps to the running job.
    expect(
      await db.enqueueJob('extract_report', { reportId: 'r1' }, { dedupeKey: 'extract:r1:2' }),
    ).toBe(a);
    expect(await db.queueStats()).toEqual({ queued: 1, running: 2, dead: 0 });

    await db.updateJobMetrics(a, {
      tokens: { input: 1200, output: 300 },
      estCostUsd: 0.0123,
      latencyMs: 4100,
    });
    await db.completeJob(a);
    const done = (await db.getJob(a))!;
    expect(done).toMatchObject({ status: 'done', locked_at: null, locked_by: null });
    expect(done.finished_at).not.toBeNull();
    expect(done.payload).toEqual({
      reportId: 'r1',
      metrics: { tokens: { input: 1200, output: 300 }, estCostUsd: 0.0123, latencyMs: 4100 },
    });
    // Once done, the key is free again.
    const b = await db.enqueueJob(
      'extract_report',
      { reportId: 'r1' },
      { dedupeKey: 'extract:r1:2' },
    );
    expect(b).not.toBe(a);
    expect(await db.getJob(999_999)).toBeNull();
    await q(`delete from jobs where id <> $1`, [later]);
  });

  it('fails with the §10.1 backoff and goes dead after the 5th attempt', async () => {
    const id = await db.enqueueJob('transcribe_audio', { messageId: 'm1' });
    const expected = [30, 120, 600, 1800];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const [job] = await db.claimJobs('worker-a', 1);
      expect(job).toMatchObject({ id, attempts: attempt });
      await db.failJob(id, `boom ${attempt} ` + 'x'.repeat(5000));
      const row = await one<{
        status: string;
        delay: number;
        last_error: string;
        locked_by: string | null;
      }>(
        `select status::text, extract(epoch from run_after - now())::float8 as delay, last_error, locked_by from jobs where id = $1`,
        [id],
      );
      expect(row.last_error.length).toBe(4000);
      expect(row.last_error.startsWith(`boom ${attempt}`)).toBe(true);
      expect(row.locked_by).toBeNull();
      if (attempt < 5) {
        expect(row.status).toBe('queued');
        expect(row.delay).toBeGreaterThan(expected[attempt - 1]! - 5);
        expect(row.delay).toBeLessThanOrEqual(expected[attempt - 1]!);
        await q(`update jobs set run_after = now() - interval '1 second' where id = $1`, [id]);
      } else {
        expect(row.status).toBe('dead');
      }
    }
    expect((await db.getJob(id))!.finished_at).not.toBeNull();
    expect(await db.claimJobs('worker-a', 5)).toEqual([]);
    expect((await db.queueStats()).dead).toBe(1);
    await db.failJob(424242, 'unknown job is a no-op');
  });

  it('returns the winning job when a concurrent enqueue of the same dedupe key races it', async () => {
    // Simulate the race inside one session: the first insert of key 'race:1' fails exactly the way
    // the loser of two concurrent enqueue_job calls does (unique_violation on the partial index).
    await pg.exec(`
      create sequence race_once;
      create function simulate_race() returns trigger language plpgsql as $f$
      begin
        if new.dedupe_key = 'race:1' and nextval('race_once') = 1 then
          raise exception 'duplicate key value violates unique constraint "jobs_dedupe_key_active"'
            using errcode = 'unique_violation', constraint = 'jobs_dedupe_key_active';
        end if;
        return new;
      end $f$;
      create trigger simulate_race before insert on jobs for each row execute function simulate_race();
    `);
    try {
      const id = await db.enqueueJob('extract_report', { reportId: 'r9' }, { dedupeKey: 'race:1' });
      expect((await db.getJob(id))!.dedupe_key).toBe('race:1');
      // Other errors on a dedupe-keyed enqueue still surface.
      await expect(
        db.enqueueJob(null as never, { reportId: 'r9' }, { dedupeKey: 'race:2' }),
      ).rejects.toThrow(/null value in column "type"/);
    } finally {
      await pg.exec(
        `drop trigger simulate_race on jobs; drop function simulate_race(); drop sequence race_once;`,
      );
    }
  });

  it('reclaims jobs stuck in running for more than 15 minutes', async () => {
    await q(`delete from jobs`);
    const id = await db.enqueueJob('render_pdf', { reportId: 'r', version: 1 });
    await db.claimJobs('worker-a', 1);
    expect(await db.claimJobs('worker-b', 1)).toEqual([]);
    await q(`update jobs set locked_at = now() - interval '16 minutes' where id = $1`, [id]);
    const [again] = await db.claimJobs('worker-b', 1);
    expect(again).toMatchObject({ id, attempts: 2, locked_by: 'worker-b' });
  });
});

describe('PostgresDb on PGlite: evidence packs and retention', () => {
  it('updates evidence packs', async () => {
    const seeded = await one<{ id: string }>(`select id from evidence_packs limit 1`);
    const pack = (await db.getEvidencePack(seeded.id))!;
    expect(pack).toMatchObject({
      status: 'ready',
      period_start: '2026-09-01',
      period_end: '2026-09-30',
    });
    expect(pack.sections).toEqual(['summary', 'reports', 'transcripts', 'photos', 'weather']);
    await db.updateEvidencePack(pack.id, {
      status: 'failed',
      error: 'storage down',
      pdf_path: null,
    });
    expect(await db.getEvidencePack(pack.id)).toMatchObject({
      status: 'failed',
      error: 'storage down',
      pdf_path: null,
    });
    await db.updateEvidencePack(pack.id, {
      status: 'ready',
      error: null,
      pdf_path: 'x.pdf',
      ready_at: '2026-10-12T10:00:00Z',
    });
    expect(await db.getEvidencePack(pack.id)).toMatchObject({
      status: 'ready',
      ready_at: '2026-10-12T10:00:00.000Z',
    });
  });

  it('lists expired voice notes and photos and purges them (transcript + storage path)', async () => {
    const before = new Date('2026-10-12T21:00:10Z');
    // Fixed: a photo sent "as a file" (inbound document, stored in the photos bucket) is customer
    // media and expires too; our own outbound PDFs (kept with the reports) never do.
    const convo = (await db.getConversationByPhone(MARCO_PHONE))!;
    const [inDoc, outDoc] = (
      await q<{ id: string }>(
        `insert into messages (conversation_id, direction, type, media_mime, storage_path, created_at) values
           ($1, 'in', 'document', 'image/jpeg', 'org/site/2026-10-12/doc.jpg', '2026-10-12T20:59:00Z'),
           ($1, 'out', 'document', 'application/pdf', 'org/site/RL-2041-0188_v1.pdf', '2026-10-12T20:59:01Z')
         returning id`,
        [convo.id],
      )
    ).map((r) => r.id);
    const expired = await db.listExpiredMedia(before, 500);
    expect(expired.length).toBeGreaterThan(1);
    for (const m of expired) {
      expect(['audio', 'image', 'document']).toContain(m.type);
      expect(m.storage_path).toBeTruthy();
      expect(m.created_at < '2026-10-12T21:00:10.000Z').toBe(true);
    }
    const ids = expired.map((m) => m.message_id);
    expect(ids).toContain(inDoc);
    expect(ids).not.toContain(outDoc);
    const times = expired.map((m) => m.created_at);
    expect(times).toEqual([...times].sort());
    expect(await db.listExpiredMedia(before, 1)).toHaveLength(1);

    const audio = expired.find((m) => m.created_at === '2026-10-12T21:00:00.000Z')!;
    expect(audio.type).toBe('audio');
    expect(await db.getTranscript(audio.message_id)).not.toBeNull();
    await db.purgeMessageMedia(audio.message_id, new Date('2026-11-12T03:00:00Z'));
    const purged = (await db.getMessage(audio.message_id))!;
    expect(purged.storage_path).toBeNull();
    expect(purged.payload).toEqual({ voice: true, purged_at: '2026-11-12T03:00:00.000Z' });
    expect(await db.getTranscript(audio.message_id)).toBeNull();
    expect((await db.listExpiredMedia(before, 500)).map((m) => m.message_id)).not.toContain(
      audio.message_id,
    );
    // A message without payload gets one.
    const other = expired.find((m) => m.message_id !== audio.message_id)!;
    await q(`update messages set payload = null where id = $1`, [other.message_id]);
    await db.purgeMessageMedia(other.message_id, new Date('2026-11-12T03:00:00Z'));
    expect((await db.getMessage(other.message_id))!.payload).toEqual({
      purged_at: '2026-11-12T03:00:00.000Z',
    });
  });

  it('updates reporters (invite bookkeeping)', async () => {
    await db.updateReporter(MARCO, {
      last_invite_error: 'Not on WhatsApp',
      invited_at: '2026-10-12T10:00:00-05:00', // any offset comes back as UTC ISO
    });
    expect(await db.getReporter(MARCO)).toMatchObject({
      last_invite_error: 'Not on WhatsApp',
      invited_at: '2026-10-12T15:00:00.000Z',
    });
    await db.updateReporter(MARCO, { status: 'disabled' });
    expect(await db.listReportersByPhone(MARCO_PHONE)).toEqual([]);
    await db.updateReporter(MARCO, { status: 'verified', last_invite_error: null });
    const created = await db.insertCompany(ORG, 'Ridgeway', 'unconfirmed', 'Framing');
    expect(created).toMatchObject({ name: 'Ridgeway' });
    const fresh = await db.insertCompany(ORG, 'Northside Roofing', 'unconfirmed');
    expect(fresh).toMatchObject({ status: 'unconfirmed', trade: null, aliases: [] });
    expect((await db.insertCompany(ORG, 'Northside Roofing', 'confirmed')).id).toBe(fresh.id);
  });

  it('keeps two sites with the same name apart in the digest weather totals', async () => {
    // Fixed: the digest grouped weather hours by site *name*, merging namesake sites.
    const [twin] = await q<{ id: string }>(
      `insert into sites (org_id, name, project_code, timezone) values ($1, 'Riverside Lofts — Block B', 'RL-2042', 'America/Chicago') returning id`,
      [ORG],
    );
    const day = await db.getOrCreateSiteDay(
      twin!.id,
      '2026-10-13',
      new Date('2026-10-13T22:30:00Z'),
    );
    const report = await db.insertReport({
      org_id: ORG,
      site_id: twin!.id,
      site_day_id: day.id,
      report_no: await db.nextReportNo(twin!.id),
      reporter_id: null,
      received_at: '2026-10-13T21:00:00Z',
      kind: 'daily',
    });
    expect(report.report_no).toBe('RL-2042-0001');
    const data: DailyReportData = {
      ...emptyReportData('2026-10-13'),
      weather: {
        conditionsText: 'High wind PM',
        periods: [
          { start: '13:00', end: '15:00', condition: 'High wind', lostHours: 2, source: [] },
        ],
      },
    };
    await db.insertVersion({
      report_id: report.id,
      version: 1,
      data,
      summary: null,
      author: 'agent',
    });
    await db.denormalizeVersion(report.id, 1);
    await db.updateReport(report.id, {
      status: 'filed',
      filed_at: new Date('2026-10-13T21:05:00Z'),
    });
    const stats = await db.digestStats(ORG, '2026-10-12', '2026-10-16');
    expect(stats.weatherHoursBySite).toEqual([
      { siteName: 'Riverside Lofts — Block B', hours: 3.5 },
      { siteName: 'Riverside Lofts — Block B', hours: 2 },
    ]);
  });
});
