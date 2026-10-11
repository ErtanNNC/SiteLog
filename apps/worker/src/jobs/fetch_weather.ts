import { fetchSiteDayWeather } from '../weather';
import type { JobHandler } from './types';

export const fetchWeather: JobHandler<'fetch_weather'> = async (ctx, payload) => {
  await fetchSiteDayWeather(ctx, payload.siteId, payload.date);
};
