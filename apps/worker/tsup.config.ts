import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  // Native / binary / large runtime deps stay external; @sitelog/shared is bundled from source.
  external: [
    'ffmpeg-static',
    'fluent-ffmpeg',
    '@react-pdf/renderer',
    '@sentry/node',
    'postgres',
    'openai',
    '@anthropic-ai/sdk',
    '@supabase/supabase-js',
    'resend',
    'react',
    'dotenv',
    'zod',
    'date-fns',
    'date-fns-tz',
  ],
  noExternal: ['@sitelog/shared'],
  // Embedded PDF fonts travel with the bundle (see src/pdf/fonts.ts for the lookup order).
  onSuccess: 'mkdir -p dist/fonts && cp src/pdf/fonts/*.ttf dist/fonts/',
});
