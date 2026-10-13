// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowedHostsFrom,
  FIELD_API_PROXY_KEY,
  fieldApiProxy,
  fieldServers,
  proxyWarning,
  supabaseUrlFrom,
} from './server';
import viteConfig from '../vite.config';

/** The one rule's options (the rewrite is what the proxy sends upstream). */
function rule(supabaseUrl: string) {
  const rules = fieldApiProxy(supabaseUrl);
  expect(Object.keys(rules)).toEqual([FIELD_API_PROXY_KEY]);
  return rules[FIELD_API_PROXY_KEY]!;
}

/** What Vite does with a `^…` key: a RegExp tested against the request URL. */
const matches = (url: string) => new RegExp(FIELD_API_PROXY_KEY).test(url);

describe('field-api proxy (D39, §6.5)', () => {
  it('adds no rule without a Supabase URL, so CI builds and tests with no env set', () => {
    expect(fieldApiProxy(undefined)).toEqual({});
    expect(fieldApiProxy('')).toEqual({});
    expect(supabaseUrlFrom({})).toBeUndefined();
    expect(supabaseUrlFrom({ SUPABASE_URL: '  ', VITE_SUPABASE_URL: '' })).toBeUndefined();
    const { server, preview } = fieldServers({});
    expect(server.proxy).toEqual({});
    expect(preview.proxy).toEqual({});
  });

  it('adds no rule for a value that is not an http(s) URL, and says so', () => {
    expect(fieldApiProxy('https://<ref>.supabase.co')).toEqual({});
    expect(fieldApiProxy('127.0.0.1:54321')).toEqual({});
    expect(fieldApiProxy('ftp://example.com')).toEqual({});
    expect(proxyWarning({ SUPABASE_URL: 'https://<ref>.supabase.co' })).toMatch(/not an http/);
    expect(proxyWarning({ SUPABASE_URL: 'http://127.0.0.1:54321' })).toBeNull();
    expect(proxyWarning({})).toBeNull();
  });

  it('reads SUPABASE_URL, else VITE_SUPABASE_URL', () => {
    expect(supabaseUrlFrom({ SUPABASE_URL: 'http://127.0.0.1:54321' })).toBe(
      'http://127.0.0.1:54321',
    );
    expect(supabaseUrlFrom({ VITE_SUPABASE_URL: 'https://abc.supabase.co' })).toBe(
      'https://abc.supabase.co',
    );
    expect(
      supabaseUrlFrom({
        SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_URL: 'https://abc.supabase.co',
      }),
    ).toBe('http://127.0.0.1:54321');
  });

  it('forwards /api/<route> to {SUPABASE_URL}/functions/v1/field-api/<route>', () => {
    const local = rule('http://127.0.0.1:54321');
    expect(local.target).toBe('http://127.0.0.1:54321');
    expect(local.changeOrigin).toBe(true);
    expect(local.rewrite!('/api/resolve')).toBe('/functions/v1/field-api/resolve');
    expect(local.rewrite!('/api/reports/7d2f/answer')).toBe(
      '/functions/v1/field-api/reports/7d2f/answer',
    );
    expect(local.rewrite!('/api/today?site=abc')).toBe('/functions/v1/field-api/today?site=abc');
    expect(local.rewrite!('/api')).toBe('/functions/v1/field-api');
    expect(local.rewrite!('/api?x=1')).toBe('/functions/v1/field-api?x=1');

    const hosted = rule('https://abuanbyzttuqksdctqcp.supabase.co/');
    expect(hosted.target).toBe('https://abuanbyzttuqksdctqcp.supabase.co');
    expect(hosted.rewrite!('/api/resolve')).toBe('/functions/v1/field-api/resolve');

    // A gateway under a path keeps it.
    const gateway = rule('https://gw.example.com/supabase/');
    expect(gateway.target).toBe('https://gw.example.com');
    expect(gateway.rewrite!('/api/resolve')).toBe('/supabase/functions/v1/field-api/resolve');
  });

  it('matches /api, /api/… and /api?… only', () => {
    for (const url of ['/api', '/api/', '/api/resolve', '/api/device/verify', '/api?x=1']) {
      expect(matches(url), url).toBe(true);
    }
    for (const url of ['/apiary', '/apis/x', '/today', '/r/api', '/', '/API/resolve']) {
      expect(matches(url), url).toBe(false);
    }
  });
});

describe('field servers (W1-04)', () => {
  it('serves dev on 5174 and preview on 4174, on every interface (--host), with the same proxy', () => {
    const { server, preview } = fieldServers({ SUPABASE_URL: 'http://127.0.0.1:54321' });
    expect(server).toMatchObject({ port: 5174, strictPort: true, host: true });
    expect(preview).toMatchObject({ port: 4174, strictPort: true, host: true });
    expect(Object.keys(server.proxy!)).toEqual([FIELD_API_PROXY_KEY]);
    expect(Object.keys(preview.proxy!)).toEqual([FIELD_API_PROXY_KEY]);
  });

  it('answers the host of FIELD_APP_URL when it is a tunnel, besides localhost and IPs', () => {
    expect(allowedHostsFrom({})).toEqual([]);
    expect(allowedHostsFrom({ FIELD_APP_URL: 'http://localhost:5174' })).toEqual([]);
    expect(allowedHostsFrom({ FIELD_APP_URL: 'http://192.168.1.20:5174' })).toEqual([]);
    expect(allowedHostsFrom({ FIELD_APP_URL: 'http://[::1]:5174' })).toEqual([]);
    expect(allowedHostsFrom({ FIELD_APP_URL: 'not a url' })).toEqual([]);
    expect(allowedHostsFrom({ FIELD_APP_URL: 'https://quiet-fox.trycloudflare.com' })).toEqual([
      'quiet-fox.trycloudflare.com',
    ]);
    const { server, preview } = fieldServers({ FIELD_APP_URL: 'https://field.example.dev/' });
    expect(server.allowedHosts).toEqual(['field.example.dev']);
    expect(preview.allowedHosts).toEqual(['field.example.dev']);
  });
});

describe('vite.config.ts env', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('lets the shell environment win over .env files (Vite loadEnv with no prefix)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'field-env-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env'), 'SUPABASE_URL=http://from-file:54321\nFIELD_APP_URL=x\n');
    expect(loadEnv('development', dir, '').SUPABASE_URL).toBe('http://from-file:54321');
    vi.stubEnv('SUPABASE_URL', 'http://from-shell:54321');
    expect(loadEnv('development', dir, '').SUPABASE_URL).toBe('http://from-shell:54321');
  });

  it('builds the dev and preview proxy from SUPABASE_URL', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
    const config = await viteConfig({ command: 'serve', mode: 'development' } as never);
    const devRule = config.server?.proxy?.[FIELD_API_PROXY_KEY] as { target: string };
    const previewRule = config.preview?.proxy?.[FIELD_API_PROXY_KEY] as { target: string };
    expect(devRule.target).toBe('http://127.0.0.1:54321');
    expect(previewRule.target).toBe('http://127.0.0.1:54321');
    expect(config.server?.port).toBe(5174);
  });
});
