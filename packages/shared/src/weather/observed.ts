import type { ObservedWeather } from '../schemas/report.ts';
import { splitWorkingHours } from '../report/hours.ts';

/** §10.10 — Open-Meteo hourly data for a site-day. */

export interface OpenMeteoHourly {
  time: string[];
  precipitation?: Array<number | null>;
  temperature_2m?: Array<number | null>;
  wind_speed_10m?: Array<number | null>;
  wind_gusts_10m?: Array<number | null>;
}

export interface OpenMeteoResponse {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  hourly_units?: Record<string, string>;
  hourly: OpenMeteoHourly;
}

export interface WeatherHour {
  /** "HH:MM" local */
  time: string;
  precipIn: number;
  tempF: number | null;
  windMph: number | null;
  gustMph: number | null;
}

export interface SiteDayWeather {
  date: string;
  provider: 'Open-Meteo';
  fetchedAt: string;
  units: { precip: 'in'; temp: 'F'; wind: 'mph' };
  hours: WeatherHour[];
  summary: ObservedWeather & { precipWorkingHoursIn: number; maxGustWorkingHoursMph: number };
}

export const WEATHER_THRESHOLDS = { precipIn: 0.05, gustMph: 25 } as const;

export function buildOpenMeteoUrl(
  base: string,
  lat: number,
  lng: number,
  opts: { timezone: string; pastDays?: number; forecastDays?: number; apiKey?: string | null },
): string {
  const u = new URL(base);
  u.searchParams.set('latitude', lat.toFixed(4));
  u.searchParams.set('longitude', lng.toFixed(4));
  u.searchParams.set('hourly', 'precipitation,temperature_2m,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('timezone', opts.timezone);
  u.searchParams.set('past_days', String(opts.pastDays ?? 1));
  u.searchParams.set('forecast_days', String(opts.forecastDays ?? 1));
  u.searchParams.set('precipitation_unit', 'inch');
  u.searchParams.set('temperature_unit', 'fahrenheit');
  u.searchParams.set('wind_speed_unit', 'mph');
  if (opts.apiKey) u.searchParams.set('apikey', opts.apiKey);
  return u.toString();
}

/** Reduce an Open-Meteo response to the hours of one local date. */
export function summarizeHourly(
  resp: OpenMeteoResponse,
  date: string,
  workingHours: string | null | undefined = '07:00–15:30',
  fetchedAt: Date = new Date(),
): SiteDayWeather {
  const h = resp.hourly;
  const hours: WeatherHour[] = [];
  h.time.forEach((t, i) => {
    if (!t.startsWith(date)) return;
    hours.push({
      time: t.slice(11, 16),
      precipIn: h.precipitation?.[i] ?? 0,
      tempF: h.temperature_2m?.[i] ?? null,
      windMph: h.wind_speed_10m?.[i] ?? null,
      gustMph: h.wind_gusts_10m?.[i] ?? null,
    });
  });
  const [ws, we] = splitWorkingHours(workingHours ?? undefined);
  const inWork = (t: string) => (ws && we ? t >= ws && t < we : true);
  const temps = hours.map((x) => x.tempF).filter((x): x is number => x !== null);
  const winds = hours.map((x) => x.windMph).filter((x): x is number => x !== null);
  const gusts = hours.map((x) => x.gustMph).filter((x): x is number => x !== null);
  const workGusts = hours
    .filter((x) => inWork(x.time))
    .map((x) => x.gustMph)
    .filter((x): x is number => x !== null);
  const precipTotal = round2(hours.reduce((a, x) => a + x.precipIn, 0));
  const precipWork = round2(
    hours.filter((x) => inWork(x.time)).reduce((a, x) => a + x.precipIn, 0),
  );
  return {
    date,
    provider: 'Open-Meteo',
    fetchedAt: fetchedAt.toISOString(),
    units: { precip: 'in', temp: 'F', wind: 'mph' },
    hours,
    summary: {
      precipIn: precipTotal,
      tempMinF: temps.length ? Math.round(Math.min(...temps)) : 0,
      tempMaxF: temps.length ? Math.round(Math.max(...temps)) : 0,
      windMph: winds.length ? Math.round(average(winds)) : 0,
      gustMph: gusts.length ? Math.round(Math.max(...gusts)) : undefined,
      provider: 'Open-Meteo',
      precipWorkingHoursIn: precipWork,
      maxGustWorkingHoursMph: workGusts.length ? Math.round(Math.max(...workGusts)) : 0,
    },
  };
}

/** "Weather observed" for the heads-up: precipitation > 0.05 in during working hours or gusts > 25 mph. */
export function isWeatherObserved(
  w: SiteDayWeather | null | undefined,
  thresholds = WEATHER_THRESHOLDS,
): boolean {
  if (!w) return false;
  return (
    w.summary.precipWorkingHoursIn > thresholds.precipIn ||
    w.summary.maxGustWorkingHoursMph > thresholds.gustMph
  );
}

/** The {{2}} variable of `sitelog_weather_headsup`. */
export function weatherPhrase(w: SiteDayWeather): string {
  const rainHours = w.hours.filter((h) => h.precipIn > 0.01);
  const parts: string[] = [];
  if (w.summary.precipWorkingHoursIn > WEATHER_THRESHOLDS.precipIn && rainHours.length) {
    const first = rainHours[0]!.time;
    const last = rainHours[rainHours.length - 1]!.time;
    const when =
      Number(last.slice(0, 2)) < 12
        ? 'this morning'
        : Number(first.slice(0, 2)) >= 12
          ? 'this afternoon'
          : 'today';
    parts.push(`It rained ${when} (${w.summary.precipIn.toFixed(1)} in)`);
  }
  if (w.summary.maxGustWorkingHoursMph > WEATHER_THRESHOLDS.gustMph) {
    parts.push(`${parts.length ? 'g' : 'G'}usts up to ${w.summary.maxGustWorkingHoursMph} mph`);
  }
  return parts.length ? parts.join(' and ') : 'Weather hit the site today';
}

/** Observed block for the report (§10.3 weather.observed). */
export function toObserved(w: SiteDayWeather): ObservedWeather {
  const { precipIn, tempMinF, tempMaxF, windMph, gustMph, provider } = w.summary;
  return { precipIn, tempMinF, tempMaxF, windMph, gustMph, provider };
}

function average(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
