import { assertEquals } from '@std/assert';
import type { SiteDayWeather } from '@sitelog/shared';
import {
  asSiteDayWeather,
  dueStage,
  ladderFromSettings,
  missingNotification,
  mondayOf,
  orgIsBlocked,
  pickReminderTarget,
  planSiteDay,
  reminderJob,
  retentionDue,
  siteDayPatchForStage,
  weatherJobFor,
  weeklyDigestDue,
  type OrgSettingsInput,
  type SiteDayInput,
  type SiteInput,
} from './logic.ts';

const settings: OrgSettingsInput = {
  default_deadline: '17:30:00',
  working_days: [1, 2, 3, 4, 5],
  heads_up_enabled: true,
  heads_up_offset_min: -35,
  reminder1_enabled: true,
  reminder1_offset_min: 15,
  reminder2_enabled: true,
  reminder2_offset_min: 60,
  missing_enabled: true,
  missing_offset_min: 90,
  past_due_grace_days: 14,
};

const site: SiteInput = {
  id: 'site-1',
  org_id: 'org-1',
  name: 'Elm St. Townhomes',
  timezone: 'America/Chicago',
  deadline: null,
  lat: 41.88,
  lng: -87.63,
};

const rainy: SiteDayWeather = {
  date: '2026-10-09',
  provider: 'Open-Meteo',
  fetchedAt: '2026-10-09T17:00:00.000Z',
  units: { precip: 'in', temp: 'F', wind: 'mph' },
  hours: [
    { time: '08:00', precipIn: 0.2, tempF: 58, windMph: 9, gustMph: 14 },
    { time: '09:00', precipIn: 0.2, tempF: 59, windMph: 10, gustMph: 15 },
  ],
  summary: {
    precipIn: 0.4,
    tempMinF: 58,
    tempMaxF: 64,
    windMph: 9,
    gustMph: 15,
    provider: 'Open-Meteo',
    precipWorkingHoursIn: 0.4,
    maxGustWorkingHoursMph: 15,
  },
};

const dry: SiteDayWeather = {
  ...rainy,
  hours: [{ time: '08:00', precipIn: 0, tempF: 70, windMph: 5, gustMph: 8 }],
  summary: { ...rainy.summary, precipIn: 0, precipWorkingHoursIn: 0, maxGustWorkingHoursMph: 8 },
};

Deno.test('planSiteDay: creates a site-day on working days only, in the site time zone', () => {
  // Friday Oct 9 2026, 10:00 Chicago (15:00Z)
  assertEquals(planSiteDay(site, settings, new Date('2026-10-09T15:00:00Z')), {
    site_id: 'site-1',
    date: '2026-10-09',
    deadline_at: '2026-10-09T22:30:00.000Z',
  });
  // Saturday → no site-day
  assertEquals(planSiteDay(site, settings, new Date('2026-10-10T15:00:00Z')), null);
  // 03:30Z on Oct 10 is still Friday evening in Chicago
  assertEquals(planSiteDay(site, settings, new Date('2026-10-10T03:30:00Z'))?.date, '2026-10-09');
  // a site-specific deadline wins over the org default
  assertEquals(
    planSiteDay({ ...site, deadline: '16:00' }, settings, new Date('2026-10-09T15:00:00Z'))
      ?.deadline_at,
    '2026-10-09T21:00:00.000Z',
  );
  // custom working days (Mon–Sat)
  assertEquals(
    planSiteDay(
      site,
      { ...settings, working_days: [1, 2, 3, 4, 5, 6] },
      new Date('2026-10-10T15:00:00Z'),
    )?.date,
    '2026-10-10',
  );
});

Deno.test('planSiteDay: DST fall-back in America/Chicago (Nov 1 2026)', () => {
  const everyDay = { ...settings, working_days: [1, 2, 3, 4, 5, 6, 7] };
  // 01:30 CDT (first pass) and 01:30 CST (second pass) are both Nov 1 → one and the same site-day.
  const first = planSiteDay(site, everyDay, new Date('2026-11-01T06:30:00Z'));
  const second = planSiteDay(site, everyDay, new Date('2026-11-01T07:30:00Z'));
  assertEquals(first, second);
  assertEquals(first?.date, '2026-11-01');
  // 17:30 on Nov 1 is after the fall-back → CST (UTC−6)
  assertEquals(first?.deadline_at, '2026-11-01T23:30:00.000Z');
  // the day before is still CDT (UTC−5)
  assertEquals(
    planSiteDay(site, everyDay, new Date('2026-10-31T15:00:00Z'))?.deadline_at,
    '2026-10-31T22:30:00.000Z',
  );
  // Monday Nov 2 at the org default deadline
  assertEquals(
    planSiteDay(site, settings, new Date('2026-11-02T15:00:00Z'))?.deadline_at,
    '2026-11-02T23:30:00.000Z',
  );
});

function simulate(opts: {
  weather?: SiteDayWeather | null;
  paused?: boolean;
  settings?: OrgSettingsInput;
  status?: SiteDayInput['status'];
  deadlineAt?: string;
  from?: string;
  to?: string;
}) {
  const sd: SiteDayInput = {
    id: 'sd-1',
    site_id: 'site-1',
    date: '2026-10-09',
    status: opts.status ?? 'pending',
    deadline_at: opts.deadlineAt ?? '2026-10-09T22:30:00.000Z',
    reminder_stage: 0,
    reminders_paused: opts.paused ?? false,
    weather: opts.weather ?? null,
  };
  const ladder = ladderFromSettings(opts.settings ?? settings);
  const fired: Array<{ stage: number; at: string }> = [];
  const start = new Date(opts.from ?? '2026-10-09T21:00:00Z').getTime(); // 16:00 Chicago
  const end = new Date(opts.to ?? '2026-10-10T01:00:00Z').getTime(); // 20:00 Chicago
  for (let t = start; t <= end; t += 5 * 60_000) {
    const due = dueStage(sd, ladder, new Date(t));
    if (!due) continue;
    fired.push({ stage: due.stage, at: new Date(t).toISOString() });
    Object.assign(sd, siteDayPatchForStage(due.stage));
  }
  return { fired, sd };
}

Deno.test('ladder: R1, R2 and missing each fire exactly once, in order, at the right ticks', () => {
  const { fired, sd } = simulate({});
  assertEquals(fired, [
    { stage: 2, at: '2026-10-09T22:45:00.000Z' }, // 17:45 = deadline + 15
    { stage: 3, at: '2026-10-09T23:30:00.000Z' }, // 18:30 = deadline + 60
    { stage: 4, at: '2026-10-10T00:00:00.000Z' }, // 19:00 = deadline + 90
  ]);
  assertEquals(sd.status, 'missing');
  assertEquals(sd.reminder_stage, 4);
});

Deno.test('ladder: the heads-up fires once, only when weather was observed', () => {
  const withRain = simulate({ weather: rainy });
  assertEquals(
    withRain.fired.map((f) => f.stage),
    [1, 2, 3, 4],
  );
  assertEquals(withRain.fired[0]?.at, '2026-10-09T21:55:00.000Z'); // 16:55 = deadline − 35
  assertEquals(
    simulate({ weather: dry }).fired.map((f) => f.stage),
    [2, 3, 4],
  );
  assertEquals(
    simulate({ weather: rainy, settings: { ...settings, heads_up_enabled: false } }).fired.map(
      (f) => f.stage,
    ),
    [2, 3, 4],
  );
});

Deno.test('ladder: "stop" pauses the reporter reminders but the office is still alerted', () => {
  const { fired, sd } = simulate({ paused: true, weather: rainy });
  assertEquals(fired, [{ stage: 4, at: '2026-10-10T00:00:00.000Z' }]);
  assertEquals(sd.status, 'missing');
});

Deno.test('ladder: nothing fires for site-days that are not waiting for a report', () => {
  for (const status of ['filed', 'weather_day', 'no_work', 'processing', 'missing'] as const) {
    assertEquals(simulate({ status, weather: rainy }).fired, [], status);
  }
});

Deno.test(
  'ladder: a stage already recorded never fires again (idempotent via reminder_stage)',
  () => {
    const ladder = ladderFromSettings(settings);
    const base: SiteDayInput = {
      id: 'sd',
      site_id: 'site-1',
      date: '2026-10-09',
      status: 'reminded',
      deadline_at: '2026-10-09T22:30:00.000Z',
      reminder_stage: 2,
      reminders_paused: false,
      weather: null,
    };
    assertEquals(dueStage(base, ladder, new Date('2026-10-09T22:50:00Z')), null);
    assertEquals(dueStage(base, ladder, new Date('2026-10-09T23:31:00Z'))?.stage, 3);
    // after an outage only the latest overdue stage runs
    assertEquals(
      dueStage(
        { ...base, reminder_stage: 0, status: 'pending' },
        ladder,
        new Date('2026-10-09T23:45:00Z'),
      )?.stage,
      3,
    );
    assertEquals(
      dueStage({ ...base, reminder_stage: 3 }, ladder, new Date('2026-10-10T00:05:00Z'))?.stage,
      4,
    );
  },
);

Deno.test('ladder: disabled stages are skipped and offsets are honoured', () => {
  const custom = {
    ...settings,
    reminder2_enabled: false,
    reminder1_offset_min: 30,
    missing_offset_min: 120,
  };
  assertEquals(simulate({ settings: custom, to: '2026-10-10T02:00:00Z' }).fired, [
    { stage: 2, at: '2026-10-09T23:00:00.000Z' }, // 18:00
    { stage: 4, at: '2026-10-10T00:30:00.000Z' }, // 19:30
  ]);
});

Deno.test('ladder: DST — reminders follow the CST deadline after Nov 1 2026', () => {
  const ladder = ladderFromSettings(settings);
  const monday: SiteDayInput = {
    id: 'sd',
    site_id: 'site-1',
    date: '2026-11-02',
    status: 'pending',
    deadline_at: '2026-11-02T23:30:00.000Z', // 17:30 CST
    reminder_stage: 0,
    reminders_paused: false,
    weather: null,
  };
  // 22:46Z would have been 17:46 CDT a week earlier; now it is 16:46 CST → nothing yet
  assertEquals(dueStage(monday, ladder, new Date('2026-11-02T22:46:00Z')), null);
  assertEquals(dueStage(monday, ladder, new Date('2026-11-02T23:46:00Z'))?.stage, 2);
  const { fired } = simulate({
    deadlineAt: monday.deadline_at,
    from: '2026-11-02T22:00:00Z',
    to: '2026-11-03T02:00:00Z',
  });
  assertEquals(
    fired.map((f) => f.at),
    ['2026-11-02T23:45:00.000Z', '2026-11-03T00:30:00.000Z', '2026-11-03T01:00:00.000Z'],
  );
});

Deno.test('reminderJob: builds the send_template payload per stage', () => {
  const ladder = ladderFromSettings(settings);
  const ctx = {
    siteDayId: 'sd-1',
    conversationId: 'c-1',
    firstName: 'Priya',
    siteName: 'Elm St. Townhomes',
    deadlineAt: new Date('2026-10-09T22:30:00.000Z'),
    tz: 'America/Chicago',
    ladder,
    weather: null,
  };
  const r1 = reminderJob(2, ctx);
  assertEquals(r1.dedupeKey, 'reminder:sd-1:2');
  assertEquals(r1.payload, {
    conversationId: 'c-1',
    template: 'sitelog_reminder_1',
    vars: { '1': 'Priya', '2': 'Elm St. Townhomes' },
    freeFormText:
      'Hi Priya — no report yet for Elm St. Townhomes today. A one-minute voice note is plenty.',
    buttons: [
      { id: 'rem:sd-1:recording', title: 'Recording now' },
      { id: 'rem:sd-1:no_work', title: 'No work today' },
      { id: 'rem:sd-1:weather', title: 'Site closed: weather' },
    ],
    siteDayId: 'sd-1',
    stage: 2,
  });
  const r2 = reminderJob(3, ctx);
  assertEquals(r2.payload.template, 'sitelog_reminder_2');
  assertEquals(r2.payload.vars, { '1': '19:00' });
  assertEquals(r2.payload.buttons, []);
  const headsUp = reminderJob(1, { ...ctx, weather: rainy });
  assertEquals(headsUp.payload.template, 'sitelog_weather_headsup');
  assertEquals(headsUp.payload.vars, { '1': '17:30', '2': 'It rained this morning (0.4 in)' });
});

Deno.test('siteDayPatchForStage / missingNotification', () => {
  assertEquals(siteDayPatchForStage(1), { reminder_stage: 1 });
  assertEquals(siteDayPatchForStage(2), { reminder_stage: 2, status: 'reminded' });
  assertEquals(siteDayPatchForStage(3), { reminder_stage: 3, status: 'reminded' });
  assertEquals(siteDayPatchForStage(4), { reminder_stage: 4, status: 'missing' });
  assertEquals(missingNotification('Elm St. Townhomes', 'Priya'), {
    title: 'Elm St. Townhomes — no report',
    body: 'Priya didn’t answer 2 reminders.',
  });
  assertEquals(
    missingNotification('Elm St. Townhomes', null).body,
    'The site manager didn’t answer 2 reminders.',
  );
});

Deno.test('asSiteDayWeather rejects malformed snapshots', () => {
  assertEquals(asSiteDayWeather(null), null);
  assertEquals(asSiteDayWeather({ summary: {} }), null);
  assertEquals(asSiteDayWeather(rainy), rainy);
});

Deno.test('billing grace: past_due orgs are blocked only after past_due_grace_days', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const org = (billing_status: string | null, past_due_since: string | null, grace = 14) => ({
    id: 'o',
    timezone: 'America/Chicago',
    billing_status,
    past_due_since,
    settings: { ...settings, past_due_grace_days: grace },
  });
  assertEquals(orgIsBlocked(org('active', null), now), false);
  assertEquals(orgIsBlocked(org('trialing', null), now), false);
  assertEquals(orgIsBlocked(org(null, null), now), false);
  assertEquals(orgIsBlocked(org('past_due', '2026-10-10T00:00:00Z'), now), false); // day 10 of 14
  assertEquals(orgIsBlocked(org('past_due', '2026-10-01T00:00:00Z'), now), true); // day 19
  assertEquals(orgIsBlocked(org('past_due', null), now), false); // unknown start → still in grace
  assertEquals(orgIsBlocked(org('past_due', '2026-10-10T00:00:00Z', 5), now), true);
  assertEquals(orgIsBlocked(org('canceled', null), now), true);
  assertEquals(orgIsBlocked(org('paused', null), now), true);
});

Deno.test('pickReminderTarget prefers the primary verified reporter with a conversation', () => {
  const links = [
    { site_id: 's1', reporter_id: 'backup', is_primary: false },
    { site_id: 's1', reporter_id: 'primary', is_primary: true },
    { site_id: 's2', reporter_id: 'other', is_primary: true },
  ];
  const reporters = [
    { id: 'primary', name: 'Priya Natarajan', status: 'verified' },
    { id: 'backup', name: 'Luis Ortega', status: 'verified' },
    { id: 'other', name: 'Sam', status: 'verified' },
  ];
  const conversations = [
    { id: 'c-primary', reporter_id: 'primary' },
    { id: 'c-backup', reporter_id: 'backup' },
  ];
  assertEquals(pickReminderTarget('s1', links, reporters, conversations), {
    conversationId: 'c-primary',
    reporterId: 'primary',
    firstName: 'Priya',
  });
  // primary not verified yet → fall back to the verified backup
  assertEquals(
    pickReminderTarget(
      's1',
      links,
      [{ ...reporters[0]!, status: 'invited' }, reporters[1]!],
      conversations,
    )?.reporterId,
    'backup',
  );
  // no conversation for the only reporter → nobody to remind
  assertEquals(pickReminderTarget('s2', links, reporters, conversations), null);
});

Deno.test('weatherJobFor needs coordinates and is keyed per site, date and slot', () => {
  assertEquals(weatherJobFor(site, '2026-10-09', '12:00'), {
    payload: { siteId: 'site-1', date: '2026-10-09' },
    dedupeKey: 'weather:site-1:2026-10-09:12:00',
  });
  assertEquals(weatherJobFor({ ...site, lat: null }, '2026-10-09', '12:00'), null);
});

Deno.test(
  'weeklyDigestDue: Monday 07:00 org time, once per week, catches up after an outage',
  () => {
    const org = { timezone: 'America/Chicago' };
    assertEquals(mondayOf('2026-10-09'), '2026-10-05');
    assertEquals(weeklyDigestDue(org, null, new Date('2026-10-12T11:59:00Z')), null); // Mon 06:59
    assertEquals(weeklyDigestDue(org, null, new Date('2026-10-12T12:00:00Z')), {
      weekStart: '2026-10-05',
      runKey: '2026-10-12',
    });
    assertEquals(weeklyDigestDue(org, '2026-10-12', new Date('2026-10-12T12:05:00Z')), null);
    assertEquals(
      weeklyDigestDue(org, '2026-10-05', new Date('2026-10-14T15:00:00Z'))?.weekStart,
      '2026-10-05',
    ); // Wed
    assertEquals(
      weeklyDigestDue(org, '2026-10-12', new Date('2026-10-19T12:00:00Z'))?.weekStart,
      '2026-10-12',
    );
  },
);

Deno.test('retentionDue: from 03:00 UTC, once per UTC day', () => {
  assertEquals(retentionDue(null, new Date('2026-10-12T02:59:00Z')), null);
  assertEquals(retentionDue(null, new Date('2026-10-12T03:00:00Z')), '2026-10-12');
  assertEquals(retentionDue('2026-10-12', new Date('2026-10-12T23:00:00Z')), null);
  assertEquals(retentionDue('2026-10-12', new Date('2026-10-13T03:05:00Z')), '2026-10-13');
});
