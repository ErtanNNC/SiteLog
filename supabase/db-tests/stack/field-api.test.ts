import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  LINK_CODE_ALPHABET,
  deviceCookieName,
  linkCodeHash,
  uploadStoragePath,
} from '@sitelog/shared';
import { connectStack, STACK_DB_URL } from './db.ts';

/**
 * field-api (W1-07) served by `supabase start` (the Edge Runtime), against the stack's database:
 * the happy path resolve → send-code → verify (the code read from the console `messages` row of a
 * demo org) → consent → uploads (PUT to the signed URL) → complete, which checks the stored object,
 * creates the site-day, the numbered report and the transcribe_upload job; confirm enqueuing
 * file_report for the confirmed version, after which no upload completes; the cookie and no-store
 * through the gateway; refusals, and no console code for a real org. And the RPCs raced on real
 * Postgres: transactions completing uploads of one site-day at once make one report and burn no
 * number, and a confirm raced with a voice note either files the confirmed draft or reopens it.
 *
 * Needs SUPABASE_DB_URL (the stack's DB_URL) and FIELD_API_URL (`{API_URL}/functions/v1/field-api`,
 * as .env.example has it); the function must be up (CI warms it first). Skips without them.
 */

const FIELD_API = process.env.FIELD_API_URL?.trim().replace(/\/+$/, '') || undefined;
const describeField = STACK_DB_URL && FIELD_API ? describe : describe.skip;
const describeRace = STACK_DB_URL ? describe : describe.skip;

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length]).join('');
}

/** A unique +1 555 number per run (rate limits are per phone). */
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

interface Fixture {
  orgId: string;
  siteId: string;
  site2Id: string;
  marco: { id: string; phone: string; code: string };
  dana: { id: string; phone: string; code: string };
  expiredCode: string;
}

async function createFixture(sql: Sql, label: string): Promise<Fixture> {
  // A demo org: field-api writes the device code as a console text only there (W1-07).
  const [org] = await sql<{ id: string }[]>`
    insert into orgs (name, is_demo) values (${`test:stack ${label} ${Date.now()}`}, true) returning id`;
  const orgId = org!.id;
  const [s1] = await sql<{ id: string }[]>`
    insert into sites (org_id, name, project_code, timezone, deadline)
    values (${orgId}, 'Riverside', 'FA-1', 'America/Chicago', '17:30') returning id`;
  const [s2] = await sql<{ id: string }[]>`
    insert into sites (org_id, name, project_code, timezone)
    values (${orgId}, 'Pier 9', 'FA-2', 'America/Chicago') returning id`;
  const marco = { phone: phone(), code: randomCode(), id: '' };
  const dana = { phone: phone(), code: randomCode(), id: '' };
  const [m] = await sql<{ id: string }[]>`
    insert into reporters (org_id, name, phone_e164) values (${orgId}, 'Marco Ruiz', ${marco.phone}) returning id`;
  const [d] = await sql<{ id: string }[]>`
    insert into reporters (org_id, name, phone_e164, status) values (${orgId}, 'Dana Park', ${dana.phone}, 'active') returning id`;
  marco.id = m!.id;
  dana.id = d!.id;
  await sql`insert into site_reporters (site_id, reporter_id, is_primary) values
    (${s1!.id}, ${marco.id}, true), (${s2!.id}, ${marco.id}, true), (${s1!.id}, ${dana.id}, false)`;
  const expiredCode = randomCode();
  await sql`insert into field_links (code_hash, reporter_id, kind) values
    (${linkCodeHash(marco.code)}, ${marco.id}, 'personal'),
    (${linkCodeHash(dana.code)}, ${dana.id}, 'personal')`;
  await sql`insert into field_links (code_hash, reporter_id, site_id, kind, report_date, expires_at)
    values (${linkCodeHash(expiredCode)}, ${marco.id}, ${s1!.id}, 'daily', '2026-01-05', now() - interval '1 hour')`;
  return { orgId, siteId: s1!.id, site2Id: s2!.id, marco, dana, expiredCode };
}

/**
 * Removes the fixture's rows. report_sources.upload_id and field_links.site_id have no ON DELETE,
 * so the sources go before the uploads they name and the links before the org's sites. Every step
 * runs even when one fails (a test that stopped halfway), and the first error is thrown at the end.
 */
async function dropFixture(sql: Sql, f: Fixture | undefined) {
  if (!f) return;
  const sites = [f.siteId, f.site2Id];
  const steps = [
    () => sql`delete from jobs where payload->>'uploadId' in (select id::text from uploads where site_id in ${sql(sites)})
                             or payload->>'reportId' in (select id::text from reports where org_id = ${f.orgId})`,
    () => sql`delete from rate_limits where key in (${`code_send:${f.marco.phone}`}, ${`code:${f.marco.phone}`},
                                                    ${`code_send:${f.dana.phone}`}, ${`code:${f.dana.phone}`})
                or key in (select 'dev:' || d.id from field_devices d join reporters r on r.id = d.reporter_id where r.org_id = ${f.orgId})`,
    () =>
      sql`delete from report_sources where upload_id in (select id from uploads where site_id in ${sql(sites)})`,
    () => sql`delete from uploads where site_id in ${sql(sites)}`,
    // field_links.site_id has no ON DELETE either (the daily link names a site).
    () =>
      sql`delete from field_links where reporter_id in (select id from reporters where org_id = ${f.orgId})`,
    () => sql`delete from orgs where id = ${f.orgId}`,
  ];
  let first: unknown = null;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      first ??= err;
    }
  }
  if (first) throw first;
}

describeField('field-api on the local stack', () => {
  let sql: Sql;
  let f: Fixture;
  /** The device cookie as the browser sends it (`sl_dev_<8 hex>=<token>`). */
  let cookie = '';

  async function call(
    method: string,
    route: string,
    opts: { body?: unknown; code?: string | null; cookie?: string | null } = {},
  ) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const code = opts.code === undefined ? f.marco.code : opts.code;
    if (code) headers['x-link-code'] = code;
    const c = opts.cookie === undefined ? cookie : opts.cookie;
    if (c) headers['cookie'] = c;
    const res = await fetch(`${FIELD_API}/${route}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    sql = connectStack(4);
    f = await createFixture(sql, 'field-api');
  });

  afterAll(async () => {
    await dropFixture(sql, f);
    await sql?.end({ timeout: 5 });
  });

  it('runs the happy path and creates the site-day, the report and the job', async () => {
    const resolved = await call('POST', 'resolve', { body: { code: f.marco.code }, code: null });
    expect(resolved.status).toBe(200);
    expect(resolved.headers.get('cache-control')).toBe('no-store');
    expect(resolved.json).toMatchObject({ needsDeviceCheck: true, needsConsent: true, sites: [] });
    expect(resolved.json.country).toMatchObject({ code: 'US', twoWaySms: true });

    const sent = await call('POST', 'device/send-code');
    expect(sent.status).toBe(202);
    const setCookie = sent.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^sl_dev_[0-9a-f]{8}=[A-Za-z0-9_-]{43};/);
    expect(setCookie.startsWith(`${deviceCookieName(f.marco.id)}=`)).toBe(true);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000'])
      expect(setCookie).toContain(attr);
    cookie = /^([^;]+)/.exec(setCookie)![1]!;

    // The console text (W1-07; the Notifier from W1-08), as the Demo phone shows it.
    const [msg] = await sql<{ body: string; channel: string; provider: string }[]>`
      select body, channel, provider from messages
      where reporter_id = ${f.marco.id} and copy_key = 'verify_code' order by created_at desc limit 1`;
    expect(msg).toMatchObject({ channel: 'sms', provider: 'console' });
    const otp = /(\d{6})/.exec(msg!.body)![1]!;
    const [dev] = await sql<{ code_hash: string }[]>`
      select code_hash from field_devices where reporter_id = ${f.marco.id}`;
    expect(dev!.code_hash).not.toContain(otp);

    expect((await call('GET', 'today')).json.error).toBe('device_unverified');
    const verified = await call('POST', 'device/verify', { body: { code: otp } });
    expect(verified.status).toBe(200);
    expect(verified.json).toEqual({ verified: true, needsConsent: true });

    const consent = await call('POST', 'consent', {
      body: {
        types: ['recording', 'data_processing', 'sms'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: 'en-US',
      },
    });
    expect(consent.status).toBe(200);
    expect(consent.json.status).toBe('active');
    const [rep] = await sql<{ status: string; activated_at: Date | null }[]>`
      select status, activated_at from reporters where id = ${f.marco.id}`;
    expect(rep!.status).toBe('active');
    expect(rep!.activated_at).not.toBeNull();

    const today = await call('GET', `today?site=${f.siteId}`);
    expect(today.status).toBe(200);
    expect(today.json.dayStatus).toBe('pending');
    expect((today.json.allowedDates as string[])[0]).toBe(today.json.date);

    const audio = new Uint8Array(2048).fill(7);
    const up = await call('POST', 'uploads', {
      body: {
        kind: 'audio',
        mime: 'audio/webm;codecs=opus',
        bytes: 4096, // claimed; uploads.bytes gets what Storage holds
        siteId: f.siteId,
      },
    });
    expect(up.status).toBe(201);
    const date = today.json.date as string;
    expect(up.json.path).toBe(
      uploadStoragePath(f.orgId, f.siteId, date, up.json.uploadId as string, 'webm'),
    );

    // Not there yet; then PUT through the signed URL (the gateway's public origin: inside the
    // Edge Runtime SUPABASE_URL is the internal host).
    expect((await call('POST', `uploads/${up.json.uploadId}/complete`)).json.error).toBe(
      'upload_missing',
    );
    const signed = new URL(up.json.signedUrl as string);
    const put = await fetch(`${new URL(FIELD_API!).origin}${signed.pathname}${signed.search}`, {
      method: 'PUT',
      headers: { 'content-type': 'audio/webm' },
      body: audio,
    });
    expect(put.status, await put.clone().text()).toBe(200);

    const done = await call('POST', `uploads/${up.json.uploadId}/complete`);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      reportNo: 'FA-1-0001',
      reportStatus: 'processing',
      created: true,
      alreadyComplete: false,
    });
    const [report] = await sql<
      { channel: string; language: string; status: string; day: string }[]
    >`
      select r.channel, r.language, r.status, sd.status::text as day
      from reports r join site_days sd on sd.id = r.site_day_id where r.id = ${done.json.reportId as string}`;
    expect(report).toEqual({
      channel: 'web',
      language: 'en',
      status: 'processing',
      day: 'processing',
    });
    const jobs = await sql<{ type: string; payload: { uploadId: string } }[]>`
      select type, payload from jobs where payload->>'uploadId' = ${up.json.uploadId as string}`;
    expect(jobs).toEqual([{ type: 'transcribe_upload', payload: { uploadId: up.json.uploadId } }]);
    const [stored] = await sql<{ bytes: number; mime: string }[]>`
      select bytes, mime from uploads where id = ${up.json.uploadId as string}`;
    expect(stored).toEqual({ bytes: audio.length, mime: 'audio/webm' });

    // Draft ready → confirm enqueues file_report for the version the reporter saw.
    await sql`update reports set status = 'awaiting_confirmation' where id = ${done.json.reportId as string}`;
    const confirmed = await call('POST', `reports/${done.json.reportId}/confirm`, {
      body: { version: 1 },
    });
    expect([confirmed.status, confirmed.json.status]).toEqual([202, 'queued']);
    const [file] = await sql<{ payload: Record<string, unknown>; dedupe_key: string }[]>`
      select payload, dedupe_key from jobs where type = 'file_report' and payload->>'reportId' = ${done.json.reportId as string}`;
    expect(file).toEqual({
      payload: { reportId: done.json.reportId, trigger: 'confirm', version: 1 },
      dedupe_key: `file:${done.json.reportId}:v1`,
    });
    // A double tap answers the same, and enqueues nothing more.
    expect((await call('POST', `reports/${done.json.reportId}/confirm`)).status).toBe(202);

    // A voice note completed before the job runs does not join the confirmed draft.
    const more = await call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: audio.length, siteId: f.siteId },
    });
    const signed2 = new URL(more.json.signedUrl as string);
    await fetch(`${new URL(FIELD_API!).origin}${signed2.pathname}${signed2.search}`, {
      method: 'PUT',
      headers: { 'content-type': 'audio/webm' },
      body: audio,
    });
    const late = await call('POST', `uploads/${more.json.uploadId}/complete`);
    expect([late.status, late.json.error]).toEqual([409, 'report_filing']);
    const [still] = await sql<{ status: string; n: number }[]>`
      select r.status, (select count(*)::int from jobs where dedupe_key = ${`file:${done.json.reportId}:v1`}) as n
      from reports r where r.id = ${done.json.reportId as string}`;
    expect(still).toEqual({ status: 'awaiting_confirmation', n: 1 });

    const audit = await sql<{ action: string }[]>`
      select distinct action from audit_log where org_id = ${f.orgId} and actor_type = 'reporter'`;
    expect(audit.map((a) => a.action).sort()).toEqual(
      expect.arrayContaining([
        'consent.given',
        'device.code_sent',
        'device.verified',
        'link.opened',
        'report.confirm_requested',
        'report.created',
        'reporter.activated',
        'upload.completed',
        'upload.created',
      ]),
    );
  });

  it('refuses expired links, other reporters and a missing device, all no-store', async () => {
    const expired = await call('POST', 'resolve', { body: { code: f.expiredCode }, code: null });
    expect([expired.status, expired.json.error]).toEqual([410, 'link_expired']);
    // Dana's link with Marco's device cookie.
    const cross = await call('GET', 'today', { code: f.dana.code });
    expect([cross.status, cross.json.error]).toEqual([401, 'device_unverified']);
    const none = await call('GET', 'history', { cookie: null });
    expect([none.status, none.json.error]).toEqual([401, 'device_unverified']);
    const missing = await call('GET', 'nowhere');
    expect(missing.status).toBe(404);
    // A guessed code on a header route answers like a valid one without a device.
    const unknown = await call('GET', 'today', { code: 'ZZZZZZZZ', cookie: null });
    expect([unknown.status, unknown.json.error]).toEqual([401, 'device_unverified']);
    for (const r of [expired, cross, none, missing, unknown])
      expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('writes no console code for a real org: 409 and no messages row', async () => {
    await sql`update orgs set is_demo = false where id = ${f.orgId}`;
    try {
      const res = await call('POST', 'device/send-code', { code: f.dana.code, cookie: null });
      expect([res.status, res.json.error, res.json.reason]).toEqual([
        409,
        'code_undeliverable',
        'no_channel',
      ]);
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from messages where reporter_id = ${f.dana.id}`;
      expect(row!.n).toBe(0);
    } finally {
      await sql`update orgs set is_demo = true where id = ${f.orgId}`;
    }
  });
});

describeRace('field_complete_upload on real Postgres', () => {
  let sql: Sql;
  let f: Fixture | undefined;

  beforeAll(async () => {
    sql = connectStack(8);
    f = await createFixture(sql, 'field race');
  });

  afterAll(async () => {
    await dropFixture(sql, f);
    await sql?.end({ timeout: 5 });
  });

  async function upload(reporterId: string, siteId: string, date: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`insert into uploads (id, reporter_id, site_id, kind, storage_path)
      values (${id}, ${reporterId}, ${siteId}, 'audio', ${uploadStoragePath(f!.orgId, siteId, date, id, 'webm')})`;
    return id;
  }

  /** Completes the uploads in parallel transactions that all start before any of them numbers. */
  async function race(ids: { upload: string; reporter: string }[]) {
    let started = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => (release = resolve));
    return Promise.all(
      ids.map(({ upload: id, reporter }) =>
        sql.begin(async (tx) => {
          await tx`select 1`;
          if (++started === ids.length) release();
          await all;
          const [row] =
            (await tx`select field_complete_upload(${id}, ${reporter}) as r`) as unknown as [
              { r: { reportId: string; reportNo: string; created: boolean } },
            ];
          await tx`select pg_sleep(0.01)`;
          return row.r;
        }),
      ),
    );
  }

  it('makes one report for uploads of one site-day completed at once, with one number', async () => {
    const day = '2026-03-02';
    const ids = [
      { upload: await upload(f!.marco.id, f!.siteId, day), reporter: f!.marco.id },
      { upload: await upload(f!.marco.id, f!.siteId, day), reporter: f!.marco.id },
      { upload: await upload(f!.dana.id, f!.siteId, day), reporter: f!.dana.id },
      { upload: await upload(f!.dana.id, f!.siteId, day), reporter: f!.dana.id },
    ];
    const results = await race(ids);
    expect(new Set(results.map((r) => r.reportId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const [site] = await sql<
      { report_seq: number }[]
    >`select report_seq from sites where id = ${f!.siteId}`;
    expect(site!.report_seq).toBe(1);
    const [jobs] = await sql<{ n: number }[]>`
      select count(*)::int as n from jobs where type = 'transcribe_upload'
        and payload->>'uploadId' in ${sql(ids.map((i) => i.upload))}`;
    expect(jobs!.n).toBe(4);
  });

  it('serialises a confirm with a voice note on its site-day: one of them wins, never both', async () => {
    const day = '2026-03-11';
    const first = await upload(f!.marco.id, f!.siteId, day);
    const [done] =
      (await sql`select field_complete_upload(${first}, ${f!.marco.id}) as r`) as unknown as [
        { r: { reportId: string } },
      ];
    const reportId = done.r.reportId;
    await sql`update reports set status = 'awaiting_confirmation' where id = ${reportId}`;
    const voice = await upload(f!.dana.id, f!.siteId, day);

    let started = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => (release = resolve));
    const run = (stmt: (tx: Sql) => Promise<unknown>) =>
      sql
        .begin(async (tx) => {
          await tx`select 1`;
          if (++started === 2) release();
          await all;
          const out = await stmt(tx as unknown as Sql);
          await tx`select pg_sleep(0.02)`;
          return out;
        })
        .then(
          () => 'ok',
          (err: Error) => err.message,
        );
    const [confirm, complete] = await Promise.all([
      run((tx) => tx`select field_confirm_report(${reportId}, ${f!.marco.id}, 1)`),
      run((tx) => tx`select field_complete_upload(${voice}, ${f!.dana.id})`),
    ]);
    const [state] = await sql<{ status: string; jobs: number; attached: boolean }[]>`
      select r.status,
             (select count(*)::int from jobs where dedupe_key = ${`file:${reportId}:v1`}) as jobs,
             (select report_id is not null from uploads where id = ${voice}) as attached
      from reports r where r.id = ${reportId}`;
    if (confirm === 'ok') {
      // Confirmed first: the voice note waits for the filing (report_filing).
      expect(complete).toBe('report_filing');
      expect(state).toEqual({ status: 'awaiting_confirmation', jobs: 1, attached: false });
    } else {
      // The voice note first: the draft reopened, so the confirm is refused.
      expect([confirm, complete]).toEqual(['wrong_state', 'ok']);
      expect(state).toEqual({ status: 'processing', jobs: 0, attached: true });
    }
  });

  it('numbers reports of different site-days raced together uniquely and without gaps', async () => {
    const days = [
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-09',
      '2026-03-10',
    ];
    const ids = [];
    for (const d of days)
      ids.push({ upload: await upload(f!.marco.id, f!.site2Id, d), reporter: f!.marco.id });
    const results = await race(ids);
    expect(results.map((r) => r.reportNo).sort()).toEqual(
      days.map((_, i) => `FA-2-${String(i + 1).padStart(4, '0')}`),
    );
  });
});
