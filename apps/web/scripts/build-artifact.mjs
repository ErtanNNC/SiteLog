#!/usr/bin/env node
/**
 * Builds the hosted demo: the panel in demo mode (in-memory §18 data, no Supabase) with in-memory
 * routing and relative asset paths, then rewrites index.html into the page-body form the Artifact
 * host expects (it wraps the page in its own <html>/<head>/<body>). Output: dist-artifact/.
 *
 *   pnpm --filter @sitelog/web build:artifact
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-artifact';
rmSync(OUT, { recursive: true, force: true });
execFileSync('pnpm', ['exec', 'vite', 'build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_DEMO: 'true',
    VITE_ROUTER: 'memory',
    VITE_BASE: './',
    VITE_SOURCEMAP: 'false',
    VITE_OUT_DIR: OUT,
    VITE_SUPABASE_URL: '',
    VITE_SUPABASE_ANON_KEY: '',
    VITE_SENTRY_DSN: '',
  },
});

const html = readFileSync(join(OUT, 'index.html'), 'utf8');
const head = /<head>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? '';
const keep = head
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !/^<meta (charset|name="viewport")/i.test(l))
  .join('\n')
  // Published files are referenced relative and without "./" (Artifact files map).
  .replaceAll('"./', '"')
  .replace(/<title>[^<]*<\/title>/, '<title>TalkOlog Demo</title>');
writeFileSync(join(OUT, 'index.html'), `${keep}\n${body.trim().replaceAll('"./', '"')}\n`);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p !== join(OUT, 'index.html')) files.push(p.slice(OUT.length + 1));
  }
};
walk(OUT);
writeFileSync(join(OUT, 'files.json'), JSON.stringify(files.sort(), null, 2));
const bytes = files.reduce((a, f) => a + statSync(join(OUT, f)).size, 0);
console.log(
  `dist-artifact: index.html + ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`,
);
