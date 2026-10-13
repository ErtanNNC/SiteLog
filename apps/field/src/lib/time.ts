/** The phone's time zone; the site's time zone replaces it once the link names the site (W1-07). */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
