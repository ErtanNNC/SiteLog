import { NEVER_ABORTED } from '../abort';
import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { Sql } from 'postgres';
import { createConsoleSmsTransport } from '@sitelog/shared';
import { testConfig, type Config } from '../config';
import { createMetrics, type Ctx } from '../context';
import type { Db } from '../db';
import { createFakeTranscriber as createFixtureTranscriber } from '../ai/fake-transcriber';
import type { Transcriber } from '../ai/transcriber';
import { loadVoiceFixtures } from '../ai/voice-fixtures';
import { createWorkerNotifier } from '../messaging';
import { createMemoryProvider, type EmailMessage } from '../email/provider';
import { silentLogger, type Logger } from '../log';
import { createRunner, type Runner, type RunnerOptions } from '../runner';
import { createMemoryStorage } from '../storage';
import { createFakeWaClient } from '../wa/client';
import {
  createFakeClaude,
  createFakeFfmpeg,
  createFakeTranscriber,
  FAKE_PHOTO,
  fakeAudio,
  sleep,
  withSimEmail,
  withSimStorage,
  withSimWa,
  type Clock,
  type FakeClaude,
  type FakeClaudeOptions,
  type FakeTranscriber,
  type FixtureLibrary,
  type Sim,
  type SimWaClient,
} from './fakes';
import {
  deliverSigned,
  type DeliverOptions,
  type MetaPayload,
  type WebhookResult,
} from './webhook';

/**
 * A worker Ctx on a real database (the production postgres.js repository) with the outside world
 * faked (./fakes), plus the webhook (./webhook) to feed it. Shared by the integration test and the
 * load test.
 */

export const APP_SECRET = 'integration-app-secret';

export interface World {
  ctx: Ctx;
  db: Db;
  sql: Sql;
  clock: Clock;
  sim: Sim;
  lib: FixtureLibrary;
  wa: SimWaClient;
  claude: FakeClaude;
  transcriber: FakeTranscriber;
  emails: EmailMessage[];
  storage: ReturnType<typeof createMemoryStorage>;
  /** Make a voice note of a golden case downloadable under `mediaId`. */
  registerVoiceNote(mediaId: string, fixtureId: string, durationS?: number): void;
  /** Make a photo downloadable under `mediaId` (a 1×1 PNG). */
  registerPhoto(mediaId: string): void;
  /**
   * The web recorder's transcriber (W1-11, `ctx.ai.transcriber`): the fixtures/voice fake unless
   * the world was given another (a Deepgram transcriber on a mocked fetch).
   */
  fieldTranscriber: Transcriber;
  /**
   * The field-upload entry point (W1-11): a voice note of fixtures/voice as field-api stores it
   * (the file in the `audio` bucket at `{org}/{site}/{date}/{upload}.{ext}`, the `uploads` row),
   * then `field_complete_upload()` (the report, its voice_note source, the `transcribe_upload`
   * job), as `uploads/:id/complete` does.
   */
  uploadVoiceNote(opts: FieldUploadOptions): Promise<FieldUpload>;
  /** Sign + POST a Meta payload through the webhook; messages.created_at = clock time. */
  deliver(
    payload: MetaPayload | string,
    opts?: DeliverOptions & { signWith?: string },
  ): Promise<WebhookResult>;
  /** A runner on this world (the real createRunner). */
  runner(opts?: Partial<RunnerOptions>): Runner;
}

export interface FieldUploadOptions {
  reporterId: string;
  siteId: string;
  /** A fixtures/voice id. */
  fixtureId: string;
  /** The site-day (`YYYY-MM-DD`). */
  date: string;
  mime?: string;
  /** Default: the fixture's duration. */
  durationS?: number;
}

export interface FieldUpload {
  uploadId: string;
  reportId: string;
  jobId: number | null;
  storagePath: string;
  created: boolean;
}

export interface WorldOptions {
  db: Db;
  sql: Sql;
  clock: Clock;
  sim: Sim;
  lib: FixtureLibrary;
  claude?: Omit<FakeClaudeOptions, 'lib' | 'sim'>;
  config?: Partial<Config>;
  log?: Logger;
  /** The web recorder's transcriber; default the fixtures/voice fake. */
  fieldTranscriber?: Transcriber;
}

export function createWorld(opts: WorldOptions): World {
  const { db, sql, clock, sim, lib } = opts;
  const inner = createFakeWaClient();
  const wa = withSimWa(inner, sim, clock);
  const storage = createMemoryStorage();
  const email = createMemoryProvider();
  const claude = createFakeClaude({ lib, sim, ...opts.claude });
  const transcriber = createFakeTranscriber(lib, sim);
  const fieldTranscriber = opts.fieldTranscriber ?? createFixtureTranscriber();
  // The texts with a personal link (W1-12's question and draft, W1-15's `filed`) need both.
  const config = testConfig({
    LINK_SIGNING_SECRET: 'integration-link-secret',
    FIELD_APP_URL: 'https://go.sitelog.test',
    ...opts.config,
  });
  const ctx: Ctx = {
    config,
    db,
    wa,
    storage: withSimStorage(storage, sim),
    ai: { claude, openai: transcriber as unknown as OpenAI, transcriber: fieldTranscriber },
    email: withSimEmail(email, sim),
    // Console only: the simulated world never reaches an SMS provider.
    notifier: createWorkerNotifier(config, db, () => createConsoleSmsTransport(() => randomUUID())),
    ffmpeg: createFakeFfmpeg(),
    log: opts.log ?? silentLogger,
    now: () => clock.now(),
    metrics: createMetrics(),
    signal: NEVER_ABORTED,
  };
  return {
    ctx,
    db,
    sql,
    clock,
    sim,
    lib,
    wa,
    claude,
    transcriber,
    emails: email.sent,
    storage,
    registerVoiceNote(mediaId, fixtureId, durationS) {
      const c = lib.get(fixtureId);
      inner.media.set(mediaId, {
        buffer: fakeAudio(fixtureId, durationS ?? c.durationS),
        mime: 'audio/ogg; codecs=opus',
        sha256: null,
      });
    },
    registerPhoto(mediaId) {
      inner.media.set(mediaId, { buffer: FAKE_PHOTO, mime: 'image/png', sha256: null });
    },
    fieldTranscriber,
    async uploadVoiceNote(u) {
      const fixture = loadVoiceFixtures().find((f) => f.id === u.fixtureId);
      if (!fixture) throw new Error(`fixtures/voice has no ${u.fixtureId}`);
      const mime = u.mime ?? fixture.mime;
      const [site] = await sql<
        Array<{ org_id: string }>
      >`select org_id from sites where id = ${u.siteId}`;
      if (!site) throw new Error(`site ${u.siteId} not found`);
      const uploadId = randomUUID();
      const storagePath = `${site.org_id}/${u.siteId}/${u.date}/${uploadId}.${mime.includes('mp4') ? 'm4a' : 'webm'}`;
      const body = fakeAudio(fixture.id, u.durationS ?? fixture.durationS);
      await storage.upload('audio', storagePath, body, mime);
      await sql`insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at)
        values (${uploadId}, ${u.reporterId}, ${u.siteId}, 'audio', ${storagePath}, ${mime}, ${clock.now().toISOString()})`;
      const [res] = await sql<
        Array<{ r: { reportId: string; jobId: number | null; created: boolean } }>
      >`
        select field_complete_upload(${uploadId}, ${u.reporterId}, ${body.length}) as r`;
      return {
        uploadId,
        reportId: res!.r.reportId,
        jobId: res!.r.jobId,
        storagePath,
        created: res!.r.created,
      };
    },
    deliver(payload, dopts = {}) {
      return deliverSigned(sql, payload, APP_SECRET, { receivedAt: clock.now(), ...dopts });
    },
    runner(ropts = {}) {
      return createRunner(ctx, {
        concurrency: 1,
        pollIntervalMs: 5,
        // The timeout sweep compares DB timestamps (wall clock) with ctx.now(); keep it off unless asked.
        sweepIntervalMs: 24 * 3600_000,
        jobTimeoutMs: 60_000,
        workerId: 'integration',
        ...ropts,
      });
    },
  };
}

/**
 * Run every due job through `runner.tick()` (claim_jobs → runJob) until the queue has nothing
 * claimable and nothing in flight. With concurrency 1 the order is the queue order (run_after, id).
 */
export async function drainQueue(runner: Runner, maxJobs = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await runner.tick();
    total += n;
    while (runner.active > 0) await sleep(1);
    if (n === 0) return total;
    if (total > maxJobs) throw new Error(`drainQueue: more than ${maxJobs} jobs; a job loop?`);
  }
}
