-- SiteLog · job queue fairness and intake race (2026-10-12), found by the worker load test.
--   1. jobs.lock_key: jobs about one WhatsApp conversation (inbound_message, transcribe_audio,
--      parse_reply) run one at a time. Two messages sent together (voice note + photo) were handled
--      by two worker slots at once and could create two reports for one site-day, or extract a
--      report before its transcript existed. The key is derived on insert, so the webhook and the
--      worker keep calling enqueue_job unchanged.
--   2. claim_jobs(): skips a job while an earlier job with the same key is due or running, and
--      claims short conversational jobs first, then filing, PDF and the report email (acks were
--      waiting behind transcription and extraction under load: ack p95 26 min in the load test;
--      the filed-report email waited ~37 min behind them once acks were first).
--   3. At most one non-void report per site-day (edits are versions of that report).
--   4. Indexes for lookups that were sequential scans: reports by site-day, reporters by phone
--      (webhook + every session), site_reporters by reporter.

-- 1. Lock key ------------------------------------------------------------------------------------
alter table jobs add column lock_key text;  -- + per-conversation serialisation
create index jobs_lock_key_active on jobs (lock_key, id) where lock_key is not null and status in ('queued','running');

create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_type in ('inbound_message', 'transcribe_audio', 'parse_reply')
         and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
      then (select 'convo:' || m.conversation_id from messages m
             where m.id = (p_payload ->> 'messageId')::uuid and m.conversation_id is not null)
  end;
$$;

create or replace function jobs_set_lock_key() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.lock_key is null then new.lock_key := job_lock_key(new.type, new.payload); end if;
  return new;
end $$;

create trigger jobs_lock_key before insert on jobs
  for each row execute function jobs_set_lock_key();

-- 2. Claim: one job per lock key at a time; conversational jobs first ------------------------------
create or replace function job_priority(p_type text) returns int
language sql immutable set search_path = public as $$
  select case
    when p_type in ('inbound_message', 'send_message', 'send_template', 'send_welcome') then 0
    when p_type in ('parse_reply', 'decide_next', 'file_report', 'render_pdf', 'send_email') then 1
    when p_type in ('transcribe_audio', 'extract_report') then 2
    else 3
  end;
$$;

create or replace function claim_jobs(p_worker text, p_limit int default 4)
returns setof jobs language sql security definer set search_path = public as $$
  with candidates as (
    select j.id from jobs j
    where ((j.status = 'queued' and j.run_after <= now())
        or (j.status = 'running' and j.locked_at < now() - interval '15 minutes'))
      and (j.lock_key is null or not exists (
        select 1 from jobs o
        where o.lock_key = j.lock_key and o.id <> j.id
          and ((o.status = 'running' and o.locked_at >= now() - interval '15 minutes')
            or (o.status = 'queued' and o.run_after <= now() and o.id < j.id))
      ))
    order by job_priority(j.type), j.run_after, j.id
    limit p_limit
    for update skip locked
  )
  update jobs j
  set status = 'running', locked_at = now(), locked_by = p_worker, attempts = j.attempts + 1
  from candidates c
  where j.id = c.id
  returning j.*;
$$;

revoke execute on function claim_jobs(text, int), job_lock_key(text, jsonb) from public, anon, authenticated;

-- 3. One live report per site-day -----------------------------------------------------------------
create unique index reports_one_live_per_site_day on reports (site_day_id) where status <> 'void';

-- 4. Missing lookup indexes -----------------------------------------------------------------------
create index reports_site_day_id on reports (site_day_id);
create index reporters_phone_e164 on reporters (phone_e164);
create index site_reporters_reporter_id on site_reporters (reporter_id);
