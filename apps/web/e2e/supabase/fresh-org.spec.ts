import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { admin, ANON_KEY, APP_URL, SUPABASE_URL } from './support';

/**
 * A brand-new customer on a deployment without the worker or the scheduler: one org and its
 * admin, then one site with no reporter, then a report typed in the panel. Every page must load
 * (no "Couldn't load …") and the typed report's PDF must be stored for its version.
 */
test.describe.configure({ mode: 'serial' });

const EMAIL = `fresh-${Date.now()}@sitelog.example`;
const PASSWORD = 'fresh-org-e2e-password';
let user: SupabaseClient;
let orgId = '';
let siteId = '';

const PAGES: Array<[path: string, heading: RegExp]> = [
  ['/', /Today across/],
  ['/sites', /Sites/],
  ['/reports', /Reports/],
  ['/reports/new', /New report/],
  ['/hours', /Crew hours/],
  ['/weather', /Weather & delays/],
  ['/team', /Team & numbers/],
  ['/glossary', /Site glossary/],
  ['/settings/reports', /Settings/],
  ['/settings/pdf', /Settings/],
  ['/settings/recipients', /Settings/],
  ['/billing', /Billing/],
];

async function signIn(page: Page) {
  const { data, error } = await admin().auth.admin.generateLink({
    type: 'magiclink',
    email: EMAIL,
    options: { redirectTo: `${APP_URL}/auth/callback` },
  });
  if (error) throw error;
  await page.goto(data.properties.action_link);
  await page.waitForURL((url) => url.origin === APP_URL && !url.pathname.startsWith('/auth'), {
    timeout: 30_000,
  });
}

/** Opens every panel page and fails on an error state or a missing heading. */
async function visitAll(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const [path, heading] of PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }), path).toHaveText(heading);
    await expect(page.getByText(/^Couldn’t load|^Couldn't load/), path).toHaveCount(0);
    await expect(page.getByText(/NaN|undefined|Invalid ISO date/), path).toHaveCount(0);
  }
  expect(errors).toEqual([]);
}

test.beforeAll(async () => {
  const created = await admin().auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  user = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const signedIn = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signedIn.error) throw signedIn.error;
  const org = await user.rpc('create_org', {
    p_name: 'Fresh Build Co',
    p_timezone: 'America/Chicago',
  });
  if (org.error) throw org.error;
  orgId = (org.data as { id?: string; org_id?: string }).id ?? '';
  if (!orgId) {
    const { data } = await user.from('org_members').select('org_id').limit(1).single();
    orgId = (data as { org_id: string }).org_id;
  }
});

test('a new org with no sites: every page loads', async ({ page }) => {
  await signIn(page);
  await visitAll(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Today across 0 sites/);
});

test('one site, no reporter and no site-days yet: every page loads', async ({ page }) => {
  const { data, error } = await user
    .from('sites')
    .insert({
      org_id: orgId,
      name: 'Harbor Lofts',
      project_code: 'HL-0101',
      timezone: 'America/Chicago',
      status: 'active',
    })
    .select('id')
    .single();
  if (error) throw error;
  siteId = (data as { id: string }).id;
  await signIn(page);
  await visitAll(page);
  await page.goto(`/sites/${siteId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Harbor Lofts');
  await expect(page.getByText(/^Couldn’t load|^Couldn't load/)).toHaveCount(0);
});

test('a typed report is filed with its PDF stored, then every page still loads', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/reports/new?site=${siteId}`);
  const editor = page.getByTestId('report-editor');
  await editor.getByRole('textbox').first().fill('Framing on level 2; drywall delivered.');
  await editor.getByRole('button', { name: 'Add work item' }).click();
  await editor.getByLabel('Activity').first().fill('Level 2 framing');
  await page.getByTestId('file-report').click();
  await page.waitForURL(/\/reports\/(?!new)[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByText(/Entered by .+ in SiteLog at/)).toBeVisible();

  const reportId = new URL(page.url()).pathname.split('/').at(-1)!;
  // The browser rendered the PDF, uploaded it and attached it to version 1.
  await expect
    .poll(
      async () =>
        (
          await admin()
            .from('report_versions')
            .select('pdf_path')
            .eq('report_id', reportId)
            .eq('version', 1)
            .single()
        ).data?.pdf_path ?? null,
      { timeout: 60_000 },
    )
    .toMatch(new RegExp(`^${orgId}/${siteId}/HL-0101-0001_v1\\.pdf$`));
  const { data: file, error } = await admin()
    .storage.from('pdfs')
    .download(`${orgId}/${siteId}/HL-0101-0001_v1.pdf`);
  if (error) throw error;
  expect(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 5))).toBe('%PDF-');

  await visitAll(page);
});
