import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

/**
 * W3-15 · the call suite (spec §17 Voice, §10.13, §16.2 M7 and M8 Done when; `pnpm e2e:voice`):
 * every scripted call of `fixtures/calls/` (a fixture with a `simulate` block) run by the call
 * simulator (`pnpm simulate:call`, scripts/src/call-sim) at text level through the real
 * field-api `/voice/*` routes and the worker on fake providers, on the local Supabase stack: each
 * script on an org of its own, its tool answers checked against the recorded ones and the voice
 * contract, then the call's outcome and the report it filed (or did not). One test per script,
 * tagged with its milestone (`@m7` inbound calls and Talk now, `@m8` questions, corrections and
 * special intents) and its flow (`@F6` … `@F15`).
 *
 * Needs (CI's e2e-supabase job sets them): the worker on the stack (WORKER_HEALTH_URL, as every
 * `worker` spec), the database URL (DB_URL or SUPABASE_DB_URL) and the API URL (API_URL), the
 * agent's VOICE_AGENT_TOOL_SECRET as field-api has it (supabase/functions/.env), and for the SIP
 * scripts the US pack's voice number (`pnpm countries:set -- --code US --voice +15550142290`).
 * The browser is not used: field-api is called server to server, as the agent calls it.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const CALLS = resolve(REPO, 'fixtures', 'calls');
const run = promisify(execFile);

interface Listed {
  file: string;
  id: string;
  title: string;
  tags: string[];
}

/** The scripts of fixtures/calls, read as data (the simulator parses them for real). */
function listScripts(): Listed[] {
  return readdirSync(CALLS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const json = JSON.parse(readFileSync(resolve(CALLS, f), 'utf8')) as {
        id: string;
        simulate?: { title: string; milestone: string; flow: string };
      };
      const sim = json.simulate;
      return sim
        ? [
            {
              file: resolve(CALLS, f),
              id: json.id,
              title: sim.title,
              tags: [`@${sim.milestone}`, `@${sim.flow}`],
            },
          ]
        : [];
    });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  test.skip(
    !process.env.SUPABASE_DB_URL && !process.env.DB_URL,
    'needs the stack database (DB_URL of `supabase status -o env`)',
  );
});

for (const script of listScripts()) {
  test(`${script.id}: ${script.title}`, { tag: script.tags }, async () => {
    test.setTimeout(240_000);
    let out = '';
    try {
      const r = await run(
        'pnpm',
        ['--silent', '--filter', '@sitelog/scripts', 'simulate-call', script.file],
        { cwd: REPO, env: process.env, timeout: 220_000, maxBuffer: 4 * 1024 * 1024 },
      );
      out = r.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(`${script.id} failed:\n${e.stdout ?? ''}\n${e.stderr ?? e.message}`);
    }
    expect(out, out).toContain(`PASS ${script.id}`);
  });
}
