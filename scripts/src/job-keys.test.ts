import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The D16 key audit (W1-10, GAP D16). Since 20261015000001 a job's dedupe key names one job for
 * good (`jobs.dedupe_key` unique, `enqueue_job … on conflict do nothing`): a caller that enqueues
 * under a key it has used before gets the old job back (done or dead included) and nothing runs. So
 * every key must name one occurrence of the work, never "the latest one". This test finds every
 * dedupe key in the code that enqueues (the worker, the edge functions, the SQL functions) and
 * holds each to an entry below that says why the key is never needed for a second job. A new key
 * fails here until it is audited the same way.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** Key shape (`${…}` → `{}`) → why the same key never has to start a second job. */
const AUDITED: Record<string, string> = {
  // apps/worker
  'transcribe:{}': 'one transcription per WhatsApp voice-note message',
  'extract:{}:{}': 'per report and source count: a new voice note or photo is a new count',
  'decide:{}:extract:{}': 'per report and source count, after that extraction',
  'decide:{}:{}': 'per report and the question or message that triggered it',
  'decide:{}:timeout:{}': 'per report and the pending question that timed out',
  'parse_reply:{}': 'one parse per inbound WhatsApp message',
  'render_pdf:{}:{}': 'per report version; versions are immutable',
  'email:{}:{}:{}': 'per email kind, report and version',
  'email:edited_after_signoff:{}:{}': 'per report and new version',
  'email:pack:{}': 'per evidence pack',
  'jobKeys.extractUpload':
    'extract:<report>:upload:<latest voice upload>: enqueued once every kept voice note of the report is transcribed (W1-11), so it names the notes up to that upload; a new voice note is a new latest upload',
  'send_welcome:{}':
    'the Notifier key of a send_welcome job (messages.payload, not jobs): per job, so a retry never texts twice',
  'jobKeys.decideAfterExtract':
    'decide:<report>:extract-job:<extract job id> (W1-12, web reports): per extract job that wrote the draft; a retry of that job finds its key taken, a new extraction is a new job id',
  'jobKeys.questionReady':
    'notify:question_ready:<question> (the Notifier key in messages.payload, W1-12): one text per question; a retried decide_next never texts twice, a new question is a new key',
  'jobKeys.draftReady':
    'notify:draft_ready:<report>:<decide job id> (the Notifier key, W1-12): per decide_next job that showed the draft; a retry never texts twice, a draft shown again after more audio or photos comes from a new decide job',
  'jobKeys.fileReportOn':
    'file:<report>:v<version>:m<confirm message> or :t<draft sent at>: one filing per WhatsApp confirm message or per draft sent (timeouts); drafts keep their version until filed, so a key per version alone would let a finished filing swallow later ones',
  // supabase/functions
  'jobKeys.welcomeInvite':
    "welcome:<reporter>:invite:<n>, per office invite (the nth 'reporter.invited')",
  'jobKeys.welcomeResend':
    'welcome:<reporter>:resend:<n>, per re-send (the nth "reporter.reinvited")',
  'jobKeys.welcomeLinked': 'welcome:<reporter>:linked:<unknown sender>, per linked sender',
  'reprocess:{}': 'per unknown sender linked (a sender is linked once)',
  'pack:{}': 'per evidence pack row',
  inboundDedupeKey: 'per WhatsApp message id (v1.0 webhook)',
  'weather:{}:{}:{}': 'per site, date and §10.10 slot',
  'weekly_digest:{}:{}': 'per org and week',
  'retention:{}': 'per UTC day',
  'job.dedupeKey': "scheduler-tick's planned jobs: the weather, digest and retention keys above",
  'email:report_missing:{}':
    'scheduler-tick (spec §19 Q55): per site-day, enqueued by the tick whose update made the day missing; a day becomes missing once (reminder_stage 4 stays)',
  'reminder:{}:{}':
    'per site-day and ladder stage (logic.ts reminderJob, unused since W1-10 until the M6 SMS ladder)',
  // SQL (the latest body of each function)
  "sql:'transcribe_upload:' || u.id": 'field_complete_upload: one transcription per upload',
  "sql:'file:' || r.id || ':v' || p_version":
    'field_confirm_report: the first web confirm of a draft version (a dead job is re-queued)',
  "sql:'file:' || r.id || ':v' || p_version || ':c' || v_n":
    'field_confirm_report: a later confirm of that version after its job finished without filing (n past the confirm_requested count; a taken n moves on)',
  "sql:'sms_inbound:' || p_provider_message_id":
    'receive_sms_inbound: per Twilio MessageSid; a redelivery whose job died re-queues it (requeue_dead_job)',
  "sql:'extract:' || r.id || ':photo:' || u.id":
    'field_complete_upload (W1-12): the extraction after a photo completed on a draft awaiting confirmation; per photo, and an upload completes once',
  "sql:'decide:' || r.id || ':answer:' || q.id":
    'field_answer_question (W1-12): decide_next after a web answer; per question, and a question is answered once (a retry returns already_answered)',
  "sql:'render_pdf:' || p_report_id || ':' || v_next":
    'per report version (office edits, sign-off)',
  "sql:'render_pdf:' || p_report_id || ':' || r.current_version || ':signoff:' || (extract(epoch from now()) * 1000000)::bigint":
    'sign_off_report (W1-14): the re-render that prints the sign-off; per sign-off event (transaction time in µs), since a report can be signed off again after an undo',
  "sql:'render_pdf:' || p_report_id || ':' || r.current_version || ':signoff_undone:' || (extract(epoch from now()) * 1000000)::bigint":
    'undo_sign_off (W1-14): the re-render that clears the sign-off; per undo event (transaction time in µs)',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/(\.test|_test|\.d)\.ts$/.test(name) && !/fake/.test(name))
      out.push(p);
  }
  return out;
}

/** Not keys: type annotations and pass-throughs of a key chosen elsewhere. */
const NOT_KEYS = [
  'string',
  'opts.dedupeKey',
  'input.dedupeKey',
  'payload.dedupeKey',
  // decide_next's notice (apps/worker/src/pipeline/web.ts): jobKeys.questionReady / draftReady above
  'notice.dedupeKey',
];

interface Found {
  keys: Map<string, string[]>;
  /** `dedupeKey` properties the audit cannot read (shorthand, an unknown expression form). */
  unresolved: string[];
}

function record(map: Map<string, string[]>, key: string, at: string): void {
  map.set(key, [...(map.get(key) ?? []), at]);
}

/**
 * Every `dedupeKey` property in the worker and the edge functions (not a read: `x.dedupeKey`,
 * `${dedupeKey}`):
 * `dedupeKey: <expr>` with a template literal, a call (`jobKeys.x(`, `f(`), a member or a bare
 * identifier; shorthand `{ dedupeKey }` and any other form are unresolved and fail the audit.
 */
function tsKeys(): Found {
  const keys = new Map<string, string[]>();
  const unresolved: string[] = [];
  const files = [
    ...walk(join(ROOT, 'apps', 'worker', 'src')),
    ...walk(join(ROOT, 'supabase', 'functions')),
  ].filter(
    (f) => !f.includes(`${join('src', 'integration')}`) && !f.includes(`${join('src', 'test')}`),
  );
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const at = relative(ROOT, file);
    for (const m of src.matchAll(/(?<![.\w$])(?<!\$\{\s*)dedupeKey\s*([:,}])/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      if (m[1] !== ':') {
        unresolved.push(`${at}:${line} shorthand`);
        continue;
      }
      const rest = src.slice(m.index + m[0].length).trimStart();
      const expr = /^(`[^`]*`|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(?)/.exec(rest)?.[1] ?? null;
      if (!expr) {
        unresolved.push(`${at}:${line} ${rest.slice(0, 40)}`);
        continue;
      }
      let key = expr;
      if (key.startsWith('`')) key = key.slice(1, -1).replace(/\$\{[^}]*\}/g, '{}');
      if (key.endsWith('(')) key = key.slice(0, -1);
      if (NOT_KEYS.includes(key)) continue;
      record(keys, key, at);
    }
  }
  return { keys, unresolved };
}

/** The latest definition of every SQL function, by name. */
function latestSqlFunctions(): Map<string, string> {
  const dir = join(ROOT, 'supabase', 'migrations');
  const fns = new Map<string, string>();
  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const m of sql.matchAll(
      /create (?:or replace )?function (\w+)\s*\(([\s\S]*?)\$\$([\s\S]*?)\$\$/g,
    )) {
      fns.set(m[1]!, m[3]!);
    }
  }
  return fns;
}

/** The top-level arguments of the call whose `(` is at `open`, or null when it does not close. */
function sqlCallArgs(src: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) return null;
      i = close;
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        args.push(src.slice(from, i));
        return args.map((a) => a.replace(/\s+/g, ' ').trim());
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(from, i));
      from = i + 1;
    }
  }
  return null;
}

/**
 * The fourth argument of every enqueue_job() call in the latest SQL functions, whatever the third
 * (run_after) is; a variable is resolved to its one assignment. A call that does not parse is
 * unresolved.
 */
function sqlKeys(): Found {
  const keys = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const [name, body] of latestSqlFunctions()) {
    if (name === 'enqueue_job') continue;
    for (const m of body.matchAll(/\benqueue_job\s*\(/g)) {
      const args = sqlCallArgs(body, m.index + m[0].length - 1);
      if (!args) {
        unresolved.push(`sql ${name}: enqueue_job( does not parse`);
        continue;
      }
      const key = args[3];
      if (key === undefined || /^null$/i.test(key)) continue;
      let resolved = key;
      if (/^[a-z_]\w*$/i.test(key)) {
        const assigned = [
          ...body.matchAll(new RegExp(`\\b${key}\\b(?:\\s+text)?\\s*:=\\s*([^;]+);`, 'g')),
        ].map((a) => a[1]!.replace(/\s+/g, ' ').trim());
        if (assigned.length === 1) resolved = assigned[0]!;
      }
      record(keys, `sql:${resolved}`, name);
    }
  }
  return { keys, unresolved };
}

describe('D16 key audit (W1-10): no caller reuses a dedupe key it needs again', () => {
  const tsFound = tsKeys();
  const sqlFound = sqlKeys();
  const ts = tsFound.keys;
  const sql = sqlFound.keys;

  it('finds the keys it audits', () => {
    expect(ts.size).toBeGreaterThan(15);
    expect(sql.size).toBeGreaterThanOrEqual(3);
  });

  it('reads every dedupeKey property and every enqueue_job() call (nothing escapes the audit)', () => {
    expect([...tsFound.unresolved, ...sqlFound.unresolved]).toEqual([]);
  });

  it('audits every dedupe key in the worker, the edge functions and the SQL functions', () => {
    const unaudited = [...ts, ...sql]
      .filter(([key]) => !(key in AUDITED))
      .map(([key, where]) => `${key} (${where.join(', ')})`);
    expect(unaudited).toEqual([]);
  });

  it('keeps no audit entry for a key that is gone', () => {
    const stale = Object.keys(AUDITED).filter((k) => !ts.has(k) && !sql.has(k));
    expect(stale).toEqual([]);
  });

  it('gives repeatable work a per-occurrence key: no bare per-report filing, welcome or reinvite key', () => {
    for (const key of [...ts.keys(), ...sql.keys()]) {
      expect(key).not.toMatch(/^file:\{\}$/);
      expect(key).not.toMatch(/^welcome:\{\}:(\{\}|reinvite)$/);
      expect(key).not.toBe("sql:'file:' || r.id");
    }
  });
});

describe('scheduler-tick (W1-10): the WhatsApp reminder ladder is stopped', () => {
  const source = readFileSync(
    join(ROOT, 'supabase', 'functions', 'scheduler-tick', 'index.ts'),
    'utf8',
  );

  it('enqueues no template and no reminder', () => {
    for (const banned of [
      'send_template',
      'send_message',
      'reminderJob',
      'claimStage',
      'dueStage',
    ]) {
      expect(source.includes(banned), banned).toBe(false);
    }
  });

  it('enqueues the jobs planTickJobs plans (weather, digest, retention) and the missing email', () => {
    expect([...source.matchAll(/enqueueJob\(\s*admin,\s*'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      'send_email',
    ]);
    expect(source).toContain("kind: 'report_missing'");
    expect(source).toContain('planTickJobs(');
  });

  it('marks a past-deadline day missing (§7.1), audited, and alerts the office (spec §19 Q55)', () => {
    expect(source).toContain('planMissing(');
    expect(source).toContain("action: 'site_day.status_changed'");
    expect(source).toContain("kind: 'missing_report'");
    expect(source).toContain('missingNotification(');
  });
});
