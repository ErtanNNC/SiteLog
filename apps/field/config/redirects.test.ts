// @vitest-environment node
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fieldApiTarget,
  fieldRedirects,
  fieldRedirectsPlugin,
  REDIRECTS_FILE,
  SPA_FALLBACK_RULE,
} from './redirects';
import viteConfig from '../vite.config';

/** The rules of a `_redirects` text, without comments and blank lines. */
const rules = (content: string) =>
  content.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));

/** Runs the plugin's build hooks as Rollup would, and returns the emitted file and the warnings. */
function runPlugin(plugin: Plugin) {
  const emitted: { type: string; fileName?: string; source?: unknown }[] = [];
  const warnings: string[] = [];
  const ctx = {
    emitFile: (file: (typeof emitted)[number]) => {
      emitted.push(file);
      return 'ref';
    },
    warn: (message: string) => warnings.push(message),
  };
  const call = (hook: unknown) => {
    const fn = typeof hook === 'function' ? hook : (hook as { handler?: unknown })?.handler;
    if (typeof fn === 'function') (fn as (...a: unknown[]) => void).call(ctx, {}, {}, false);
  };
  call(plugin.buildStart);
  call(plugin.generateBundle);
  return { emitted, warnings };
}

describe('_redirects for the field host (D43, §6.5)', () => {
  it('forwards /api/* to field-api first and falls back to the app second', () => {
    const { content, apiRule, warning } = fieldRedirects(
      'https://abcdefghijklmnopqrst.supabase.co',
    );
    expect(warning).toBeNull();
    expect(apiRule).toBe(
      '/api/*  https://abcdefghijklmnopqrst.supabase.co/functions/v1/field-api/:splat  200',
    );
    expect(rules(content)).toEqual([apiRule, SPA_FALLBACK_RULE]);
    expect(SPA_FALLBACK_RULE).toBe('/*  /index.html  200');
    expect(content.endsWith('\n')).toBe(true);
    // Netlify reads `#` lines as comments; the file says where it comes from.
    expect(content.split('\n')[0]).toMatch(/^# Generated at build time/);
  });

  it('has no /api rule without a Supabase URL (CI, demo, a preview with no project)', () => {
    for (const url of [undefined, '', '   ']) {
      const { content, apiRule, warning } = fieldRedirects(url);
      expect(apiRule).toBeNull();
      expect(warning).toBeNull();
      expect(rules(content)).toEqual([SPA_FALLBACK_RULE]);
      expect(content).not.toMatch(/^\/api/m);
    }
  });

  it('normalises the project URL: trailing slashes, default port, host case, a gateway path', () => {
    expect(fieldApiTarget('https://abc.supabase.co/')).toEqual({
      ok: true,
      target: 'https://abc.supabase.co/functions/v1/field-api',
    });
    expect(fieldApiTarget('  https://ABC.supabase.co:443//  ')).toEqual({
      ok: true,
      target: 'https://abc.supabase.co/functions/v1/field-api',
    });
    expect(fieldApiTarget('https://gw.example.com/supabase/')).toEqual({
      ok: true,
      target: 'https://gw.example.com/supabase/functions/v1/field-api',
    });
    // A local stack (`supabase start`) over plain http, for a local build.
    expect(fieldApiTarget('http://127.0.0.1:54321')).toEqual({
      ok: true,
      target: 'http://127.0.0.1:54321/functions/v1/field-api',
    });
    expect(fieldApiTarget('http://localhost:54321').ok).toBe(true);
    expect(fieldApiTarget('http://[::1]:54321').ok).toBe(true);
  });

  it('reads the host as a browser does (lower case, escapes decoded)', () => {
    // So the deploy job compares the host the rule forwards to, not the text it was given
    // (.github/workflows/deploy.yml, job field, step Build).
    for (const url of [
      'https://ABCDEFGHIJKLMNOPQRST.supabase.co',
      'https://%61bcdefghijklmnopqrst.supabase.co',
      'https://\uff41bcdefghijklmnopqrst.supabase.co',
    ]) {
      expect(fieldApiTarget(url), url).toEqual({
        ok: true,
        target: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/field-api',
      });
    }
  });

  it('refuses a URL of the wrong shape, says why, and writes no /api rule', () => {
    const refused: [string, RegExp][] = [
      ['https://<ref>.supabase.co', /placeholders/],
      ['https://abc .supabase.co', /spaces/],
      ['abc.supabase.co', /not a URL/],
      ['127.0.0.1:54321', /scheme|not a URL/],
      ['ftp://abc.supabase.co', /scheme is ftp/],
      ['javascript:alert(1)', /scheme/],
      ['http://abc.supabase.co', /plain http/],
      ['http://192.168.1.20:54321', /plain http/],
      ['https://user:pw@abc.supabase.co', /credentials/],
      ['https://abc.supabase.co?x=1', /query/],
      ['https://abc.supabase.co/#x', /fragment/],
      ['https://abc.supabase.co/:splat', /path/],
      ['https://abc.supabase.co/*', /path/],
      ['https://abc.supabase.co/functions/v1/field-api', /function URL/],
      ['https://abc.supabase.co/functions/v1', /function URL/],
    ];
    for (const [url, reason] of refused) {
      const checked = fieldApiTarget(url);
      expect(checked.ok, url).toBe(false);
      if (!checked.ok) expect(checked.reason, url).toMatch(reason);
      const { content, apiRule, warning } = fieldRedirects(url);
      expect(apiRule, url).toBeNull();
      expect(rules(content), url).toEqual([SPA_FALLBACK_RULE]);
      expect(warning, url).toMatch(/not used for _redirects/);
    }
  });
});

describe('fieldRedirectsPlugin', () => {
  it('emits _redirects on build only, from SUPABASE_URL, else VITE_SUPABASE_URL', () => {
    const plugin = fieldRedirectsPlugin({ VITE_SUPABASE_URL: 'https://prev.supabase.co' });
    expect(plugin.apply).toBe('build');
    const { emitted, warnings } = runPlugin(plugin);
    expect(warnings).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'asset', fileName: REDIRECTS_FILE });
    expect(rules(String(emitted[0]!.source))).toEqual([
      '/api/*  https://prev.supabase.co/functions/v1/field-api/:splat  200',
      SPA_FALLBACK_RULE,
    ]);

    // The same URL the dev and preview proxy use (config/server.ts).
    const both = runPlugin(
      fieldRedirectsPlugin({
        SUPABASE_URL: 'https://one.supabase.co',
        VITE_SUPABASE_URL: 'https://two.supabase.co',
      }),
    );
    expect(String(both.emitted[0]!.source)).toContain('https://one.supabase.co/functions/v1/');
  });

  it('warns for a URL it cannot use and still emits the app fallback', () => {
    const { emitted, warnings } = runPlugin(
      fieldRedirectsPlugin({ VITE_SUPABASE_URL: 'https://<ref>.supabase.co' }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not used for _redirects/);
    expect(rules(String(emitted[0]!.source))).toEqual([SPA_FALLBACK_RULE]);
  });

  it('emits only the fallback with no env set (CI)', () => {
    const { emitted, warnings } = runPlugin(fieldRedirectsPlugin({}));
    expect(warnings).toEqual([]);
    expect(rules(String(emitted[0]!.source))).toEqual([SPA_FALLBACK_RULE]);
  });
});

describe('vite.config.ts', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds with the redirects plugin, from the build environment', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://prev.supabase.co');
    const config = await viteConfig({ command: 'build', mode: 'production' } as never);
    const plugins = ((config.plugins ?? []) as unknown[]).flat(3) as Plugin[];
    const plugin = plugins.find((p) => p && p.name === 'sitelog-field-redirects');
    expect(plugin).toBeDefined();
    const { emitted } = runPlugin(plugin!);
    expect(rules(String(emitted[0]!.source))[0]).toBe(
      '/api/*  https://prev.supabase.co/functions/v1/field-api/:splat  200',
    );
  });
});
