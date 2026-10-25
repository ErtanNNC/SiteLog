import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm auth:templates`: the Supabase Auth sign-in (magic link) and invite emails on a hosted
 * project, through the Management API (`PATCH /v1/projects/{ref}/config/auth`), so the owner no
 * longer pastes them in the dashboard (docs/RUNBOOK.md, "Auth email templates").
 *
 * The repo's templates (`supabase/templates/*.html`, subjects in `supabase/config.toml`) carry an
 * English and a Turkish body chosen by the user's `ui_locale` (W4-09, §19 Q239). Since §19 Q378
 * Turkish is off, so this script sends the English body and subject only: every sign-in and invite
 * email is English, whatever a user's metadata still says. The local stack keeps both bodies (the
 * `@m11` suite reads the Turkish one in Mailpit).
 *
 *   --dry-run   print what would be sent, call nothing
 *   --yes       needed to write a hosted project (the Deploy dispatch is the owner's approval)
 *
 * Env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF. The token is never printed. After the write it
 * reads the config back and fails unless the four fields hold what was sent.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = 'https://api.supabase.com';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface AuthTemplateConfig {
  mailer_subjects_magic_link: string;
  mailer_templates_magic_link_content: string;
  mailer_subjects_invite: string;
  mailer_templates_invite_content: string;
}

/**
 * The English body of a bilingual template: what follows its top-level `{{ else }}` line, up to the
 * last `{{ end }}` line. A template without that shape is an error, never sent half-cut.
 */
export function englishBody(template: string): string {
  const lines = template.split('\n');
  const elseAt = lines.findIndex((l) => l.trim() === '{{ else }}');
  let endAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === '{{ end }}') {
      endAt = i;
      break;
    }
  }
  if (elseAt < 0 || endAt <= elseAt) {
    throw new Error('template has no top-level {{ else }} … {{ end }} English body');
  }
  const body = lines
    .slice(elseAt + 1, endAt)
    .join('\n')
    .trim();
  if (!body.startsWith('<!doctype html>') || !body.includes('lang="en"')) {
    throw new Error('the English body does not start with <!doctype html> and lang="en"');
  }
  return `${body}\n`;
}

/** The English subject: the `{{ else }}` branch of a bilingual subject, or the subject as it is. */
export function englishSubject(subject: string): string {
  const m = /\{\{ else \}\}(.*)\{\{ end \}\}\s*$/.exec(subject);
  const text = (m ? m[1]! : subject).trim();
  if (text === '' || text.includes('{{'))
    throw new Error(`cannot read an English subject from ${subject}`);
  return text;
}

/** A `[auth.email.template.<name>]` table's subject in config.toml, its `\"` unescaped. */
export function configSubject(toml: string, name: string): string {
  const table = new RegExp(`^\\[auth\\.email\\.template\\.${name}\\]\\s*$`, 'm').exec(toml);
  if (!table) throw new Error(`config.toml has no [auth.email.template.${name}]`);
  const rest = toml.slice(table.index + table[0].length);
  const next = rest.search(/^\[/m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const m = /^subject\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(section);
  if (!m) throw new Error(`[auth.email.template.${name}] has no subject`);
  return m[1]!.replace(/\\(.)/g, '$1');
}

/** The four Management API fields, English only, from the repo's files. */
export function buildAuthTemplates(read: (path: string) => string): AuthTemplateConfig {
  const toml = read('supabase/config.toml');
  return {
    mailer_subjects_magic_link: englishSubject(configSubject(toml, 'magic_link')),
    mailer_templates_magic_link_content: englishBody(read('supabase/templates/magic_link.html')),
    mailer_subjects_invite: englishSubject(configSubject(toml, 'invite')),
    mailer_templates_invite_content: englishBody(read('supabase/templates/invite.html')),
  };
}

export interface Deps {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  read: (path: string) => string;
  log: (line: string) => void;
}

export async function runAuthTemplates(
  argv: readonly string[],
  deps: Deps,
): Promise<{ written: boolean; config: AuthTemplateConfig }> {
  // `pnpm auth:templates -- --yes` passes the `--` through.
  argv = argv.filter((a) => a !== '--');
  const known = new Set(['--dry-run', '--yes']);
  for (const a of argv) if (!known.has(a)) throw new Error(`unknown argument ${a}`);
  const dryRun = argv.includes('--dry-run');
  const config = buildAuthTemplates(deps.read);

  deps.log('| Template | Subject | Body |');
  deps.log('| --- | --- | --- |');
  deps.log(
    `| Magic link | ${config.mailer_subjects_magic_link} | ${config.mailer_templates_magic_link_content.length} characters, English |`,
  );
  deps.log(
    `| Invite | ${config.mailer_subjects_invite} | ${config.mailer_templates_invite_content.length} characters, English |`,
  );
  deps.log('');
  if (dryRun) {
    deps.log('Dry run: nothing sent.');
    return { written: false, config };
  }

  const token = deps.env.SUPABASE_ACCESS_TOKEN ?? '';
  const ref = deps.env.SUPABASE_PROJECT_REF ?? '';
  if (!token || !ref) throw new Error('needs SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF');
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error('SUPABASE_PROJECT_REF is not a project ref');
  if (!argv.includes('--yes')) throw new Error('writing a hosted project needs --yes');

  const url = `${API}/v1/projects/${ref}/config/auth`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const res = await deps.fetch(url, { method: 'PATCH', headers, body: JSON.stringify(config) });
  if (!res.ok) throw new Error(`PATCH config/auth: HTTP ${res.status} ${await res.text()}`);

  const check = await deps.fetch(url, { method: 'GET', headers });
  if (!check.ok) throw new Error(`GET config/auth: HTTP ${check.status} ${await check.text()}`);
  const live = (await check.json()) as Partial<AuthTemplateConfig>;
  const off = (Object.keys(config) as (keyof AuthTemplateConfig)[]).filter(
    (k) => live[k] !== config[k],
  );
  if (off.length > 0) throw new Error(`the project does not hold what was sent: ${off.join(', ')}`);
  deps.log(
    `Written to project ${ref} and read back: the magic link and invite emails are English.`,
  );
  return { written: true, config };
}

const isMain = process.argv[1]?.endsWith('auth-templates.ts');
if (isMain) {
  runAuthTemplates(process.argv.slice(2), {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    read: (path) => readFileSync(join(ROOT, path), 'utf8'),
    log: (line) => console.log(line),
  }).catch((err: unknown) => {
    console.error(`auth:templates: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
