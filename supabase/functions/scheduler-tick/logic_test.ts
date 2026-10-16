import { assertEquals, assertThrows } from '@std/assert';
import { type CountryPack, deadlineInstant, type SiteDayWeather } from '@sitelog/shared';
import { demoPack } from '@sitelog/shared/demo/countries.ts';
import {
  asSiteDayWeather,
  claimArgs,
  dueStage,
  ladderFromSettings,
  missingNotification,
  mondayOf,
  orgIsBlocked,
  type LadderReporter,
  type LadderStep,
  ladderVars,
  type OrgInput,
  type OrgSettingsInput,
  planLadder,
  planMissing,
  planSiteDay,
  planTickJobs,
  reminderJob,
  retentionDue,
  type SiteDayInput,
  siteDayPatchForStage,
  type SiteInput,
  siteLadderReporters,
  siteReporterFirstName,
  weatherJobFor,
  weeklyDigestDue,
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
  // Spec §19 Q55: with no reminder sent, the notice does not mention any.
  assertEquals(missingNotification('Elm St. Townhomes', 'Priya'), {
    title: 'Elm St. Townhomes — no report',
    body: 'Priya hasn’t sent today’s report, and the deadline has passed.',
    // The panel renders this in the reader's language (EN/TR).
    data: { key: 'missing_report', params: { site: 'Elm St. Townhomes', first: 'Priya' } },
  });
  assertEquals(missingNotification('Elm St. Townhomes', null).data, {
    key: 'missing_report',
    params: { site: 'Elm St. Townhomes', first: null },
  });
  assertEquals(
    missingNotification('Elm St. Townhomes', null).body,
    'The site manager hasn’t sent today’s report, and the deadline has passed.',
  );
  assertEquals(missingNotification('X', 'Priya').body.includes('reminder'), false);
  // §13 once the ladder sent reminders (W2-06): "{first} didn't answer {n} reminders".
  assertEquals(missingNotification('Elm St. Townhomes', 'Priya', 2), {
    title: 'Elm St. Townhomes — no report',
    body: 'Priya didn’t answer 2 reminders.',
    data: {
      key: 'missing_report',
      params: { site: 'Elm St. Townhomes', first: 'Priya', reminders: 2 },
    },
  });
  assertEquals(missingNotification('X', 'Priya', 1).body, 'Priya didn’t answer 1 reminder.');
  // Nobody to name: the Q55 wording, the count kept for the panel.
  assertEquals(
    missingNotification('X', null, 2).body,
    'The site manager hasn’t sent today’s report, and the deadline has passed.',
  );
});

Deno.test('siteReporterFirstName: the primary active reporter, else any active one', () => {
  const links = [
    { site_id: 's1', reporter_id: 'r1', is_primary: false },
    { site_id: 's1', reporter_id: 'r2', is_primary: true },
    { site_id: 's2', reporter_id: 'r3', is_primary: true },
    { site_id: 's2', reporter_id: 'r1', is_primary: false },
  ];
  const reporters = [
    { id: 'r1', name: 'Marco Ruiz', status: 'active' },
    { id: 'r2', name: 'Priya Natarajan', status: 'active' },
    { id: 'r3', name: 'Dana Cole', status: 'opted_out' },
  ];
  assertEquals(siteReporterFirstName('s1', links, reporters), 'Priya');
  assertEquals(siteReporterFirstName('s2', links, reporters), 'Marco');
  assertEquals(siteReporterFirstName('s3', links, reporters), null);
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

Deno.test(
  'planTickJobs: weather, digest and retention; never a reminder (the ladder is planLadder)',
  () => {
    const org = {
      id: 'org-1',
      timezone: 'America/Chicago',
      billing_status: 'active',
      past_due_since: null,
      settings,
    };
    const sd: SiteDayInput = {
      id: 'sd-1',
      site_id: 'site-1',
      date: '2026-10-12',
      status: 'pending',
      deadline_at: '2026-10-12T22:30:00.000Z',
      reminder_stage: 0,
      reminders_paused: false,
      weather: rainy,
    };
    const types = new Set<string>();
    let digestRuns: Record<string, string> = {};
    let retentionLastRun: string | null = null;
    let prev: Date | null = null;
    for (
      let t = Date.parse('2026-10-12T11:00:00Z');
      t <= Date.parse('2026-10-13T04:55:00Z');
      t += 300_000
    ) {
      const now = new Date(t);
      for (const j of planTickJobs({
        sites: [site],
        orgs: new Map([[org.id, org]]),
        todaysSiteDays: [sd],
        now,
        prevTick: prev,
        digestRuns,
        retentionLastRun,
      })) {
        types.add(j.type);
        if (j.type === 'weekly_digest') digestRuns = { ...digestRuns, [j.orgId]: j.runKey };
        if (j.type === 'retention_cleanup') retentionLastRun = j.day;
      }
      prev = now;
    }
    assertEquals([...types].sort(), ['fetch_weather', 'retention_cleanup', 'weekly_digest']);
  },
);

Deno.test(
  'planMissing (W1-10): past deadline + offset only, pending or reminded, missing step on',
  () => {
    const org = {
      id: 'org-1',
      timezone: 'America/Chicago',
      billing_status: 'active',
      past_due_since: null,
      settings,
    };
    const base: SiteDayInput = {
      id: 'sd-1',
      site_id: 'site-1',
      date: '2026-10-12',
      status: 'pending',
      deadline_at: '2026-10-12T22:30:00.000Z',
      reminder_stage: 0,
      reminders_paused: true,
      weather: null,
    };
    const plan = (sd: SiteDayInput, now: string, s = settings) =>
      planMissing({
        sites: [site],
        orgs: new Map([[org.id, { ...org, settings: s }]]),
        todaysSiteDays: [sd],
        now: new Date(now),
      }).map((m) => m.siteDayId);
    assertEquals(plan(base, '2026-10-12T23:59:00Z'), []);
    // Paused reminders do not stop the office-facing step.
    assertEquals(plan(base, '2026-10-13T00:00:00Z'), ['sd-1']);
    assertEquals(plan({ ...base, status: 'reminded', reminder_stage: 3 }, '2026-10-13T00:05:00Z'), [
      'sd-1',
    ]);
    for (const status of ['processing', 'filed', 'missing', 'no_work', 'weather_day'] as const) {
      assertEquals(plan({ ...base, status }, '2026-10-13T01:00:00Z'), [], status);
    }
    assertEquals(plan({ ...base, reminder_stage: 4 }, '2026-10-13T01:00:00Z'), []);
    assertEquals(plan(base, '2026-10-13T01:00:00Z', { ...settings, missing_enabled: false }), []);
    // An unknown site (another org's, or inactive) is skipped.
    assertEquals(plan({ ...base, site_id: 'site-x' }, '2026-10-13T01:00:00Z'), []);
    // W2-06 (docs/AUDIT_BACKLOG.md "Site-days created on non-working days…"): a Saturday
    // site-day made by a stray upload or STOP is never escalated.
    const saturday = { ...base, date: '2026-10-10', deadline_at: '2026-10-10T22:30:00.000Z' };
    assertEquals(plan(saturday, '2026-10-11T01:00:00Z'), []);
    assertEquals(
      plan(saturday, '2026-10-11T01:00:00Z', { ...settings, working_days: [1, 2, 3, 4, 5, 6] }),
      ['sd-1'],
    );
  },
);

// ── W2-06: the reminder ladder (planLadder → claim_site_day_reminder) ─────────────────────────────

const US = demoPack('US');
const TR = demoPack('TR');

function orgOf(id: string, over: Partial<OrgInput> = {}): OrgInput {
  return {
    id,
    timezone: 'America/Chicago',
    billing_status: 'active',
    past_due_since: null,
    settings,
    units: 'imperial',
    ...over,
  };
}

function rep(id: string, over: Partial<LadderReporter> = {}): LadderReporter {
  return {
    id,
    org_id: 'org-1',
    name: id,
    status: 'active',
    contact_pref: 'link',
    message_channel: null,
    locale: 'en-US',
    ...over,
  };
}

function dayOf(
  date: string,
  tz = 'America/Chicago',
  over: Partial<SiteDayInput> = {},
): SiteDayInput {
  return {
    id: `sd-${date}`,
    site_id: 'site-1',
    date,
    status: 'pending',
    deadline_at: deadlineInstant(date, '17:30', tz).toISOString(),
    reminder_stage: 0,
    reminders_paused: false,
    weather: null,
    ...over,
  };
}

interface World {
  sites: SiteInput[];
  orgs: Map<string, OrgInput>;
  packs: Map<string, CountryPack>;
  days: SiteDayInput[];
  links: Array<{ site_id: string; reporter_id: string; is_primary: boolean }>;
  reporters: Map<string, LadderReporter>;
}

function world(over: Partial<World> = {}): World {
  return {
    sites: [site],
    orgs: new Map([['org-1', orgOf('org-1')]]),
    packs: new Map([['org-1', US]]),
    days: [dayOf('2026-10-12')],
    links: [{ site_id: 'site-1', reporter_id: 'priya', is_primary: true }],
    reporters: new Map([['priya', rep('priya')]]),
    ...over,
  };
}

/** What a tick sent: "<local time> <reporter> <key>" (site time), plus the skips and the claims. */
interface Sent {
  at: string;
  siteDayId: string;
  reporter: string;
  key: string;
}

/**
 * Every 5-minute tick of a day through planLadder and planMissing, with the claim RPC's rules in
 * TS (stage once, the daily link once, status pending/reminded, R1 → reminded); `onTick` may
 * change the world (a filing). Times are UTC instants; `at` is the site's wall clock.
 */
function simulateLadder(
  w: World,
  fromIso: string,
  toIso: string,
  onTick: (now: Date, w: World) => void = () => {},
): {
  sent: Sent[];
  skipped: Array<{ stage: string; reporter: string; reason: string }>;
  missing: string[];
  steps: LadderStep[];
} {
  const sent: Sent[] = [];
  const skipped: Array<{ stage: string; reporter: string; reason: string }> = [];
  const missing: string[] = [];
  const allSteps: LadderStep[] = [];
  const dailyLinkDone = new Set<string>();
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 300_000) {
    const now = new Date(t);
    onTick(now, w);
    const steps = planLadder({
      sites: w.sites,
      orgs: w.orgs,
      packs: w.packs,
      todaysSiteDays: w.days,
      links: w.links,
      reporters: w.reporters,
      dailyLinkDone,
      now,
    });
    for (const step of steps) {
      const sd = w.days.find((d) => d.id === step.siteDayId)!;
      // claim_site_day_reminder()'s guarded claim
      if (sd.status !== 'pending' && sd.status !== 'reminded') continue;
      if (step.stage === 'daily_link') {
        if (dailyLinkDone.has(sd.id) || sd.reminder_stage >= 2) continue;
        dailyLinkDone.add(sd.id);
      } else {
        const n = { heads_up: 1, reminder_1: 2, reminder_2: 3 }[step.stage];
        if (sd.reminder_stage >= n) continue;
        sd.reminder_stage = n;
        if (n >= 2) sd.status = 'reminded';
      }
      allSteps.push(step);
      const tz = w.sites.find((x) => x.id === step.siteId)!.timezone;
      const args = claimArgs(step, () => ({}));
      for (const m of args.messages) {
        sent.push({
          at: new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            hour: '2-digit',
            minute: '2-digit',
          }).format(now),
          siteDayId: sd.id,
          reporter: m.reporterId,
          key: m.key,
        });
      }
      for (const k of args.skipped)
        skipped.push({ stage: step.stage, reporter: k.reporterId, reason: k.reason });
    }
    for (const mark of planMissing({ sites: w.sites, orgs: w.orgs, todaysSiteDays: w.days, now })) {
      const sd = w.days.find((d) => d.id === mark.siteDayId)!;
      sd.status = 'missing';
      sd.reminder_stage = 4;
      missing.push(now.toISOString());
    }
  }
  return { sent, skipped, missing, steps: allSteps };
}

const line = (s: Sent) => `${s.at} ${s.reporter} ${s.key}`;

Deno.test(
  'planLadder: a whole day, each stage once (daily link, heads-up, R1, R2, then missing)',
  () => {
    const w = world({ days: [dayOf('2026-10-12', 'America/Chicago', { weather: rainy })] });
    const r = simulateLadder(w, '2026-10-12T11:00:00Z', '2026-10-13T04:55:00Z');
    assertEquals(r.sent.map(line), [
      '16:55 priya weather_headsup',
      '17:00 priya daily_link',
      '17:45 priya reminder_1',
      '18:30 priya reminder_2',
    ]);
    assertEquals(r.missing, ['2026-10-13T00:00:00.000Z']); // 19:00 Chicago
    assertEquals([w.days[0]!.status, w.days[0]!.reminder_stage], ['missing', 4]);
  },
);

Deno.test(
  'planLadder: no heads-up without observed weather; a filing at 17:50 stops R2 and missing',
  () => {
    const w = world({ days: [dayOf('2026-10-12', 'America/Chicago', { weather: dry })] });
    const r = simulateLadder(w, '2026-10-12T11:00:00Z', '2026-10-13T04:55:00Z', (now, w) => {
      if (now.toISOString() === '2026-10-12T22:50:00.000Z') w.days[0]!.status = 'filed';
    });
    assertEquals(r.sent.map(line), ['17:00 priya daily_link', '17:45 priya reminder_1']);
    assertEquals(r.missing, []);
  },
);

Deno.test(
  'planLadder: guards — paused, not waiting, non-working day, billing-blocked, paused site',
  () => {
    const at = new Date('2026-10-12T22:46:00Z'); // 17:46 Chicago: R1 due (daily link done)
    const plan = (w: World) =>
      planLadder({
        sites: w.sites,
        orgs: w.orgs,
        packs: w.packs,
        todaysSiteDays: w.days,
        links: w.links,
        reporters: w.reporters,
        dailyLinkDone: new Set(w.days.map((d) => d.id)),
        now: at,
      }).map((s) => s.stage);
    assertEquals(plan(world()), ['reminder_1']);
    assertEquals(
      plan(world({ days: [dayOf('2026-10-12', 'America/Chicago', { reminders_paused: true })] })),
      [],
    );
    for (const status of ['processing', 'filed', 'missing', 'no_work', 'weather_day'] as const) {
      assertEquals(
        plan(world({ days: [dayOf('2026-10-12', 'America/Chicago', { status })] })),
        [],
        status,
      );
    }
    // Saturday (docs/AUDIT_BACKLOG.md "Site-days created on non-working days…").
    const saturday = dayOf('2026-10-10');
    assertEquals(
      planLadder({
        ...world(),
        todaysSiteDays: [saturday],
        dailyLinkDone: new Set(),
        now: new Date('2026-10-10T22:46:00Z'),
      }),
      [],
    );
    // Billing-blocked org (canceled), and a site the tick did not load (paused, or archived).
    assertEquals(
      plan(world({ orgs: new Map([['org-1', orgOf('org-1', { billing_status: 'canceled' })]]) })),
      [],
    );
    assertEquals(plan(world({ sites: [] })), []);
    // A stage already run is not planned again; the daily link only while it is not done.
    assertEquals(
      plan(
        world({
          days: [dayOf('2026-10-12', 'America/Chicago', { reminder_stage: 2, status: 'reminded' })],
        }),
      ),
      [],
    );
  },
);

Deno.test(
  'planLadder: targets are site_reporters, per reporter, primary first; a phone in two orgs gets each org’s',
  () => {
    // Priya's phone is a reporter in org 1 (site-1) and, as another reporter row, in org 2 (site-2).
    const site2: SiteInput = { ...site, id: 'site-2', org_id: 'org-2', name: 'Harbor View' };
    const w = world({
      sites: [site, site2],
      orgs: new Map([
        ['org-1', orgOf('org-1')],
        ['org-2', orgOf('org-2')],
      ]),
      packs: new Map([
        ['org-1', US],
        ['org-2', US],
      ]),
      days: [dayOf('2026-10-12'), { ...dayOf('2026-10-12'), id: 'sd-2', site_id: 'site-2' }],
      links: [
        { site_id: 'site-1', reporter_id: 'luis', is_primary: false },
        { site_id: 'site-1', reporter_id: 'priya-a', is_primary: true },
        { site_id: 'site-2', reporter_id: 'priya-b', is_primary: true },
        // A link to another org's reporter is ignored (docs/AUDIT_BACKLOG.md, site_reporters).
        { site_id: 'site-2', reporter_id: 'luis', is_primary: false },
      ],
      reporters: new Map([
        ['priya-a', rep('priya-a')],
        ['priya-b', rep('priya-b', { org_id: 'org-2' })],
        ['luis', rep('luis')],
      ]),
    });
    const r = simulateLadder(w, '2026-10-12T21:55:00Z', '2026-10-12T22:50:00Z');
    assertEquals(
      r.sent.map((s) => `${s.at} ${s.siteDayId} ${s.reporter} ${s.key}`),
      [
        '17:00 sd-2026-10-12 priya-a daily_link',
        '17:00 sd-2026-10-12 luis daily_link',
        '17:00 sd-2 priya-b daily_link',
        '17:45 sd-2026-10-12 priya-a reminder_1',
        '17:45 sd-2026-10-12 luis reminder_1',
        '17:45 sd-2 priya-b reminder_1',
      ],
    );
    assertEquals(
      siteLadderReporters(site, w.links, w.reporters).map((x) => x.id),
      ['priya-a', 'luis'],
    );
  },
);

Deno.test('planLadder: a reporter of two sites gets one message per site (F14)', () => {
  const site2: SiteInput = { ...site, id: 'site-2', name: 'Riverside B' };
  const w = world({
    sites: [site, site2],
    days: [dayOf('2026-10-12'), { ...dayOf('2026-10-12'), id: 'sd-2', site_id: 'site-2' }],
    links: [
      { site_id: 'site-1', reporter_id: 'priya', is_primary: true },
      { site_id: 'site-2', reporter_id: 'priya', is_primary: true },
    ],
  });
  const r = simulateLadder(w, '2026-10-12T22:00:00Z', '2026-10-12T22:00:00Z');
  assertEquals(
    r.sent.map((s) => `${s.siteDayId} ${s.key}`),
    ['sd-2026-10-12 daily_link', 'sd-2 daily_link'],
  );
});

Deno.test(
  'planLadder: remind() per reporter — inactive skipped, call reporters get the daily link (Q76)',
  () => {
    const w = world({
      links: [
        { site_id: 'site-1', reporter_id: 'priya', is_primary: true },
        { site_id: 'site-1', reporter_id: 'jorge', is_primary: false },
        { site_id: 'site-1', reporter_id: 'dana', is_primary: false },
      ],
      reporters: new Map([
        ['priya', rep('priya', { contact_pref: 'call' })],
        ['jorge', rep('jorge', { status: 'invited' })],
        ['dana', rep('dana', { status: 'opted_out' })],
      ]),
    });
    const r = simulateLadder(w, '2026-10-12T22:00:00Z', '2026-10-12T22:45:00Z');
    assertEquals(r.sent.map(line), ['17:00 priya daily_link', '17:45 priya reminder_1']);
    assertEquals(r.skipped, [
      { stage: 'daily_link', reporter: 'dana', reason: 'inactive' },
      { stage: 'daily_link', reporter: 'jorge', reason: 'inactive' },
      { stage: 'reminder_1', reporter: 'dana', reason: 'inactive' },
      { stage: 'reminder_1', reporter: 'jorge', reason: 'inactive' },
    ]);
  },
);

Deno.test(
  'planLadder: quiet hours (Q77) — the stage is claimed, its messages skipped; notAfter is the window end',
  () => {
    const w = world({
      orgs: new Map([
        [
          'org-1',
          orgOf('org-1', {
            settings: { ...settings, call_window_start: '07:00:00', call_window_end: '17:30:00' },
          }),
        ],
      ]),
    });
    const r = simulateLadder(w, '2026-10-12T22:00:00Z', '2026-10-12T23:35:00Z');
    assertEquals(r.sent.map(line), ['17:00 priya daily_link']);
    assertEquals(r.skipped, [
      { stage: 'reminder_1', reporter: 'priya', reason: 'quiet_hours' },
      { stage: 'reminder_2', reporter: 'priya', reason: 'quiet_hours' },
    ]);
    // The 17:00 job may not go out after 17:30 Chicago (22:30Z).
    assertEquals(r.steps[0]!.notAfter?.toISOString(), '2026-10-12T22:30:00.000Z');
    // The default window (07:00–20:00) ends at 20:00 Chicago (01:00Z).
    const d = simulateLadder(world(), '2026-10-12T22:00:00Z', '2026-10-12T22:00:00Z');
    assertEquals(d.steps[0]!.notAfter?.toISOString(), '2026-10-13T01:00:00.000Z');
  },
);

Deno.test('planLadder: after an outage the daily link, then only the latest stage', () => {
  // The first tick at 17:46 (the plan's e2e clock): the daily link, then R1.
  const first = simulateLadder(world(), '2026-10-12T22:46:00Z', '2026-10-12T22:46:00Z');
  assertEquals(first.sent.map(line), ['17:46 priya daily_link', '17:46 priya reminder_1']);
  const r = simulateLadder(world(), '2026-10-12T23:35:00Z', '2026-10-12T23:35:00Z'); // 18:35 Chicago
  assertEquals(r.sent.map(line), ['18:35 priya daily_link', '18:35 priya reminder_2']);
  // At 19:05 the missing step is due: no reminder, the office is told.
  const late = simulateLadder(world(), '2026-10-13T00:05:00Z', '2026-10-13T00:05:00Z');
  assertEquals(late.sent, []);
  assertEquals(late.missing, ['2026-10-13T00:05:00.000Z']);
});

const allDays = { ...settings, working_days: [1, 2, 3, 4, 5, 6, 7] };

for (const [tz, date, pack, expected] of [
  // America/Chicago: spring forward Sun 2026-03-08 (UTC−5 after), fall back Sun 2026-11-01 (UTC−6).
  ['America/Chicago', '2026-03-07', US, ['23:00', '23:45', '00:30', '01:00']],
  ['America/Chicago', '2026-03-08', US, ['22:00', '22:45', '23:30', '00:00']],
  ['America/Chicago', '2026-10-31', US, ['22:00', '22:45', '23:30', '00:00']],
  ['America/Chicago', '2026-11-01', US, ['23:00', '23:45', '00:30', '01:00']],
  // Europe/Istanbul: UTC+3 all year; the EU change days (Mar 29, Oct 25) move nothing.
  ['Europe/Istanbul', '2026-03-28', TR, ['14:00', '14:45', '15:30', '16:00']],
  ['Europe/Istanbul', '2026-03-29', TR, ['14:00', '14:45', '15:30', '16:00']],
  ['Europe/Istanbul', '2026-10-24', TR, ['14:00', '14:45', '15:30', '16:00']],
  ['Europe/Istanbul', '2026-10-25', TR, ['14:00', '14:45', '15:30', '16:00']],
] as const) {
  Deno.test(`planLadder DST: ${tz} ${date} — 17:00, 17:45, 18:30 and 19:00 at the site`, () => {
    const s: SiteInput = { ...site, timezone: tz };
    const w = world({
      sites: [s],
      orgs: new Map([['org-1', orgOf('org-1', { timezone: tz, settings: allDays })]]),
      packs: new Map([['org-1', pack]]),
      days: [dayOf(date, tz)],
      reporters: new Map([['priya', rep('priya', { locale: pack === TR ? 'tr-TR' : 'en-US' })]]),
    });
    const start = new Date(deadlineInstant(date, '06:00', tz).getTime());
    const end = new Date(deadlineInstant(date, '23:55', tz).getTime());
    const r = simulateLadder(w, start.toISOString(), end.toISOString());
    assertEquals(r.sent.map(line), [
      '17:00 priya daily_link',
      '17:45 priya reminder_1',
      '18:30 priya reminder_2',
    ]);
    const utc = (i: number) => r.steps[i]!.deadlineAt; // all steps share the deadline
    assertEquals(utc(0).toISOString(), deadlineInstant(date, '17:30', tz).toISOString());
    assertEquals(r.missing.length, 1);
    assertEquals(r.missing[0]!.slice(11, 16), expected[3]);
    assertEquals(
      r.steps.map((x) => x.stage),
      ['daily_link', 'reminder_1', 'reminder_2'],
    );
    assertEquals(
      [
        deadlineInstant(date, '17:00', tz),
        deadlineInstant(date, '17:45', tz),
        deadlineInstant(date, '18:30', tz),
      ].map((d) => d.toISOString().slice(11, 16)),
      expected.slice(0, 3),
    );
  });
}

Deno.test(
  'ladderVars: §9.2 variables per key; the heads-up in the reporter’s language and the org’s units',
  () => {
    const base = {
      siteName: 'Elm St. Townhomes',
      link: 'https://go.sitelog.app/r/ABCDEFGHJKMN',
      voiceNumber: null,
      deadlineAt: new Date('2026-10-12T22:30:00Z'),
      missingAt: new Date('2026-10-13T00:00:00Z'),
      tz: 'America/Chicago',
      weather: rainy,
      locale: 'en-US',
      units: 'imperial' as const,
    };
    assertEquals(ladderVars('daily_link', base), { site: 'Elm St. Townhomes', link: base.link });
    assertEquals(
      ladderVars('daily_link', { ...base, voiceNumber: '+15550100000' }).number !== undefined,
      true,
    );
    assertEquals(ladderVars('reminder_1', base), { site: 'Elm St. Townhomes', link: base.link });
    assertEquals(ladderVars('reminder_2', base), { time: '19:00', link: base.link });
    assertEquals(ladderVars('weather_headsup', base), {
      deadline: '17:30',
      weather_phrase: 'It rained this morning (0.4 in)',
    });
    assertEquals(
      ladderVars('weather_headsup', { ...base, locale: 'es-US' }).weather_phrase,
      'Llovió esta mañana (0.4 in)',
    );
    assertEquals(
      ladderVars('weather_headsup', {
        ...base,
        locale: 'tr-TR',
        units: 'metric',
        tz: 'Europe/Istanbul',
      }),
      { deadline: '01:30', weather_phrase: 'Bu sabah yağmur yağdı (10,2 mm)' },
    );
    assertThrows(() => ladderVars('reminder_1', { ...base, link: null }));
  },
);
