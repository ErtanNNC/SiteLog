import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  emptyReportData,
  addDays,
  isoWeekday,
  toObservedIn,
  type DailyReportData,
  type JobRow,
  type ReportLanguage,
  type SiteDayWeather,
  type UnitSystem,
} from '@sitelog/shared';
import { samplePng } from '@sitelog/pdf/sample-data.ts';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { buildEvidencePackInput } from '../pdf/render';
import { createMemoryStorage } from '../storage';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { buildEvidencePack } from './build_evidence_pack';

/**
 * W3-07 (F20, P9, spec §19 Q134, §16.2 M9 "Riverside October EOT pack builds in < 2 min") on
 * PGlite with every migration and the §18 seed: a month of weather days generated for Riverside
 * (Kestrel, EN, Letter, imperial) and for Kartal (Demir Yapı, TR, A4, metric), each day a voice
 * note confirmed on the recorder, a call confirmed by voice, or a voice note filed after the 2 h
 * timeout; then `build_evidence_pack` through the production Db: one stored file per pack id, the
 * included sections honoured, excerpts from the cited clip (a call's reporter lane only), each
 * day's confirmation, and the October pack built inside the M9 budget.
 */

/** §16.2 M9: the Riverside October pack builds in under 2 minutes. */
const PACK_BUDGET_MS = 2 * 60_000;

let pg: PgliteDatabase;
const storage = createMemoryStorage();
const now = new Date('2026-11-02T15:00:00Z');

/** The build_evidence_pack job, as the runner calls it. */
function build(c: Ctx, packId: string): Promise<void> {
  return buildEvidencePack(c, { packId }, { id: 1, type: 'build_evidence_pack' } as JobRow);
}

function ctx(): Ctx {
  return {
    config: testConfig(),
    db: pg.db,
    storage,
    log: silentLogger,
    metrics: createMetrics(),
    now: () => now,
  } as unknown as Ctx;
}

interface SiteRef {
  id: string;
  org: string;
  code: string;
  tz: string;
  reporter: string;
  language: ReportLanguage;
  units: UnitSystem;
}

async function siteByCode(code: string): Promise<SiteRef> {
  const [s] = await pg.q<{
    id: string;
    org_id: string;
    timezone: string;
    reporter_id: string;
    locale: string;
    units: UnitSystem;
  }>(
    `select s.id, s.org_id, s.timezone, sr.reporter_id, o.locale, o.units
     from sites s join orgs o on o.id = s.org_id
     join site_reporters sr on sr.site_id = s.id and sr.is_primary
     where s.project_code = $1`,
    [code],
  );
  return {
    id: s!.id,
    org: s!.org_id,
    code,
    tz: s!.timezone,
    reporter: s!.reporter_id,
    language: s!.locale.startsWith('tr') ? 'tr' : 'en',
    units: s!.units,
  };
}

/** Open-Meteo's hours for a rainy morning, as fetch_weather stores them (imperial). */
function observed(date: string): SiteDayWeather {
  return {
    date,
    provider: 'Open-Meteo',
    fetchedAt: `${date}T23:30:00Z`,
    units: { precip: 'in', temp: 'F', wind: 'mph' },
    hours: Array.from({ length: 24 }, (_, h) => ({
      time: `${String(h).padStart(2, '0')}:00`,
      precipIn: h >= 7 && h <= 9 ? 0.12 : 0,
      tempF: 55,
      windMph: 10,
      gustMph: 18,
    })),
    summary: {
      precipIn: 0.36,
      tempMinF: 55,
      tempMaxF: 55,
      windMph: 10,
      gustMph: 18,
      provider: 'Open-Meteo',
      precipWorkingHoursIn: 0.36,
      maxGustWorkingHoursMph: 18,
    },
  };
}

type DayMode = 'recorder' | 'call' | 'timeout';

interface GeneratedDay {
  date: string;
  reportId: string;
  mode: DayMode;
  clipId: string;
}

/**
 * Every weekday of `month` without a report at the site becomes a filed weather day: rain
 * 07:00–10:00, 3 h lost, a photo, observed weather; the voice evidence and confirmation rotate
 * through the recorder, a call and the 2 h timeout. Written as the writers write them (the
 * version through denormalize_report_version()).
 */
async function generateMonth(site: SiteRef, month: string): Promise<GeneratedDay[]> {
  const out: GeneratedDay[] = [];
  let date = `${month}-01`;
  let n = 0;
  while (date.startsWith(month)) {
    const today = date;
    date = addDays(date, 1);
    if (isoWeekday(today) > 5) continue;
    const [taken] = await pg.q<{ n: number }>(
      `select count(*)::int as n from reports r join site_days sd on sd.id = r.site_day_id
       where r.site_id = $1 and sd.date = $2`,
      [site.id, today],
    );
    if (taken!.n > 0) continue;
    const mode: DayMode = (['recorder', 'call', 'timeout'] as const)[n % 3]!;
    n += 1;
    const [day] = await pg.q<{ id: string }>(
      `insert into site_days (site_id, date, deadline_at, status, weather)
       values ($1, $2, ($2::date + time '23:00') at time zone $3, 'filed', $4)
       on conflict (site_id, date) do update set status = 'filed', weather = excluded.weather
       returning id`,
      [site.id, today, site.tz, JSON.stringify(observed(today))],
    );
    const filedAt = `${today}T22:30:00Z`;
    const [report] = await pg.q<{ id: string }>(
      `insert into reports (org_id, site_id, site_day_id, report_no, status, current_version,
         reporter_id, received_at, filed_at, confirmed_at, confirmed_via, channel, language,
         needs_review, review_reasons, kind)
       values ($1, $2, $3, $4, 'filed', 1, $5, $6, $6, $7, $8, $9, $10, $11, $12, 'daily')
       returning id`,
      [
        site.org,
        site.id,
        day!.id,
        `${site.code}-9${String(n).padStart(3, '0')}`,
        site.reporter,
        filedAt,
        mode === 'timeout' ? null : filedAt,
        mode === 'recorder' ? 'web' : mode === 'call' ? 'voice' : null,
        mode === 'call' ? 'voice' : 'web',
        site.language,
        mode === 'timeout',
        mode === 'timeout' ? ['unconfirmed'] : [],
      ],
    );
    const reportId = report!.id;
    await pg.q(`update site_days set report_id = $1 where id = $2`, [reportId, day!.id]);

    // The voice evidence: a recorder voice note, or a call with a reporter and an agent lane.
    const clipId = randomUUID();
    const rain =
      site.language === 'tr'
        ? 'sabah yediden ona kadar yağmur yağdı, dış cephe durdu'
        : 'rain from seven to ten, we stopped the facade';
    if (mode === 'call') {
      await pg.q(
        `insert into calls (id, org_id, reporter_id, site_id, report_id, direction, status,
           outcome, started_at, answered_at, ended_at, duration_s)
         values ($1, $2, $3, $4, $5, 'inbound', 'completed', 'filed', $6, $6, $6, 180)`,
        [clipId, site.org, site.reporter, site.id, reportId, filedAt],
      );
      await pg.q(
        `insert into transcripts (call_id, language, text, segments) values ($1, $2, $3, $4)`,
        [
          clipId,
          site.language,
          rain,
          JSON.stringify([
            { start: 120, end: 128, text: 'Any weather today?', speaker: 'agent' },
            { start: 130, end: 140, text: rain, speaker: 'reporter' },
            { start: 140, end: 146, text: 'Got it, three hours lost.', speaker: 'agent' },
          ]),
        ],
      );
      await pg.q(`insert into report_sources (report_id, kind, call_id) values ($1, 'call', $2)`, [
        reportId,
        clipId,
      ]);
    } else {
      await pg.q(
        `insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path, mime,
           duration_s, received_at)
         values ($1, $2, $3, $4, 'audio', $5, 'audio/webm', 60, $6)`,
        [clipId, reportId, site.reporter, site.id, `${site.org}/${clipId}.webm`, filedAt],
      );
      await pg.q(
        `insert into transcripts (upload_id, language, text, segments) values ($1, $2, $3, $4)`,
        [
          clipId,
          site.language,
          `crew of eight. ${rain}`,
          JSON.stringify([
            { start: 0, end: 8, text: 'crew of eight on level two' },
            { start: 8, end: 16, text: rain },
          ]),
        ],
      );
      await pg.q(
        `insert into report_sources (report_id, kind, upload_id) values ($1, 'voice_note', $2)`,
        [reportId, clipId],
      );
    }
    // One photo, stored, so the pack embeds it.
    const photoId = randomUUID();
    const photoPath = `${site.org}/${site.id}/${today}/${photoId}.png`;
    await pg.q(
      `insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path, mime, received_at)
       values ($1, $2, $3, $4, 'photo', $5, 'image/png', $6)`,
      [photoId, reportId, site.reporter, site.id, photoPath, filedAt],
    );
    await pg.q(`insert into report_sources (report_id, kind, upload_id) values ($1, 'photo', $2)`, [
      reportId,
      photoId,
    ]);
    await storage.upload('photos', photoPath, Buffer.from(samplePng), 'image/png');

    const data: DailyReportData = {
      ...emptyReportData(today, { reportLanguage: site.language, units: site.units }),
      summary: site.language === 'tr' ? 'Yağmur nedeniyle 3 saat kayıp.' : 'Rain cost 3 hours.',
      weather: {
        observed: toObservedIn(observed(today), site.units),
        conditionsText: site.language === 'tr' ? 'Sabah yağmurlu' : 'Rain AM',
        periods: [
          {
            start: '07:00',
            end: '10:00',
            condition: site.language === 'tr' ? 'Yağmur' : 'Rain',
            lostHours: 3,
            source:
              mode === 'call'
                ? [{ type: 'call', callId: clipId, start: 132 }]
                : [{ type: 'voice_note', uploadId: clipId, start: 9 }],
          },
        ],
      },
      photos: [{ uploadId: photoId, takenAt: filedAt }],
    };
    await pg.q(
      `insert into report_versions (report_id, version, data, author) values ($1, 1, $2, 'agent')`,
      [reportId, JSON.stringify(data)],
    );
    await pg.q(`select denormalize_report_version($1, 1)`, [reportId]);
    out.push({ date: today, reportId, mode, clipId });
  }
  return out;
}

async function newPack(site: SiteRef, sections: string[]): Promise<string> {
  const [p] = await pg.q<{ id: string }>(
    `insert into evidence_packs (org_id, site_id, period_start, period_end, status, sections)
     values ($1, $2, '2026-10-01', '2026-10-31', 'queued', $3) returning id`,
    [site.org, site.id, sections],
  );
  return p!.id;
}

async function packRow(id: string) {
  const [p] = await pg.q<{ status: string; pdf_path: string | null; error: string | null }>(
    `select status::text, pdf_path, error from evidence_packs where id = $1`,
    [id],
  );
  return p!;
}

let riverside: SiteRef;
let kartal: SiteRef;
let riversideDays: GeneratedDay[];
let kartalDays: GeneratedDay[];

beforeAll(async () => {
  pg = await startPgliteDatabase();
  riverside = await siteByCode('RL-2041');
  kartal = await siteByCode('KK-1203');
  riversideDays = await generateMonth(riverside, '2026-10');
  kartalDays = await generateMonth(kartal, '2026-10');
}, 240_000);

afterAll(async () => {
  await pg?.close();
});

describe('build_evidence_pack on PGlite (W3-07)', () => {
  it('builds Riverside’s October pack within the M9 budget, one file per pack id', async () => {
    const all = ['summary', 'reports', 'transcripts', 'photos', 'weather'];
    const first = await newPack(riverside, all);
    const job = ctx();
    const t0 = performance.now();
    await build(job, first);
    const ms = performance.now() - t0;
    console.info(`W3-07 metric: Riverside October pack built in ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(PACK_BUDGET_MS);
    // The job records its build time and size in its metrics (jobs.payload.metrics).
    const metrics = job.metrics.snapshot();
    expect(metrics.packBuildMs).toBeLessThan(PACK_BUDGET_MS);
    expect(metrics.packDays).toBeGreaterThanOrEqual(riversideDays.length);
    const row = await packRow(first);
    expect(row).toMatchObject({ status: 'ready', error: null });
    expect(row.pdf_path).toMatch(
      new RegExp(`^${riverside.org}/${riverside.id}/eot_2026-10-01_2026-10-31_${first}\\.pdf$`),
    );
    const pdf = await storage.download('exports', row.pdf_path!);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');

    // A rebuild of the same site and period is another file: the first pack stays as sent.
    const second = await newPack(riverside, all);
    await build(ctx(), second);
    const again = await packRow(second);
    expect(again.pdf_path).not.toBe(row.pdf_path);
    expect((await storage.download('exports', row.pdf_path!)).equals(pdf)).toBe(true);
  }, 180_000);

  it('cites each day’s own clip, a call’s reporter lane only, and states the confirmation', async () => {
    const packId = await newPack(riverside, ['summary', 'transcripts']);
    const site = (await pg.db.siteContext(riverside.id))!;
    const pack = (await pg.db.getEvidencePack(packId))!;
    const input = await buildEvidencePackInput(ctx(), pack, site);
    expect(input).toMatchObject({
      language: 'en',
      units: 'imperial',
      settings: { paper: 'letter' },
    });
    expect(input.sections).toEqual(['summary', 'transcripts']);
    const byDate = new Map(input.days.map((d) => [d.date, d]));
    for (const g of riversideDays) {
      const d = byDate.get(g.date)!;
      expect(d, g.date).toBeDefined();
      expect(d.photos, 'photos not loaded without the Photos section').toEqual([]);
      expect(d.photoCount).toBe(1);
      expect(d.observed).not.toBeNull();
      if (g.mode === 'call') {
        expect(d.confirmation).toBe('call');
        expect(d.transcriptExcerpts).toEqual([
          {
            clip: 'call',
            clipNo: null,
            start: 130,
            end: 140,
            text: 'rain from seven to ten, we stopped the facade',
          },
        ]);
        expect(d.claimReady).toBe(true);
      } else {
        expect(d.transcriptExcerpts.map((e) => [e.clip, e.text])).toEqual([
          ['voice_note', 'crew of eight on level two'],
          ['voice_note', 'rain from seven to ten, we stopped the facade'],
        ]);
        // §19 Q134: a day filed without confirmation is in the pack, not claim-ready until
        // signed off.
        expect(d.confirmation).toBe(g.mode === 'recorder' ? 'recorder' : 'unconfirmed');
        expect(d.claimReady).toBe(g.mode === 'recorder');
      }
    }
    // The delay record of a call-sourced period carries the call (20261016000280).
    const call = riversideDays.find((g) => g.mode === 'call')!;
    const [wx] = await pg.q<{
      audio_source: { type: string; callId: string };
      claim_ready: boolean;
    }>(`select audio_source, claim_ready from weather_events where report_id = $1`, [
      call.reportId,
    ]);
    expect(wx).toMatchObject({
      audio_source: { type: 'call', callId: call.clipId },
      claim_ready: true,
    });

    // A timeout day the office signs off becomes claim-ready.
    const timeout = riversideDays.find((g) => g.mode === 'timeout')!;
    await pg.q(
      `update reports set status = 'signed_off', signed_off_at = '2026-10-30T15:00:00Z' where id = $1`,
      [timeout.reportId],
    );
    const signed = await buildEvidencePackInput(ctx(), pack, site);
    expect(signed.days.find((d) => d.date === timeout.date)).toMatchObject({
      confirmation: 'unconfirmed',
      signedOff: true,
      claimReady: true,
    });
  }, 120_000);

  it('builds Demir Yapı’s October pack in Turkish, A4 and metric', async () => {
    expect(kartalDays.length).toBeGreaterThan(15);
    const packId = await newPack(kartal, [
      'summary',
      'reports',
      'transcripts',
      'photos',
      'weather',
    ]);
    const site = (await pg.db.siteContext(kartal.id))!;
    const input = await buildEvidencePackInput(ctx(), (await pg.db.getEvidencePack(packId))!, site);
    expect(input).toMatchObject({ language: 'tr', units: 'metric', settings: { paper: 'a4' } });
    expect(input.days.some((d) => d.transcriptExcerpts.some((e) => e.clip === 'call'))).toBe(true);
    const t0 = performance.now();
    await build(ctx(), packId);
    console.info(
      `W3-07 metric: Kartal October pack built in ${Math.round(performance.now() - t0)} ms`,
    );
    const row = await packRow(packId);
    expect(row.status).toBe('ready');
    const pdf = await storage.download('exports', row.pdf_path!);
    // A4 (595 × 842 pt), as Demir Yapı's paper setting says.
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.\d+ 841\.\d+\]/);
  }, 180_000);
});
