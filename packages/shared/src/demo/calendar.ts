/**
 * The demo calendar (GAP D36): where the §18 demo days land on the real calendar.
 *
 * The demo data is written for §18.1's Fri Oct 9, 2026 (`DEMO_CANONICAL_TODAY`) and three weeks of
 * history before it. Every date in the builders is such a canonical date; the calendar maps it to
 * the date the rows get, and keys (ids, pseudo-random picks) stay on the canonical date, so the
 * same demo day has the same ids and content whatever the target date.
 *
 * - Default (no date): the identity. §18.1 as written, "now" Fri Oct 9 19:05 (the e2e default).
 * - Live (`--date YYYY-MM-DD`, a Monday to Friday): today is that date, and the demo starts at the
 *   17:00 daily link (§7.4). History is moved by whole weeks, so weekdays stay weekdays (the week
 *   of Oct 5–9 becomes the target's week) and only canonical days that land before the target
 *   date are kept: history ends the working day before. Canonical Oct 9 becomes the target date
 *   itself, as of 17:00 (see kestrel.ts: Pier 9 filed at 16:58, five sites awaiting).
 *
 * Instants are built from the local wall-clock time on the mapped date in the site's time zone
 * (`fromZonedTime`), so a 17:38 voice note is 17:38 local on both sides of a DST change.
 */
import { fromZonedTime } from 'date-fns-tz';
import { addDays, daysBetween, isoWeekday, parseIsoDate } from '../format.ts';

/** §18.1's "today": Fri Oct 9, 2026. */
export const DEMO_CANONICAL_TODAY = '2026-10-09';

/** §7.4 daily link time: a live demo day starts here (D36). */
export const DEMO_LIVE_START = '17:00';

export interface DemoCalendar {
  /** True for `--date`: the live demo (today starts at 17:00), false for §18.1 as written. */
  live: boolean;
  /** The date canonical Oct 9 lands on (`YYYY-MM-DD`). */
  today: string;
  /** Whole days canonical history moves by (a multiple of 7; 0 by default). */
  shiftDays: number;
  /** A canonical date → the date its rows get. */
  day(canonical: string): string;
  /** A canonical date and a local wall-clock time (`HH:MM` or `HH:MM:SS`) in `tz` → ISO instant. */
  at(canonical: string, time: string, tz: string): string;
  /**
   * A date that is already mapped (from `day()`, `pastDay()` or `today`) and a local wall-clock
   * time in `tz` → ISO instant, with no second mapping (`at()` maps its date first).
   */
  atDate(date: string, time: string, tz: string): string;
  /** A canonical working day before Oct 9 that is kept as history (all of them by default). */
  isHistory(canonical: string): boolean;
  /**
   * For a one-off event that must have happened by today (an invite, a glossary sighting): its
   * date, moved a week earlier at a time while it would land on or after today. Canonical Oct 9
   * stays today (its events are before 17:00 or not kept).
   */
  pastDay(canonical: string): string;
}

function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const { y, m, d } = parseIsoDate(date);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * The calendar for a target date (`YYYY-MM-DD`, Monday to Friday), or §18.1's own when none is
 * given. Throws on a malformed date or a weekend: the demo org works Monday to Friday, so a
 * Saturday has no site-days to start awaiting.
 */
export function demoCalendar(date?: string): DemoCalendar {
  if (date === undefined) {
    return {
      live: false,
      today: DEMO_CANONICAL_TODAY,
      shiftDays: 0,
      day: (c) => c,
      at: (c, time, tz) => instant(c, time, tz),
      atDate: instant,
      isHistory: (c) => c < DEMO_CANONICAL_TODAY,
      pastDay: (c) => c,
    };
  }
  if (!isRealDate(date)) throw new Error(`--date must be YYYY-MM-DD (got "${date}")`);
  const weekday = isoWeekday(date);
  if (weekday > 5)
    throw new Error(`--date ${date} is a weekend day; the demo orgs work Monday to Friday`);
  // The Friday of the target's week is where canonical Fri Oct 9 would land by whole weeks.
  const friday = addDays(date, 5 - weekday);
  const shiftDays = daysBetween(DEMO_CANONICAL_TODAY, friday);
  const day = (c: string) => (c === DEMO_CANONICAL_TODAY ? date : addDays(c, shiftDays));
  return {
    live: true,
    today: date,
    shiftDays,
    day,
    at: (c, time, tz) => instant(day(c), time, tz),
    atDate: instant,
    isHistory: (c) => c < DEMO_CANONICAL_TODAY && addDays(c, shiftDays) < date,
    pastDay: (c) => {
      if (c === DEMO_CANONICAL_TODAY) return date;
      let d = day(c);
      while (d >= date) d = addDays(d, -7);
      return d;
    },
  };
}

function instant(date: string, time: string, tz: string): string {
  const t = time.length === 5 ? `${time}:00` : time;
  return fromZonedTime(`${date}T${t}`, tz).toISOString();
}

/** Today's date where the code runs, in a time zone (`--date today`). */
export function todayIn(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
