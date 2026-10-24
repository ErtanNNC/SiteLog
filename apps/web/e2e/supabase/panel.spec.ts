import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { admin, pinSeedClock, SEED, signInWithMagicLink } from './support';

/**
 * §17 E2E web against a real local Supabase stack (migrations + seed.sql, Auth, PostgREST,
 * Realtime, Edge Functions): login via admin generateLink, Overview realtime flip, report edit →
 * new version, sign-off, hours CSV, EOT pack request. No worker runs, so the pack stays queued.
 * Specs share one database and run in order. The hours CSV and the EOT pack belong to the M9
 * acceptance suite (W3-18, `pnpm e2e:m9`, `@m9 @F19` / `@F20`), which runs before the worker starts.
 */
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await pinSeedClock(page);
  await signInWithMagicLink(page);
});

/** Resolves once Realtime confirms the org channel's postgres_changes subscription. */
function realtimeReady(page: Page): Promise<void> {
  return new Promise((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        const text = typeof payload === 'string' ? payload : payload.toString('utf8');
        if (text.includes('Subscribed to PostgreSQL')) resolve();
      });
    });
  });
}

test('magic-link sign-in lands on the Overview with the seeded sites', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Today across 6 sites' })).toBeVisible();
  // lena@kestrelbuild.example is in Kestrel Build Group only (W1-06; the TR demo org has its own
  // admin, Elif Aydın, demir.spec.ts). Chromium names the switcher with a space before the comma:
  // the purpose is an `sr-only` span, a block in the name computation (jsdom: Sidebar.test.tsx).
  await expect(
    page.getByRole('button', { name: /^Kestrel Build Group 6 active sites ?, Switch company$/ }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('demo-chip')).toHaveCount(0);
  await expect(page.getByTestId('kpi-reports-in')).toHaveText(/4\s*\/\s*6/);
  const table = page.getByRole('table', { name: 'Sites today' });
  for (const name of ['Riverside Lofts — Block B', 'Elm St. Townhomes', 'Oakmont Medical Center']) {
    await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('needs-attention').locator('[data-kind]').first()).toHaveAttribute(
    'data-kind',
    'missing',
  );
});

test('realtime: a site-day change on the server flips the Overview row without a reload', async ({
  page,
}) => {
  const ready = realtimeReady(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Today across 6 sites' })).toBeVisible();
  const row = page
    .getByRole('table', { name: 'Sites today' })
    .getByRole('row')
    .filter({ hasText: 'Elm St. Townhomes' });
  await expect(row).toContainText('Missing');
  await ready;
  await page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });

  try {
    await admin()
      .from('site_days')
      .update({ status: 'no_work' })
      .eq('id', SEED.elmSiteDay)
      .throwOnError();
    await expect(row).toContainText('No work', { timeout: 15_000 });
    await expect(page.getByTestId('needs-attention').locator('[data-kind="missing"]')).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true);
  } finally {
    await admin()
      .from('site_days')
      .update({ status: 'missing' })
      .eq('id', SEED.elmSiteDay)
      .throwOnError();
  }
});

// W1-16: a report filed on the server (as the worker's file_report leaves it: a filed report on
// the web channel and its site-day `filed`) flips the Overview row without a reload. Realtime is
// the fast path; the page's 10 s poll (OVERVIEW_POLL_MS) would also get there within the timeout.
test('realtime: server-side filing flips the Overview row to Filed with its channel', async ({
  page,
}) => {
  const ready = realtimeReady(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Today across 6 sites' })).toBeVisible();
  const row = page
    .getByRole('table', { name: 'Sites today' })
    .getByRole('row')
    .filter({ hasText: 'Elm St. Townhomes' });
  await expect(row).toContainText('Missing');
  await expect(row.getByText('Reports by text link')).toBeAttached();
  await ready;
  await page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });

  const { data: priya } = await admin()
    .from('reporters')
    .select('id')
    .eq('org_id', SEED.orgId)
    .eq('name', 'Priya Raman')
    .single()
    .throwOnError();
  const { data: report } = await admin()
    .from('reports')
    .insert({
      org_id: SEED.orgId,
      site_id: SEED.sites.elm,
      site_day_id: SEED.elmSiteDay,
      report_no: 'ES-0377-E2E-W116',
      status: 'filed',
      reporter_id: priya.id,
      received_at: '2026-10-09T23:58:00Z',
      confirmed_at: '2026-10-10T00:01:00Z',
      filed_at: '2026-10-10T00:01:00Z',
      is_late: true,
      channel: 'web',
      language: 'en',
    })
    .select('id')
    .single()
    .throwOnError();
  try {
    await admin()
      .from('site_days')
      .update({ status: 'filed', report_id: report.id, is_late: true })
      .eq('id', SEED.elmSiteDay)
      .throwOnError();
    await expect(row).toContainText('Filed', { timeout: 15_000 });
    await expect(row).toContainText('18:58');
    await expect(row.getByText('Reported by text link')).toBeAttached();
    await expect(page.getByTestId('needs-attention').locator('[data-kind="missing"]')).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true);
  } finally {
    await admin()
      .from('site_days')
      .update({ status: 'missing', report_id: null, is_late: false })
      .eq('id', SEED.elmSiteDay)
      .throwOnError();
    await admin().from('reports').delete().eq('id', report.id).throwOnError();
  }
});

// W1-16: "Text today's link" through api-text-daily-link. Kestrel is a demo org, so the text goes
// through the console driver and lands in `messages` (and the Demo phone); the link row is today's
// (the function's clock, not the page's pinned one) and its code is never in the answer.
test('Text today’s link texts Priya her daily link through the Notifier', async ({ page }) => {
  const since = new Date().toISOString();
  const { data: priya } = await admin()
    .from('reporters')
    .select('id')
    .eq('org_id', SEED.orgId)
    .eq('name', 'Priya Raman')
    .single()
    .throwOnError();
  const missing = page.getByTestId('needs-attention').locator('[data-kind="missing"]');
  const answer = page.waitForResponse((r) => r.url().endsWith('/functions/v1/api-text-daily-link'));
  await missing.getByRole('button', { name: 'Text today’s link' }).click();
  const res = await answer;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ sent: true, channel: 'sms', reporterId: priya.id });
  expect(JSON.stringify(body)).not.toMatch(/\/r\//);
  await expect(page.getByText('Today’s link texted to Priya.')).toBeVisible();

  const { data: texts } = await admin()
    .from('messages')
    .select('copy_key, provider, status, body, channel')
    .eq('reporter_id', priya.id)
    .eq('copy_key', 'daily_link')
    .gte('created_at', since)
    .throwOnError();
  expect(texts).toEqual([
    expect.objectContaining({ provider: 'console', status: 'delivered', channel: 'sms' }),
  ]);
  expect(texts[0]!.body).toMatch(/^Today's report for Elm St\. Townhomes: \S+\/r\/[A-Z0-9]{6}/);
  const { data: links } = await admin()
    .from('field_links')
    .select('kind, site_id, expires_at')
    .eq('reporter_id', priya.id)
    .eq('kind', 'daily')
    .gte('created_at', since)
    .throwOnError();
  expect(links).toEqual([expect.objectContaining({ kind: 'daily', site_id: SEED.sites.elm })]);
  const { data: audit } = await admin()
    .from('audit_log')
    .select('action, actor_id')
    .eq('org_id', SEED.orgId)
    .eq('action', 'daily_link.texted')
    .gte('created_at', since)
    .throwOnError();
  expect(audit).toEqual([{ action: 'daily_link.texted', actor_id: SEED.admin.id }]);
});

test('editing a report saves a new version with the change note', async ({ page }) => {
  const { id, no } = SEED.northgateReport;
  const { data: before } = await admin()
    .from('reports')
    .select('current_version')
    .eq('id', id)
    .single()
    .throwOnError();
  const next = (before.current_version as number) + 1;
  const summary = `Deck pour on level 3 finished by 14:00 (E2E edit v${next}).`;
  const note = `Corrected the summary after the PM call (E2E v${next})`;

  await page.goto(`/reports/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Northgate');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Summary', { exact: true }).fill(summary);
  await page.getByTestId('save-version').click();

  const dialog = page.getByRole('dialog', { name: `Save ${no} as a new version?` });
  await expect(dialog).toContainText(`This becomes version ${next}.`);
  await dialog.getByLabel('Change note').fill(note);
  await dialog.getByTestId('confirm-save').click();

  await expect(page).toHaveURL(new RegExp(`/reports/${id}\\?v=${next}$`));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(summary)).toBeVisible();
  await expect(page.getByText(note).first()).toBeVisible();

  const { data: versions } = await admin()
    .from('report_versions')
    .select('version, change_note, author, author_user_id, summary')
    .eq('report_id', id)
    .order('version')
    .throwOnError();
  expect(versions.at(-1)).toMatchObject({
    version: next,
    change_note: note,
    author: 'office_user',
    author_user_id: SEED.admin.id,
  });
  const { data: after } = await admin()
    .from('reports')
    .select('current_version')
    .eq('id', id)
    .single()
    .throwOnError();
  expect(after.current_version).toBe(next);
});

test('demo step 6: clicking the rain stoppage plays the voice note from its timestamp', async ({
  page,
}) => {
  const { id } = SEED.heroReport;
  await page.goto(`/reports/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Riverside');
  await expect(page.getByTestId('provenance')).toContainText(
    'Reported by Marco Ruiz · voice note via text link at 17:38',
  );
  // Every clip of the report has its player: the 17:38 note and the 20:09 correction (F10).
  const players = page.getByTestId('media-player');
  await expect(players).toHaveCount(2);
  const note = players.first();
  await page
    .getByTestId('weather-period')
    .first()
    .getByRole('button', { name: /^audio 0:41/ })
    .click();
  // No audio file is seeded in Storage: the player still jumps to 0:41 and runs from there.
  await expect(note.getByTestId('player-position')).toHaveAttribute('aria-valuetext', /^0:4\d$/);
  await expect(note.getByTestId('player-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.locator('[data-testid="transcript-excerpt"][data-active="true"]').first(),
  ).toContainText('Llovió');
});

test('signing off a filed report records who signed it', async ({ page }) => {
  const { id, no } = SEED.pier9Report;
  const startedAt = new Date(Date.now() - 1000).toISOString();
  // Re-runnable against the same stack: start from the seeded `filed` state.
  await admin()
    .from('reports')
    .update({ status: 'filed', signed_off_by: null, signed_off_at: null })
    .eq('id', id)
    .throwOnError();

  await page.goto(`/reports/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Pier 9');
  await page.getByTestId('sign-off').click();
  const dialog = page.getByRole('dialog', { name: `Sign off ${no} v1?` });
  await dialog.getByRole('button', { name: 'Sign off', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('signed-off-state')).toContainText('Signed off by Lena Ortiz');

  const { data: report } = await admin()
    .from('reports')
    .select('status, signed_off_by, signed_off_at')
    .eq('id', id)
    .single()
    .throwOnError();
  expect(report).toMatchObject({ status: 'signed_off', signed_off_by: SEED.admin.id });
  expect(report.signed_off_at).not.toBeNull();
  // Demo step 7: the sign-off is in the audit log, by the signed-in admin, for this version.
  const { data: audit } = await admin()
    .from('audit_log')
    .select('actor_type, actor_id, action, entity, diff, created_at')
    .eq('entity_id', id)
    .eq('action', 'report.signed_off')
    .gte('created_at', startedAt)
    .throwOnError();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_type: 'user',
    actor_id: SEED.admin.id,
    entity: 'report',
    diff: { version: 1 },
  });
  // The report's Activity shows it.
  await expect(
    page.getByTestId('activity').locator('[data-kind="signed_off"]').last(),
  ).toBeVisible();
});

test(
  'crew hours: Payroll CSV downloads from the export edge function',
  { tag: ['@m9', '@F19'] },
  async ({ page }) => {
    await page.goto('/hours?week=2026-W41');
    await expect(page.getByTestId('hours-matrix')).toBeVisible();
    const exported = page.waitForResponse(
      (r) => r.url().includes('/functions/v1/api-export-payroll') && r.request().method() === 'GET',
    );
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Payroll CSV' }).click();
    expect((await exported).status()).toBe(200);
    const file = await download;
    expect(file.suggestedFilename()).toBe('payroll-2026-W41.csv');
    const csv = await readFile((await file.path())!, 'utf8');
    const [header, ...rows] = csv.trim().split(/\r?\n/);
    expect(header).toBe('date,site,project_code,company,trade,workers,hours,report_no,version');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => /^2026-10-(0[5-9]|1[01]),/.test(r))).toBe(true);
    expect(csv).toContain('RL-2041-0187');
  },
);

test(
  'EOT evidence pack request creates a queued pack and build job',
  { tag: ['@m9', '@F20'] },
  async ({ page }) => {
    const requestedAfter = new Date().toISOString();
    await page.goto(`/weather?site=${SEED.sites.riverside}&month=2026-10`);
    await expect(page.getByTestId('delay-log')).toBeVisible();
    await page.getByRole('button', { name: 'Build EOT evidence pack' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'EOT evidence pack' });
    await expect(dialog.getByRole('combobox', { name: 'Site' })).toContainText('Riverside');
    const created = page.waitForResponse(
      (r) => r.url().includes('/functions/v1/api-evidence-pack') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Generate PDF pack' }).click();
    expect((await created).status()).toBe(201);
    await expect(dialog).toHaveCount(0);
    // No worker in this stack: the pack stays queued in the history list.
    await expect(page.getByTestId('pack-history').getByTestId('pack-status').first()).toHaveText(
      'Queued',
    );

    const { data: packs } = await admin()
      .from('evidence_packs')
      .select('id, site_id, status, period_start, period_end, created_by')
      .eq('org_id', SEED.orgId)
      .gte('created_at', requestedAfter)
      .throwOnError();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      site_id: SEED.sites.riverside,
      status: 'queued',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      created_by: SEED.admin.id,
    });
    const { data: jobs } = await admin()
      .from('jobs')
      .select('type, status, payload')
      .eq('type', 'build_evidence_pack')
      .eq('payload->>packId', packs[0]!.id)
      .throwOnError();
    expect(jobs).toEqual([
      expect.objectContaining({ type: 'build_evidence_pack', status: 'queued' }),
    ]);
  },
);
