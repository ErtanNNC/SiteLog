import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Sql } from 'postgres';
import {
  emptyReportDataV1,
  JOB_BACKOFF_SECONDS,
  JOB_MAX_ATTEMPTS,
  officePhotoStoragePath,
  readReportData,
  type DailyReportDataV1,
  type StoredReportData,
} from '@sitelog/shared';
// The @sitelog/db harness (supabase/db-tests) boots PGlite with the Supabase stubs, every
// migration and the demo seed. Imported by path so the worker image does not need that package.
import { bootDatabase } from '../../../supabase/db-tests/src/harness.ts';
import { DEMO_AUDIT_ID_BASE } from '@sitelog/shared/demo/rows.ts';
import { STALE_LOCK_MS, testConfig } from './config';
import type { Ctx } from './context';
import { connectSql, createDb, type Db } from './db';
import { silentLogger } from './log';
import { createWorkerNotifier } from './messaging';
import { buildReportPdfInput } from './pdf/render';
import { createMemoryStorage } from './storage';

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
    // The two §18 demo orgs, oldest first: Kestrel Build Group, then Demir Yapı A.Ş. (W1-06).
    const demir = await one<{ id: string }>(`select id from orgs where name = 'Demir Yapı A.Ş.'`);
    expect((await db.listOrgs()).map((o) => o.id)).toEqual([ORG, demir.id]);

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
    // The seed's WhatsApp threads only serve /try (W1-06): each last changed at its reporter's
    // invite, so all but Marco's (moved above) are older than Oct 8.
    expect(old.map((c) => c.phone_e164).sort()).toEqual([
      '+15550142087',
      '+15550143390',
      '+15550145521',
      '+15550146604',
      '+15550147719',
      '+15550149932',
    ]);
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

  it('records unknown contacts', async () => {
    const seeded = (await db.findPendingUnknownContact('+15550194410'))!;
    expect(seeded.guessed_site_id).toBe(ELM);
    expect((await db.getUnknownContact(seeded.id))!.snippet).toMatch(/^this is Luis/);

    const convo = await db.ensureConversation('+15550000002', {});
    const msg = await db.insertOutboundMessage({
      conversation_id: convo.id,
      type: 'text',
      body: 'unknownNumber',
      status: 'sent',
    });
    const row = await db.insertUnknownContact({
      org_id: null,
      phone_e164: '+15550000002',
      channel: null,
      message_id: msg.id,
      snippet: 'Hi, this is Dana from the Pier 9 site',
    });
    expect(row).toMatchObject({
      status: 'pending',
      org_id: null,
      guessed_site_id: null,
      channel: null,
      call_id: null,
      message_id: msg.id,
    });
    await db.updateUnknownContact(row.id, { org_id: ORG, guessed_site_id: OAKMONT });
    expect(await db.getUnknownContact(row.id)).toMatchObject({
      org_id: ORG,
      guessed_site_id: OAKMONT,
    });
    // A text from an unknown number (W1-08) carries its channel.
    const sms = await db.insertUnknownContact({
      org_id: null,
      phone_e164: '+15550000003',
      channel: 'sms',
      message_id: null,
      snippet: 'who do I report to',
    });
    expect(sms).toMatchObject({ channel: 'sms', message_id: null });
    await q(`update unknown_contacts set status = 'linked' where id = $1`, [row.id]);
    expect(await db.findPendingUnknownContact('+15550000002')).toBeNull();
  });
});

/** A complete draft for Riverside on Mon Oct 12 that touches every denormalised column. */
function draftFor(date: string, audioId: string, photoId: string): DailyReportDataV1 {
  return {
    ...emptyReportDataV1(date),
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
  it('writes each report in its org’s report language (§9.6), or the one given', async () => {
    const day = async (date: string) =>
      (
        await q<{ id: string }>(
          `insert into site_days (site_id, date, deadline_at) values ($1, $2, now()) returning id`,
          [RIVERSIDE, date],
        )
      )[0]!.id;
    const input = (siteDayId: string, no: string) => ({
      org_id: ORG,
      site_id: RIVERSIDE,
      site_day_id: siteDayId,
      report_no: no,
      reporter_id: MARCO,
      received_at: new Date('2026-07-01T21:00:00Z'),
      kind: 'daily' as const,
    });
    await q(`update orgs set locale = 'tr-TR' where id = $1`, [ORG]);
    try {
      const tr = await db.insertReport(input(await day('2026-07-01'), 'LANG-0001'));
      expect(tr.language).toBe('tr');
    } finally {
      await q(`update orgs set locale = 'en-US' where id = $1`, [ORG]);
    }
    const given = await db.insertReport({
      ...input(await day('2026-07-02'), 'LANG-0002'),
      language: 'tr',
    });
    expect(given.language).toBe('tr');
    await q(`delete from reports where report_no like 'LANG-%'`);
    await q(`delete from site_days where site_id = $1 and date in ('2026-07-01', '2026-07-02')`, [
      RIVERSIDE,
    ]);
  });

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
      // §6.3: the org's report language; a WhatsApp report has no channel (D13).
      language: 'en',
      channel: null,
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
    expect(v1).toMatchObject({
      version: 1,
      author: 'agent',
      change_note: null,
      pdf_path: null,
      draft_rev: 1,
    });
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
    // The draft is overwritten in place: its revision says it changed (20261015000070).
    expect(v1b).toMatchObject({
      summary: 'Corrected summary',
      author_message_id: audioId,
      change_note: 'reporter fix',
      draft_rev: 2,
    });
    // The same draft again changes nothing.
    const v1c = await db.insertVersion({
      report_id: reportId,
      version: 1,
      data: corrected,
      summary: corrected.summary,
      author: 'agent',
      author_message_id: audioId,
      change_note: 'reporter fix',
    });
    expect(v1c.draft_rev).toBe(2);
    await db.updateVersion(reportId, 1, { data, summary: data.summary, change_note: null });
    expect((await db.getVersion(reportId, 1))!).toMatchObject({ data, draft_rev: 3 });
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
    const v1 = (await db.getVersion(reportId, 1))!.data as DailyReportDataV1;
    const edited: DailyReportDataV1 = {
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
        author: 'reporter',
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

  // The filing race (20261015000090): the check of the draft, the filing write and the status
  // are one transaction, the filing write is no new draft revision, and a draft write after
  // filing is refused.
  it('fileVersion files only the draft it was computed from, and nothing overwrites it', async () => {
    const day = await db.getOrCreateSiteDay(
      OAKMONT,
      '2026-11-02',
      new Date('2026-11-02T23:30:00Z'),
    );
    const report = await db.insertReport({
      org_id: ORG,
      site_id: OAKMONT,
      site_day_id: day.id,
      report_no: await db.nextReportNo(OAKMONT),
      reporter_id: null,
      received_at: '2026-11-02T21:30:00Z',
      kind: 'daily',
      status: 'awaiting_confirmation',
    });
    const data = draftFor('2026-11-02', audioId, photoId);
    const draft = (summary: string) => ({
      report_id: report.id,
      version: 1,
      data: { ...data, summary },
      summary,
      author: 'agent' as const,
    });
    expect((await db.storeDraftVersion(draft('Extracted')))!.draft_rev).toBe(1);
    // A re-extraction after the filing read revision 1.
    expect((await db.storeDraftVersion(draft('Re-extracted')))!.draft_rev).toBe(2);
    const file = (draftRev: number, status: 'awaiting_confirmation' | 'processing') =>
      db.fileVersion({
        reportId: report.id,
        siteDayId: day.id,
        version: 1,
        expect: { status, draftRev },
        data: { ...data, summary: 'Frozen' },
        summary: 'Frozen',
        report: { status: 'filed', filed_at: new Date('2026-11-02T21:40:00Z') },
        siteDay: { status: 'filed', report_id: report.id },
        audit: {
          org_id: ORG,
          actor_type: 'agent',
          action: 'report.filed',
          entity: 'report',
          entity_id: report.id,
          diff: { version: 1 },
        },
      });
    const state = async () => ({
      status: (await db.getReport(report.id))!.status,
      day: (await db.getSiteDay(day.id))!.status,
      summary: (await db.getVersion(report.id, 1))!.summary,
      rev: (await db.getVersion(report.id, 1))!.draft_rev,
      manpower: (
        await one<{ n: number }>(
          `select count(*)::int as n from manpower_entries where report_id = $1`,
          [report.id],
        )
      ).n,
      filed: (
        await one<{ n: number }>(
          `select count(*)::int as n from audit_log where entity_id = $1 and action = 'report.filed'`,
          [report.id],
        )
      ).n,
    });
    const untouched = await state();
    expect(untouched).toMatchObject({ status: 'awaiting_confirmation', summary: 'Re-extracted' });
    expect(await file(1, 'awaiting_confirmation')).toEqual({ filed: false });
    expect(await file(2, 'processing')).toEqual({ filed: false });
    expect(await state()).toEqual(untouched);

    const res = await file(2, 'awaiting_confirmation');
    expect(res.filed && res.report.status).toBe('filed');
    const filed = await state();
    // The frozen data keeps the draft's revision: a field poll never sees it as a newer draft.
    expect(filed).toMatchObject({
      status: 'filed',
      day: 'filed',
      summary: 'Frozen',
      rev: 2,
      filed: 1,
    });
    expect(filed.manpower).toBeGreaterThan(0);

    // A re-extraction that read the report before filing: refused, the filed version stands.
    expect(await db.storeDraftVersion(draft('Late re-extraction'))).toBeNull();
    await expect(db.insertVersion(draft('Late WhatsApp draft'))).rejects.toThrow(
      'already exists and is immutable',
    );
    expect(await state()).toEqual(filed);
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
    expect(
      (await one<{ data: unknown }>(`select data from notifications where id = $1`, [id])).data,
    ).toBeNull();
    // The notice's data (20261015000080): stored as jsonb for the panel to render.
    const withData = await db.notifyOrg(
      ORG,
      'needs_review',
      'RL-2041-0187 needs review',
      'no_photo',
      '/reports/x',
      null,
      { key: 'needs_review', params: { reportNo: 'RL-2041-0187', reasons: ['no_photo'] } },
    );
    expect(
      (await one<{ data: unknown }>(`select data from notifications where id = $1`, [withData]))
        .data,
    ).toEqual({ key: 'needs_review', params: { reportNo: 'RL-2041-0187', reasons: ['no_photo'] } });
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
    }>(
      // The seed's audit rows carry fixed ids above the sequence's (DEMO_AUDIT_ID_BASE, W1-06).
      `select actor_type, actor_id, diff, entity from audit_log where id < $1 order by id desc limit 2`,
      [DEMO_AUDIT_ID_BASE],
    );
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
    // D16 (W1-10): a key names one job for good. Done, it still answers with that job and
    // enqueues nothing; dead or failed, the same.
    expect(
      await db.enqueueJob('extract_report', { reportId: 'r1' }, { dedupeKey: 'extract:r1:2' }),
    ).toBe(a);
    expect(await db.queueStats()).toEqual({ queued: 1, running: 1, dead: 0 });
    await q(`update jobs set status = 'dead' where id = $1`, [a]);
    expect(
      await db.enqueueJob('extract_report', { reportId: 'r1' }, { dedupeKey: 'extract:r1:2' }),
    ).toBe(a);
    // A key of another occurrence (the next source count) is a new job.
    const b = await db.enqueueJob(
      'extract_report',
      { reportId: 'r1' },
      { dedupeKey: 'extract:r1:3' },
    );
    expect(b).not.toBe(a);
    expect(await db.getJob(999_999)).toBeNull();
    await q(`delete from jobs where id <> $1`, [later]);
  });

  it('fails with the §10.1 backoff (30 s · 2 min · 10 min · 30 min · 2 h) and goes dead after the 6th attempt (D17)', async () => {
    const id = await db.enqueueJob('transcribe_audio', { messageId: 'm1' });
    const expected = [...JOB_BACKOFF_SECONDS];
    expect(expected).toEqual([30, 120, 600, 1800, 7200]);
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt++) {
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
      if (attempt < JOB_MAX_ATTEMPTS) {
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

  it('returns the winning job when a concurrent enqueue of the same dedupe key races it (pre-W1-10 database)', async () => {
    // Simulate the race inside one session: the first insert of key 'race:1' fails exactly the way
    // the loser of two concurrent enqueue_job calls did before W1-10 (unique_violation on the
    // partial index). Since 20261015000001 enqueue_job() inserts `on conflict do nothing`, so this
    // only matters to a worker deployed ahead of the migration.
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

  it('refreshes locked_at of a job this worker still holds (the W1-10 heartbeat)', async () => {
    await q(`delete from jobs`);
    const id = await db.enqueueJob('render_pdf', { reportId: 'r', version: 1 });
    await db.claimJobs('worker-a', 1);
    await q(`update jobs set locked_at = now() - interval '9 minutes' where id = $1`, [id]);
    expect(await db.heartbeatJob(id, 'worker-b')).toBe(false);
    expect(await db.heartbeatJob(id, 'worker-a')).toBe(true);
    const { age } = await one<{ age: number }>(
      `select extract(epoch from now() - locked_at)::float8 as age from jobs where id = $1`,
      [id],
    );
    expect(age).toBeLessThan(5);
    // Kept fresh, the job is not reclaimed after the stale lock.
    expect(await db.claimJobs('worker-b', 1)).toEqual([]);
    await db.completeJob(id);
    expect(await db.heartbeatJob(id, 'worker-a')).toBe(false);
  });

  it('reclaims jobs stuck in running for more than 10 minutes (GAP D18)', async () => {
    await q(`delete from jobs`);
    const id = await db.enqueueJob('render_pdf', { reportId: 'r', version: 1 });
    await db.claimJobs('worker-a', 1);
    expect(await db.claimJobs('worker-b', 1)).toEqual([]);
    // Twice JOB_TIMEOUT_MS: a live worker fails its own job first; this is a dead worker's job.
    await q(`update jobs set locked_at = now() - interval '9 minutes' where id = $1`, [id]);
    expect(await db.claimJobs('worker-b', 1)).toEqual([]);
    await q(`update jobs set locked_at = now() - interval '11 minutes' where id = $1`, [id]);
    const [again] = await db.claimJobs('worker-b', 1);
    expect(again).toMatchObject({ id, attempts: 2, locked_by: 'worker-b' });
  });

  it("reclaims after the worker's STALE_LOCK_MS, the interval claim_jobs() uses", async () => {
    const [row] = await q<{ def: string }>(
      `select pg_get_functiondef('claim_jobs(text, int)'::regprocedure) as def`,
    );
    const intervals = [...row!.def.matchAll(/interval '(\d+) minutes'/g)].map((m) => Number(m[1]));
    expect(intervals.length).toBeGreaterThan(0);
    expect(new Set(intervals)).toEqual(new Set([STALE_LOCK_MS / 60_000]));
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
      expect(['audio', 'photos']).toContain(m.bucket);
      expect(m.storage_path).toBeTruthy();
      expect(m.created_at < '2026-10-12T21:00:10.000Z').toBe(true);
    }
    const ids = expired.map((m) => m.id);
    expect(ids).toContain(inDoc);
    expect(ids).not.toContain(outDoc);
    const times = expired.map((m) => m.created_at);
    expect(times).toEqual([...times].sort());
    expect(await db.listExpiredMedia(before, 1)).toHaveLength(1);

    const audio = expired.find((m) => m.created_at === '2026-10-12T21:00:00.000Z')!;
    expect(audio.bucket).toBe('audio');
    expect(await db.getTranscript(audio.id)).not.toBeNull();
    await db.purgeMedia(audio.id, new Date('2026-11-12T03:00:00Z'));
    const purged = (await db.getMessage(audio.id))!;
    expect(purged.storage_path).toBeNull();
    expect(purged.payload).toEqual({ voice: true, purged_at: '2026-11-12T03:00:00.000Z' });
    expect(await db.getTranscript(audio.id)).toBeNull();
    expect((await db.listExpiredMedia(before, 500)).map((m) => m.id)).not.toContain(audio.id);
    // A message without payload gets one (the inbound document; the seed's media are uploads).
    const other = expired.find((m) => m.id === inDoc)!;
    await q(`update messages set payload = null where id = $1`, [other.id]);
    await db.purgeMedia(other.id, new Date('2026-11-12T03:00:00Z'));
    expect((await db.getMessage(other.id))!.payload).toEqual({
      purged_at: '2026-11-12T03:00:00.000Z',
    });
  });

  it('expires an upload once, with its transcript, keeping the upload row and every source key', async () => {
    const convo = (await db.getConversationByPhone(MARCO_PHONE))!;
    const report = await one<{ id: string; site_id: string }>(
      `select id, site_id from reports where status = 'filed' order by report_no limit 1`,
    );
    // A voice note the migration backfilled (upload with the message id) and an upload alone.
    const [voice] = await q<{ id: string }>(
      `insert into messages (conversation_id, direction, type, media_mime, storage_path, created_at)
       values ($1, 'in', 'audio', 'audio/ogg', 'org/site/2020-01-01/old.ogg', '2020-01-01T10:00:00Z')
       returning id`,
      [convo.id],
    );
    await q(
      `insert into uploads (id, report_id, site_id, kind, storage_path, mime, received_at)
       values ($1, $2, $3, 'audio', 'org/site/2020-01-01/old.ogg', 'audio/ogg', '2020-01-01T10:00:00Z')`,
      [voice!.id, report.id, report.site_id],
    );
    await q(
      `insert into report_sources (report_id, message_id, upload_id, kind) values ($1, $2, $2, 'voice_note')`,
      [report.id, voice!.id],
    );
    await q(
      `insert into transcripts (message_id, upload_id, text, segments) values ($1, $1, 'old', '[]')`,
      [voice!.id],
    );
    const [photo] = await q<{ id: string }>(
      `insert into uploads (report_id, site_id, kind, storage_path, mime, received_at)
       values ($1, $2, 'photo', 'org/site/office/old.jpg', 'image/jpeg', '2020-01-01T11:00:00Z')
       returning id`,
      [report.id, report.site_id],
    );
    await q(`insert into report_sources (report_id, upload_id, kind) values ($1, $2, 'photo')`, [
      report.id,
      photo!.id,
    ]);

    const expired = await db.listExpiredMedia(new Date('2020-02-01T00:00:00Z'), 50);
    // Listed once each (the backfilled message is not listed beside its upload), oldest first.
    expect(expired).toEqual([
      {
        id: voice!.id,
        storage_path: 'org/site/2020-01-01/old.ogg',
        bucket: 'audio',
        created_at: '2020-01-01T10:00:00.000Z',
      },
      {
        id: photo!.id,
        storage_path: 'org/site/office/old.jpg',
        bucket: 'photos',
        created_at: '2020-01-01T11:00:00.000Z',
      },
    ]);
    for (const m of expired) await db.purgeMedia(m.id, new Date('2026-11-12T03:00:00Z'));
    // The upload rows stay, marked purged (storage_path keeps the deleted object's name).
    expect(
      await q(
        `select id, storage_path, purged_at from uploads where id = any($1::uuid[]) order by received_at`,
        [[voice!.id, photo!.id]],
      ),
    ).toEqual([
      {
        id: voice!.id,
        storage_path: 'org/site/2020-01-01/old.ogg',
        purged_at: new Date('2026-11-12T03:00:00Z'),
      },
      {
        id: photo!.id,
        storage_path: 'org/site/office/old.jpg',
        purged_at: new Date('2026-11-12T03:00:00Z'),
      },
    ]);
    expect(await db.getTranscript(voice!.id)).toBeNull();
    expect((await db.getMessage(voice!.id))!.storage_path).toBeNull();
    // The sources keep their keys (an office photo has no other) and read as files that are gone.
    const kept = (await db.listReportSources(report.id)).filter((s) =>
      [voice!.id, photo!.id].includes(s.media_id!),
    );
    expect(
      kept
        .map((s) => ({
          kind: s.kind,
          message_id: s.message_id,
          upload_id: s.upload_id,
          storage_path: s.storage_path,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: 'photo', message_id: null, upload_id: photo!.id, storage_path: null },
      { kind: 'voice_note', message_id: voice!.id, upload_id: voice!.id, storage_path: null },
    ]);
    expect(await db.listExpiredMedia(new Date('2020-02-01T00:00:00Z'), 50)).toEqual([]);
    // A second purge (the retention job's retry after a failed delete) keeps the first time.
    await db.purgeMedia(photo!.id, new Date('2026-12-12T03:00:00Z'));
    expect(await one(`select purged_at from uploads where id = $1`, [photo!.id])).toEqual({
      purged_at: new Date('2026-11-12T03:00:00Z'),
    });
  });

  it('deletes only done jobs finished before the cutoff', async () => {
    const mk = async (status: string, finished: string | null) => {
      const [row] = await q<{ id: string }>(
        `insert into jobs (type, payload, status, finished_at) values ('weekly_digest', '{}', $1, $2) returning id`,
        [status, finished],
      );
      return Number(row!.id);
    };
    const oldDone = await mk('done', '2026-08-01T00:00:00Z');
    const newDone = await mk('done', '2026-10-11T00:00:00Z');
    const oldDead = await mk('dead', '2026-08-01T00:00:00Z');
    expect(
      await db.purgeFinishedJobs(new Date('2026-09-12T00:00:00Z'), 1_000),
    ).toBeGreaterThanOrEqual(1);
    const left = (
      await q<{ id: string }>(`select id from jobs where id = any($1)`, [
        [oldDone, newDone, oldDead],
      ])
    ).map((r) => Number(r.id));
    expect(left.sort()).toEqual([newDone, oldDead].sort());
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
    await db.updateReporter(MARCO, { status: 'active', last_invite_error: null });
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
    const data: DailyReportDataV1 = {
      ...emptyReportDataV1('2026-10-13'),
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

describe('PostgresDb on PGlite: photos uploaded in the panel', () => {
  it('reads an office upload (no conversation) and prints it on the edited version only', async () => {
    // A reporter's report (stored v1 data, as the seed's history is) with two stored photos.
    const report = await one<{ id: string; site_id: string; current_version: number }>(
      `select r.id, r.site_id, r.current_version from reports r
       join report_versions v on v.report_id = r.id and v.version = r.current_version
       where r.reporter_id is not null and r.status = 'filed'
         and v.data->>'schemaVersion' is distinct from '2'
         and jsonb_array_length(v.data->'photos') = 2
         and (select count(*) from report_sources rs join uploads u on u.id = rs.upload_id
              where rs.report_id = r.id and rs.kind = 'photo' and u.purged_at is null) = 2
         and not exists (select 1 from report_sources rs join uploads u on u.id = rs.upload_id
                         where rs.report_id = r.id and u.purged_at is not null)
       order by r.report_no limit 1`,
    );
    const before = (await db.getVersion(report.id, report.current_version))!;
    const beforeData = before.data as DailyReportDataV1;
    const [kept, dropped] = beforeData.photos;
    const upload = officePhotoStoragePath(ORG, report.site_id, randomUUID(), 'image/png');

    await sql`select set_config('request.jwt.claim.sub', ${LENA}, false)`;
    try {
      const [res] = await sql<Array<{ r: { version: number } }>>`
        select create_report_version(${report.id},
          ${sql.json({ ...beforeData, photos: [{ ...kept!, caption: 'Kept' }] } as never)},
          'Photo swapped',
          ${sql.json([{ path: upload, mime: 'image/png', caption: 'From the office' }] as never)}) as r`;
      expect(res!.r).toEqual({ version: report.current_version + 1 });
    } finally {
      await sql`select set_config('request.jwt.claim.sub', '', false)`;
    }

    const sources = await db.listReportSources(report.id);
    const office = sources.find((s) => s.storage_path === upload)!;
    // An upload (D14), with no message: listReportSources reads its file from uploads.
    expect(office).toMatchObject({
      kind: 'photo',
      caption: 'From the office',
      message_id: null,
      message_type: 'image',
      media_mime: 'image/png',
      body: 'From the office',
    });
    expect(office.upload_id).toBe(office.media_id);
    const [row] = await q<{ reporter_id: string | null; uploaded_by: string; report_id: string }>(
      `select reporter_id, uploaded_by, report_id from uploads where id = $1`,
      [office.media_id],
    );
    expect(row).toEqual({ reporter_id: null, uploaded_by: LENA, report_id: report.id });
    // Customer media: the retention job deletes it like a WhatsApp photo.
    expect(
      (await db.listExpiredMedia(new Date('2099-01-01T00:00:00Z'), 5_000)).map((m) => m.id),
    ).toContain(office.media_id);
    // Unattached uploads are listed from storage.objects; this database has no storage schema.
    expect(await db.listOrphanOfficePhotos(new Date('2099-01-01T00:00:00Z'), 10)).toEqual([]);

    const storage = createMemoryStorage();
    for (const s of sources.filter((x) => x.kind === 'photo'))
      await storage.upload('photos', s.storage_path!, Buffer.from(s.media_id!), 'image/jpeg');
    const ctx = {
      db,
      storage,
      log: silentLogger,
      now: () => new Date('2026-10-13T12:00:00Z'),
    } as unknown as Ctx;
    const site = (await db.siteContext(report.site_id))!;
    const printed = async (version: number) => {
      const v = (await db.getVersion(report.id, version))!;
      const input = await buildReportPdfInput(ctx, {
        report: (await db.getReport(report.id))!,
        version: v,
        site,
        data: readReportData(v.data as unknown as StoredReportData),
      });
      return input.photos.map((p) => [
        'data' in p ? Buffer.from(p.data).toString() : p.url,
        p.caption,
      ]);
    };
    expect(await printed(report.current_version)).toEqual([
      [kept!.messageId, kept!.caption ?? null],
      [dropped!.messageId, dropped!.caption ?? null],
    ]);
    expect(await printed(report.current_version + 1)).toEqual([
      [kept!.messageId, 'Kept'],
      [office.media_id, 'From the office'],
    ]);

    // Retention deletes the office photo's file: the source keeps its upload, so the photo stays
    // listed (without a file) and an unrelated office edit neither drops it nor counts it removed.
    await db.purgeMedia(office.media_id!, new Date('2026-11-12T03:00:00Z'));
    const purged = (await db.listReportSources(report.id)).find(
      (s) => s.media_id === office.media_id,
    );
    expect(purged).toMatchObject({ kind: 'photo', upload_id: office.media_id, storage_path: null });
    const edited = (await db.getVersion(report.id, report.current_version + 1))!;
    await sql`select set_config('request.jwt.claim.sub', ${LENA}, false)`;
    try {
      await sql`select create_report_version(${report.id},
        ${sql.json({ ...(edited.data as DailyReportDataV1), summary: 'Reworded' } as never)},
        'Summary reworded', '[]'::jsonb)`;
    } finally {
      await sql`select set_config('request.jwt.claim.sub', '', false)`;
    }
    const after = (await db.getVersion(report.id, report.current_version + 2))!;
    expect((after.data as DailyReportDataV1).photos).toEqual(
      (edited.data as DailyReportDataV1).photos,
    );
    const [audit] = await q<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where entity_id = $1 and action = 'report.version_created'
       order by created_at desc, id desc limit 1`,
      [report.id],
    );
    expect(audit!.diff).toMatchObject({
      version: report.current_version + 2,
      photos: 2,
      photos_added: 0,
      photos_removed: 0,
    });
    // The PDF of the new version prints the photo that still has its file.
    expect(await printed(report.current_version + 2)).toEqual([[kept!.messageId, 'Kept']]);
    await q(`delete from jobs where dedupe_key = any($1::text[])`, [
      [1, 2].map((n) => `render_pdf:${report.id}:${report.current_version + n}`),
    ]);
  });
});

describe('PostgresDb on PGlite: messaging (W1-08)', () => {
  it('reads the packs and a reporter’s consents', async () => {
    const us = await db.getCountry('US');
    expect(us).toMatchObject({ code: 'US', sms_provider: 'twilio', sms_sender_id: null });
    expect((await db.listCountries()).map((c) => c.code)).toEqual(['TR', 'US']);
    const consents = await db.listConsents(MARCO);
    expect(consents.map((c) => c.type).sort()).toEqual(['data_processing', 'recording', 'sms']);
    expect(consents.every((c) => c.revoked_at === null)).toBe(true);
  });

  it('the Notifier over Postgres: a welcome on the demo org, its row, its retry and its audit', async () => {
    const sent: string[] = [];
    const notifier = createWorkerNotifier(testConfig(), db, (driver) => ({
      driver,
      async send(_to, body) {
        sent.push(body);
        return { providerId: `${driver}:${randomUUID()}` };
      },
    }));
    const vars = {
      first: 'Marco',
      company: 'Kestrel Build Group',
      site: 'Elm St. Townhomes',
      deadline: '17:30',
      link: 'https://go.sitelog.app/r/ABCDEF',
    };
    const out = await notifier.send(MARCO, 'welcome', vars, { dedupeKey: 'w108:test' });
    expect(out.channel).toBe('sms');
    const row = await one<Record<string, unknown>>(
      `select org_id, reporter_id, phone_e164, channel, direction, provider, copy_key, body, status, payload
       from messages where id = $1`,
      [(out as { messageId: string }).messageId],
    );
    expect(row).toMatchObject({
      org_id: ORG,
      reporter_id: MARCO,
      phone_e164: MARCO_PHONE,
      channel: 'sms',
      direction: 'out',
      provider: 'console',
      copy_key: 'welcome',
      status: 'delivered',
      payload: { dedupe_key: 'w108:test' },
    });
    // Kestrel is a demo org: the whole text, link and all, for the Demo phone.
    expect(row.body).toContain('https://go.sitelog.app/r/ABCDEF');
    expect(await notifier.send(MARCO, 'welcome', vars, { dedupeKey: 'w108:test' })).toEqual(out);
    expect(sent).toHaveLength(1);
    const audit = await q<{ action: string }>(
      `select action from audit_log where entity_id = $1 and action = 'sms.sent'`,
      [(out as { messageId: string }).messageId],
    );
    expect(audit).toHaveLength(1);
  });

  it('issues personal links once and refuses a taken hash', async () => {
    const id = randomUUID();
    expect(await db.insertPersonalLink({ id, code_hash: `w108-${id}`, reporter_id: MARCO })).toBe(
      true,
    );
    expect(
      await db.insertPersonalLink({
        id: randomUUID(),
        code_hash: `w108-${id}`,
        reporter_id: MARCO,
      }),
    ).toBe(false);
    const links = await db.listPersonalLinks(MARCO);
    expect(links[0]).toEqual({ id, code_hash: `w108-${id}` });
  });

  it('reads a phone’s reporters per pack and scope, records opt-outs, marks a text handled', async () => {
    // Kestrel (US, demo) holds Marco: a real sender never reaches him, the Demo phone does.
    expect(await db.listInboundReporters(MARCO_PHONE, 'US', { realOnly: true })).toEqual([]);
    const inOrg = await db.listInboundReporters(MARCO_PHONE, 'US', { orgId: ORG });
    expect(inOrg).toHaveLength(1);
    expect(inOrg[0]).toMatchObject({
      id: MARCO,
      orgId: ORG,
      name: 'Marco Ruiz',
      phone: MARCO_PHONE,
      locale: 'en-US',
      orgName: 'Kestrel Build Group',
      orgIsDemo: true,
      contactPref: 'link',
    });
    expect(await db.listInboundReporters(MARCO_PHONE, 'TR', { orgId: ORG })).toEqual([]);

    expect(await db.isSmsOptedOut(MARCO_PHONE, 'US')).toBe(false);
    await db.recordSmsOptOut({ phone_e164: MARCO_PHONE, country: 'US', method: 'sms_keyword' });
    // A second record keeps the first (its method and time).
    await db.recordSmsOptOut({
      phone_e164: MARCO_PHONE,
      country: 'US',
      method: 'provider_opt_out',
    });
    expect(await db.isSmsOptedOut(MARCO_PHONE, 'US')).toBe(true);
    expect(await db.isSmsOptedOut(MARCO_PHONE, 'TR')).toBe(false);
    expect(
      await one(`select method from sms_opt_outs where phone_e164 = $1 and country = 'US'`, [
        MARCO_PHONE,
      ]),
    ).toEqual({ method: 'sms_keyword' });
    await db.clearSmsOptOut(MARCO_PHONE, 'US');
    expect(await db.isSmsOptedOut(MARCO_PHONE, 'US')).toBe(false);

    // The reporter row follows a provider opt-out; a disabled one keeps its status.
    await db.optOutReporter(MARCO, '2026-10-09T23:00:00Z');
    expect(await one(`select status, opted_out_at from reporters where id = $1`, [MARCO])).toEqual({
      status: 'opted_out',
      opted_out_at: new Date('2026-10-09T23:00:00Z'),
    });
    await db.optOutReporter(MARCO, '2026-10-10T23:00:00Z');
    expect(
      (await one(`select opted_out_at from reporters where id = $1`, [MARCO])).opted_out_at,
    ).toEqual(new Date('2026-10-09T23:00:00Z'));
    await db.updateReporter(MARCO, { status: 'active', opted_out_at: null, contact_pref: 'call' });
    expect(await one(`select status, contact_pref from reporters where id = $1`, [MARCO])).toEqual({
      status: 'active',
      contact_pref: 'call',
    });
    await db.updateReporter(MARCO, { contact_pref: 'link' });

    // The inbound row's handled mark, beside what the webhook stored.
    const id = randomUUID();
    await q(
      `insert into messages (id, org_id, reporter_id, phone_e164, channel, direction, provider, provider_message_id, body, status, payload)
       values ($1, $2, $3, $4, 'sms', 'in', 'twilio', $5, 'STOP', 'received', '{"to":"+18885550142","pack":"US"}')`,
      [id, ORG, MARCO, MARCO_PHONE, `SM${id}`],
    );
    await db.markSmsHandled(id, '2026-10-09T23:00:01.000Z');
    expect((await one(`select payload from messages where id = $1`, [id])).payload).toEqual({
      to: '+18885550142',
      pack: 'US',
      handled_at: '2026-10-09T23:00:01.000Z',
    });
    expect(await db.hasPendingUnknownContact('+15550194410', 'sms')).toBe(false);
    const contact = await db.insertUnknownContact({
      org_id: null,
      phone_e164: '+15550194410',
      channel: 'sms',
      message_id: id,
      snippet: 'hello?',
    });
    expect(contact.status).toBe('pending');
    expect(await db.hasPendingUnknownContact('+15550194410', 'sms')).toBe(true);
    expect(await db.hasPendingUnknownContact('+15550194410', 'sms')).toBe(true);
    const [prior, ...more] = await db.listMessagesByDedupeKey(MARCO, 'w108:test');
    expect(more).toEqual([]);
    expect(prior).toMatchObject({
      attempt: 1,
      provider: 'console',
      error: null,
      status: 'delivered',
      error_code: null,
    });
  });

  it('the F13 row once per text; a retry of that text does not count its own row as pending', async () => {
    const phone = '+15550194420';
    const text = randomUUID();
    await q(
      `insert into messages (id, phone_e164, channel, direction, provider, provider_message_id, body, status)
       values ($1, $2, 'sms', 'in', 'twilio', $3, 'who is this', 'received')`,
      [text, phone, `SM${text}`],
    );
    const first = await db.insertSmsUnknownContact({
      phone_e164: phone,
      message_id: text,
      snippet: 'who is this',
      org_id: null,
    });
    expect(first.created).toBe(true);
    expect(
      await db.insertSmsUnknownContact({
        phone_e164: phone,
        message_id: text,
        snippet: 'x',
        org_id: null,
      }),
    ).toEqual({ id: first.id, created: false });
    expect(
      await one(`select org_id, channel, status, snippet from unknown_contacts where id = $1`, [
        first.id,
      ]),
    ).toEqual({ org_id: null, channel: 'sms', status: 'pending', snippet: 'who is this' });
    expect(await db.hasPendingUnknownContact(phone, 'sms')).toBe(true);
    expect(await db.hasPendingUnknownContact(phone, 'sms', text)).toBe(false);
    expect(await db.hasPendingUnknownContact(phone, 'sms', randomUUID())).toBe(true);
    // Spec §19 Q44: once an org links the number, its next unknown text is that org's history.
    const org = await one<{ country: string; is_demo: boolean }>(
      `select country, is_demo from orgs where id = $1`,
      [ORG],
    );
    expect(await db.linkedContactOrgs(phone, org.country)).toEqual([]);
    await q(`update unknown_contacts set status = 'linked', org_id = $2 where id = $1`, [
      first.id,
      ORG,
    ]);
    expect(await db.linkedContactOrgs(phone, org.country)).toEqual(org.is_demo ? [] : [ORG]);
    expect(await db.linkedContactOrgs(phone, 'XX')).toEqual([]);
  });

  it('keeps the provider code of a refused send with its dedupe key', async () => {
    const id = randomUUID();
    await db.insertSmsMessage({
      id,
      org_id: ORG,
      reporter_id: MARCO,
      phone_e164: MARCO_PHONE,
      channel: 'sms',
      direction: 'out',
      provider: 'twilio',
      provider_message_id: null,
      copy_key: 'welcome',
      body: 'Hi Marco',
      status: 'queued',
      error: null,
      payload: { dedupe_key: 'w108:refused' },
    });
    await db.updateSmsMessage(id, {
      status: 'undeliverable',
      error: 'twilio 400 21610: unsubscribed',
      payload: { dedupe_key: 'w108:refused', error_code: '21610' },
    });
    // A row written before W2-01 has no attempt number (the walk reads it as the first).
    expect(await db.listMessagesByDedupeKey(MARCO, 'w108:refused')).toEqual([
      {
        id,
        channel: 'sms',
        status: 'undeliverable',
        provider: 'twilio',
        provider_message_id: null,
        error: 'twilio 400 21610: unsubscribed',
        error_code: '21610',
        attempt: null,
      },
    ]);
  });

  it("a real sender reaches a real org's reporter, and a keyword's change commits with its audit and notice or not at all", async () => {
    // A non-demo US org with a reporter on Marco's number (the Kestrel demo org has him too).
    const real = (
      await one<{ id: string }>(
        `insert into orgs (name, country, is_demo) values ('Real Builders Inc', 'US', false) returning id`,
      )
    ).id;
    try {
      const dana = (
        await one<{ id: string }>(
          `insert into reporters (org_id, name, phone_e164, status, activated_at)
           values ($1, 'Dana Whitfield', $2, 'active', now()) returning id`,
          [real, MARCO_PHONE],
        )
      ).id;
      const realOnly = await db.listInboundReporters(MARCO_PHONE, 'US', { realOnly: true });
      expect(realOnly).toEqual([
        expect.objectContaining({
          id: dana,
          orgId: real,
          name: 'Dana Whitfield',
          orgName: 'Real Builders Inc',
          orgIsDemo: false,
          status: 'active',
        }),
      ]);
      expect(await db.listInboundReporters(MARCO_PHONE, 'US', { orgId: real })).toEqual(realOnly);
      expect(
        (await db.listInboundReporters(MARCO_PHONE, 'US', { orgId: ORG })).map((r) => r.id),
      ).toEqual([MARCO]);

      const change = (orgId: string) => ({
        reporterId: dana,
        patch: { status: 'opted_out' as const, opted_out_at: '2026-10-09T23:00:00.000Z' },
        audit: {
          org_id: real,
          actor_type: 'reporter' as const,
          actor_id: dana,
          action: 'reporter.opted_out',
          entity: 'reporter',
          entity_id: dana,
          diff: { method: 'sms_keyword', keyword: 'stop' },
        },
        notification: {
          orgId,
          kind: 'reporter_opted_out',
          title: 'Dana Whitfield opted out of texts (STOP)',
          body: 'Call them.',
          targetPath: '/team',
        },
      });
      const state = async () => ({
        status: (
          await one<{ status: string }>(`select status from reporters where id = $1`, [dana])
        ).status,
        audits: (
          await q(
            `select 1 from audit_log where entity_id = $1 and action = 'reporter.opted_out'`,
            [dana],
          )
        ).length,
        notices: (await q(`select 1 from notifications where org_id = $1`, [real])).length,
      });
      // The notice fails (an org that does not exist): the update and the audit roll back too.
      await expect(db.applyInboundChange(change(randomUUID()))).rejects.toThrow();
      expect(await state()).toEqual({ status: 'active', audits: 0, notices: 0 });
      await db.applyInboundChange(change(real));
      expect(await state()).toEqual({ status: 'opted_out', audits: 1, notices: 1 });
    } finally {
      await q(`delete from orgs where id = $1`, [real]);
    }
  });

  it('files a console email for the Demo phone', async () => {
    const id = await db.insertConsoleEmail({
      org_id: ORG,
      kind: 'report_filed',
      recipients: ['pm@kestrelbuild.example'],
      subject: 'Daily report · Riverside',
      body_text: 'Filed.',
      attachments: [{ filename: 'RL-2041-0187.pdf', bytes: 1234 }],
    });
    expect(
      await one(`select kind, recipients, attachments from console_emails where id = $1`, [id]),
    ).toEqual({
      kind: 'report_filed',
      recipients: ['pm@kestrelbuild.example'],
      attachments: [{ filename: 'RL-2041-0187.pdf', bytes: 1234 }],
    });
  });
});
