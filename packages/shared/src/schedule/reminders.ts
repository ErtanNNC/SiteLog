import { fromZonedTime } from 'date-fns-tz';
import { formatDateInTz, formatTimeInTz } from '../format.ts';

/** §7.4 / §F9 — reminder ladder. All arithmetic on UTC instants; wall-clock → instant via the site tz (DST-safe). */

export const REMINDER_STAGE = {
  none: 0,
  headsUp: 1,
  reminder1: 2,
  reminder2: 3,
  missing: 4,
} as const;
export type ReminderStage = (typeof REMINDER_STAGE)[keyof typeof REMINDER_STAGE];

export interface LadderSettings {
  headsUpEnabled: boolean;
  /** Negative = before the deadline (default −35). */
  headsUpOffsetMin: number;
  reminder1Enabled?: boolean;
  reminder1OffsetMin: number;
  reminder2Enabled?: boolean;
  reminder2OffsetMin: number;
  missingEnabled?: boolean;
  missingOffsetMin: number;
}

export const DEFAULT_LADDER: LadderSettings = {
  headsUpEnabled: true,
  headsUpOffsetMin: -35,
  reminder1Enabled: true,
  reminder1OffsetMin: 15,
  reminder2Enabled: true,
  reminder2OffsetMin: 60,
  missingEnabled: true,
  missingOffsetMin: 90,
};

/** "17:30" | "17:30:00" on `date` in `tz` → UTC instant. */
export function deadlineInstant(date: string, deadline: string, tz: string): Date {
  const hhmm = deadline.slice(0, 5);
  return fromZonedTime(`${date}T${hhmm}:00`, tz);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export interface LadderTimes {
  headsUpAt: Date;
  reminder1At: Date;
  reminder2At: Date;
  missingAt: Date;
}

export function ladderTimes(deadlineAt: Date, s: LadderSettings = DEFAULT_LADDER): LadderTimes {
  return {
    headsUpAt: addMinutes(deadlineAt, s.headsUpOffsetMin),
    reminder1At: addMinutes(deadlineAt, s.reminder1OffsetMin),
    reminder2At: addMinutes(deadlineAt, s.reminder2OffsetMin),
    missingAt: addMinutes(deadlineAt, s.missingOffsetMin),
  };
}

export interface DueStage {
  stage: Exclude<ReminderStage, 0>;
  at: Date;
}

/**
 * The stage to run now for a site-day that still has no report.
 * Each stage fires at most once (callers persist `reminder_stage`). When several stages are
 * overdue (scheduler outage) only the latest meaningful one fires.
 * The heads-up only fires when weather was observed today and R1 is not yet due.
 */
export function nextDueStage(params: {
  now: Date;
  deadlineAt: Date;
  currentStage: number;
  settings?: LadderSettings;
  weatherObserved: boolean;
  remindersPaused?: boolean;
}): DueStage | null {
  const s = params.settings ?? DEFAULT_LADDER;
  const t = ladderTimes(params.deadlineAt, s);
  const now = params.now.getTime();
  const candidates: DueStage[] = [];
  if (!params.remindersPaused) {
    if (
      s.headsUpEnabled &&
      params.weatherObserved &&
      now >= t.headsUpAt.getTime() &&
      now < t.reminder1At.getTime()
    ) {
      candidates.push({ stage: REMINDER_STAGE.headsUp, at: t.headsUpAt });
    }
    if ((s.reminder1Enabled ?? true) && now >= t.reminder1At.getTime()) {
      candidates.push({ stage: REMINDER_STAGE.reminder1, at: t.reminder1At });
    }
    if ((s.reminder2Enabled ?? true) && now >= t.reminder2At.getTime()) {
      candidates.push({ stage: REMINDER_STAGE.reminder2, at: t.reminder2At });
    }
  }
  // Missing escalation goes to the office, so "stop" from the reporter does not suppress it.
  if ((s.missingEnabled ?? true) && now >= t.missingAt.getTime()) {
    candidates.push({ stage: REMINDER_STAGE.missing, at: t.missingAt });
  }
  const due = candidates.filter((c) => c.stage > params.currentStage);
  if (due.length === 0) return null;
  return due.reduce((a, b) => (b.stage > a.stage ? b : a));
}

/** Template variables for each stage (§9.2). */
export function reminderVars(
  stage: Exclude<ReminderStage, 0>,
  ctx: {
    firstName: string;
    siteName: string;
    deadlineAt: Date;
    missingAt: Date;
    tz: string;
    weatherPhrase?: string;
  },
): string[] {
  switch (stage) {
    case REMINDER_STAGE.headsUp:
      return [
        formatTimeInTz(ctx.deadlineAt, ctx.tz),
        ctx.weatherPhrase ?? 'Weather hit the site today',
      ];
    case REMINDER_STAGE.reminder1:
      return [ctx.firstName, ctx.siteName];
    case REMINDER_STAGE.reminder2:
      return [formatTimeInTz(ctx.missingAt, ctx.tz)];
    case REMINDER_STAGE.missing:
      return [];
  }
}

/** Weather fetch slots (§10.10): 12:00, 16:30, 23:30 site time. */
export const WEATHER_FETCH_SLOTS = ['12:00', '16:30', '23:30'] as const;

/** Which weather slot (if any) a 5-minute scheduler tick should run, given the previous tick time. */
export function weatherSlotDue(prevTick: Date | null, now: Date, tz: string): string | null {
  const today = formatDateInTz(now, tz);
  const nowLocal = formatTimeInTz(now, tz);
  for (const slot of WEATHER_FETCH_SLOTS) {
    if (nowLocal < slot) continue;
    if (!prevTick) return slot;
    const prevSameDay = formatDateInTz(prevTick, tz) === today;
    const prevLocal = formatTimeInTz(prevTick, tz);
    if (!prevSameDay || prevLocal < slot) return slot;
  }
  return null;
}
