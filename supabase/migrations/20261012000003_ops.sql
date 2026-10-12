-- SiteLog · internal ops (2026-10-12)
--   §15 Reliability: "dead-letter visible in an internal /ops page (admin of SiteLog only)".
--   §15 Cost guardrail: "Track AI + WhatsApp cost per report; alert if a single report exceeds
--   3× median". §16.2 M9: "Ops page for dead jobs".
--
--   1. platform_admins + is_platform_admin() — SiteLog's own operators. Not an org role: an org
--      admin of a customer is never a platform admin, and platform admins get no customer data
--      through RLS from this table. Operators are added with SQL (docs/RUNBOOK.md §6).
--   2. report_costs — the worker's cost estimate per filed report (integer cents) plus the 30-day
--      baseline it was compared with. A table, not a column on `reports`: cost is SiteLog-internal
--      (customers' reports_select policy must not expose it) and a stored snapshot keeps the
--      median query a cheap indexed aggregate. Inputs: report_cost_inputs(), report_cost_baseline().
--   3. Ops RPCs (platform admins only, security definer): ops_queue_stats, ops_dead_jobs,
--      ops_retry_job, ops_discard_job, ops_cost_outliers. Dead-job payloads are reduced to ids and
--      enum-like fields and errors are redacted, so no phone number, email or message body leaves
--      the database through them. Retry / discard write audit_log (org_id null = platform action).

-- 1. Platform staff -----------------------------------------------------------------------------
create table platform_admins (
  user_id uuid primary key references auth.users on delete cascade,
  note text,                                     -- who / why, e.g. "on-call 2026"
  created_at timestamptz not null default now()
);
-- RLS on and no policies: invisible to anon / authenticated; managed with the service role.
alter table platform_admins enable row level security;
revoke all on platform_admins from anon, authenticated;

create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from platform_admins where user_id = auth.uid());
$$;

-- 2. Cost per report ----------------------------------------------------------------------------
create table report_costs (
  report_id uuid primary key references reports on delete cascade,
  org_id uuid not null references orgs on delete cascade,
  kind text not null,                            -- reports.kind: the baseline compares like with like
  filed_at timestamptz not null,                 -- reports.filed_at (first filing)
  cost_cents int not null check (cost_cents >= 0),  -- AI + WhatsApp estimate, rounded to cents
  median_cents numeric(12,2),                    -- baseline median when estimated; null = sample too small
  sample int not null default 0,                 -- reports in the baseline window
  outlier boolean not null default false,        -- cost_cents > multiplier × median_cents (worker decides)
  detail jsonb not null default '{}',            -- {aiUsd, waTemplates, waTemplateUsd, jobs}
  computed_at timestamptz not null default now()
);
alter table report_costs enable row level security;  -- no policies: service role + ops RPCs only
create index report_costs_baseline on report_costs (kind, filed_at);
create index report_costs_outliers on report_costs (filed_at desc) where outlier;

-- Lookups for report_cost_inputs(): jobs and template messages that reference a report.
create index jobs_payload_report_id on jobs ((payload ->> 'reportId'));
create index jobs_payload_message_id on jobs ((payload ->> 'messageId'));
create index messages_template_report_id on messages ((payload ->> 'reportId'))
  where direction = 'out' and type = 'template';
create index messages_template_site_day_id on messages ((payload ->> 'siteDayId'))
  where direction = 'out' and type = 'template';

-- AI + WhatsApp inputs of one report's cost.
--   ai_usd: jobs.payload.metrics of every job whose payload references the report (reportId) or
--           one of its source messages (messageId: the intake + transcription of the voice notes).
--           costUsdTotal (all attempts, written by the worker on retries) wins over estCostUsd.
--   wa_templates: outbound template messages (Meta bills those; free-form replies inside the 24 h
--           window are free) tagged with the report or its site-day, not failed.
create or replace function report_cost_inputs(p_report_id uuid)
returns table (ai_usd numeric, job_count int, wa_templates int)
language sql stable security definer set search_path = public as $$
  with ids as (
    select j.id from jobs j where j.payload ->> 'reportId' = p_report_id::text
    union
    select j.id
    from report_sources rs
    join jobs j on j.payload ->> 'messageId' = rs.message_id::text
    where rs.report_id = p_report_id
  ),
  costs as (
    select case
             when jsonb_typeof(j.payload #> '{metrics,costUsdTotal}') = 'number'
               then (j.payload #>> '{metrics,costUsdTotal}')::numeric
             when jsonb_typeof(j.payload #> '{metrics,estCostUsd}') = 'number'
               then (j.payload #>> '{metrics,estCostUsd}')::numeric
             else 0
           end as usd
    from jobs j join ids using (id)
  ),
  templates as (
    select m.id
    from messages m
    where m.direction = 'out' and m.type = 'template' and m.status <> 'failed'
      and m.payload ->> 'reportId' = p_report_id::text
    union
    select m.id
    from reports r
    join messages m on m.payload ->> 'siteDayId' = r.site_day_id::text
    where r.id = p_report_id
      and m.direction = 'out' and m.type = 'template' and m.status <> 'failed'
  )
  select coalesce((select sum(usd) from costs), 0)::numeric,
         (select count(*) from costs)::int,
         (select count(*) from templates)::int;
$$;

-- Median cost (cents) of the reports of one kind filed in the p_days before p_before.
create or replace function report_cost_baseline(
  p_kind text, p_before timestamptz, p_exclude uuid default null, p_days int default 30
) returns table (median_cents numeric, sample int)
language sql stable security definer set search_path = public as $$
  select (percentile_cont(0.5) within group (order by c.cost_cents))::numeric,
         count(*)::int
  from report_costs c
  where c.kind = p_kind
    and c.filed_at < p_before
    and c.filed_at >= p_before - make_interval(days => p_days)
    and c.report_id is distinct from p_exclude;
$$;

-- 3. Ops RPCs -----------------------------------------------------------------------------------
-- Errors may quote an API response: drop emails and phone-like numbers, cap the length.
create or replace function ops_redact(p_text text) returns text
language sql immutable set search_path = public as $$
  select case when p_text is null then null else left(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(p_text, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
          '\+[0-9][0-9 ().-]{5,}[0-9]', '[phone]', 'g'),
        '(?<![0-9A-Za-z-])\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-][0-9]{4}(?![0-9A-Za-z-])', '[phone]', 'g'),
      '(?<![0-9A-Za-z-])[0-9]{10,15}(?![0-9A-Za-z-])', '[phone]', 'g'),
    500) end;
$$;

-- Job payload → ids and enum-like fields only (no phone numbers, texts, template vars, emails).
create or replace function ops_payload_summary(p jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) as e(key, value)
  where (e.key ~ '^[A-Za-z]+Id$' and jsonb_typeof(e.value) = 'string'
         and (e.value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (e.key in ('version', 'stage') and jsonb_typeof(e.value) = 'number')
     or (e.key in ('trigger', 'kind', 'template', 'date', 'weekStart', 'reason')
         and jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ '^[A-Za-z0-9_:.-]{1,64}$')
     or (e.key in ('reinvite', 'testMode', 'sendToWhatsApp', 'emailRecipients', 'notifyReporter')
         and jsonb_typeof(e.value) = 'boolean');
$$;

-- Queue health per job type. oldest_due_s = wait of the oldest job that is due (run_after passed)
-- but not claimed yet; jobs backing off until a later run_after are queued, not late.
create or replace function ops_queue_stats()
returns table (type text, queued int, running int, dead int, oldest_due_s int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select j.type,
           (count(*) filter (where j.status = 'queued'))::int,
           (count(*) filter (where j.status = 'running'))::int,
           (count(*) filter (where j.status = 'dead'))::int,
           (extract(epoch from now() - min(j.run_after) filter (
              where j.status = 'queued' and j.run_after <= now())))::int
    from jobs j
    where j.status in ('queued', 'running', 'dead')
    group by j.type
    order by j.type;
end $$;

create or replace function ops_dead_jobs(p_limit int default 100)
returns table (
  id bigint, type text, attempts int, last_error text,
  created_at timestamptz, finished_at timestamptz, payload jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select j.id, j.type, j.attempts, ops_redact(j.last_error), j.created_at, j.finished_at,
           ops_payload_summary(j.payload)
    from jobs j
    where j.status = 'dead'
    order by j.finished_at desc nulls last, j.id desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;

-- Dead → queued with a fresh attempt budget, due now. Refused when another job with the same
-- dedupe key is already queued or running (that job does the same work).
create or replace function ops_retry_job(p_job_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare j jobs%rowtype;
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into j from jobs where jobs.id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.status <> 'dead' then raise exception 'only dead jobs can be retried (status %)', j.status; end if;
  if j.dedupe_key is not null and exists (
    select 1 from jobs x
    where x.dedupe_key = j.dedupe_key and x.status in ('queued', 'running') and x.id <> j.id
  ) then
    raise exception 'job % is already queued again as job %', j.id, (
      select x.id from jobs x
      where x.dedupe_key = j.dedupe_key and x.status in ('queued', 'running') and x.id <> j.id
      limit 1);
  end if;
  update jobs
  set status = 'queued', attempts = 0, run_after = now(), finished_at = null,
      locked_at = null, locked_by = null
  where jobs.id = p_job_id;
  perform log_audit(null, 'user', auth.uid(), 'ops.job_retried', 'job', null,
    jsonb_build_object('job_id', j.id, 'type', j.type, 'attempts', j.attempts,
                       'last_error', ops_redact(j.last_error)));
  return jsonb_build_object('id', j.id, 'status', 'queued');
end $$;

-- Dead → failed: kept for forensics, never claimed again (fail_job never writes 'failed', so the
-- status only ever means "discarded by an operator").
create or replace function ops_discard_job(p_job_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare j jobs%rowtype;
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into j from jobs where jobs.id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.status <> 'dead' then raise exception 'only dead jobs can be discarded (status %)', j.status; end if;
  update jobs set status = 'failed', locked_at = null, locked_by = null where jobs.id = p_job_id;
  perform log_audit(null, 'user', auth.uid(), 'ops.job_discarded', 'job', null,
    jsonb_build_object('job_id', j.id, 'type', j.type, 'attempts', j.attempts,
                       'last_error', ops_redact(j.last_error)));
  return jsonb_build_object('id', j.id, 'status', 'failed');
end $$;

-- Filed reports the worker flagged as cost outliers in the last p_days.
create or replace function ops_cost_outliers(p_days int default 30)
returns table (
  report_id uuid, report_no text, org_id uuid, org_name text, site_id uuid, site_name text,
  kind text, filed_at timestamptz, cost_cents int, median_cents numeric, sample int, detail jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select c.report_id, r.report_no, c.org_id, o.name, r.site_id, s.name,
           c.kind, c.filed_at, c.cost_cents, c.median_cents, c.sample, c.detail
    from report_costs c
    join reports r on r.id = c.report_id
    join orgs o on o.id = c.org_id
    join sites s on s.id = r.site_id
    where c.outlier
      and c.filed_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
    order by c.filed_at desc
    limit 200;
end $$;

-- Grants: the panel calls is_platform_admin() and the ops_* RPCs (each checks the caller);
-- the cost inputs and helpers are for the worker (service role) only.
revoke execute on function is_platform_admin(), ops_queue_stats(), ops_dead_jobs(int),
  ops_retry_job(bigint), ops_discard_job(bigint), ops_cost_outliers(int) from public, anon;
grant execute on function is_platform_admin(), ops_queue_stats(), ops_dead_jobs(int),
  ops_retry_job(bigint), ops_discard_job(bigint), ops_cost_outliers(int) to authenticated;
revoke execute on function report_cost_inputs(uuid), report_cost_baseline(text, timestamptz, uuid, int),
  ops_redact(text), ops_payload_summary(jsonb) from public, anon, authenticated;
