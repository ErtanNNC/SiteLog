import {
  buildOpenMeteoUrl,
  deadlineInstant,
  formatDeadline,
  summarizeHourly,
  type OpenMeteoResponse,
  type SiteDayWeather,
} from '@sitelog/shared';
import type { Ctx } from './context';

/** §10.10 — hourly observed weather for a site-day → site_days.weather (Open-Meteo, CC BY 4.0). */

export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchOpenMeteo(
  url: string,
  fetchImpl: FetchLike,
): Promise<OpenMeteoResponse> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
  const body = (await res.json()) as OpenMeteoResponse;
  if (!body?.hourly?.time) throw new Error('Open-Meteo response has no hourly data');
  return body;
}

export async function fetchSiteDayWeather(
  ctx: Ctx,
  siteId: string,
  date: string,
  fetchImpl: FetchLike = (u) => fetch(u, { signal: ctx.signal }),
): Promise<SiteDayWeather | null> {
  const site = await ctx.db.getSite(siteId);
  if (!site) throw new Error(`site ${siteId} not found`);
  if (site.lat === null || site.lng === null) {
    ctx.log.info('weather skipped: site has no location', { site_id: siteId });
    return null;
  }
  const settings = await ctx.db.getOrgSettings(site.org_id);
  const url = buildOpenMeteoUrl(ctx.config.WEATHER_API_BASE, site.lat, site.lng, {
    timezone: site.timezone,
    pastDays: 1,
    forecastDays: 1,
    apiKey: ctx.config.WEATHER_API_KEY || null,
  });
  const resp = await fetchOpenMeteo(url, fetchImpl);
  const weather = summarizeHourly(resp, date, site.working_hours, ctx.now());
  if (weather.hours.length === 0) {
    ctx.log.warn('weather: no hours for date', { site_id: siteId, date });
    return null;
  }
  const deadline = formatDeadline(site.deadline ?? settings?.default_deadline ?? '17:30');
  const siteDay = await ctx.db.getOrCreateSiteDay(
    site.id,
    date,
    deadlineInstant(date, deadline, site.timezone),
  );
  await ctx.db.updateSiteDay(siteDay.id, {
    weather: weather as unknown as Record<string, unknown>,
  });
  ctx.log.info('weather stored', {
    site_id: siteId,
    date,
    precip_in: weather.summary.precipIn,
    max_gust: weather.summary.maxGustWorkingHoursMph,
  });
  return weather;
}
