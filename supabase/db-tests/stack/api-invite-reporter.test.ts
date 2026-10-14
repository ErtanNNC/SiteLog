import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { deriveLinkCode, linkCodeHash } from '@sitelog/shared';
import { connectStack, STACK_DB_URL } from './db.ts';

/**
 * api-invite-reporter (W1-08) served by `supabase start`, against the stack's database: the
 * orchestration logic_test.ts cannot see. Lena (the seeded Kestrel admin) is made an admin of a
 * fresh real org and invites: a new number with the "Speaks" languages → the reporter stored with
 * the pack's matching field locale (es → es-US) and `contact_pref 'link'`, one personal
 * `field_links` row (its hash the derived code's), the `field_link.created` audit row as Lena,
 * the `send_welcome` job, a 201 carrying `personalLinkId` and no code, and no `conversations` row;
 * a reused reporter with only `locale` in the request → only the locale changes (200, `reused`);
 * a number that sent STOP on the pack (`sms_opt_outs`) → created `opted_out`, so the welcome job
 * skips it (§9.5, §13).
 *
 * Needs SUPABASE_DB_URL (the stack's DB_URL), INVITE_API_URL
 * (`{API_URL}/functions/v1/api-invite-reporter`), ANON_KEY and SERVICE_ROLE_KEY (as
 * `supabase status -o env` names them; the function must be up, CI warms it first). With
 * LINK_SIGNING_SECRET (the functions' value) the link's hash is checked against the derived code.
 * Skips without them.
 */

const INVITE_API = process.env.INVITE_API_URL?.trim().replace(/\/+$/, '') || undefined;
const AUTH_URL = INVITE_API?.replace(/\/functions\/v1\/.*$/, '/auth/v1');
const ANON_KEY = process.env.ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY =
  process.env.SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const LINK_SECRET = process.env.LINK_SIGNING_SECRET?.trim() || undefined;
const describeInvite =
  STACK_DB_URL && INVITE_API && ANON_KEY && SERVICE_ROLE_KEY ? describe : describe.skip;

/** supabase/seed.sql: Lena Okafor, Kestrel's admin (§18.1). */
const LENA = { id: '3dee836a-fca5-4d0c-8572-5e8e0c3fb25a', email: 'lena@kestrelbuild.example' };

/** A unique +1 555 number per run. */
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

interface Fixture {
  orgId: string;
  siteId: string;
  site2Id: string;
  /** A reporter already in the org (the §F2 "same phone" edge case). */
  marco: { id: string; phone: string };
}

async function createFixture(sql: Sql): Promise<Fixture> {
  // A real org (is_demo false) on the US pack; Lena is its admin.
  const [org] = await sql<{ id: string }[]>`
    insert into orgs (name, is_demo, country) values (${`test:stack invite ${Date.now()}`}, false, 'US') returning id`;
  const orgId = org!.id;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${LENA.id}, 'admin')`;
  const [s1] = await sql<{ id: string }[]>`
    insert into sites (org_id, name, project_code, timezone)
    values (${orgId}, 'Riverside', 'IN-1', 'America/Chicago') returning id`;
  const [s2] = await sql<{ id: string }[]>`
    insert into sites (org_id, name, project_code, timezone)
    values (${orgId}, 'Pier 9', 'IN-2', 'America/Chicago') returning id`;
  const marco = { id: '', phone: phone() };
  const [m] = await sql<{ id: string }[]>`
    insert into reporters (org_id, name, phone_e164, status, locale, languages, contact_pref, activated_at)
    values (${orgId}, 'Marco Ruiz', ${marco.phone}, 'active', 'en-US', '{en}', 'call', now()) returning id`;
  marco.id = m!.id;
  await sql`insert into site_reporters (site_id, reporter_id, is_primary) values (${s1!.id}, ${marco.id}, true)`;
  return { orgId, siteId: s1!.id, site2Id: s2!.id, marco };
}

/** Removes the fixture's rows; every step runs and the first error is thrown at the end. */
async function dropFixture(sql: Sql, f: Fixture | undefined, phones: string[]) {
  if (!f) return;
  const steps = [
    () => sql`delete from jobs where type = 'send_welcome'
              and payload->>'reporterId' in (select id::text from reporters where org_id = ${f.orgId})`,
    () =>
      sql`delete from field_links where reporter_id in (select id from reporters where org_id = ${f.orgId})`,
    () => sql`delete from audit_log where org_id = ${f.orgId}`,
    () =>
      phones.length
        ? sql`delete from sms_opt_outs where phone_e164 in ${sql(phones)}`
        : Promise.resolve(),
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

/** Lena's session as the panel would hold it: GoTrue mints a magic link, the token hash is verified. */
async function signInAsLena(): Promise<string> {
  const admin = { apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` };
  const linkRes = await fetch(`${AUTH_URL}/admin/generate_link`, {
    method: 'POST',
    headers: { ...admin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: LENA.email }),
  });
  const link = (await linkRes.json()) as { hashed_token?: string; msg?: string };
  if (!linkRes.ok || !link.hashed_token) {
    throw new Error(`generate_link ${linkRes.status}: ${link.msg ?? JSON.stringify(link)}`);
  }
  const verifyRes = await fetch(`${AUTH_URL}/verify`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.hashed_token }),
  });
  const session = (await verifyRes.json()) as { access_token?: string; msg?: string };
  if (!verifyRes.ok || !session.access_token) {
    throw new Error(`verify ${verifyRes.status}: ${session.msg ?? JSON.stringify(session)}`);
  }
  return session.access_token;
}

describeInvite('api-invite-reporter on the local stack', () => {
  let sql: Sql;
  let f: Fixture;
  let jwt = '';
  const phones: string[] = [];

  async function invite(body: Record<string, unknown>) {
    const res = await fetch(INVITE_API!, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ orgId: f.orgId, ...body }),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
  }

  beforeAll(async () => {
    sql = connectStack(2);
    f = await createFixture(sql);
    jwt = await signInAsLena();
  });

  afterAll(async () => {
    try {
      await dropFixture(sql, f, phones);
    } finally {
      await sql?.end({ timeout: 5 });
    }
  });

  it('a new number: the locale from "Speaks", the personal link, the audit, the job, no code and no conversation', async () => {
    const ana = phone();
    phones.push(ana);
    const res = await invite({
      name: 'Ana Torres',
      phone: ana,
      role: 'backup',
      siteIds: [f.siteId, f.site2Id],
      languages: ['es'],
    });
    expect(res.status, res.text).toBe(201);
    const reporter = res.json.reporter as Record<string, unknown>;
    expect(reporter).toMatchObject({
      org_id: f.orgId,
      name: 'Ana Torres',
      phone_e164: ana,
      role: 'backup',
      languages: ['es'],
      locale: 'es-US',
      contact_pref: 'link',
      status: 'invited',
      opted_out_at: null,
    });
    expect(res.json.reused).toBe(false);
    expect(res.json.linkedSiteIds).toEqual([f.siteId, f.site2Id]);
    // Riverside already has Marco as primary; Pier 9 gets Ana.
    expect(res.json.primarySiteIds).toEqual([f.site2Id]);
    expect(typeof res.json.personalLinkId).toBe('string');
    expect(typeof res.json.welcomeJobId).toBe('number');
    // The answer never carries the link code (§4.5): no `code` anywhere in it.
    expect(res.json).not.toHaveProperty('code');
    expect(res.text).not.toMatch(/"code"\s*:/);

    const id = reporter.id as string;
    const links = await sql<
      {
        id: string;
        code_hash: string;
        kind: string;
        site_id: string | null;
        expires_at: string | null;
      }[]
    >`select id, code_hash, kind, site_id, expires_at from field_links where reporter_id = ${id}`;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      id: res.json.personalLinkId,
      kind: 'personal',
      site_id: null,
      expires_at: null,
    });
    expect(links[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    if (LINK_SECRET) {
      expect(links[0]!.code_hash).toBe(
        linkCodeHash(await deriveLinkCode(LINK_SECRET, links[0]!.id)),
      );
    }

    const audits = await sql<
      { action: string; actor_type: string; actor_id: string; diff: unknown }[]
    >`
      select action, actor_type, actor_id::text, diff from audit_log
      where org_id = ${f.orgId} and entity_id = ${id} order by id`;
    expect(audits.map((a) => [a.action, a.actor_type, a.actor_id])).toEqual([
      ['field_link.created', 'user', LENA.id],
      ['reporter.invited', 'user', LENA.id],
    ]);
    expect(audits[0]!.diff).toEqual({ kind: 'personal', site_id: null, report_date: null });
    expect(audits[1]!.diff).toMatchObject({
      siteIds: [f.siteId, f.site2Id],
      reused: false,
      locale: 'es-US',
      contact_pref: 'link',
      status: 'invited',
      phone_opted_out: false,
    });

    const jobs = await sql<
      { type: string; status: string; payload: unknown; dedupe_key: string }[]
    >`
      select type, status, payload, dedupe_key from jobs where id = ${res.json.welcomeJobId as number}`;
    expect(jobs[0]).toEqual({
      type: 'send_welcome',
      status: 'queued',
      payload: { reporterId: id, siteId: f.siteId, reinvite: false },
      dedupe_key: `welcome:${id}:${f.siteId}`,
    });
    // No WhatsApp conversation any more (W1-08).
    expect(
      await sql`select id from conversations where reporter_id = ${id} or org_id = ${f.orgId}`,
    ).toEqual([]);

    // The same request again: the same reporter, reused, with the same link and job.
    const again = await invite({
      name: 'Ana Torres',
      phone: ana,
      role: 'backup',
      siteIds: [f.siteId],
      languages: ['es'],
    });
    expect(again.status, again.text).toBe(200);
    expect([again.json.reused, again.json.personalLinkId, again.json.welcomeJobId]).toEqual([
      true,
      res.json.personalLinkId,
      res.json.welcomeJobId,
    ]);
    expect(await sql`select id from field_links where reporter_id = ${id}`).toHaveLength(1);
  });

  it('a reused reporter changes only what the request names (here the locale)', async () => {
    const res = await invite({
      name: 'Marco R.',
      phone: f.marco.phone,
      siteIds: [f.site2Id],
      locale: 'es-US',
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json.reused).toBe(true);
    expect(res.json.reporter).toMatchObject({
      id: f.marco.id,
      name: 'Marco Ruiz', // the name of an active reporter is not rewritten
      locale: 'es-US',
      languages: ['en'],
      contact_pref: 'call',
      status: 'active',
    });
    const [row] = await sql<{ locale: string; contact_pref: string; status: string }[]>`
      select locale, contact_pref, status from reporters where id = ${f.marco.id}`;
    expect(row).toEqual({ locale: 'es-US', contact_pref: 'call', status: 'active' });
    expect(res.json.linkedSiteIds).toEqual([f.site2Id]);

    // A preference alone, for the same reporter: the locale stays.
    const pref = await invite({
      name: 'Marco R.',
      phone: f.marco.phone,
      siteIds: [f.siteId],
      contactPref: 'link',
    });
    expect(pref.status, pref.text).toBe(200);
    expect(pref.json.reporter).toMatchObject({ locale: 'es-US', contact_pref: 'link' });

    // A locale the pack does not offer is refused.
    const bad = await invite({
      name: 'Marco R.',
      phone: f.marco.phone,
      siteIds: [f.siteId],
      locale: 'tr-TR',
    });
    expect(bad.status).toBe(400);
  });

  it('a number that sent STOP on the pack is created opted out, so the welcome is skipped', async () => {
    const stopped = phone();
    phones.push(stopped);
    await sql`insert into sms_opt_outs (phone_e164, country, method) values (${stopped}, 'US', 'sms_keyword')`;
    const res = await invite({
      name: 'Quiet Person',
      phone: stopped,
      siteIds: [f.siteId],
      languages: ['en'],
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json.reporter).toMatchObject({ status: 'opted_out', locale: 'en-US' });
    expect((res.json.reporter as { opted_out_at: string | null }).opted_out_at).not.toBeNull();
    const audits = await sql<{ diff: { phone_opted_out?: boolean; status?: string } }[]>`
      select diff from audit_log where org_id = ${f.orgId} and action = 'reporter.invited'
        and entity_id = ${(res.json.reporter as { id: string }).id}`;
    expect(audits[0]!.diff).toMatchObject({ phone_opted_out: true, status: 'opted_out' });
  });

  it('refuses a phone the org country cannot read and a site of another org', async () => {
    const bad = await invite({ name: 'X', phone: '12', siteIds: [f.siteId] });
    expect(bad.status).toBe(400);
    const foreign = await invite({
      name: 'X',
      phone: phone(),
      siteIds: ['00000000-0000-4000-8000-000000000001'],
    });
    expect(foreign.status).toBe(400);
    expect(await sql`select id from reporters where org_id = ${f.orgId} and name = 'X'`).toEqual(
      [],
    );
  });
});
