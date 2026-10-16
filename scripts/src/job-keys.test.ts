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
  'email:edited_after_signoff:{}:{}': 'per report and new version',
  'email:pack:{}': 'per evidence pack',
  'jobKeys.extractUpload':
    'extract:<report>:upload:<latest voice upload>: enqueued once every kept voice note of the report is transcribed (W1-11), so it names the notes up to that upload; a new voice note is a new latest upload',
  'send_welcome:{}':
    'the Notifier key of a send_welcome job (messages.payload, not jobs): per job, so a retry never texts twice',
  'office_daily_link:{}':
    'the Notifier key of the office\'s "Text today\'s link" (api-text-daily-link, W1-16): per request id, which the panel makes fresh per tap, so a retried request texts once and the next tap texts again',
  'expired_daily_link:{}:{}':
    'the Notifier key of F16\'s "Send me today\'s link" (field-api expired/daily-link, W2-03): per expired link and site day, so however often the button is tapped one text goes out that day',
  'jobKeys.decideAfterExtract':
    'decide:<report>:extract-job:<extract job id> (W1-12, web reports): per extract job that wrote the draft; a retry of that job finds its key taken, a new extraction is a new job id',
  'jobKeys.questionReady':
    'notify:question_ready:<question> (the Notifier key in messages.payload, W1-12): one text per question; a retried decide_next never texts twice, a new question is a new key',
  'jobKeys.draftReady':
    'notify:draft_ready:<report>:<decide job id> (the Notifier key, W1-12): per decide_next job that showed the draft; a retry never texts twice, a draft shown again after more audio or photos comes from a new decide job',
  timerKey:
    'jobKeys.rearm(<base>, n) (W2-07, the §7.2 web clock): the answer timeout decide:<report>:timeout:<question> and the confirmation timeout decide:<report>:file-timeout:v<version>:r<draft rev>, then <base>:re<n>. The pipeline arms a timer only while none of its jobs is queued or running (a retry finds the live one); a timer that fired while the report was busy and changed nothing is armed again under the next n (up to MAX_TIMER_REARMS), so the question still times out and the draft still files',
  nudgeKey:
    'jobKeys.rearm(jobKeys.draftNudge(…), n), notify:draft_nudge:<report>:v<version>:r<draft rev>[:re<n>] (W2-07, the 30-minute nudge): the notify job and its Notifier key per draft version, revision and arming of the filing timer it goes with, so a retry never nudges twice and a draft shown again after its clock ran out without filing gets a new clock',
  'jobKeys.renderPdf':
    'render_pdf:<report>:<version> (file_report, W1-15): per report version; versions are immutable, and a retried filing finds the key taken',
  'jobKeys.reportEmail':
    'email:<report_filed|report_updated>:<report>:<version> (render_pdf): per email kind, report and version; also the email provider idempotency key',
  'jobKeys.filed':
    'notify:filed:<report> (file_report, W1-15): the notify job and its Notifier key; a report is filed once, so a retried or repeated filing never texts twice',
  'jobKeys.fileReportOn':
    'file:<report>:v<version>:m<confirm message> or :t<draft sent at>: one filing per WhatsApp confirm message or per draft sent (timeouts); drafts keep their version until filed, so a key per version alone would let a finished filing swallow later ones',
  // supabase/functions
  'jobKeys.welcomeInvite':
    "welcome:<reporter>:invite:<n>, per office invite (the nth 'reporter.invited')",
  'jobKeys.welcomeResend':
    'welcome:<reporter>:resend:<n>, per re-send (the nth "reporter.reinvited")',
  'jobKeys.welcomeLinked': 'welcome:<reporter>:linked:<unknown sender>, per linked sender',
  'reprocess:{}': 'per unknown sender linked (a sender is linked once)',
  jobKey:
    "sms-webhook's enqueueNotify (W2-01): jobKeys.notifyAfter(<message dedupe key>, <failed attempt id>) from lateFallback, the fallback after a late status callback; per logical message and failed attempt, and an attempt fails once (nextMessageStatus never moves a failed row)",
  'pack:{}': 'per evidence pack row',
  inboundDedupeKey: 'per WhatsApp message id (v1.0 webhook)',
  'weather:{}:{}:{}': 'per site, date and §10.10 slot',
  'weekly_digest:{}:{}': 'per org and week',
  'retention:{}': 'per UTC day',
  'job.dedupeKey': "scheduler-tick's planned jobs: the weather, digest and retention keys above",
  'reminder:{}:{}':
    'per site-day and ladder stage (logic.ts reminderJob, unused since W1-10 until the M6 SMS ladder)',
  // SQL (the latest body of each function)
  "sql:'transcribe_upload:' || u.id": 'field_complete_upload: one transcription per upload',
  "sql:'transcribe_upload:' || v_caption":
    'field_complete_upload (W2-04, F9): the voice caption of a batch of photos added after filing, transcribed once the batch is whole; per caption upload, and an upload completes once (a retry returns alreadyComplete)',
  "sql:'notify:' || (m ->> 'key') || ':' || p_site_day_id || ':' || (m ->> 'reporterId')":
    'claim_site_day_reminder (W2-06, the reminder ladder): the notify job and its Notifier key per ladder key, site-day and reporter (notify:daily_link:<site_day>:<reporter>, notify:reminder_1:…); enqueued in the transaction whose guarded claim runs that stage once (reminder_stage 1-3, the daily link by its audit row), so each reporter gets each stage of a day once and a retried tick finds the stage taken',
  "sql:'email:report_missing:' || p_site_day_id":
    'mark_site_day_missing (spec §19 Q55): per site-day, enqueued in the transaction whose guarded update made the day missing; a day becomes missing once (reminder_stage 4 stays)',
  "sql:'file:' || r.id || ':v' || p_version || ':r' || p_draft_rev":
    'field_confirm_report: the first web confirm of a draft version at a draft revision (report_versions.draft_rev, bumped on every change of the draft; a dead job is re-queued)',
  "sql:'file:' || r.id || ':v' || p_version || ':r' || p_draft_rev || ':c' || v_n":
    'field_confirm_report: a later confirm of that draft after its job finished without filing (n past the confirm_requested count; a taken n moves on)',
  "sql:'file:' || r.id || ':v1:' || p_status":
    'field_report_day_off (W2-08, F12): the filing of the weather-day or no-work report the recorder made; per report, which the transaction that enqueues it creates (a retried tap finds the day already in that status and creates nothing)',
  "sql:'sms_inbound:' || p_provider_message_id":
    'receive_sms_inbound: per Twilio MessageSid; a redelivery whose job died re-queues it (requeue_dead_job)',
  "sql:'extract:' || r.id || ':photo:' || u.id":
    'field_complete_upload (W1-12): the extraction after a photo completed on a draft awaiting confirmation; per photo, and an upload completes once',
  "sql:'decide:' || r.id || ':answer:' || q.id":
    'field_answer_question (W1-12): decide_next after a web answer; per question, and a question is answered once (a retry returns already_answered). field_settle_voice_answer (W2-09) uses the same key for a spoken answer applied, or recorded unanswered after two unclear tries: the question is answered once either way, so a tap and a voice answer never both run it',
  "sql:'test_clip:' || p_id || ':delete'":
    'field_test_clip_create (W2-13, F4): the 10-minute delete of one test recording; per clip id, which the call creates',
  "sql:'test_clip:' || t.id":
    'field_test_clip_complete (W2-13, F4): the transcription of one test recording; per clip, and a retried complete finds the key taken',
  "sql:'answer:' || q.id || ':' || u.id":
    'field_answer_question_voice (W2-09, F7 Other…): parse_answer per question and answer clip (jobKeys.parseAnswer); a clip is spoken once and names one question (uploads.question_id), a retry of the same clip returns the first call, and a second try is a new clip',
  "sql:'render_pdf:' || p_report_id || ':' || v_next":
    'per report version (office edits, sign-off; field_attach_photos, W2-04: the version a batch of photos made); versions are immutable',
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
  // decide_next's notice (apps/worker/src/pipeline/web.ts): jobKeys.questionReady / draftReady
  // above, the notify job's key and the Notifier's since W2-07 (one job per key, deferred 30 s or not)
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

describe('scheduler-tick (W2-06): the reminder ladder through the Notifier, never WhatsApp', () => {
  const source = readFileSync(
    join(ROOT, 'supabase', 'functions', 'scheduler-tick', 'index.ts'),
    'utf8',
  );
  const claimSql = readFileSync(
    join(ROOT, 'supabase', 'migrations', '20261016000040_reminder_ladder.sql'),
    'utf8',
  );

  it('enqueues no WhatsApp template and no reminder outside the claim', () => {
    for (const banned of ['send_template', 'send_message', 'reminderJob', 'claimStage']) {
      expect(source.includes(banned), banned).toBe(false);
    }
    expect([...source.matchAll(/enqueueJob\(\s*admin,\s*'([a-z_]+)'/g)]).toEqual([]);
    expect(source).toContain('planTickJobs(');
  });

  it('claims each ladder stage with its notify jobs in one transaction (claim_site_day_reminder)', () => {
    expect(source).toContain('planLadder(');
    expect(source).toContain("rpc('claim_site_day_reminder'");
    expect(claimSql).toContain("perform enqueue_job('notify'");
    expect(claimSql).toContain("'site_day.reminder'");
    expect(claimSql).toMatch(
      /status in \('pending', 'reminded'\) and not reminders_paused\s+for update/,
    );
  });

  it('marks a past-deadline day missing (§7.1) and alerts the office in one transaction (spec §19 Q55)', () => {
    expect(source).toContain('planMissing(');
    expect(source).toContain("rpc('mark_site_day_missing'");
    expect(source).toContain('missingNotification(');
    expect(claimSql).toContain("'site_day.status_changed'");
    expect(claimSql).toContain("'missing_report'");
    expect(claimSql).toContain("'report_missing'");
  });
});
