import { describe, expect, it } from 'vitest';
import { emptyReportDataV1, type DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { DemoStore } from './demo/store';
import { DemoSource } from './demo/DemoSource';
import { buildReportPdfInput, imageFormatOf, officeEntryAuthor } from './pdfInput';
import { storeHeroAs } from '@/test/heroData';

const user = {
  id: 'u-lena',
  email: 'lena@kestrelbuild.example',
  name: 'Lena Ortiz',
  role: 'admin' as const,
};

describe('buildReportPdfInput', () => {
  it('maps the hero report like the worker does: org letterhead, site, version, edits, photos', async () => {
    const store = new DemoStore();
    const source = new DemoSource(store, user);
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const detail = await source.getReportDetail(hero.id);
    const settings = await source.getSettings();
    detail.photos = [
      {
        messageId: 'p1',
        storagePath: 'o/s/a.JPG',
        mime: 'image/jpeg',
        url: 'https://x/a',
        caption: 'Pour',
        takenAt: '2026-10-09T20:00:00Z',
      },
      {
        messageId: 'p2',
        storagePath: 'o/s/b.png',
        mime: 'image/png',
        url: null,
        caption: null,
        takenAt: null,
      },
      // react-pdf embeds JPEG and PNG only: a WebP is left out, as the worker does.
      {
        messageId: 'p3',
        storagePath: 'o/s/c.webp',
        mime: 'image/webp',
        url: 'https://x/c',
        caption: 'WebP',
        takenAt: '2026-10-09T20:05:00Z',
      },
      // No extension: the message's type decides.
      {
        messageId: 'p4',
        storagePath: 'o/s/d',
        mime: 'image/png',
        url: 'https://x/d',
        caption: null,
        takenAt: '2026-10-09T20:10:00Z',
      },
    ];
    const input = buildReportPdfInput(detail, settings, {
      logo: null,
      now: new Date('2026-10-10T00:00:00Z'),
    });
    expect(input.org.name).toBe('Kestrel Build Group');
    expect(input.site.projectCode).toBe('RL-2041');
    expect(input.report).toMatchObject({ reportNo: 'RL-2041-0187', version: 2, kind: 'daily' });
    expect(input.reporterName).toBe('Marco Ruiz');
    expect(input.enteredBy).toBeNull();
    expect(input.edits.map((e) => e.version)).toEqual([1, 2]);
    // Only JPEG / PNG photos with a URL are embedded; the format comes from the path or type.
    expect(input.photos).toEqual([
      { url: 'https://x/a', format: 'jpg', takenAt: '2026-10-09T20:00:00Z', caption: 'Pour' },
      { url: 'https://x/d', format: 'png', takenAt: '2026-10-09T20:10:00Z', caption: null },
    ]);
    expect(input.settings.paper).toBe(settings.settings.pdf_paper === 'a4' ? 'a4' : 'letter');
    expect(input.generatedAt).toBe('2026-10-10T00:00:00.000Z');
  });

  it('prints the sign-off on the current version only, never on an older one (?v=)', async () => {
    const store = new DemoStore();
    const source = new DemoSource(store, user);
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const signed = (d: Awaited<ReturnType<typeof source.getReportDetail>>) => ({
      ...d,
      report: {
        ...d.report,
        status: 'signed_off' as const,
        signedOffAt: '2026-10-10T14:00:00Z',
        signedOffBy: user.id,
        signedOffByName: user.name,
      },
    });
    const opts = { logo: null, now: new Date('2026-10-10T15:00:00Z') };
    const settings = await source.getSettings();

    const current = signed(await source.getReportDetail(hero.id));
    expect(current.version).toBe(current.report.currentVersion);
    expect(buildReportPdfInput(current, settings, opts).report).toMatchObject({
      status: 'signed_off',
      signedOffAt: '2026-10-10T14:00:00Z',
      signedOffByName: 'Lena Ortiz',
    });

    const older = signed(await source.getReportDetail(hero.id, 1));
    expect(older.version).toBe(1);
    expect(buildReportPdfInput(older, settings, opts).report).toMatchObject({
      version: 1,
      status: 'filed',
      signedOffAt: null,
      signedOffByName: null,
    });
  });

  it('marks a report typed in the panel as entered by the office user', async () => {
    const store = new DemoStore();
    const source = new DemoSource(store, user);
    const elm = store.data.sites.find((s) => s.name === 'Elm St. Townhomes')!;
    const { reportId } = await source.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      data: emptyReportDataV1('2026-10-09'),
    });
    const detail = await source.getReportDetail(reportId);
    expect(detail.reporter).toBeNull();
    expect(officeEntryAuthor(detail)).toBe(detail.versions[0]!.authorName);
    const input = buildReportPdfInput(detail, await source.getSettings(), {
      logo: null,
      now: new Date(),
    });
    expect(input.enteredBy).toBe(detail.versions[0]!.authorName);
    expect(input.report.confirmedAt).toBeNull();
  });

  it('reads a version stored as v2 exactly like the v1 version it upgrades from', async () => {
    // The same report with both of its versions stored as schemaVersion 1, and as 2.
    const v1Store = new DemoStore();
    const v2Store = new DemoStore();
    const heroId = storeHeroAs(v1Store, 1);
    storeHeroAs(v2Store, 2);
    const now = new Date('2026-10-10T00:00:00Z');
    const [a, b] = await Promise.all(
      [v1Store, v2Store].map(async (store) => {
        const source = new DemoSource(store, user);
        const detail = await source.getReportDetail(heroId);
        const input = buildReportPdfInput(detail, await source.getSettings(), { logo: null, now });
        return { detail, input };
      }),
    );
    expect(a!.detail.storedData.schemaVersion).toBe(1);
    expect(b!.detail.storedData.schemaVersion).toBe(2);
    // Every view reads v2 either way.
    expect(a!.detail.data.schemaVersion).toBe(2);
    expect(b!.detail.data).toEqual(a!.detail.data);
    expect(b!.detail.previousData).toEqual(a!.detail.previousData);
    expect(b!.detail.totals).toEqual(a!.detail.totals);
    expect(b!.detail.photos).toEqual(a!.detail.photos);
    expect(b!.detail.excerpts).toEqual(a!.detail.excerpts);
    expect(b!.detail.excerpts.length).toBeGreaterThan(0); // voice-note seconds found their segments
    expect(b!.input).toEqual(a!.input);
    expect(b!.input.data.weather.observed).toMatchObject({ precip: 0.4, tempMin: 58 });
    expect(b!.input.data.units).toBe('imperial');
  });

  it('passes a metric v2 version on in its own units', async () => {
    const store = new DemoStore();
    const heroId = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!.id;
    const row = store.data.versions.find((v) => v.report_id === heroId && v.version === 2)!;
    // The seeded hero is stored as v2 (W1-06).
    const v2: DailyReportData = {
      ...(row.data as unknown as DailyReportData),
      reportLanguage: 'tr',
      units: 'metric',
    };
    v2.weather.observed = {
      precip: 10.2,
      tempMin: 14,
      tempMax: 18,
      wind: 15,
      provider: 'Open-Meteo',
    };
    row.data = v2 as unknown as typeof row.data;
    const source = new DemoSource(store, user);
    const detail = await source.getReportDetail(heroId);
    const input = buildReportPdfInput(detail, await source.getSettings(), {
      logo: null,
      now: new Date(),
    });
    expect(input.data).toMatchObject({ reportLanguage: 'tr', units: 'metric' });
    expect(input.data.weather.observed).toEqual(v2.weather.observed);
  });

  it('reads image formats from storage paths', () => {
    expect(imageFormatOf('a/b/logo.PNG')).toBe('png');
    expect(imageFormatOf('a/b/p.jpeg?token=1')).toBe('jpg');
    expect(imageFormatOf('a/b/logo.svg')).toBeNull();
    expect(imageFormatOf(null)).toBeNull();
    expect(imageFormatOf('a/b/office/x.webp', 'image/webp')).toBeNull();
    expect(imageFormatOf('a/b/blob', 'image/jpeg')).toBe('jpg');
  });
});
