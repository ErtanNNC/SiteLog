import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobKeys, type JobPayloads, type JobRow } from '@sitelog/shared';
import { testConfig, type Config } from '../config';
import type { Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { sendWelcome } from './send_welcome';

/**
 * W4-12 · F3's automatic welcome re-send (spec §19 Q241, `WELCOME_RESEND`) on PGlite: the first
 * welcome that went queues one `send_welcome` with `auto` under `welcome_resend:<reporter>`, 48 h
 * on in the site's daytime; it re-sends once, never after a reaction (a consent answer, a link
 * opened) and never to a phone on the pack's opt-out list, and moves to the next 09:00 when it
 * runs at night. Kestrel (§18.1, US, a demo org) holds the reporters: its texts go to `console`,
 * here a recording transport.
 */

const ORG = '7a0cfa5d-2a29-43fb-8665-fcd9bed4106d';
/** Mon Oct 12 2026, 10:15 in Chicago (CDT, UTC−5). */
const T0 = new Date('2026-10-12T15:15:00Z');
const H = 3_600_000;

let pg: PgliteDatabase;
let SITE = '';
const sent: Array<{ to: string; body: string }> = [];

function ctxAt(now: Date, overrides: Partial<Config> = {}): Ctx {
  const config = testConfig({
    LINK_SIGNING_SECRET: 'w412-link-secret',
    FIELD_APP_URL: 'https://go.sitelog.test',
    ...overrides,
  });
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(
      config,
      pg.db,
      (driver) => ({
        driver,
        async send(to, body) {
          sent.push({ to, body });
          return { providerId: `${driver}:${randomUUID()}` };
        },
      }),
      () => now,
      [],
    ),
    log: silentLogger,
    now: () => now,
  } as unknown as Ctx;
}

const job = (id = 1) => ({ id, attempts: 1 }) as JobRow;

async function newReporter(): Promise<{ id: string; phone: string }> {
  const phone = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const [r] = await pg.q<{ id: string }>(
    `insert into reporters (org_id, name, phone_e164, locale, contact_pref)
     values ($1, 'Dana Brooks', $2, 'en-US', 'link') returning id`,
    [ORG, phone],
  );
  await pg.q(
    `insert into site_reporters (site_id, reporter_id, is_primary) values ($1, $2, true)`,
    [SITE, r!.id],
  );
  return { id: r!.id, phone };
}

/** The office's invite: the first welcome, at `at`. */
async function invite(reporterId: string, at = T0): Promise<void> {
  await sendWelcome(ctxAt(at), { reporterId, siteId: SITE, reinvite: false }, job());
}

async function autoJob(reporterId: string): Promise<{
  id: number;
  payload: JobPayloads['send_welcome'];
  delayH: number;
} | null> {
  const [row] = await pg.q<{ id: number; payload: JobPayloads['send_welcome']; delay_h: number }>(
    `select id, payload, extract(epoch from run_after - created_at) / 3600 as delay_h
     from jobs where dedupe_key = $1`,
    [jobKeys.welcomeAutoResend(reporterId)],
  );
  return row ? { id: row.id, payload: row.payload, delayH: Number(row.delay_h) } : null;
}

async function runAuto(reporterId: string, at: Date): Promise<void> {
  const j = await autoJob(reporterId);
  if (!j) throw new Error('no automatic re-send queued');
  await sendWelcome(ctxAt(at), j.payload, job(j.id));
}

async function welcomes(reporterId: string) {
  return pg.q<{ dedupe_key: string; status: string }>(
    `select payload->>'dedupe_key' as dedupe_key, status from messages
     where reporter_id = $1 and copy_key = 'welcome' and direction = 'out' order by created_at`,
    [reporterId],
  );
}

async function audits(reporterId: string) {
  return pg.q<{ action: string; diff: Record<string, unknown> }>(
    `select action, diff from audit_log
     where entity_id = $1 and action like 'reporter.%' order by id`,
    [reporterId],
  );
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [s] = await pg.q<{ id: string }>(
    `insert into sites (org_id, name, project_code, timezone, deadline, status)
     values ($1, 'Harbor Lofts', 'W412', 'America/Chicago', '17:30', 'active') returning id`,
    [ORG],
  );
  SITE = s!.id;
});

afterAll(async () => {
  await pg?.close();
});

describe('the automatic welcome re-send (§19 Q241)', () => {
  it('is queued by the first welcome that went, 48 h on, once per reporter', async () => {
    const r = await newReporter();
    await invite(r.id);
    const j = await autoJob(r.id);
    expect(j?.payload).toEqual({ reporterId: r.id, siteId: SITE, reinvite: false, auto: true });
    // Mon 10:15 + 48 h is Wed 10:15 in Chicago, inside 09:00–18:00: exactly 48 h on the DB clock.
    expect(j!.delayH).toBeCloseTo(48, 3);
    // The office's Re-send later queues no second automatic one (the key names one job for good).
    await sendWelcome(
      ctxAt(new Date(T0.getTime() + 50 * H)),
      {
        reporterId: r.id,
        siteId: SITE,
        reinvite: true,
      },
      job(2),
    );
    const all = await pg.q(`select id from jobs where dedupe_key like $1`, [
      `${jobKeys.welcomeAutoResend(r.id)}%`,
    ]);
    expect(all).toHaveLength(1);
  });

  it('re-sends once when nothing happened, keyed for Team, audited, never twice', async () => {
    const r = await newReporter();
    await invite(r.id);
    sent.length = 0;
    const due = new Date(T0.getTime() + 48 * H);
    await runAuto(r.id, due);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(r.phone);
    expect(sent[0]!.body).toContain('https://go.sitelog.test/r/');
    expect((await welcomes(r.id)).map((m) => m.dedupe_key)).toEqual([
      expect.stringMatching(/^send_welcome:/),
      jobKeys.welcomeAutoResend(r.id),
    ]);
    const acts = await audits(r.id);
    expect(acts.map((a) => a.action)).toEqual(['reporter.invited', 'reporter.welcome_resent']);
    expect(acts[1]!.diff).toMatchObject({ auto: true, channel: 'sms', site_id: SITE });
    const [row] = await pg.q<{ status: string; invited_at: string }>(
      `select status, invited_at from reporters where id = $1`,
      [r.id],
    );
    expect(row!.status).toBe('invited');
    expect(new Date(row!.invited_at).toISOString()).toBe(due.toISOString());

    // A retry of the same job texts nothing more.
    await runAuto(r.id, new Date(due.getTime() + 60_000));
    expect(sent).toHaveLength(1);
    expect(await welcomes(r.id)).toHaveLength(2);
  });

  it('never after a reaction: a consent answer or a link opened', async () => {
    const consented = await newReporter();
    await invite(consented.id);
    await pg.q(
      `insert into consents (reporter_id, type, method, text_version)
       values ($1, 'data_processing', 'web_checkbox', 'field.consent.v1')`,
      [consented.id],
    );
    const opened = await newReporter();
    await invite(opened.id);
    await pg.q(`update field_links set last_opened_at = $2 where reporter_id = $1`, [
      opened.id,
      new Date(T0.getTime() + 2 * H).toISOString(),
    ]);
    sent.length = 0;
    const due = new Date(T0.getTime() + 48 * H);
    await runAuto(consented.id, due);
    await runAuto(opened.id, due);
    expect(sent).toEqual([]);
    expect((await audits(consented.id)).at(-1)).toEqual({
      action: 'reporter.welcome_resend_skipped',
      diff: { auto: true, reason: 'consent_answered' },
    });
    expect((await audits(opened.id)).at(-1)).toEqual({
      action: 'reporter.welcome_resend_skipped',
      diff: { auto: true, reason: 'link_opened' },
    });
    expect(await welcomes(opened.id)).toHaveLength(1);
  });

  it('never to a phone that opted out of texts on the pack', async () => {
    const r = await newReporter();
    await invite(r.id);
    await pg.q(
      `insert into sms_opt_outs (phone_e164, country, method) values ($1, 'US', 'sms_keyword')`,
      [r.phone],
    );
    sent.length = 0;
    await runAuto(r.id, new Date(T0.getTime() + 48 * H));
    expect(sent).toEqual([]);
    expect(await welcomes(r.id)).toHaveLength(1);
    expect((await audits(r.id)).at(-1)).toEqual({
      action: 'reporter.welcome_resend_skipped',
      diff: { auto: true, reason: 'phone_opted_out' },
    });
  });

  it('waits for the site’s daytime: a job run at night moves to 09:00, once that date', async () => {
    const r = await newReporter();
    await invite(r.id);
    sent.length = 0;
    // Wed 20:30 in Chicago.
    const night = new Date('2026-10-15T01:30:00Z');
    await runAuto(r.id, night);
    await runAuto(r.id, night);
    expect(sent).toEqual([]);
    const moved = await pg.q<{ payload: JobPayloads['send_welcome']; delay_h: number }>(
      `select payload, extract(epoch from run_after - created_at) / 3600 as delay_h
       from jobs where dedupe_key = $1`,
      [jobKeys.welcomeAutoResendDeferred(r.id, '2026-10-14')],
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]!.payload).toMatchObject({ reporterId: r.id, auto: true });
    // Thu 09:00 CDT is 12.5 h after Wed 20:30.
    expect(Number(moved[0]!.delay_h)).toBeCloseTo(12.5, 3);
    // The moved job at 09:00 sends.
    await sendWelcome(ctxAt(new Date('2026-10-15T14:00:00Z')), moved[0]!.payload, job(3));
    expect(sent).toHaveLength(1);
  });

  it('WELCOME_RESEND=off queues nothing and a queued one sends nothing', async () => {
    const r = await newReporter();
    await sendWelcome(
      ctxAt(T0, { WELCOME_RESEND: 'off' }),
      { reporterId: r.id, siteId: SITE, reinvite: false },
      job(),
    );
    expect(await autoJob(r.id)).toBeNull();
    sent.length = 0;
    await sendWelcome(
      ctxAt(new Date(T0.getTime() + 48 * H), { WELCOME_RESEND: 'off' }),
      { reporterId: r.id, siteId: SITE, reinvite: false, auto: true },
      job(),
    );
    expect(sent).toEqual([]);
  });
});
