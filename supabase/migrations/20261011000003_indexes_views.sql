-- SiteLog · §6.4 indexes & views

create index on site_days (site_id, date desc);
create index on site_days (status, deadline_at);
create index on reports (org_id, site_id, site_day_id);
create index on reports (org_id, status);
create index on manpower_entries (company_id);
create index on manpower_entries (report_id, version);
create index on weather_events (site_id, date);
create index on messages (conversation_id, created_at desc);
create index on glossary_terms (org_id, status);
create index on jobs (status, run_after);
create unique index jobs_dedupe_key_active on jobs (dedupe_key) where dedupe_key is not null and status in ('queued','running');
create index on audit_log (org_id, created_at desc);
create index on notifications (org_id, created_at desc);
create index on unknown_senders (org_id, status);
create index on questions (report_id);
create index on sub_invoices (org_id, company_id);
create index on transcripts using gin (to_tsvector('english', text));

-- Only the current version is used for aggregates.
-- The views run with the owner's privileges (so `accounts` users can read hours without a
-- policy on reports) and filter by org membership explicitly; service connections see everything.
create or replace function is_service() returns boolean
language sql stable as $$
  select current_user in ('postgres', 'service_role', 'supabase_admin')
      or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
$$;

create view current_manpower as
  select m.*, r.site_id, r.org_id, sd.date, r.report_no, r.status as report_status
  from manpower_entries m
  join reports r on r.id = m.report_id and r.current_version = m.version
  join site_days sd on sd.id = r.site_day_id
  where r.status in ('filed','signed_off')
    and (is_service() or exists (select 1 from org_members om where om.org_id = r.org_id and om.user_id = auth.uid()));

create view current_weather as
  select w.*, r.org_id, r.report_no
  from weather_events w
  join reports r on r.id = w.report_id and r.current_version = w.version
  where r.status in ('filed','signed_off')
    and (is_service() or exists (select 1 from org_members om where om.org_id = r.org_id and om.user_id = auth.uid()
                                 and om.role in ('admin','pm','ops')));
