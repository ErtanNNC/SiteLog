/**
 * Common IANA zones for the setup selects (the input also accepts any zone the browser knows).
 * Every country pack's default time zone is listed (`countries.default_timezone`, spec §4.6).
 */
export const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Warsaw',
  'Europe/Istanbul',
  'Asia/Kolkata',
  'Australia/Sydney',
] as const;

export function timezoneOptions(extra?: string | null): string[] {
  const list: string[] = [...TIMEZONES];
  if (extra && !list.includes(extra)) list.unshift(extra);
  return list;
}

/** "America/Chicago" → "America/Chicago (GMT-5)" using the browser's Intl data. */
export function timezoneLabel(tz: string, at = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return parts ? `${tz} (${parts.value})` : tz;
  } catch {
    return tz;
  }
}
