import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEVER_ABORTED } from '../abort';
import { createFakeTranscriber, fakeAudio } from '../ai/fake-transcriber';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { createMemoryStorage } from '../storage';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { retentionCleanup } from './retention_cleanup';
import { deleteTestClipJob, testSnippet, transcribeTestClipJob } from './test_clip';

/**
 * W2-13 (F4 step 3, spec §19 Q52) on PGlite: the Welcome screen's test recording as field-api
 * makes it (field_test_clip_create(), field_test_clip_complete()), then the worker's
 * transcribe_test_clip with the fake transcriber (fixtures/voice, kind `test`): the snippet is
 * read once (field_test_clip_read()) and then gone, the file is deleted as soon as it is
 * transcribed, and nothing is left behind: no upload, no transcript, no report. The 10-minute
 * delete job and the retention backstop remove a clip nobody read. Independent of the date.
 */

let pg: PgliteDatabase;
let MARCO = '';
let ORG = '';
const storage = createMemoryStorage();
const transcriber = createFakeTranscriber();

function ctx(attempts = 1): { ctx: Ctx; job: { attempts: number } } {
  return {
    ctx: {
      config: testConfig(),
      db: pg.db,
      storage,
      ai: { claude: null, openai: null, transcriber },
      log: silentLogger,
      metrics: createMetrics(),
      now: () => new Date(),
      signal: NEVER_ABORTED,
    } as unknown as Ctx,
    job: { attempts },
  };
}

async function newClip(opts: { file?: boolean; fixture?: string } = {}) {
  const id = randomUUID();
  const path = `test/${ORG}/${id}.webm`;
  await pg.q(`select field_test_clip_create($1, $2, null, $3, 'audio/webm', 10)`, [
    id,
    MARCO,
    path,
  ]);
  if (opts.file !== false)
    await storage.upload(
      'audio',
      path,
      fakeAudio(opts.fixture ?? 'test-es-en-check', 3),
      'audio/webm',
    );
  const [done] = await pg.q<{ r: { status: string; jobId: number } }>(
    `select field_test_clip_complete($1, $2, 10) as r`,
    [id, MARCO],
  );
  return { id, path, completed: done!.r };
}

const read = async (id: string) =>
  (
    await pg.q<{ r: { status: string; snippet: string | null } }>(
      `select field_test_clip_read($1, $2) as r`,
      [id, MARCO],
    )
  )[0]!.r;

const counts = async () =>
  (
    await pg.q<{ uploads: number; transcripts: number; reports: number }>(
      `select (select count(*)::int from uploads) as uploads,
              (select count(*)::int from transcripts) as transcripts,
              (select count(*)::int from reports) as reports`,
    )
  )[0]!;

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [m] = await pg.q<{ id: string; org_id: string }>(
    `select id, org_id from reporters where name = 'Marco Ruiz'`,
  );
  MARCO = m!.id;
  ORG = m!.org_id;
  // The recording consent covers the test (F4: after the consents).
  await pg.q(
    `insert into consents (reporter_id, type, method, text_version)
     select $1, 'recording', 'web_checkbox', 'field.consent.v1'
     where not exists (select 1 from consents where reporter_id = $1 and type = 'recording'
                         and revoked_at is null)`,
    [MARCO],
  );
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe('W2-13: the test recording (F4)', () => {
  it('shows the fake transcript once and leaves no upload, transcript or report behind', async () => {
    const before = await counts();
    const clip = await newClip();
    expect(clip.completed.status).toBe('pending');
    const [jobs] = await pg.q<{ keys: string[] }>(
      `select array_agg(dedupe_key order by id) as keys from jobs where payload ->> 'testClipId' = $1`,
      [clip.id],
    );
    expect(jobs!.keys).toEqual([`test_clip:${clip.id}:delete`, `test_clip:${clip.id}`]);
    expect(await read(clip.id)).toEqual({ status: 'pending', snippet: null });

    const run = ctx();
    await transcribeTestClipJob(run.ctx, { testClipId: clip.id }, run.job as never);
    // The file goes as soon as it is transcribed.
    expect(storage.files.has(`audio/${clip.path}`)).toBe(false);
    expect(await read(clip.id)).toEqual({
      status: 'heard',
      snippet: 'Testing, uno, dos, tres. ¿Me oyes bien?',
    });
    // Read once: the words are gone.
    expect(await read(clip.id)).toEqual({ status: 'gone', snippet: null });
    const [row] = await pg.q<{ snippet: string | null; deleted_at: string | null }>(
      `select snippet, deleted_at from test_clips where id = $1`,
      [clip.id],
    );
    expect(row).toMatchObject({ snippet: null });
    expect(row!.deleted_at).not.toBeNull();
    expect(await counts()).toEqual(before);
    const audits = await pg.q<{ action: string }>(
      `select action from audit_log where entity = 'test_clip' and entity_id = $1 order by id`,
      [clip.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'test_clip.created',
      'test_clip.transcribed',
      'test_clip.deleted',
    ]);
    // A retried transcription changes nothing; the 10-minute job finds it deleted.
    await transcribeTestClipJob(run.ctx, { testClipId: clip.id }, run.job as never);
    await deleteTestClipJob(run.ctx, { testClipId: clip.id }, run.job as never);
    expect(
      await pg.q(`select 1 from audit_log where entity_id = $1 and action = 'test_clip.deleted'`, [
        clip.id,
      ]),
    ).toHaveLength(1);
  });

  it('the Turkish clip is heard in Turkish; a clip with no file fails on the last attempt', async () => {
    await pg.q(`update reporters set locale = 'tr-TR', languages = '{tr}' where id = $1`, [MARCO]);
    try {
      const tr = await newClip({ fixture: 'test-tr-check' });
      const run = ctx();
      await transcribeTestClipJob(run.ctx, { testClipId: tr.id }, run.job as never);
      expect((await read(tr.id)).snippet).toBe('Deneme, bir, iki, üç. Beni duyuyor musunuz?');
    } finally {
      await pg.q(`update reporters set locale = 'en-US', languages = '{es,en}' where id = $1`, [
        MARCO,
      ]);
    }
    const lost = await newClip({ file: false });
    await expect(
      transcribeTestClipJob(ctx(1).ctx, { testClipId: lost.id }, { attempts: 1 } as never),
    ).rejects.toThrow();
    await transcribeTestClipJob(ctx().ctx, { testClipId: lost.id }, { attempts: 6 } as never);
    expect(await read(lost.id)).toEqual({ status: 'failed', snippet: null });
  });

  it('a clip nobody read goes after 10 minutes: the delete job, else the retention backstop', async () => {
    const a = await newClip();
    await deleteTestClipJob(ctx().ctx, { testClipId: a.id }, {} as never);
    expect(storage.files.has(`audio/${a.path}`)).toBe(false);
    expect(await read(a.id)).toEqual({ status: 'gone', snippet: null });

    const b = await newClip();
    await pg.q(`update test_clips set created_at = now() - interval '11 minutes' where id = $1`, [
      b.id,
    ]);
    const fresh = await newClip();
    await retentionCleanup(ctx().ctx, {}, {} as never);
    expect(storage.files.has(`audio/${b.path}`)).toBe(false);
    expect(await read(b.id)).toEqual({ status: 'gone', snippet: null });
    // A clip younger than 10 minutes stays for its own job.
    expect(storage.files.has(`audio/${fresh.path}`)).toBe(true);
  });

  it('a file whose removal failed after transcription goes with the delete job or the backstop', async () => {
    const failing = (): Ctx => {
      const c = ctx().ctx;
      return {
        ...c,
        storage: {
          ...storage,
          remove: () => Promise.reject(new Error('storage 503')),
        },
      } as Ctx;
    };
    for (const via of ['delete job', 'retention'] as const) {
      const clip = await newClip();
      // Transcribed, but the file stays (a transient storage error), and the snippet is read.
      await transcribeTestClipJob(failing(), { testClipId: clip.id }, { attempts: 1 } as never);
      expect(storage.files.has(`audio/${clip.path}`)).toBe(true);
      expect((await read(clip.id)).status).toBe('heard');
      expect(await read(clip.id)).toEqual({ status: 'gone', snippet: null });
      if (via === 'delete job') {
        await deleteTestClipJob(ctx().ctx, { testClipId: clip.id }, {} as never);
      } else {
        await pg.q(
          `update test_clips set created_at = now() - interval '11 minutes' where id = $1`,
          [clip.id],
        );
        await retentionCleanup(ctx().ctx, {}, {} as never);
      }
      expect(storage.files.has(`audio/${clip.path}`), via).toBe(false);
      // Deleted once: the read's audit row only.
      expect(
        await pg.q(
          `select 1 from audit_log where entity_id = $1 and action = 'test_clip.deleted'`,
          [clip.id],
        ),
      ).toHaveLength(1);
    }
  });

  it('needs the recording consent; one line of at most 160 characters', async () => {
    await pg.q(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'recording'`,
      [MARCO],
    );
    try {
      await expect(
        pg.q(`select field_test_clip_create($1, $2, null, 'test/x.webm', 'audio/webm', 1)`, [
          randomUUID(),
          MARCO,
        ]),
      ).rejects.toThrow(/consent_required/);
    } finally {
      await pg.q(
        `insert into consents (reporter_id, type, method, text_version)
         values ($1, 'recording', 'web_checkbox', 'field.consent.v1')`,
        [MARCO],
      );
    }
    expect(testSnippet('  a\n b  ')).toBe('a b');
    const long = testSnippet('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });
});
