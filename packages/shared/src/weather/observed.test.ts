import { describe, expect, it } from 'vitest';
import {
  buildOpenMeteoUrl,
  isWeatherObserved,
  summarizeHourly,
  weatherPhrase,
} from './observed.ts';

const hours = Array.from({ length: 48 }, (_, i) => i);
const resp = {
  hourly: {
    time: hours.map((i) => `2026-10-0${i < 24 ? 8 : 9}T${String(i % 24).padStart(2, '0')}:00`),
    precipitation: hours.map((i) => (i >= 24 + 7 && i < 24 + 11 ? 0.1 : 0)),
    temperature_2m: hours.map((i) => 50 + (i % 24)),
    wind_speed_10m: hours.map(() => 9),
    wind_gusts_10m: hours.map((i) => (i === 24 + 14 ? 31 : 12)),
  },
};

describe('weather summary', () => {
  it('reduces hourly data to one site-day', () => {
    const w = summarizeHourly(resp, '2026-10-09', '07:00–15:30', new Date('2026-10-09T17:00:00Z'));
    expect(w.hours).toHaveLength(24);
    expect(w.summary).toMatchObject({
      precipIn: 0.4,
      precipWorkingHoursIn: 0.4,
      tempMinF: 50,
      tempMaxF: 73,
      windMph: 9,
      gustMph: 31,
      maxGustWorkingHoursMph: 31,
    });
    expect(isWeatherObserved(w)).toBe(true);
    expect(weatherPhrase(w)).toBe('It rained this morning (0.4 in) and gusts up to 31 mph');
  });
  it('is not "observed" when rain fell outside working hours', () => {
    const night = {
      hourly: {
        ...resp.hourly,
        precipitation: hours.map((i) => (i === 24 + 22 ? 0.3 : 0)),
        wind_gusts_10m: hours.map(() => 10),
      },
    };
    const w = summarizeHourly(night, '2026-10-09', '07:00–15:30');
    expect(w.summary.precipIn).toBe(0.3);
    expect(w.summary.precipWorkingHoursIn).toBe(0);
    expect(isWeatherObserved(w)).toBe(false);
    expect(isWeatherObserved(null)).toBe(false);
  });
  it('builds the Open-Meteo URL with imperial units', () => {
    const url = buildOpenMeteoUrl(
      'https://customer-api.open-meteo.com/v1/forecast',
      41.8781,
      -87.6298,
      { timezone: 'America/Chicago', apiKey: 'k' },
    );
    expect(url).toContain('latitude=41.8781');
    expect(url).toContain('precipitation_unit=inch');
    expect(url).toContain('timezone=America%2FChicago');
    expect(url).toContain('apikey=k');
  });
});
