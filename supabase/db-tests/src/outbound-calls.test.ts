import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261016000380_outbound_calls.sql (W3-17, M8; spec §7.4, F11, §19 Q125–Q132), the SQL half; the
 * worker's `place_call` on the same functions is `apps/worker/src/jobs/place-call.pglite.test.ts`.
 * - claim_site_day_reminder() with calls: R1 queues one `place_call` per call reporter in the same
 *   transaction as its texts (`call:<site_day>:<reporter>:<stage>`); the daily link stage takes
 *   `call_coming` (§19 Q130) and places no call; a lost claim queues nothing;
 * - org_places_calls(): a demo org, or a pack with an outbound trunk here (§19 Q51, Q132);
 * - field_grant_consent() takes `auto_call` only where calls are placed (§19 Q33, Q131);
 * - field_no_calls_today(): the end of the day in the org's time zone, audited (§19 Q129);
 * - outbound_call_start() refuses an office-attested consent (§19 Q131) and a second R1;
 * - outbound_call_share() and ops_outbound_call_share() (M8): per org and ISO week.
 */

const KEVIN_PHONE = '+15550142087';
const LENA = DEMO_USERS[0]!.id;
const OPERATOR = 'bbbbbbbb-1717-4111-8111-111111111111';

let db: PGlite;
let kevin: string;
let northgate: string;
let days = 0;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await svc(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** A fresh Northgate day (Mon–Fri of May 2031), deadline 17:30 Chicago. */
async function freshDay(): Promise<string> {
  const date = new Date(
    Date.parse('2031-05-05T00:00:00Z') + (Math.floor(days / 5) * 7 + (days % 5)) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  days += 1;
  const [row] = await svc<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at) values ($1, $2, $3) returning id`,
    [northgate, date, `${date}T22:30:00Z`],
  );
  return row!.id;
}

const jobKeys = (siteDay: string) =>
  svc<{ type: string; dedupe_key: string; payload: Record<string, unknown> }>(
    `select type, dedupe_key, payload from jobs where dedupe_key like $1 order by id`,
    [`%${siteDay}%`],
  );

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  kevin = (
    await svc<{ id: string }>(`select id from reporters where phone_e164 = $1 and org_id = $2`, [
      KEVIN_PHONE,
      DEMO_ORG_ID,
    ])
  )[0]!.id;
  northgate = (
    await svc<{ id: string }>(
      `select site_id as id from site_reporters where reporter_id = $1 and is_primary`,
      [kevin],
    )
  )[0]!.id;
  await svc(`insert into auth.users (id, email) values ($1, 'oncall-w317@sitelog.test')`, [
    OPERATOR,
  ]);
  await svc(`insert into platform_admins (user_id, note) values ($1, 'on-call')`, [OPERATOR]);
});

describe('claim_site_day_reminder() with calls (W3-17)', () => {
  it('queues R1’s place_call with the texts of the stage, in one transaction', async () => {
    const sd = await freshDay();
    const [ok] = await svc<{ ok: boolean }>(
      `select claim_site_day_reminder($1, 'reminder_1', '[]'::jsonb, '[]'::jsonb,
         '2031-05-06T01:00:00Z', $2::jsonb) as ok`,
      [sd, JSON.stringify([{ reporterId: kevin, giveUpAt: '2031-05-05T23:15:00Z' }])],
    );
    expect(ok!.ok).toBe(true);
    expect(await jobKeys(sd)).toEqual([
      {
        type: 'place_call',
        dedupe_key: `call:${sd}:${kevin}:reminder_1`,
        payload: {
          reporterId: kevin,
          siteDayId: sd,
          stage: 'reminder_1',
          notAfter: '2031-05-06T01:00:00+00:00',
          giveUpAt: '2031-05-05T23:15:00Z',
        },
      },
    ]);
    const [audit] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'site_day.reminder' and entity_id = $1`,
      [sd],
    );
    expect(audit!.diff).toMatchObject({ stage: 'reminder_1', called: [kevin], sent: [] });
    // Claimed once: a second claim of the stage queues nothing.
    const [again] = await svc<{ ok: boolean }>(
      `select claim_site_day_reminder($1, 'reminder_1', '[]'::jsonb, '[]'::jsonb, null, $2::jsonb) as ok`,
      [sd, JSON.stringify([{ reporterId: kevin }])],
    );
    expect(again!.ok).toBe(false);
    expect(await jobKeys(sd)).toHaveLength(1);
  });

  it('takes call_coming at the daily link (§19 Q130) and places no call then', async () => {
    const sd = await freshDay();
    const msg = [
      { reporterId: kevin, key: 'call_coming', vars: { time: '17:45', link: 'https://x/r/a' } },
    ];
    const [ok] = await svc<{ ok: boolean }>(
      `select claim_site_day_reminder($1, 'daily_link', $2::jsonb) as ok`,
      [sd, JSON.stringify(msg)],
    );
    expect(ok!.ok).toBe(true);
    expect((await jobKeys(sd)).map((j) => j.dedupe_key)).toEqual([
      `notify:call_coming:${sd}:${kevin}`,
    ]);
    const sd2 = await freshDay();
    expect(
      await failure(
        `select claim_site_day_reminder($1, 'daily_link', '[]'::jsonb, '[]'::jsonb, null, $2::jsonb)`,
        [sd2, JSON.stringify([{ reporterId: kevin }])],
      ),
    ).toMatch('places no call');
    // A stage's message stays its own (call_coming is the daily link's only).
    expect(
      await failure(`select claim_site_day_reminder($1, 'reminder_1', $2::jsonb)`, [
        sd2,
        JSON.stringify(msg),
      ]),
    ).toMatch('sends reminder_1');
  });
});

describe('who places calls and who agrees to them (§19 Q33, Q51, Q131, Q132)', () => {
  it('a demo org places calls; a real org only with its pack’s trunk', async () => {
    const [demo] = await svc<{ v: boolean }>(`select org_places_calls($1) as v`, [DEMO_ORG_ID]);
    expect(demo!.v).toBe(true);
    await asService(db, async (q) => {
      await q(`update orgs set is_demo = false where id = $1`, [DEMO_ORG_ID]);
      expect(
        (await q<{ v: boolean }>(`select org_places_calls($1) as v`, [DEMO_ORG_ID])).rows[0]!.v,
      ).toBe(false);
      // Settings' Turn on is refused there (no automated calls asked where none are placed).
      await expect(
        q(`select field_grant_consent($1, 'auto_call', 'v1', null, null)`, [kevin]),
      ).rejects.toThrow('consent_not_offered');
      await q(
        `select set_country_endpoints('US', null, '+15550142290', null, null, 'ST_testTrunk1')`,
      );
      expect(
        (await q<{ v: boolean }>(`select org_places_calls($1) as v`, [DEMO_ORG_ID])).rows[0]!.v,
      ).toBe(true);
      await q(`select set_country_endpoints('US', null, null, null, null, null)`);
      await q(`update orgs set is_demo = true where id = $1`, [DEMO_ORG_ID]);
    });
  });

  it('Settings turns automated calls on (web_checkbox), audited', async () => {
    await svc(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'auto_call'`,
      [kevin],
    );
    const [r] = await svc<{ r: { granted: boolean } }>(
      `select field_grant_consent($1, 'auto_call', 'field.consent.v1', null, '{}'::jsonb) as r`,
      [kevin],
    );
    expect(r!.r.granted).toBe(true);
    const [audit] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'consent.given' and actor_id = $1
         and entity = 'consent' and diff->>'type' = 'auto_call' order by id desc limit 1`,
      [kevin],
    );
    expect(audit!.diff).toMatchObject({ type: 'auto_call', via: 'settings' });
  });

  it('an office-attested auto_call places no ladder call (§19 Q131)', async () => {
    const sd = await freshDay();
    await svc(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'auto_call'`,
      [kevin],
    );
    await svc(
      `insert into consents (reporter_id, type, method, text_version) values ($1, 'auto_call', 'office_attested', 'v1')`,
      [kevin],
    );
    const [r] = await svc<{ r: { status: string; reason: string } }>(
      `select outbound_call_start($1, $2, 'reminder_1', $3::timestamptz, 'console') as r`,
      [kevin, sd, '2031-05-05T22:46:00Z'],
    );
    expect(r!.r).toEqual({ status: 'skipped', reason: 'no_consent' });
    await svc(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'auto_call'`,
      [kevin],
    );
    await svc(
      `insert into consents (reporter_id, type, method, text_version) values ($1, 'auto_call', 'web_checkbox', 'v1')`,
      [kevin],
    );
  });
});

describe('"Don’t call me today" from Settings (§19 Q129)', () => {
  it('sets the end of the org’s day once, audited via web with the device', async () => {
    const now = '2031-05-05T22:00:00Z'; // 17:00 Chicago
    const [first] = await svc<{ r: { until: string; changed: boolean } }>(
      `select field_no_calls_today($1, null, $2::timestamptz) as r`,
      [kevin, now],
    );
    expect(first!.r.changed).toBe(true);
    expect(new Date(first!.r.until).toISOString()).toBe('2031-05-06T05:00:00.000Z');
    const [again] = await svc<{ r: { changed: boolean } }>(
      `select field_no_calls_today($1, null, $2::timestamptz) as r`,
      [kevin, now],
    );
    expect(again!.r.changed).toBe(false);
    const audits = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'reporter.preferences_changed' and entity_id = $1
         and diff->>'channel' = 'web' order by id`,
      [kevin],
    );
    expect(audits).toHaveLength(1);
    await svc(`update reporters set no_calls_until = null where id = $1`, [kevin]);
  });
});

describe('the M8 measure (outbound_call_share, ops_outbound_call_share)', () => {
  it('counts the called site-days of a week and those filed on the call', async () => {
    const a = await freshDay();
    const b = await freshDay();
    for (const [sd, attempt, outcome] of [
      [a, 1, 'not_reached'],
      [a, 2, 'filed'],
      [b, 1, 'not_reached'],
    ] as const) {
      await svc(
        `insert into calls (org_id, reporter_id, site_id, site_day_id, direction, transport, purpose,
                            attempt, status, outcome, ended_at)
         values ($1, $2, $3, $4, 'outbound', 'pstn', 'reminder', $5, 'completed', $6, now())`,
        [DEMO_ORG_ID, kevin, northgate, sd, attempt, outcome],
      );
    }
    const rows = await svc<{ week_start: string; call_days: number; filed_by_call: number }>(
      `select to_char(week_start, 'YYYY-MM-DD') as week_start, call_days, filed_by_call
         from outbound_call_share($1, '2031-05-01', '2031-05-31') order by week_start`,
      [DEMO_ORG_ID],
    );
    // Whatever weeks the two days fall in: two called site-days, one filed on the call.
    expect(rows.reduce((n, r) => n + r.call_days, 0)).toBe(2);
    expect(rows.reduce((n, r) => n + r.filed_by_call, 0)).toBe(1);
    for (const r of rows) expect(new Date(`${r.week_start}T12:00:00Z`).getUTCDay()).toBe(1);
    // A second outbound R1 of a site-day is refused by the partial unique index (§19 Q128).
    expect(
      await failure(
        `insert into calls (org_id, reporter_id, site_day_id, direction, transport, attempt)
         values ($1, $2, $3, 'outbound', 'pstn', 1)`,
        [DEMO_ORG_ID, kevin, a],
      ),
    ).toMatch('calls_outbound_attempt_key');
  });

  it('is read on /ops by SiteLog staff only', async () => {
    const res = await asUser(db, OPERATOR, (q) =>
      q<{ org_name: string; call_days: number }>(`select * from ops_outbound_call_share(520)`),
    );
    // The window is the last weeks to now; the 2031 rows above are ahead of it, so it may be empty
    // here: what matters is that the operator may read it and an org admin may not.
    expect(Array.isArray(res.rows)).toBe(true);
    expect(
      await probeAs(
        db,
        { role: 'authenticated', userId: LENA },
        `select * from ops_outbound_call_share()`,
      ),
    ).toMatchObject({ ok: false });
  });
});
