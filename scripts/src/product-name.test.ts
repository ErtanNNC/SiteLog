import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The product is TalkOlog (formerly SiteLog, renamed 2026-10-19). The technical names keep the old
 * one (the `@sitelog/*` packages, the database, the repo, env names such as
 * `DEMO_SITELOG_NUMBER`, `sitelog_voice`, storage keys), but no text a person reads may: no SMS,
 * WhatsApp, email, PDF, panel, field app or voice line, no brand file, no default sender.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const THIS_FILE = 'scripts/src/product-name.test.ts';

/**
 * Files that keep the old name, and why. Nothing here reaches a person using the product.
 * Forward-only migrations are never edited (CLAUDE.md "How to work" 6); their notice text is a
 * fallback the panel replaces with its keyed copy (`apps/web/src/data/notices.ts`).
 */
const KEEPS_OLD_NAME: { prefix: string; why: string }[] = [
  { prefix: 'supabase/migrations/', why: 'applied migrations are never edited' },
  { prefix: 'docs/design/', why: 'the v1.2 kit artboards, kept as delivered' },
  { prefix: 'docs/PLAN_WEEK', why: 'ticket history, written under the old name' },
  { prefix: 'docs/GAP_ANALYSIS.md', why: 'migration history' },
  { prefix: 'docs/AUDIT_BACKLOG.md', why: 'audit history' },
  { prefix: 'docs/START_HERE.md', why: 'the v1.2 kickoff note, history' },
  { prefix: 'CLAUDE.md', why: 'the owner’s notes for Claude Code' },
  { prefix: THIS_FILE, why: 'this test names what it looks for' },
];

/** The old display name, in any spacing, and the old SMS sender id. */
const OLD_NAME = /Site ?Log|SITE ?LOG(?!_SPEC)/g;
/** Technical names that only contain the letters: env names and the spec's file name. */
const TECHNICAL = /DEMO_SITELOG_NUMBER|SITELOG_SPEC/g;
/** A line may say where the name came from. */
const FORMERLY = /formerly SiteLog|eski adıyla SiteLog/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (f) => f && !/\.(png|jpe?g|webp|gif|ico|ttf|woff2?|ogg|wav|mp3|webm|pdf|zip)$/i.test(f),
    );
}

function keepsOldName(file: string): boolean {
  return KEEPS_OLD_NAME.some((k) => file === k.prefix || file.startsWith(k.prefix));
}

function oldNameLines(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (FORMERLY.test(line)) return;
    if (OLD_NAME.test(line.replace(TECHNICAL, ''))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    OLD_NAME.lastIndex = 0;
  });
  return hits;
}

/** Copy catalogues and templates: every quoted string, any letter case (`go.sitelog.app` too). */
const COPY_FILES = [
  /^packages\/shared\/src\/copy\/(?!.*\.test\.ts$).*\.ts$/,
  /^apps\/web\/src\/copy\/(?!.*\.test\.ts$).*\.ts$/,
  /^apps\/voice-agent\/copy\/.*\.json$/,
  /^apps\/voice-agent\/src\/sitelog_voice\/prompts\/.*\.md$/,
  /^apps\/worker\/src\/email\/(?!.*\.test\.ts$).*\.ts$/,
  /^packages\/pdf\/src\/copy\.ts$/,
  /^supabase\/templates\/.*\.html$/,
  /^(apps\/web|apps\/field)\/index\.html$/,
  /^apps\/field\/config\/pwa\.ts$/,
  /^(docs\/brand|apps\/web\/public\/brand|apps\/field\/public\/brand)\/.*\.svg$/,
];

/** Quoted strings in a source file, less import paths (`@sitelog/shared`, `./x.ts`). */
function quotedStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    const s = m[0].slice(1, -1);
    if (/^(@sitelog\/|\.{1,2}\/)/.test(s)) continue;
    out.push(s);
  }
  return out;
}

describe('the product name is TalkOlog in every text a person reads', () => {
  const files = trackedFiles();

  it('no tracked file outside the history list says SiteLog or SITELOG', () => {
    const hits = files.filter((f) => !keepsOldName(f)).flatMap(oldNameLines);
    expect(hits).toEqual([]);
  });

  it('no copy catalogue, template, prompt or brand file has the old name in any case', () => {
    const copy = files.filter((f) => COPY_FILES.some((re) => re.test(f)));
    // The catalogues exist where this test looks for them (a move would make it pass vacuously).
    expect(copy).toEqual(
      expect.arrayContaining([
        'packages/shared/src/copy/sms.en.ts',
        'packages/shared/src/copy/voice.tr.ts',
        'packages/shared/src/copy/ui/es.ts',
        'apps/web/src/copy/en.ts',
        'apps/voice-agent/copy/en.json',
        'apps/worker/src/email/office-copy.ts',
        'packages/pdf/src/copy.ts',
        'supabase/templates/invite.html',
        'docs/brand/logo-mark.svg',
      ]),
    );
    const hits = copy.flatMap((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8');
      const strings = /\.(ts|tsx)$/.test(f) ? quotedStrings(text) : [text];
      return strings
        .filter((s) => /site ?log/i.test(s.replace(/@sitelog\//g, '')))
        .map((s) => `${f}: ${s.slice(0, 120)}`);
    });
    expect(hits).toEqual([]);
  });

  it('the copy says TalkOlog where it names the product', () => {
    const sms = readFileSync(join(ROOT, 'packages/shared/src/copy/sms.en.ts'), 'utf8');
    expect(sms).toContain("I'm TalkOlog, the daily report assistant");
    const voice = readFileSync(join(ROOT, 'apps/voice-agent/copy/tr.json'), 'utf8');
    expect(voice).toContain('ben TalkOlog asistanı');
    const lockup = readFileSync(join(ROOT, 'apps/web/public/brand/logo-lockup.svg'), 'utf8');
    expect(lockup).toContain('<title>TalkOlog</title>');
  });
});
