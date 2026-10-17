import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApplyCorrectionResultSchema,
  RecordAnswerResultSchema,
  VoiceDraftStateSchema,
  computeTotals,
  createConsoleSmsTransport,
  isCallConfirm,
  readReportData,
  speakable,
  speakableVoiceAnswer,
  voiceTurnKey,
  type DailyReportData,
  type JobPayloads,
  type JobRow,
  type StoredReportData,
  type VoiceTurnKind,
} from '@sitelog/shared';
import { createFixtureClaude, loadFixtureLibrary, type FakeClaude } from '../ai/fake-claude';
import { FIXTURES_DIR } from '../ai/eval';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import { createMemoryStorage } from '../storage';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { fileReportJob } from './file_report';
import { renderPdf } from './render_pdf';
import { voiceTurnJob } from './voice_turn';

/**
 * W4-07 on PGlite (spec §9.4 "numbers spoken naturally", §16.2 M11 "voice TR"; §19 Q245): Demir
 * Yapı's Kartal report said in Turkish on Talk now calls by Emre Yıldız (§18.2), through the live
 * pipeline with `EXTRACT_PROVIDER=fake` (the TR call cases `fixtures/transcripts/call-kartal-*-tr`):
 *
 * - the hero: crews, a rain stop, code's read-back in Turkish, handed to the agent with every
 *   number in words; "Evet." files it, and its PDF is Turkish, A4, metric;
 * - one question: the rebar crew's headcount, asked in Turkish; "Demirciler altı kişiydi, tam gün
 *   çalıştılar." applies 6 × 8 = 48 saat in code, then the read-back and the yes;
 * - a correction: "Usta Beton beş değil, altı kişiydi." makes 6 × 8 = 48 saat, read back alone.
 *
 * Each recorded TR call (`fixtures/calls/kartal-*-tr`, field-api's answers) matches what the
 * pipeline answers, in the spoken form field-api hands on (`speakableVoiceAnswer`).
 */

let pg: PgliteDatabase;
let EMRE = '';
let KARTAL = '';
let ORG = '';
let fake: FakeClaude;
const storage = createMemoryStorage();

function ctx(): Ctx {
  const config = testConfig({
    LINK_SIGNING_SECRET: 'voice-tr-link-secret',
    FIELD_APP_URL: 'https://go.sitelog.test',
  });
  return {
    config,
    db: pg.db,
    storage,
    ai: { claude: fake, openai: null, transcriber: null },
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => new Date(),
    ),
    log: silentLogger,
    metrics: createMetrics(),
    now: () => new Date(),
  } as unknown as Ctx;
}

interface RecordedCall {
  routes: Record<string, unknown[]>;
  reporterTurns: string[];
  answers?: string[];
  corrections?: string[];
  filing?: Array<{ utterance: string; draftRev: number; answer: string }>;
}

function recordedCall(id: string): RecordedCall {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'calls', `${id}.json`), 'utf8'),
  ) as RecordedCall;
}

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'reportId' && k !== 'draftRev' && k !== 'id')
      .map(([k, v]) => [k, withoutIds(v)]),
  );
}

/** A worker answer as field-api hands it to the agent: its lines in Turkish words (§19 Q245). */
const handedOn = (value: unknown) => withoutIds(speakableVoiceAnswer(value, 'tr'));

function fixtureSegments(id: string): Array<{ start: number; end: number; text: string }> {
  const t = JSON.parse(readFileSync(join(FIXTURES_DIR, 'transcripts', `${id}.json`), 'utf8')) as {
    segments: Array<{ start: number; end: number; text: string }>;
  };
  return t.segments.map(({ start, end, text }) => ({ start, end, text }));
}

/** A Talk now call of Emre's at Kartal (`field_talk_now_start()`'s row: web, inbound, tr-TR). */
async function newCall(started: string): Promise<string> {
  const id = randomUUID();
  await pg.q(
    `insert into calls (id, org_id, reporter_id, site_id, direction, transport, provider_call_id,
                        status, started_at, answered_at, call_token_issued_at, language)
     values ($1, $2, $3, $4, 'inbound', 'web', $5, 'in_progress', $6, $6, $6, 'tr-TR')`,
    [id, ORG, EMRE, KARTAL, `call-${id}`, started],
  );
  return id;
}

async function turn(callId: string, kind: VoiceTurnKind, input: unknown) {
  const key = await voiceTurnKey(kind, input);
  const [row] = await pg.q<{ r: { turnId: string; reportId: string } }>(
    `select voice_turn_submit($1, $2, $3, $4::jsonb) as r`,
    [callId, kind, key, JSON.stringify(input)],
  );
  const { turnId, reportId } = row!.r;
  await voiceTurnJob(ctx(), { turnId, reportId }, {} as JobRow);
  const [t] = await pg.q<{ status: string; result: unknown; error: string | null }>(
    `select status, result, error from voice_turns where id = $1`,
    [turnId],
  );
  return { reportId, ...t! };
}

/** field-api's file_report: code's grammar on the words, then voice_file_report(). */
async function fileOnCall(callId: string, reportId: string, draftRev: number, words: string) {
  const [row] = await pg.q<{ r: { status: string; jobId?: number } }>(
    `select voice_file_report($1, $2, $3, $4, $5) as r`,
    [callId, reportId, draftRev, words, isCallConfirm(words)],
  );
  return row!.r;
}

async function draftOf(reportId: string): Promise<{ data: DailyReportData; rev: number }> {
  const [v] = await pg.q<{ data: StoredReportData; draft_rev: number }>(
    `select v.data, v.draft_rev from report_versions v join reports r on r.id = v.report_id
      where r.id = $1 and v.version = r.current_version`,
    [reportId],
  );
  return { data: readReportData(v!.data), rev: v!.draft_rev };
}

/** Runs the queued jobs of `type` for the report once (the worker's loop, in order). */
async function runQueued<T extends 'file_report' | 'render_pdf'>(type: T, reportId: string) {
  const jobs = await pg.q<{ id: number; payload: JobPayloads[T] }>(
    `select id, payload from jobs where type = $1 and status = 'queued'
        and payload ->> 'reportId' = $2 order by id`,
    [type, reportId],
  );
  for (const j of jobs) {
    if (type === 'file_report')
      await fileReportJob(ctx(), j.payload as JobPayloads['file_report'], {} as JobRow);
    else await renderPdf(ctx(), j.payload as JobPayloads['render_pdf'], {} as JobRow);
    await pg.q(`update jobs set status = 'done' where id = $1`, [j.id]);
  }
  return jobs.length;
}

/** Files the read-back revision on the reporter's words; the report is filed once, via voice. */
async function fileWith(callId: string, reportId: string, words: string) {
  const { rev } = await draftOf(reportId);
  expect(isCallConfirm(words)).toBe(true);
  expect((await fileOnCall(callId, reportId, rev, words)).status).toBe('queued');
  expect(await runQueued('file_report', reportId)).toBe(1);
  expect((await fileOnCall(callId, reportId, rev, words)).status).toBe('filed');
  const [r] = await pg.q<{ status: string; confirmed_via: string; language: string }>(
    `select status::text, confirmed_via::text, language from reports where id = $1`,
    [reportId],
  );
  expect(r).toEqual({ status: 'filed', confirmed_via: 'voice', language: 'tr' });
}

const hasPdftotext = !spawnSync('pdftotext', ['-v']).error;

function pdfText(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'sitelog-tr-call-'));
  try {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, pdf);
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  fake = createFixtureClaude({ lib: loadFixtureLibrary() });
  const [emre] = await pg.q<{ id: string; site_id: string; org_id: string }>(
    `select r.id, sr.site_id, r.org_id from reporters r
       join site_reporters sr on sr.reporter_id = r.id
      where r.phone_e164 = '+905320001203' and sr.is_primary limit 1`,
  );
  EMRE = emre!.id;
  KARTAL = emre!.site_id;
  ORG = emre!.org_id;
});

afterAll(async () => {
  await pg?.close();
});
describe('W4-07: the Kartal call in Turkish (kartal-hero-tr)', () => {
  const recorded = recordedCall('kartal-hero-tr');
  let call = '';
  let reportId = '';

  it("crews and a rain stop: code's read-back in Turkish, handed on with every number in words", async () => {
    call = await newCall('2030-06-07T13:10:00Z');
    const r = await turn(call, 'update_draft', {
      segments: fixtureSegments('call-kartal-2026-10-09-tr'),
    });
    expect(r.status).toBe('done');
    reportId = r.reportId;
    const state = VoiceDraftStateSchema.parse(r.result);
    expect(state.question).toBeNull();
    expect(state.missing).toEqual([]);
    // Code's read-back (§19 Q118), written as the report language writes it …
    expect(state.readBack).toBe(
      'Elimdeki bilgiler: 3 firmadan sahada 12 kişi, toplam 90 saat. Hava nedeniyle 1,5 saat çalışılamadı. ' +
        'Yapılanlar: 3. Kat döşeme betonu dökümü tamamlandı, 2. Kat elektrik tesisatı, 1. Kat kalıp sökümü tamamlandı. ' +
        'Teslimatlar: Kaya Demir firmasından 2 tır inşaat demiri. İş güvenliği konuşması yapıldı. Kaza ya da olay yok. Kaydedeyim mi?',
    );
    // … and as field-api hands it to the agent: every number a word (§19 Q245).
    expect(speakable(state.readBack!, 'tr')).toBe(
      'Elimdeki bilgiler: üç firmadan sahada on iki kişi, toplam doksan saat. Hava nedeniyle bir buçuk saat çalışılamadı. ' +
        'Yapılanlar: üçüncü Kat döşeme betonu dökümü tamamlandı, ikinci Kat elektrik tesisatı, birinci Kat kalıp sökümü tamamlandı. ' +
        'Teslimatlar: Kaya Demir firmasından iki tır inşaat demiri. İş güvenliği konuşması yapıldı. Kaza ya da olay yok. Kaydedeyim mi?',
    );
    expect(handedOn(state)).toEqual(withoutIds(recorded.routes.update_draft![0]));

    const { data } = await draftOf(reportId);
    expect(data).toMatchObject({ reportLanguage: 'tr', units: 'metric' });
    expect(computeTotals(data).totals).toMatchObject({
      crewOnSite: 12,
      companies: 3,
      totalHours: 90,
      lostHours: 1.5,
    });
    expect(
      data.manpower.map((m) => [m.companyName, m.workers, m.hoursPerWorker, m.totalHours]),
    ).toEqual([
      ['Usta Beton', 5, 8, 40],
      ['Volt Elektrik', 3, 8, 24],
      ['Demir Yapı öz ekip', 4, 6.5, 26],
    ]);
    for (const item of [...data.manpower, ...data.workPerformed, data.safety])
      for (const s of item.source) expect(s).toMatchObject({ type: 'call', callId: call });
    expect(fake.phoneLeaks).toEqual([]);
  });

  it('"Evet." files it via voice; the PDF is Turkish, A4 and metric', async () => {
    const step = recorded.filing![0]!;
    expect(step).toEqual({ utterance: 'Evet.', draftRev: 1, answer: 'filed' });
    await fileWith(call, reportId, step.utterance);
    expect(await runQueued('render_pdf', reportId)).toBe(1);
    const [v] = await pg.q<{ pdf_path: string }>(
      `select v.pdf_path from report_versions v join reports r on r.id = v.report_id
        where r.id = $1 and v.version = r.current_version`,
      [reportId],
    );
    const pdf = storage.files.get(`pdfs/${v!.pdf_path}`)!.body;
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    // A4 (595.28 × 841.89 pt): the TR pack's paper (on_org_created(), D32).
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.\d+ 841\.\d+\]/);
    // pdftotext comes with poppler-utils, which CI installs; a machine without it skips the text.
    if (hasPdftotext || process.env.CI) {
      const flat = pdfText(pdf).replace(/\s+/g, ' ');
      expect(flat).toContain('GÜNLÜK ŞANTİYE RAPORU');
      expect(flat).toContain('ŞANTİYEDEKİ İŞGÜCÜ');
      expect(flat).toContain('Toplam · 3 firma 12 90 sa');
      expect(flat).toContain('Yağmur · 1,5 sa kayıp');
      expect(flat).toContain('Döşeme betonu dökümü — yaklaşık 45 m³');
      expect(flat).toContain('Şantiye şefi raporu görüşmede sesli olarak onayladı');
      expect(flat).not.toMatch(/Daily Site Report|DAILY SITE REPORT|WhatsApp/);
    }
  });
});

describe('W4-07: one question in Turkish (kartal-question-tr)', () => {
  const recorded = recordedCall('kartal-question-tr');

  it('asks for Akış Mekanik in Turkish; "Altı kişi, tam gün." applies 6 × 8 = 48 saat; "Evet, kaydedin." files', async () => {
    const call = await newCall('2030-06-08T13:10:00Z');
    const draft = await turn(call, 'update_draft', {
      segments: fixtureSegments('call-kartal-2026-10-08-tr'),
    });
    const state = VoiceDraftStateSchema.parse(draft.result);
    expect(state.question?.text).toBe(
      'Kısa bir soru: Akış Mekanik ikinci katta kaç kişiydi, tam gün mü çalıştılar?',
    );
    expect(state.missing).toEqual(['manpower.workers:Akış Mekanik', 'manpower.hours:Akış Mekanik']);
    expect(handedOn(state)).toEqual(withoutIds(recorded.routes.update_draft![0]));

    const [words] = recorded.answers!;
    const answer = await turn(call, 'record_answer', {
      questionId: state.question!.id,
      utterance: words,
      start: 44.5,
      end: 47.8,
    });
    const result = RecordAnswerResultSchema.parse(answer.result);
    expect(result.status).toBe('applied');
    // F7's confirmation from code's numbers, said in words.
    expect(result.confirmation).toBe('Akış Mekanik: 6 kişi, kişi başı 8 saat — toplam 48 saat.');
    expect(speakable(result.confirmation!, 'tr')).toBe(
      'Akış Mekanik: altı kişi, kişi başı sekiz saat — toplam kırk sekiz saat.',
    );
    expect(handedOn(result)).toEqual(withoutIds(recorded.routes.record_answer![0]));
    const { data } = await draftOf(draft.reportId);
    const akis = data.manpower.find((m) => m.companyName === 'Akış Mekanik')!;
    expect([akis.workers, akis.hoursPerWorker, akis.totalHours]).toEqual([6, 8, 48]);
    expect(computeTotals(data).totals).toMatchObject({ crewOnSite: 12, totalHours: 96 });

    await fileWith(call, draft.reportId, recorded.filing![0]!.utterance);
  });
});

describe('W4-07: a correction in Turkish (kartal-fix-tr)', () => {
  const recorded = recordedCall('kartal-fix-tr');

  it('"Usta Beton beş değil, altı kişiydi." makes 6 × 8 = 48 saat, read back alone, then filed', async () => {
    const call = await newCall('2030-06-09T13:10:00Z');
    const draft = await turn(call, 'update_draft', {
      segments: fixtureSegments('call-kartal-2026-10-09-tr'),
    });
    expect(handedOn(VoiceDraftStateSchema.parse(draft.result))).toEqual(
      withoutIds(recorded.routes.update_draft![0]),
    );
    const fix = await turn(call, 'apply_correction', {
      utterance: recorded.corrections![0],
      start: 70.5,
      end: 73,
    });
    expect(fix.status).toBe('done');
    const result = ApplyCorrectionResultSchema.parse(fix.result);
    expect(result.readBack).toBe(
      'Usta Beton: 6 kişi, kişi başı 8 saat — toplam 48 saat. Kaydedeyim mi?',
    );
    expect(handedOn(result)).toEqual(withoutIds(recorded.routes.apply_correction![0]));
    const { data, rev } = await draftOf(draft.reportId);
    expect(result.draft!.draftRev).toBe(rev);
    const usta = data.manpower.find((m) => m.companyName === 'Usta Beton')!;
    expect([usta.workers, usta.hoursPerWorker, usta.totalHours]).toEqual([6, 8, 48]);
    expect(usta.source).toContainEqual({ type: 'call', callId: call, start: 70.5, end: 73 });
    expect(computeTotals(data).totals).toMatchObject({ crewOnSite: 13, totalHours: 98 });

    const step = recorded.filing![0]!;
    expect(step.draftRev).toBe(rev);
    await fileWith(call, draft.reportId, step.utterance);
  });
});
