import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

const FONTS = '../../packages/pdf/src/fonts';

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
  // Native / binary / large runtime deps stay external; @sitelog/shared and @sitelog/pdf are bundled from source.
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
  noExternal: ['@sitelog/shared', '@sitelog/pdf'],
  // Embedded PDF fonts travel with the bundle (see fontsDir() in src/pdf/render.ts).
  onSuccess: async () => {
    await mkdir('dist/fonts', { recursive: true });
    for (const f of await readdir(FONTS))
      if (f.endsWith('.ttf')) await copyFile(`${FONTS}/${f}`, `dist/fonts/${f}`);
  },
});
