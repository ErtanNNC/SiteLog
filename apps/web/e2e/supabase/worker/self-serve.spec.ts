import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SMS_STAND_IN_ROUTES, type StandInMessage } from '@sitelog/shared/sms/stand-in.ts';
import { admin, ANON_KEY, signInWithMagicLink, SUPABASE_URL } from '../support';

/**
 * W4-12 · self-serve onboarding end to end (spec §16.2 M10 Done when: "a new contractor
 * self-onboards a site and gets the first report via link **and** via call without TalkOlog
 * staff"; F1–F6; §19 Q246: Talk now counts as the call). One brand-new customer per pack, on a
 * **real** org (not a demo org), with no seed rows and no staff action:
 *
 * 1. F1/F2: a new user signs up (GoTrue, email confirmations off on the stack) and makes the org,
 *    its site and the site manager's invite with the calls the setup wizard makes (create_org with
 *    the pack, the `sites` insert, api-invite-reporter), as that user under RLS; Settings sets one
 *    question per report to none (the office's own choice) so the draft follows the voice note;
 * 2. F3: the worker's welcome goes through the pack's real driver (Twilio for US, İletimerkezi for
 *    TR) to the local SMS stand-in (`pnpm sms:stand-in`, SMS_PROVIDER_STUB), which hands back the
 *    personal link;
 * 3. F4/F5: the manager's link resolves at field-api, the device code arrives at the stand-in
 *    (field-api's own driver), the phone is verified and consents, a voice note (a fixtures/voice
 *    recording for the CI worker's fake transcriber) is uploaded and completed, the worker makes
 *    the draft, the manager confirms, and the report is filed with its PDF;
 * 4. the next day (the first report's day is moved back one day: the stack has one clock), the
 *    same manager files by Talk now (F6): the call row as field-api's `voice/token` makes it
 *    (`field_talk_now_start()`; LiveKit aside, which the fake VoiceClient stands in for in the
 *    field app's own suite), then the agent's requests to field-api's `/voice/*` routes with a
 *    recorded call's transcript (fixtures/calls), the read-back confirmed by the verbatim yes;
 * 5. the panel, signed in as the new user, lists both filed reports; both PDFs are stored.
 *
 * `@m10` is the US run, `@m11` the TR run (W4-16: in the M10 and M11 suites, `pnpm e2e:m10` and
 * `pnpm e2e:m11`, CI's last two e2e-supabase steps, after `pnpm countries:set` gives both packs a
 * stand-in sender on that stack; `pnpm e2e:onboarding` runs this file alone). Needs: the worker
 * on the stack with TRANSCRIBE_PROVIDER=fake, EXTRACT_PROVIDER=fake and the stand-in's env
 * (WORKER_HEALTH_URL), SMS_STAND_IN_URL, VOICE_AGENT_TOOL_SECRET as field-api has it, and the
 * functions' env with SMS_PROVIDER_STUB (CI's "Edge Function env"). Locally it skips without them.
 */
test.describe.configure({ mode: 'serial' });

const WORKER_HEALTH_URL = process.env.WORKER_HEALTH_URL ?? 'http://127.0.0.1:8080/health';
const STAND_IN_URL = (process.env.SMS_STAND_IN_URL ?? '').replace(/\/+$/, '');
const TOOL_SECRET = process.env.VOICE_AGENT_TOOL_SECRET ?? '';
const FIELD_API = `${SUPABASE_URL}/functions/v1/field-api`;
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const WAIT = 90_000;

interface Run {
  tag: '@m10' | '@m11';
  country: 'US' | 'TR';
  company: string;
  timezone: string;
  site: string;
  projectCode: string;
  manager: string;
  /** A random number of the pack's region nobody on the stack has. */
  phone: () => string;
  locale: 'en-US' | 'tr-TR';
  /** The fixtures/voice recording the fake transcriber answers the voice note with. */
  voiceNote: string;
  /** The recorded call whose transcript the call sends, and the reporter's yes. */
  callTranscript: string;
  utterances: string[];
  /** The pack's provider as the stand-in records it. */
  provider: StandInMessage['provider'];
}

const RUNS: Run[] = [
  {
    tag: '@m10',
    country: 'US',
    company: 'Selfserve Builders',
    timezone: 'America/Chicago',
    site: 'Northgate Parking Structure',
    projectCode: 'SS1',
    manager: 'Kevin O’Brien',
    phone: () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
    locale: 'en-US',
    voiceNote: 'en-elm-2026-10-02',
    callTranscript: 'call-northgate-2026-10-09-en',
    utterances: ['Sounds good, I guess.', 'Yes, file it.'],
    provider: 'twilio',
  },
  {
    tag: '@m11',
    country: 'TR',
    company: 'Selfserve Yapı A.Ş.',
    timezone: 'Europe/Istanbul',
    site: 'Kartal Konutları — B Blok',
    projectCode: 'SS2',
    manager: 'Emre Yıldız',
    phone: () => `+90532${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
    locale: 'tr-TR',
    voiceNote: 'tr-kartal-2026-10-09',
    callTranscript: 'call-kartal-2026-10-09-tr',
    utterances: ['Evet.'],
    provider: 'iletimerkezi',
  },
];

test.beforeAll(async () => {
  const up = await fetch(WORKER_HEALTH_URL)
    .then((r) => r.ok)
    .catch(() => false);
  const standIn = STAND_IN_URL
    ? await fetch(`${STAND_IN_URL}${SMS_STAND_IN_ROUTES.health}`)
        .then((r) => r.ok)
        .catch(() => false)
    : false;
  const ready = up && standIn && TOOL_SECRET !== '';
  // Locally the spec needs the worker, the stand-in and the agent's secret; CI must never skip.
  test.skip(
    !ready && !process.env.CI,
    'needs the worker (WORKER_HEALTH_URL), the SMS stand-in (SMS_STAND_IN_URL, pnpm sms:stand-in) and VOICE_AGENT_TOOL_SECRET',
  );
  expect(up, `the worker answers at ${WORKER_HEALTH_URL}`).toBe(true);
  expect(standIn, `the SMS stand-in answers at ${STAND_IN_URL || '(SMS_STAND_IN_URL unset)'}`).toBe(
    true,
  );
  expect(TOOL_SECRET, 'VOICE_AGENT_TOOL_SECRET').not.toBe('');
});

/** Polls `fn` until it returns a value (not null/undefined), or fails after `ms`. */
async function until<T>(what: string, fn: () => Promise<T | null | undefined>, ms = WAIT) {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function standInTexts(to: string): Promise<StandInMessage[]> {
  const res = await fetch(
    `${STAND_IN_URL}${SMS_STAND_IN_ROUTES.messages}?to=${encodeURIComponent(to)}`,
  );
  return (await res.json()) as StandInMessage[];
}

/** A field-api call as the phone makes it: the link code header and the device cookie. */
function phoneClient(code: string) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(method: string, route: string, body?: unknown) {
      const headers: Record<string, string> = { accept: 'application/json', 'x-link-code': code };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      const res = await fetch(`${FIELD_API}/${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = /^([^;]+)/.exec(set)![1]!;
      const text = await res.text();
      return {
        status: res.status,
        json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      };
    },
  };
}

/** The voice agent's request to field-api (its bearer secret, the call token). */
async function agent(path: string, body: unknown, callToken?: string) {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${FIELD_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOOL_SECRET}`,
        'content-type': 'application/json',
        'x-request-id': randomUUID().replace(/-/g, ''),
        ...(callToken ? { 'x-call-token': callToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // A live tool the worker is still on answers `pending` (W3-09): ask again.
    if (res.status === 202 && json.status === 'pending') {
      await new Promise((r) => setTimeout(r, Math.min(Number(json.retryAfterMs) || 1000, 5000)));
      continue;
    }
    return { status: res.status, json };
  }
  throw new Error(`${path} still pending`);
}

for (const run of RUNS) {
  test.describe(`${run.country} pack`, { tag: run.tag }, () => {
    const email = `selfserve-${run.country.toLowerCase()}-${Date.now()}@sitelog.example`;
    const password = `selfserve-${randomUUID()}`;
    const phone = run.phone();
    let user: SupabaseClient;
    let orgId = '';
    let siteId = '';
    let reporterId = '';
    let linkCode = '';
    let linkReportId = '';
    let callReportId = '';

    test('a new user signs up and sets up the org, the site and the manager’s invite', async () => {
      user = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const signedUp = await user.auth.signUp({ email, password });
      if (signedUp.error) throw signedUp.error;
      expect(signedUp.data.session, 'email confirmations are off on the stack').not.toBeNull();

      const org = await user.rpc('create_org', {
        p_name: run.company,
        p_timezone: run.timezone,
        p_address: null,
        p_license_no: null,
        p_country: run.country,
      });
      if (org.error) throw org.error;
      orgId = (org.data as { id: string }).id;
      const { data: orgRow } = await admin()
        .from('orgs')
        .select('country, is_demo')
        .eq('id', orgId)
        .single()
        .throwOnError();
      expect(orgRow).toEqual({ country: run.country, is_demo: false });

      const site = await user
        .from('sites')
        .insert({
          org_id: orgId,
          name: run.site,
          project_code: run.projectCode,
          timezone: run.timezone,
          deadline: '17:30:00',
          status: 'active',
        })
        .select('id')
        .single();
      if (site.error) throw site.error;
      siteId = (site.data as { id: string }).id;
      // One office choice in Settings: no questions, so the draft follows the voice note.
      const settings = await user
        .from('org_settings')
        .update({ max_questions_per_report: 0 })
        .eq('org_id', orgId);
      if (settings.error) throw settings.error;

      const { data: session } = await user.auth.getSession();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/api-invite-reporter`, {
        method: 'POST',
        headers: {
          apikey: ANON_KEY,
          authorization: `Bearer ${session.session!.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          orgId,
          name: run.manager,
          phone,
          role: 'site_manager',
          siteIds: [siteId],
          locale: run.locale,
          contactPref: 'link',
        }),
      });
      const invited = (await res.json()) as { reporter?: { id: string } };
      expect([200, 201], JSON.stringify(invited)).toContain(res.status);
      reporterId = invited.reporter!.id;
    });

    test('the welcome reaches the stand-in through the pack’s driver with the personal link', async () => {
      const welcome = await until('the welcome at the stand-in', async () =>
        (await standInTexts(phone)).find((m) => /\/r\/[A-Za-z0-9]+/.test(m.body)),
      );
      expect(welcome.provider).toBe(run.provider);
      expect(welcome.body).toContain(run.site);
      linkCode = /\/r\/([A-Za-z0-9]+)/.exec(welcome.body)![1]!;
      // The text reaches the stand-in before the worker marks the invite sent and queues the
      // re-send, so both are polled.
      const reporter = await until('the invite marked sent', async () => {
        const { data } = await admin()
          .from('reporters')
          .select('status, invited_at')
          .eq('id', reporterId)
          .single()
          .throwOnError();
        return data?.invited_at ? data : null;
      });
      expect(reporter.status).toBe('invited');
      // Q241: the one automatic re-send waits 48 h for a reaction (the PGlite test runs it).
      const resend = await until('the queued re-send', async () => {
        const { data } = await admin()
          .from('jobs')
          .select('status')
          .eq('dedupe_key', `welcome_resend:${reporterId}`)
          .throwOnError();
        return data?.length ? data : null;
      });
      expect(resend).toEqual([{ status: 'queued' }]);
    });

    test('the manager’s link verifies the phone, records and files', async () => {
      const p = phoneClient(linkCode);
      expect((await p.call('POST', 'resolve', { code: linkCode })).status).toBe(200);
      expect((await p.call('POST', 'device/send-code')).status).toBe(202);
      const codeText = await until('the device code at the stand-in', async () =>
        (await standInTexts(phone)).find(
          (m) => /\b\d{6}\b/.test(m.body) && !m.body.includes('/r/'),
        ),
      );
      expect(codeText.provider).toBe(run.provider);
      const otp = /\b(\d{6})\b/.exec(codeText.body)![1]!;
      expect((await p.call('POST', 'device/verify', { code: otp })).status).toBe(200);
      const consent = await p.call('POST', 'consent', {
        types: ['recording', 'data_processing', 'sms'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: run.locale,
      });
      expect(consent.json.status).toBe('active');

      // A voice note the CI worker's fake transcriber knows (fixtures/voice), through Storage.
      const audio = Buffer.from(
        JSON.stringify({ 'sitelog-fake-audio': run.voiceNote, durationS: 40 }),
      );
      const up = await p.call('POST', 'uploads', {
        kind: 'audio',
        mime: 'audio/webm',
        bytes: audio.length,
        siteId,
      });
      expect(up.status, JSON.stringify(up.json)).toBe(201);
      const signed = new URL(up.json.signedUrl as string);
      const put = await fetch(`${new URL(SUPABASE_URL).origin}${signed.pathname}${signed.search}`, {
        method: 'PUT',
        headers: { 'content-type': 'audio/webm' },
        body: audio,
      });
      expect(put.status, await put.clone().text()).toBe(200);
      const done = await p.call('POST', `uploads/${String(up.json.uploadId)}/complete`);
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      linkReportId = done.json.reportId as string;

      const draft = await until('the draft', async () => {
        const r = await p.call('GET', `reports/${linkReportId}`);
        return r.json.status === 'awaiting_confirmation' && r.json.draftRev ? r.json : null;
      });
      const confirmed = await p.call('POST', `reports/${linkReportId}/confirm`, {
        version: draft.currentVersion,
        draftRev: draft.draftRev,
      });
      expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(202);
      await until('the filed report and its PDF', async () => {
        const { data } = await admin()
          .from('reports')
          .select('status, channel, report_versions(pdf_path)')
          .eq('id', linkReportId)
          .single();
        const row = data as {
          status: string;
          channel: string;
          report_versions: Array<{ pdf_path: string | null }>;
        } | null;
        return row?.status === 'filed' && row.report_versions.some((v) => v.pdf_path) ? row : null;
      });
    });

    test('the next day the same manager files by Talk now', async () => {
      // One clock on the stack: the first report's day becomes yesterday, as the next day sees it.
      const { data: report } = await admin()
        .from('reports')
        .select('site_day_id')
        .eq('id', linkReportId)
        .single()
        .throwOnError();
      const { data: day } = await admin()
        .from('site_days')
        .select('date')
        .eq('id', report!.site_day_id)
        .single()
        .throwOnError();
      const yesterday = new Date(`${day!.date}T12:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      await admin()
        .from('site_days')
        .update({ date: yesterday.toISOString().slice(0, 10) })
        .eq('id', report!.site_day_id)
        .throwOnError();

      // The call row as field-api's voice/token makes it for Talk now (LiveKit aside).
      const { data: started } = await admin()
        .rpc('field_talk_now_start', {
          p_reporter_id: reporterId,
          p_site_id: siteId,
          p_device_id: null,
        })
        .throwOnError();
      const { room, callId } = started as { room: string; callId: string };
      const start = await agent('/voice/calls/start', { room, transport: 'web', callId });
      expect(start.status, JSON.stringify(start.json)).toBe(200);
      const token = start.json.callToken as string;
      expect((await agent(`/voice/calls/${callId}/disclosure`, { callId }, token)).status).toBe(
        200,
      );
      const transcript = JSON.parse(
        readFileSync(
          resolve(REPO, 'fixtures', 'transcripts', `${run.callTranscript}.json`),
          'utf8',
        ),
      ) as { segments: Array<{ start: number; end: number; text: string }> };
      const segments = transcript.segments.map(({ start: s, end, text }) => ({
        start: s,
        end,
        text,
      }));
      const drafted = await agent('/voice/tools/update_draft', { callId, segments }, token);
      expect(drafted.status, JSON.stringify(drafted.json)).toBe(200);
      callReportId = drafted.json.reportId as string;
      let draftRev = drafted.json.draftRev as number;
      let filed: Record<string, unknown> = {};
      for (const utterance of run.utterances) {
        const r = await agent(
          '/voice/tools/file_report',
          { callId, reportId: callReportId, draftRev, utterance },
          token,
        );
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        filed = r.json;
        const next = (r.json.draft as { draftRev?: number } | undefined)?.draftRev;
        if (typeof next === 'number') draftRev = next;
      }
      // The verbatim yes files the revision read back (W3-10); the model never decides it.
      expect(filed.status, JSON.stringify(filed)).toBe('filed');
      const ended = await agent(
        '/voice/tools/end_call',
        {
          callId,
          outcome: 'filed',
          dialogLog: run.utterances.map((text, i) => ({ t: i * 10, speaker: 'reporter', text })),
          metrics: {
            latencyP50Ms: null,
            latencyP95Ms: null,
            interruptions: 0,
            sttConfidence: null,
            turns: run.utterances.length,
          },
        },
        token,
      );
      expect(ended.status, JSON.stringify(ended.json)).toBe(200);
      await until('the call’s report filed with its PDF', async () => {
        const { data } = await admin()
          .from('reports')
          .select('status, channel, report_versions(pdf_path)')
          .eq('id', callReportId)
          .single();
        const row = data as {
          status: string;
          channel: string;
          report_versions: Array<{ pdf_path: string | null }>;
        } | null;
        return row?.status === 'filed' && row.report_versions.some((v) => v.pdf_path) ? row : null;
      });
      expect(callReportId).not.toBe(linkReportId);
    });

    test('the panel shows both filed reports to the new customer', async ({ page }) => {
      await signInWithMagicLink(page, email);
      const { data: rows } = await admin()
        .from('reports')
        .select('id, report_no, status, channel')
        .eq('org_id', orgId)
        .order('report_no')
        .throwOnError();
      expect(rows!.map((r) => [r.status, r.channel])).toEqual([
        ['filed', 'web'],
        ['filed', 'voice'],
      ]);
      await page.goto('/reports');
      for (const r of rows!)
        await expect(page.getByText(r.report_no as string).first()).toBeVisible();
      await page.goto(`/reports/${callReportId}`);
      await expect(page.getByText(/^Couldn’t load|^Couldn't load/)).toHaveCount(0);
      await expect(page.getByText(rows![1]!.report_no as string).first()).toBeVisible();
    });
  });
}
