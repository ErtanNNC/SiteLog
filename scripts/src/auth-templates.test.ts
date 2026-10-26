import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colors } from '@sitelog/shared';

/**
 * W4-09 (spec §13, §19 Q239): Supabase Auth's sign-in and invite emails, one Go template each with
 * an English and a Turkish body chosen by the user's metadata `ui_locale`, wired in
 * supabase/config.toml for the local stack (the hosted ones are the owner's step, RUNBOOK). GoTrue
 * renders them, so this checks their shape; `apps/web/e2e/supabase/auth-email.spec.ts` checks a
 * real Turkish magic link on the local stack.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const CONFIG = read('supabase', 'config.toml');
const TR_TEST = '{{ if or (eq .Data.ui_locale "tr-TR") (eq .Data.ui_locale "tr") }}';
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const TOKEN_HEX = new Set(Object.values(colors).map((c) => c.toLowerCase()));

const TEMPLATES = {
  magic_link: {
    tr: ['TalkOlog’a giriş yapın', 'Giriş yap'],
    en: ['Sign in to TalkOlog', 'Sign in'],
    subject: ['TalkOlog giriş linkiniz', 'Your TalkOlog sign-in link'],
  },
  invite: {
    tr: ['TalkOlog’a davet edildiniz', 'Daveti kabul et', '{{ with .Data.invited_org_name }}'],
    en: ['You are invited to TalkOlog', 'Accept the invite'],
    subject: ['TalkOlog’a davet edildiniz', 'You are invited to TalkOlog'],
  },
} as const;

/** The `[auth.email.template.<name>]` table of config.toml. */
function section(name: string): string {
  const head = `[auth.email.template.${name}]`;
  const at = CONFIG.indexOf(head);
  if (at < 0) return '';
  const rest = CONFIG.slice(at + head.length);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('Supabase Auth email templates (W4-09)', () => {
  for (const [name, want] of Object.entries(TEMPLATES)) {
    it(`${name}: a Turkish and an English body, chosen by ui_locale`, () => {
      const html = read('supabase', 'templates', `${name}.html`);
      const tr = html.indexOf(TR_TEST);
      // The outer else and end stand on lines of their own (a body may hold {{ with … }}).
      const otherwise = html.indexOf('\n{{ else }}\n', tr);
      const end = html.lastIndexOf('\n{{ end }}');
      expect(tr).toBeGreaterThanOrEqual(0);
      expect(otherwise).toBeGreaterThan(tr);
      expect(end).toBeGreaterThan(otherwise);
      const trBody = html.slice(tr, otherwise);
      const enBody = html.slice(otherwise, end);
      expect(trBody).toContain('<html lang="tr">');
      expect(enBody).toContain('<html lang="en">');
      for (const s of want.tr) expect(trBody).toContain(s);
      for (const s of want.en) expect(enBody).toContain(s);
      // The action is GoTrue's link, in both bodies.
      for (const body of [trBody, enBody]) expect(body).toContain('href="{{ .ConfirmationURL }}"');
      expect(html).not.toMatch(EMOJI);
      // §14.1 tokens only; text on signal (the button) is asphalt, never white.
      const hexes = [...html.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
      expect(hexes.length).toBeGreaterThan(0);
      for (const hex of hexes) expect(TOKEN_HEX.has(hex), hex).toBe(true);
      expect(html).not.toMatch(/color:\s*#fff/i);
      expect(html).not.toMatch(/gradient/i);
    });

    it(`${name}: wired in supabase/config.toml with an EN/TR subject`, () => {
      const s = section(name);
      // The CLI resolves content_path against the project root (the folder holding supabase/).
      expect(s).toContain(`content_path = "./supabase/templates/${name}.html"`);
      const path = /^content_path = "(.*)"$/m.exec(s)?.[1] ?? '';
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
      const subject = /^subject = "(.*)"$/m.exec(s)?.[1]?.replace(/\\"/g, '"') ?? '';
      expect(subject.startsWith(TR_TEST)).toBe(true);
      expect(subject).toContain(`${want.subject[0]}{{ else }}${want.subject[1]}{{ end }}`);
    });
  }
});
