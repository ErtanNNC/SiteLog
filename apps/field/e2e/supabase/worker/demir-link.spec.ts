import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { demoId, demoLinkCode } from '@sitelog/shared/demo/ids.ts';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { expectFieldScreen } from '../../support/checks.ts';
import { deviceCode, inList, rest, storageObject } from '../stack.ts';

/**
 * W4-16 · Demir Yapı's link report in Turkish on the stack through the worker (spec §16.2 M11
 * Done when: "the TR demo org completes link … reports end-to-end in Turkish, PDF in Turkish";
 * F4, F5, F8; §18.2). The seeded TR demo org, not an org of the spec's own: Emre Yıldız opens his
 * personal link at 390 px in a `tr-TR` browser, gets the device code (a console text: Demir Yapı
 * is a demo org) and records with the fake microphone; the CI worker's fake transcriber answers
 * with the Kartal voice note (`fixtures/voice/tr-kartal-2026-10-09`, the first Turkish report
 * clip) and the fake Claude with its golden extraction; Emre confirms the draft and the worker
 * files it. Every screen reads in Turkish (the field app's `tr` copy). Then the filed PDF from
 * Storage: A4, its text Turkish (`pdftotext`, which CI installs; a machine without it checks the
 * paper only), and the `filed` text in Turkish.
 *
 * Arranged for the run and put back after: Demir Yapı asks no question per report (the office's
 * Settings choice, as the self-serve spec makes it; the Kartal clip leaves crew hours open) and
 * works every day (CI runs on weekends too). A report of an earlier run on the same stack for
 * today is moved back a day first (one clock on the stack), so the day is free. Tagged `@m11`
 * (`pnpm e2e:m11`, after the worker started). Skips without the worker.
 */
test.describe.configure({ mode: 'serial' });
test.use({ locale: 'tr-TR' });

const copy = UI_RESOURCES.tr.field;
const DEMIR_ORG = demoId('org:demir');
const KARTAL = demoId('demir:site:kartal');
const EMRE = { id: demoId('demir:reporter:emre'), name: 'Emre Yıldız', phone: '+905320001203' };
const TZ = 'Europe/Istanbul';
const WAIT = 120_000;

type Settings = { max_questions_per_report: number; working_days: number[] };
let saved: Settings | null = null;

const hasPdftotext = !spawnSync('pdftotext', ['-v']).error;

function pdfText(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'sitelog-demir-'));
  try {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, pdf);
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const clearRateLimits = () =>
  rest('DELETE', `rate_limits?key=${inList([`code_send:${EMRE.phone}`, `code:${EMRE.phone}`])}`);

test.beforeAll(async () => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  const [settings] = await rest<Settings[]>(
    'GET',
    `org_settings?select=max_questions_per_report,working_days&org_id=eq.${DEMIR_ORG}`,
  );
  saved = settings!;
  await rest('PATCH', `org_settings?org_id=eq.${DEMIR_ORG}`, {
    max_questions_per_report: 0,
    working_days: [1, 2, 3, 4, 5, 6, 7],
  });
  await clearRateLimits();
  // Today's Kartal day from an earlier run on this stack: moved before the site's first day.
  const today = formatDateInTz(new Date(), TZ);
  const days = await rest<{ id: string; date: string; report_id: string | null }[]>(
    'GET',
    `site_days?select=id,date,report_id&site_id=eq.${KARTAL}&order=date.asc`,
  );
  const taken = days.find((d) => d.date === today && d.report_id);
  if (taken) {
    const before = new Date(`${days[0]!.date}T12:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    await rest('PATCH', `site_days?id=eq.${taken.id}`, { date: before.toISOString().slice(0, 10) });
  }
});

test.afterAll(async () => {
  if (saved) await rest('PATCH', `org_settings?org_id=eq.${DEMIR_ORG}`, saved);
  await clearRateLimits().catch(() => undefined);
});

test(
  'Emre files Kartal’s report by his link in Turkish; the PDF is Turkish, A4',
  { tag: ['@m11', '@F5'] },
  async ({ page }) => {
    test.setTimeout(300_000);
    const since = new Date().toISOString();
    await page.goto(`/r/${demoLinkCode(`personal:${EMRE.id}`)}`);

    // A new phone (F16): the device check in Turkish, the code from the console text.
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: copy.device.title.replace('{{name}}', EMRE.name),
      }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    const before = (
      await rest<{ id: string }[]>(
        'GET',
        `messages?select=id&reporter_id=eq.${EMRE.id}&copy_key=eq.verify_code`,
      )
    ).length;
    await page.getByRole('button', { name: copy.device.send }).click();
    const input = page.getByLabel(copy.device.codeLabel);
    await expect(input).toBeVisible();
    await input.fill(await deviceCode(EMRE.id, before));

    // §18.2: Emre consented already, so Today follows; a stack without his consents shows the
    // Welcome screen first, answered here in Turkish.
    const welcome = page.getByRole('checkbox', { name: copy.welcome.consentRequired });
    await expect
      .poll(async () => /\/today$/.test(page.url()) || (await welcome.isVisible()), {
        timeout: 30_000,
      })
      .toBe(true);
    if (await welcome.isVisible()) {
      await welcome.check();
      await page.getByRole('button', { name: copy.welcome.continue }).click();
      const skip = page.getByRole('button', { name: copy.welcomeTest.skip });
      if (await skip.isVisible({ timeout: 10_000 }).catch(() => false)) await skip.click();
    }
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('banner')).toContainText('Kartal Konutları — B Blok');
    await expectFieldScreen(page);

    // Record with the fake microphone, a little over the 5 s minimum, and send.
    await page.getByRole('link', { name: copy.today.record }).click();
    await expect(page.getByRole('button', { name: copy.recording.pause })).toBeEnabled();
    await expect(page.getByRole('timer')).toHaveText(/^00:0[5-9]$/, { timeout: 15_000 });
    await page.getByRole('button', { name: copy.recording.stopSend }).click();
    await expect(page).toHaveURL(/\/report\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const reportId = /\/report\/([0-9a-f-]{36})$/.exec(page.url())![1]!;

    // The worker transcribes and extracts (fake providers), no question: the draft in Turkish.
    await expect(page.getByRole('heading', { level: 1, name: copy.draft.title })).toBeVisible({
      timeout: WAIT,
    });
    await expectFieldScreen(page);
    await page.getByRole('button', { name: copy.draft.confirm }).click();
    await expect(page.getByRole('heading', { level: 1, name: copy.filed.title })).toBeVisible({
      timeout: WAIT,
    });
    await expect(page.getByRole('link', { name: new RegExp(`^${copy.filed.pdf}`) })).toBeVisible({
      timeout: WAIT,
    });
    await expectFieldScreen(page);

    const [report] = await rest<
      {
        org_id: string;
        report_no: string;
        status: string;
        channel: string;
        language: string;
        confirmed_via: string;
        current_version: number;
      }[]
    >(
      'GET',
      `reports?select=org_id,report_no,status,channel,language,confirmed_via,current_version&id=eq.${reportId}`,
    );
    expect(report).toMatchObject({
      org_id: DEMIR_ORG,
      status: 'filed',
      channel: 'web',
      language: 'tr',
      confirmed_via: 'web',
    });
    expect(report!.report_no).toMatch(/^KK-1203-\d{4}$/);

    // The PDF of the filed version: A4 (the TR pack's paper), its text Turkish.
    let pdfPath = '';
    await expect
      .poll(
        async () => {
          const [v] = await rest<{ pdf_path: string | null }[]>(
            'GET',
            `report_versions?select=pdf_path&report_id=eq.${reportId}&version=eq.${report!.current_version}`,
          );
          pdfPath = v?.pdf_path ?? '';
          return pdfPath;
        },
        { timeout: WAIT },
      )
      .not.toBe('');
    const pdf = await storageObject('pdfs', pdfPath);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.\d+ 841\.\d+\]/);
    if (hasPdftotext || process.env.CI) {
      const flat = pdfText(pdf).replace(/\s+/g, ' ');
      expect(flat).toContain('GÜNLÜK ŞANTİYE RAPORU');
      expect(flat).toContain('ŞANTİYEDEKİ İŞGÜCÜ');
      expect(flat).toContain('Kartal Konutları — B Blok');
      expect(flat).toContain(report!.report_no);
      expect(flat).toContain('Şantiye şefi raporu kayıt ekranında onayladı');
      expect(flat).not.toMatch(/Daily Site Report|DAILY SITE REPORT|WhatsApp/);
    }

    // The `filed` message in Turkish (§9.2), through the console driver of this demo org on
    // Emre's channel order (the Demo phone shows it).
    const filedTexts = async () =>
      (
        await rest<{ body: string; provider: string }[]>(
          'GET',
          `messages?select=body,provider&reporter_id=eq.${EMRE.id}&copy_key=eq.filed&created_at=gte.${encodeURIComponent(since)}`,
        )
      ).filter((m) => m.body.includes(report!.report_no));
    await expect.poll(async () => (await filedTexts()).length, { timeout: WAIT }).toBe(1);
    const [filed] = await filedTexts();
    expect(filed!.provider).toBe('console');
    expect(filed!.body).toContain(`Günlük Rapor ${report!.report_no}`);
  },
);
