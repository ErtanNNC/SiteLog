import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildAuthTemplates,
  configSubject,
  englishBody,
  englishSubject,
  runAuthTemplates,
  type Fetch,
} from './auth-templates.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const REF = 'abcdefghijklmnopqrst';

describe('auth:templates (§19 Q378: English sign-in and invite emails)', () => {
  it('takes the English body and subject of the repo templates, nothing Turkish', () => {
    const c = buildAuthTemplates(read);
    expect(c.mailer_subjects_magic_link).toBe('Your TalkOlog sign-in link');
    expect(c.mailer_subjects_invite).toBe('You are invited to TalkOlog');
    for (const body of [c.mailer_templates_magic_link_content, c.mailer_templates_invite_content]) {
      expect(body.startsWith('<!doctype html>')).toBe(true);
      expect(body).toContain('<html lang="en">');
      expect(body).toContain('{{ .ConfirmationURL }}');
      expect(body).not.toMatch(/ui_locale|lang="tr"|Giriş|Daveti|{{ else }}\n<!doctype/);
      expect(body.trimEnd().endsWith('</html>')).toBe(true);
    }
    expect(c.mailer_templates_invite_content).toContain('{{ with .Data.invited_org_name }}');
  });

  it('refuses a template or subject it cannot cut cleanly', () => {
    expect(() => englishBody('<html lang="en"></html>')).toThrow(/no top-level/);
    expect(englishSubject('Plain subject')).toBe('Plain subject');
    expect(() => englishSubject('{{ if x }}a{{ end }}')).toThrow(/cannot read/);
    expect(configSubject('[auth.email.template.x]\nsubject = "a \\"b\\" c"\n', 'x')).toBe(
      'a "b" c',
    );
    expect(() => configSubject('', 'x')).toThrow(/has no/);
  });

  it('a dry run calls nothing; a write PATCHes the four fields and reads them back', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let stored: unknown = {};
    const fetch: Fetch = async (url, init) => {
      calls.push({ url, init });
      if (init?.method === 'PATCH') {
        stored = JSON.parse(String(init.body));
        return new Response('{}');
      }
      return new Response(JSON.stringify({ ...(stored as object), site_url: 'x' }));
    };
    const log: string[] = [];
    const deps = {
      env: { SUPABASE_ACCESS_TOKEN: 'sbp_secret', SUPABASE_PROJECT_REF: REF },
      fetch,
      read,
      log: (l: string) => log.push(l),
    };
    expect((await runAuthTemplates(['--', '--dry-run'], deps)).written).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(runAuthTemplates([], deps)).rejects.toThrow(/--yes/);
    const out = await runAuthTemplates(['--yes'], deps);
    expect(out.written).toBe(true);
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ['PATCH', `https://api.supabase.com/v1/projects/${REF}/config/auth`],
      ['GET', `https://api.supabase.com/v1/projects/${REF}/config/auth`],
    ]);
    expect(Object.keys(stored as object).sort()).toEqual([
      'mailer_subjects_invite',
      'mailer_subjects_magic_link',
      'mailer_templates_invite_content',
      'mailer_templates_magic_link_content',
    ]);
    expect(log.join('\n')).not.toContain('sbp_secret');
  });

  it('fails when the project does not hold what was sent, or the API refuses', async () => {
    const deps = (fetch: Fetch) => ({
      env: { SUPABASE_ACCESS_TOKEN: 't', SUPABASE_PROJECT_REF: REF },
      fetch,
      read,
      log: () => undefined,
    });
    await expect(
      runAuthTemplates(
        ['--yes'],
        deps(async () => new Response('{}')),
      ),
    ).rejects.toThrow(/does not hold/);
    await expect(
      runAuthTemplates(
        ['--yes'],
        deps(async () => new Response('no', { status: 401 })),
      ),
    ).rejects.toThrow(/HTTP 401/);
    await expect(
      runAuthTemplates(['--yes'], {
        ...deps(async () => new Response('{}')),
        env: { SUPABASE_ACCESS_TOKEN: 't', SUPABASE_PROJECT_REF: 'not a ref' },
      }),
    ).rejects.toThrow(/not a project ref/);
  });
});
