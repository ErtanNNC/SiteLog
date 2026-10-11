import { describe, expect, it } from 'vitest';
import { isWeatherObserved, type SiteDayWeather } from '@sitelog/shared';
import { createHarness, SITE_RIVERSIDE } from './test/harness';
import { fetchSiteDayWeather } from './weather';

describe('fetch_weather job', () => {
  it('builds the Open-Meteo URL, summarises the day and stores it on the site-day', async () => {
    const h = createHarness();
    const urls: string[] = [];
    const time = Array.from(
      { length: 48 },
      (_, i) => `${i < 24 ? '2026-10-08' : '2026-10-09'}T${String(i % 24).padStart(2, '0')}:00`,
    );
    const resp = {
      hourly: {
        time,
        precipitation: time.map((t) =>
          t.startsWith('2026-10-09') && ['07', '08', '09'].includes(t.slice(11, 13)) ? 0.12 : 0,
        ),
        temperature_2m: time.map(() => 60),
        wind_speed_10m: time.map(() => 9),
        wind_gusts_10m: time.map((t) => (t.endsWith('11:00') ? 27 : 14)),
      },
    };
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => resp };
    };
    const w = (await fetchSiteDayWeather(h.ctx, SITE_RIVERSIDE, '2026-10-09', fetchImpl))!;
    expect(urls[0]).toContain('latitude=30.2600');
    expect(urls[0]).toContain('precipitation_unit=inch');
    expect(urls[0]).toContain('timezone=America%2FChicago');
    expect(w.hours).toHaveLength(24);
    expect(w.summary.precipIn).toBeCloseTo(0.36, 2);
    expect(isWeatherObserved(w)).toBe(true);
    const day = await h.db.findSiteDay(SITE_RIVERSIDE, '2026-10-09');
    expect((day!.weather as unknown as SiteDayWeather).provider).toBe('Open-Meteo');
    await h
      .runJob('fetch_weather', { siteId: SITE_RIVERSIDE, date: '2026-10-09' })
      .catch(() => undefined);
  });

  it('skips sites without a location and fails on HTTP errors', async () => {
    const h = createHarness();
    h.db.data.sites.get(SITE_RIVERSIDE)!.lat = null;
    expect(
      await fetchSiteDayWeather(h.ctx, SITE_RIVERSIDE, '2026-10-09', async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })),
    ).toBeNull();
    h.db.data.sites.get(SITE_RIVERSIDE)!.lat = 30.26;
    await expect(
      fetchSiteDayWeather(h.ctx, SITE_RIVERSIDE, '2026-10-09', async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })),
    ).rejects.toThrow(/503/);
  });
});
