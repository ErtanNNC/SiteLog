import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { FIELD_PREVIEW_PORT } from './config/server.ts';
import { writeFakeSpeech } from './e2e/support/fakeSpeech.ts';

/** Its own port, next to `pnpm preview`'s (4174), so a preview you started by hand is never reused. */
const PORT = FIELD_PREVIEW_PORT + 1;
const baseURL = `http://localhost:${PORT}`;

/** The sandbox's Chromium when present (as in apps/web); CI installs the matching browser. */
export const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * The Recording screen needs a microphone (W1-09): Chromium's fake capture device with the
 * permission prompt answered yes, so `getUserMedia` and `MediaRecorder` run as on a phone. It plays
 * a speech-like sound (`e2e/support/fakeSpeech.ts`): its default beep is too short for the level
 * meter, and the screen would refuse the clip as silent.
 */
const FAKE_SPEECH = writeFakeSpeech(
  resolve(import.meta.dirname, 'node_modules/.e2e/fake-speech.wav'),
);

export const FAKE_MEDIA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${FAKE_SPEECH}`,
];

/** §14.6 / CLAUDE.md: every field screen works at 390 px (a phone, touch). */
export const PHONE_390 = {
  ...devices['Desktop Chrome'],
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

/**
 * The field app's smoke test runs against the production build (`vite preview`), the shape that is
 * deployed and installed: service worker, manifest and icons included. The build goes to its own
 * folder so it never touches `dist/`. `e2e/screens.spec.ts` drives the W1-09 screens on a fake
 * field-api (Playwright routes, no Supabase); `e2e/supabase/` is the stack's own config
 * (`playwright.supabase.config.ts`).
 */
const E2E_DIST = 'node_modules/.e2e/field';

export default defineConfig({
  testDir: './e2e',
  testIgnore: /\/supabase\//,
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: { executablePath: chromiumExecutablePath, args: FAKE_MEDIA_ARGS },
  },
  projects: [{ name: 'phone-390', use: PHONE_390 }],
  webServer: {
    command: `pnpm exec vite build --outDir ${E2E_DIST} --emptyOutDir && pnpm exec vite preview --outDir ${E2E_DIST} --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
