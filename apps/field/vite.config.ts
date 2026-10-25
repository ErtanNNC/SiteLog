/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fieldServers, proxyWarning } from './config/server.ts';
import { pwaOptions } from './config/pwa.ts';
import { fieldRedirectsPlugin } from './config/redirects.ts';

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Server-side values for the /api proxy, the build's _redirects (D43) and the allowed hosts: the
  // shell's environment first, then apps/field/.env*, then the root .env (where SUPABASE_URL and
  // FIELD_APP_URL live, spec §5.1). Only VITE_* from apps/field/.env* reach the bundle (Vite's envDir
  // is this folder).
  const env = { ...loadEnv(mode, ROOT_DIR, ''), ...loadEnv(mode, APP_DIR, '') };
  const warning = proxyWarning(env);
  if (warning && mode !== 'test') console.warn(warning);

  return {
    plugins: [react(), tailwindcss(), VitePWA(pwaOptions), fieldRedirectsPlugin(env)],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    ...fieldServers(env),
    build: { sourcemap: process.env.VITE_SOURCEMAP !== 'false' },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
      // §19 Q378: the tests run with Turkish on; `*LanguagesFor(false)` covers the deployed builds.
      env: { VITE_TURKISH: 'true' },
      include: ['src/**/*.test.{ts,tsx}', 'config/**/*.test.ts'],
      css: false,
      restoreMocks: true,
    },
  };
});
