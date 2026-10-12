import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { admin, pinSeedClock, SEED, signInWithMagicLink } from './support';

/**
 * §17 E2E web against a real local Supabase stack (migrations + seed.sql, Auth, PostgREST,
 * Realtime, Edge Functions): login via admin generateLink, Overview realtime flip, report edit →
 * new version, sign-off, hours CSV, EOT pack request. No worker runs, so the pack stays queued.
 * Specs share one database and run in order.
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

test('signing off a filed report records who signed it', async ({ page }) => {
  const { id, no } = SEED.pier9Report;
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
});

test('crew hours: Payroll CSV downloads from the export edge function', async ({ page }) => {
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
});

test('EOT evidence pack request creates a queued pack and build job', async ({ page }) => {
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
});
