-- SiteLog · worker runtime (W1-10, GAP step 15; spec §6.3 `jobs`, §10.1; GAP D16, D17)
--
--   1. D16: jobs.dedupe_key is fully unique (constraint jobs_dedupe_key_key, spec §6.3 `dedupe_key
--      text unique`), instead of unique among queued and running jobs (index jobs_dedupe_key_active,
--      20261011000003). A key names one job for good: "once each, even if retried" (W1-15). Keys
--      that finished jobs share are released first: for each key the queued or running job keeps
--      it (the old index allowed one), else the newest finished one; every other row's key is set
--      to null (one audit row with the count). Callers that need a job again use a key per
--      occurrence (W1-10: a filing per draft version, a welcome per invite, the worker's answer
--      timeout per question).
--   2. enqueue_job(): `insert … on conflict (dedupe_key) do nothing`. A taken key returns its job's
--      id, whatever that job's status (done and dead included), and enqueues and notifies nothing.
--      One function, the same 4 arguments and defaults (no overload: PostgREST's named-argument
--      calls stay unambiguous); NOTIFY as in 20261014000001 (a new job due now).
--   3. D17: fail_job() uses every delay of §10.1: attempts 1–5 wait 30 s, 2 min, 10 min, 30 min and
--      2 h before the next one, and the sixth failed attempt makes the job dead (before: dead after
--      the fifth, so the 2 h step never ran).
--   4. requeue_dead_job(): a dead job back to queued with a fresh attempt budget, due now, notified
--      (what ops_retry_job does for an operator, here for the two callers below). Not callable by
--      API roles.
--   5. field_complete_upload(): "being filed" is a queued or running file_report job of the report,
--      whatever its key (before: the key `file:<report>`).
--   6. field_confirm_report(): one filing job per confirm occurrence. A filing already queued or
--      running for the report (a second tap, a WhatsApp confirm, a timeout; any key) is returned as
--      before. Else the first confirm of a draft version uses `file:<report>:v<version>`; when that
--      key's job is dead (six failed attempts) it is re-queued; when it is done or failed and the
--      report is still awaiting confirmation at that version (drafts are overwritten in place, so
--      the version stays 1 until filing: a stale confirm that filed nothing, a job ops discarded),
--      this confirm is a new occurrence under `file:<report>:v<version>:c<n>`, n past the report's
--      `report.confirm_requested` count (a taken n moves on). Before D16 the finished job freed the
--      key and the next confirm enqueued a new job; without the occurrence key the confirm would
--      answer `queued` with a finished job and nothing would run.
--   7. receive_sms_inbound(): a redelivery of a text not yet handled whose job died re-queues that
--      job (before D16 it enqueued a new one under the free key), audited `job.requeued`.
--   8. notification_audience(): `message_failed` (§13 "Message undeliverable / opted out": ops,
--      admin), the worker's notice for a message job to or from a reporter that died (W1-10).
--
-- Live database (staging: finished duplicates and running rows): one transaction. The jobs lock
-- (ACCESS EXCLUSIVE, in a DO block: the Supabase CLI's pipeline is not a transaction block) is the
-- first statement after lock_timeout, so no enqueue lands between the clean-up and the constraint,
-- and enqueues waiting for the lock run against the new enqueue_job(). Queued and running rows
-- keep their keys and their state; a running row of the old worker finishes normally. The deployed
-- v1.0 callers keep working: enqueue_job() keeps its signature and answers a taken key with an id,
-- and complete_job()/fail_job() keep theirs. Grants: `create or replace` keeps every function's
-- grants and the revokes of 20261011000005, 20261014000001, 20261014000006 and 20261014000008.

set local lock_timeout = '5s';

do $$ begin lock table jobs in access exclusive mode; end $$;

-- 1. D16: one job per key -------------------------------------------------------------------------
with ranked as (
  select id, row_number() over (
           partition by dedupe_key
           order by (status in ('queued', 'running')) desc, id desc) as rn
  from jobs
  where dedupe_key is not null
), released as (
  update jobs j set dedupe_key = null
  from ranked r
  where j.id = r.id and r.rn > 1 and j.status not in ('queued', 'running')
  returning j.id
)
insert into audit_log (org_id, actor_type, action, entity, diff)
select null, 'system', 'jobs.dedupe_keys_released', 'job',
       jsonb_build_object('count', count(*), 'migration', '20261015000001')
from released
having count(*) > 0;

drop index jobs_dedupe_key_active;
alter table jobs add constraint jobs_dedupe_key_key unique (dedupe_key);

-- 2. enqueue_job: insert … on conflict do nothing ------------------------------------------------------
create or replace function enqueue_job(
  p_type text, p_payload jsonb, p_run_after timestamptz default null, p_dedupe_key text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_run_after timestamptz := coalesce(p_run_after, now());
begin
  -- A concurrent insert of the same key makes this one wait; once it commits, this one does
  -- nothing and the next statement (a new snapshot) reads its id.
  for i in 1..3 loop
    insert into jobs (type, payload, run_after, dedupe_key)
    values (p_type, p_payload, v_run_after, p_dedupe_key)
    on conflict (dedupe_key) do nothing
    returning id into v_id;
    if v_id is not null then
      if v_run_after <= now() then
        perform pg_notify('jobs', v_id::text);
      end if;
      return v_id;
    end if;
    -- The key is taken: its job, whatever its status (D16: a key is never used twice).
    select id into v_id from jobs where dedupe_key = p_dedupe_key;
    if v_id is not null then
      return v_id;
    end if;
    -- Its job was deleted in between (retention purges done jobs after 30 days): insert again.
  end loop;
  raise exception 'enqueue_job: dedupe key % is taken and released repeatedly', p_dedupe_key;
end $$;

-- 3. D17: all five delays, dead after the sixth failure -------------------------------------------------
create or replace function fail_job(p_job_id bigint, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare v_attempts int; v_delay interval;
begin
  select attempts into v_attempts from jobs where id = p_job_id;
  if v_attempts is null then return; end if;
  -- The sixth attempt ran after the fifth delay (2 h): no seventh.
  if v_attempts >= 6 then
    update jobs set status = 'dead', last_error = p_error, finished_at = now(), locked_at = null,
                    locked_by = null
    where id = p_job_id;
    return;
  end if;
  v_delay := case
    when v_attempts <= 1 then interval '30 seconds'
    when v_attempts = 2 then interval '2 minutes'
    when v_attempts = 3 then interval '10 minutes'
    when v_attempts = 4 then interval '30 minutes'
    else interval '2 hours'
  end;
  update jobs set status = 'queued', last_error = p_error, run_after = now() + v_delay,
                  locked_at = null, locked_by = null
  where id = p_job_id;
end $$;

-- 4. A dead job back to the queue -------------------------------------------------------------------
create function requeue_dead_job(p_job_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update jobs
  set status = 'queued', attempts = 0, run_after = now(), finished_at = null, locked_at = null,
      locked_by = null
  where id = p_job_id and status = 'dead';
  if not found then
    return false;
  end if;
  perform pg_notify('jobs', p_job_id::text);
  return true;
end $$;

revoke execute on function requeue_dead_job(bigint) from public, anon, authenticated;

-- 5. uploads/:id/complete: a filing job of the report, whatever its key -----------------------------------
create or replace function field_complete_upload(p_upload_id uuid, p_reporter_id uuid, p_bytes int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uploads%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  r reports%rowtype;
  v_date date;
  v_created boolean := false;
  v_from report_status;
  v_job bigint;
begin
  select * into u from uploads where id = p_upload_id for update;
  if u.id is null or u.reporter_id is distinct from p_reporter_id
     or not field_reporter_on_site(p_reporter_id, u.site_id) then
    raise exception 'upload_not_found' using errcode = 'P0002';
  end if;
  select * into s from sites where id = u.site_id;

  -- Completing twice (a retry after a lost answer) returns what the first call did.
  if u.report_id is not null then
    select * into r from reports where id = u.report_id;
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', true, 'jobId', null);
  end if;

  -- field-api writes the path {org}/{site}/{date}/{upload id}.{ext} (uploadStoragePath()).
  if split_part(u.storage_path, '/', 1) <> s.org_id::text
     or split_part(u.storage_path, '/', 2) <> s.id::text
     or split_part(u.storage_path, '/', 3) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'upload_path_mismatch' using errcode = 'P0001';
  end if;
  v_date := split_part(u.storage_path, '/', 3)::date;

  sd := field_lock_site_day(s.id, v_date);
  select * into r from reports where site_day_id = sd.id and status <> 'void'
  order by created_at limit 1 for update;
  if r.id is not null and r.status in ('filed', 'signed_off') then
    raise exception 'report_filed' using errcode = 'P0001';
  end if;
  if r.id is null and sd.status in ('filed', 'weather_day', 'no_work') then
    raise exception 'day_closed' using errcode = 'P0001';
  end if;
  -- Confirmed and being filed (field_confirm_report(), a WhatsApp confirm or a timeout): nothing
  -- joins the draft the reporter confirmed. A filing job of the report, whatever its key (W1-10:
  -- `file:<report>:v<version>`; a job queued before this migration: `file:<report>`).
  if r.id is not null and exists (
       select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                            and status in ('queued', 'running')) then
    raise exception 'report_filing' using errcode = 'P0001';
  end if;

  if r.id is null then
    insert into reports (org_id, site_id, site_day_id, report_no, status, kind, reporter_id,
                         received_at, channel, language)
    values (s.org_id, s.id, sd.id, next_report_no(s.id),
            case when u.kind = 'audio' then 'processing' else 'collecting' end::report_status,
            'daily', p_reporter_id, now(), 'web', org_report_language(s.org_id))
    returning * into r;
    v_created := true;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.created', 'report', r.id,
      jsonb_build_object('report_no', r.report_no, 'date', v_date, 'channel', 'web',
                         'status', r.status, 'upload_id', u.id));
  elsif u.kind = 'audio' and r.status <> 'processing' then
    -- §7.2: more audio puts a report back to processing (collecting, a question, a draft).
    v_from := r.status;
    update reports set status = 'processing' where id = r.id returning * into r;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.status_changed', 'report', r.id,
      jsonb_build_object('from', v_from, 'to', 'processing', 'upload_id', u.id));
  end if;

  update uploads set report_id = r.id, received_at = now(), bytes = coalesce(p_bytes, bytes)
  where id = u.id;
  insert into report_sources (report_id, kind, upload_id, taken_at)
  values (r.id, case when u.kind = 'audio' then 'voice_note' else 'photo' end, u.id, u.recorded_at);

  if u.kind = 'audio' then
    -- §7.1: a voice note starts the day's processing (a late one too: missing → processing).
    if sd.status in ('pending', 'reminded', 'missing') then
      update site_days set status = 'processing' where id = sd.id;
      perform log_audit(s.org_id, 'reporter', p_reporter_id, 'site_day.status_changed', 'site_day',
        sd.id, jsonb_build_object('from', sd.status, 'to', 'processing', 'report_id', r.id));
    end if;
    v_job := enqueue_job('transcribe_upload', jsonb_build_object('uploadId', u.id), null,
                         'transcribe_upload:' || u.id);
  end if;

  perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
    jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', v_job));
  return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                            'created', v_created, 'alreadyComplete', false, 'jobId', v_job);
end $$;

-- 6. reports/:id/confirm: one filing per draft version ------------------------------------------------
create or replace function field_confirm_report(p_report_id uuid, p_reporter_id uuid, p_version int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_job bigint;
  v_status job_status;
  v_n int;
  v_requeued boolean := false;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_complete_upload()'s lock: no voice note attaches between this check and the enqueue,
  -- and a second tap waits for the first.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  if r.status in ('filed', 'signed_off') then
    return jsonb_build_object('status', 'filed', 'jobId', null, 'version', r.current_version);
  end if;
  if r.status <> 'awaiting_confirmation' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  if p_version is null or r.current_version <> p_version then
    raise exception 'draft_changed' using errcode = 'P0001';
  end if;
  -- A filing already queued or running (a second tap, a WhatsApp confirm, a timeout; any key).
  select id into v_job from jobs
  where type = 'file_report' and payload ->> 'reportId' = r.id::text
    and status in ('queued', 'running')
  order by id limit 1;
  if v_job is not null then
    return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
  end if;
  -- D16: the first confirm of this draft version.
  v_job := enqueue_job('file_report',
    jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', p_version), null,
    'file:' || r.id || ':v' || p_version);
  select status into v_status from jobs where id = v_job;
  if v_status = 'dead' then
    -- The version's job died (six failed attempts): this confirm runs it again.
    v_requeued := requeue_dead_job(v_job);
  elsif v_status in ('done', 'failed') then
    -- That job finished without filing (the report is still awaiting confirmation at this
    -- version: a stale confirm, a job ops discarded): this confirm is a new occurrence.
    select count(*) into v_n from audit_log
    where entity = 'report' and entity_id = r.id and action = 'report.confirm_requested';
    loop
      v_n := v_n + 1;
      v_job := enqueue_job('file_report',
        jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', p_version), null,
        'file:' || r.id || ':v' || p_version || ':c' || v_n);
      select status into v_status from jobs where id = v_job;
      exit when v_status in ('queued', 'running');
      if v_status = 'dead' then
        v_requeued := requeue_dead_job(v_job);
        exit;
      end if;
      -- A finished job holds this n (retention purged audit rows, or a job outlived its audit):
      -- the next n.
      if v_n > 10000 then
        raise exception 'field_confirm_report: no free filing key for report %', r.id;
      end if;
    end loop;
  end if;
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.confirm_requested', 'report', r.id,
    jsonb_build_object('job_id', v_job, 'version', p_version, 'channel', 'web')
      || case when v_requeued then jsonb_build_object('requeued', true) else '{}'::jsonb end);
  return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
end $$;

-- 7. Store, audit and enqueue an inbound text; a redelivery re-runs a job that died ------------------
create or replace function receive_sms_inbound(
  p_id uuid, p_org_id uuid, p_reporter_id uuid, p_phone_e164 text, p_provider text,
  p_provider_message_id text, p_body text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_duplicate boolean := false;
  v_handled boolean := false;
  v_job bigint;
  v_key text := 'sms_inbound:' || p_provider_message_id;
begin
  if p_provider not in ('twilio', 'console') then
    raise exception 'receive_sms_inbound: unknown provider %', p_provider using errcode = '22023';
  end if;
  insert into messages (id, org_id, reporter_id, phone_e164, channel, direction, provider,
                        provider_message_id, body, status, payload)
  values (p_id, p_org_id, p_reporter_id, p_phone_e164, 'sms', 'in', p_provider,
          p_provider_message_id, p_body, 'received', p_payload)
  on conflict (provider_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    v_duplicate := true;
    select m.id, (m.payload ->> 'handled_at') is not null into v_id, v_handled
      from messages m where m.provider_message_id = p_provider_message_id;
  else
    perform log_audit(p_org_id,
      case when p_reporter_id is null then 'system' else 'reporter' end, p_reporter_id,
      'sms.received', 'message', v_id,
      jsonb_build_object('provider', p_provider, 'keyword', p_payload -> 'keyword',
                         'pack', p_payload -> 'pack'));
  end if;

  if p_provider = 'twilio' and not v_handled then
    -- D16: the text's one job (a redelivery joins it, whatever its status).
    v_job := enqueue_job('sms_inbound', jsonb_build_object('messageId', v_id), null, v_key);
    if requeue_dead_job(v_job) then
      perform log_audit(p_org_id, 'system', null, 'job.requeued', 'message', v_id,
        jsonb_build_object('job_id', v_job, 'type', 'sms_inbound', 'reason', 'redelivery'));
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'duplicate', v_duplicate, 'handled', v_handled,
                            'jobId', v_job);
end $$;

-- 8. Notification audience: a message job that died -------------------------------------------------------
-- 20261014000007's function with message_failed (packages/shared/src/notifications.ts).
create or replace function notification_audience(p_kind text) returns member_role[]
language sql stable set search_path = public as $$
  select (case p_kind
    when 'invoice_gap' then '{admin,ops,accounts}'        -- §13 "Invoice gap: ops, accounts"
    when 'billing' then '{admin}'                         -- §13 "Billing: admin"
    when 'missing_report' then '{admin,ops}'              -- §13 "Report missing: ops + admin"
    when 'unknown_sender' then '{admin,ops}'              -- §13 "Unknown contact: ops, admin"
    when 'unknown_contact' then '{admin,ops}'
    when 'reporter_invite_failed' then '{admin,ops}'      -- §13 "Message undeliverable / opted out"
    when 'reporter_opted_out' then '{admin,ops}'          -- the same row of §13
    when 'message_failed' then '{admin,ops}'              -- the same row: a message job that died (W1-10)
    when 'reporter_wrong_site' then '{admin,ops}'         -- §2.2 "Manage reporters": admin, ops
    else '{admin,pm,ops}'  -- needs_review (§13: ops, pm), glossary_review, processing_delayed, …
  end)::member_role[];
$$;
