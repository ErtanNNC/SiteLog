/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // `./` for the hosted demo (scripts/build-artifact.mjs): served from a sub-path, not the root.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: {
    sourcemap: process.env.VITE_SOURCEMAP !== 'false',
    outDir: process.env.VITE_OUT_DIR ?? 'dist',
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
