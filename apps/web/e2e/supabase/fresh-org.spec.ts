import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { admin, ANON_KEY, APP_URL, SUPABASE_URL } from './support';

/**
 * A brand-new customer on a deployment without the worker or the scheduler: one org and its
 * admin, then one site with no reporter, then a report typed in the panel with a photo. Every
 * page must load (no "Couldn't load …"), the photo must be stored and listed by the version, and
 * the typed report's PDF (with the photo) must be stored for its version.
 *
 * The org is created with the deployed v1.0 panel's create_org call (four named arguments, no
 * country): since W1-06a it resolves to create_org(p_country default 'US') and makes a US org.
 * A second customer creates a TR org through the setup wizard's country choice (spec §4.6).
 */
const SITE_PHOTO = fileURLToPath(new URL('../fixtures/site-photo.png', import.meta.url));
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

async function signIn(page: Page, email = EMAIL) {
  const { data, error } = await admin().auth.admin.generateLink({
    type: 'magiclink',
    email,
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
  // The deployed v1.0 panel's payload, as it still is on staging until W1-19.
  const org = await user.rpc('create_org', {
    p_name: 'Fresh Build Co',
    p_timezone: 'America/Chicago',
    p_address: null,
    p_license_no: null,
  });
  if (org.error) throw org.error;
  orgId = (org.data as { id?: string; org_id?: string }).id ?? '';
  if (!orgId) {
    const { data } = await user.from('org_members').select('org_id').limit(1).single();
    orgId = (data as { org_id: string }).org_id;
  }
});

test('the v1.0 panel’s create_org call (no country) still makes a US org', async () => {
  const { data, error } = await admin()
    .from('orgs')
    .select('country, locale, units, currency, timezone, org_settings(pdf_paper)')
    .eq('id', orgId)
    .single();
  if (error) throw error;
  expect(data).toEqual({
    country: 'US',
    locale: 'en-US',
    units: 'imperial',
    currency: 'USD',
    timezone: 'America/Chicago',
    org_settings: { pdf_paper: 'letter' },
  });
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

test('a typed report is filed with a photo and its PDF stored, then every page still loads', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/reports/new?site=${siteId}`);
  const editor = page.getByTestId('report-editor');
  await editor.getByRole('textbox').first().fill('Framing on level 2; drywall delivered.');
  await editor.getByRole('button', { name: 'Add work item' }).click();
  await editor.getByLabel('Activity').first().fill('Level 2 framing');
  const picker = editor.getByTestId('photo-picker');
  await picker.getByTestId('photo-input').setInputFiles(SITE_PHOTO);
  await expect(picker.getByRole('img', { name: 'Photo 1' })).toBeVisible();
  await picker.getByLabel('Caption for photo 1').fill('Level 2 deck');
  await page.getByTestId('file-report').click();
  await page.waitForURL(/\/reports\/(?!new)[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByText(/Entered by .+ in SiteLog at/)).toBeVisible();

  const reportId = new URL(page.url()).pathname.split('/').at(-1)!;
  // The photo: a JPEG in the private bucket, an office upload (no reporter, uploaded by the
  // signed-in user, no message: 20261014000002), a photo source of the report with its upload_id
  // and the one entry of version 1's data.photos; the report page shows it from a signed URL.
  const { data: sources, error: sourcesError } = await admin()
    .from('report_sources')
    .select(
      'upload_id, message_id, caption, taken_at, uploads(storage_path, mime, site_id, reporter_id, uploaded_by, caption)',
    )
    .eq('report_id', reportId)
    .eq('kind', 'photo');
  if (sourcesError) throw sourcesError;
  expect(sources).toHaveLength(1);
  const source = sources![0] as unknown as {
    upload_id: string;
    message_id: string | null;
    caption: string | null;
    taken_at: string;
    uploads: {
      storage_path: string;
      mime: string;
      site_id: string;
      reporter_id: string | null;
      uploaded_by: string | null;
      caption: string | null;
    };
  };
  expect(source.caption).toBe('Level 2 deck');
  expect(source.message_id).toBeNull();
  expect(source.uploads).toMatchObject({
    site_id: siteId,
    reporter_id: null,
    uploaded_by: expect.any(String),
    mime: 'image/jpeg',
    caption: 'Level 2 deck',
  });
  expect(source.uploads.storage_path).toMatch(
    new RegExp(`^${orgId}/${siteId}/office/[0-9a-f-]{36}\\.jpg$`),
  );
  const { data: photoFile, error: photoError } = await admin()
    .storage.from('photos')
    .download(source.uploads.storage_path);
  if (photoError) throw photoError;
  expect([...new Uint8Array((await photoFile.arrayBuffer()).slice(0, 3))]).toEqual([
    0xff, 0xd8, 0xff,
  ]);
  // Filed by the office in the org's report language (D13).
  const { data: filed, error: filedError } = await admin()
    .from('reports')
    .select('channel, language')
    .eq('id', reportId)
    .single();
  if (filedError) throw filedError;
  expect(filed).toEqual({ channel: 'office', language: 'en' });
  const { data: v1, error: v1Error } = await admin()
    .from('report_versions')
    .select('data')
    .eq('report_id', reportId)
    .eq('version', 1)
    .single();
  if (v1Error) throw v1Error;
  // W1-12: the panel files schemaVersion 2, whose photos name their upload.
  const typed = (v1 as { data: { schemaVersion: number; photos: unknown[] } }).data;
  expect(typed.schemaVersion).toBe(2);
  expect(typed.photos).toEqual([
    { uploadId: source.upload_id, caption: 'Level 2 deck', takenAt: expect.any(String) },
  ]);
  const shown = page.getByTestId('section-photos').getByRole('img', { name: 'Level 2 deck' });
  await expect(shown).toBeVisible();
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(48);

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
  const pdf = new TextDecoder('latin1').decode(await file.arrayBuffer());
  expect(pdf.slice(0, 5)).toBe('%PDF-');
  // "08 Site photos" embeds the photo.
  expect(pdf).toMatch(/\/Subtype\s*\/Image/);

  await visitAll(page);
});

// Spec §19 Q32 (W4-01): a browser in tr-TR has Türkiye preselected before the org exists.
test.describe('in a tr-TR browser', () => {
  test.use({ locale: 'tr-TR' });

  test('the setup wizard creates a TR org from its country pack (W1-06a)', async ({ page }) => {
    const email = `fresh-tr-${Date.now()}@sitelog.example`;
    const created = await admin().auth.admin.createUser({ email, email_confirm: true });
    if (created.error) throw created.error;
    const userId = created.data.user.id;
    await signIn(page, email);
    await expect(page.getByRole('heading', { name: 'Set up your company' })).toBeVisible();
    await page.getByLabel('Company name').fill('Yıldız İnşaat A.Ş.');
    // Preselected from the browser's region (Q32), by code: ICU names it "Türkiye" or "Turkey".
    await expect(page.getByRole('combobox', { name: 'Country' })).toHaveText(/\bTR$/);
    // Copy names (not the browser's); the zone is the select's alone.
    const presets = page.getByTestId('country-presets');
    for (const text of ['Turkish', 'Metric', 'A4', 'TRY'])
      await expect(presets.getByText(text, { exact: true })).toBeVisible();
    await expect(presets).not.toContainText('Europe/Istanbul');
    await expect(page.getByRole('combobox', { name: 'Company time zone' })).toContainText(
      'Europe/Istanbul',
    );
    await page.getByRole('button', { name: 'Continue to first site' }).click();
    await page.waitForURL(/\/setup\/site$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Site', exact: true })).toBeVisible();
    // The first site manager starts with a +90 number and Turkish, the pack's field language.
    await expect(page.getByRole('button', { name: /^Country code: / })).toHaveText(/TR \+90/);
    await expect(page.getByRole('checkbox', { name: 'Turkish' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByText('Reports always come out in Turkish.')).toBeVisible();

    // create_org preset everything from the TR row; on_org_created the paper.
    const { data: member, error: memberError } = await admin()
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .single();
    if (memberError) throw memberError;
    expect(member.role).toBe('admin');
    const { data: org, error: orgError } = await admin()
      .from('orgs')
      .select('name, country, locale, units, currency, timezone, org_settings(pdf_paper)')
      .eq('id', member.org_id)
      .single();
    if (orgError) throw orgError;
    expect(org).toEqual({
      name: 'Yıldız İnşaat A.Ş.',
      country: 'TR',
      locale: 'tr-TR',
      units: 'metric',
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      org_settings: { pdf_paper: 'a4' },
    });
    const { data: audit, error: auditError } = await admin()
      .from('audit_log')
      .select('diff')
      .eq('org_id', member.org_id)
      .eq('action', 'org.created')
      .single();
    if (auditError) throw auditError;
    expect(audit.diff).toEqual({ country: 'TR' });

    // Settings → PDF shows the preset A4 paper.
    await page.goto('/settings/pdf');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Settings/);
    await expect(page.getByRole('radio', { name: 'A4' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Letter' })).not.toBeChecked();
  });
});
