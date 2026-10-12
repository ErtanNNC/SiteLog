-- SiteLog · RPC fixes found by the worker's real-database tests (2026-10-12)
--   1. next_report_no(): lpad() truncates, so report 10000 became "…-1000" and collided.
--      Pad to at least 4 digits, never cut.
--   2. denormalize_report_version(): a uuid-shaped companyId that is not a company of the report's
--      org (deleted before filing, or posted by an office edit) violated
--      manpower_entries_company_id_fkey and filing failed. Unknown ids are stored as null; the
--      company name is kept, so the row still reads correctly and shows as unconfirmed.

create or replace function next_report_no(p_site_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_seq int;
begin
  update sites set report_seq = report_seq + 1 where id = p_site_id returning project_code, report_seq into v_code, v_seq;
  if v_code is null then raise exception 'site not found'; end if;
  return v_code || '-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');
end $$;

create or replace function denormalize_report_version(p_report_id uuid, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare v_data jsonb; v_site uuid; v_org uuid; v_date date; v_photo_count int;
begin
  select rv.data, r.site_id, r.org_id, (rv.data->>'reportDate')::date
    into v_data, v_site, v_org, v_date
  from report_versions rv join reports r on r.id = rv.report_id
  where rv.report_id = p_report_id and rv.version = p_version;
  if v_data is null then raise exception 'version not found'; end if;
  v_photo_count := coalesce(jsonb_array_length(v_data->'photos'), 0);

  delete from manpower_entries where report_id = p_report_id and version = p_version;
  delete from work_items where report_id = p_report_id and version = p_version;
  delete from weather_events where report_id = p_report_id and version = p_version;

  insert into manpower_entries (report_id, version, company_id, company_name_heard, company_name, trade, area, workers, hours, hours_basis, source, confidence)
  select p_report_id, p_version,
         (select c.id from companies c
           where (m->>'companyId') ~ '^[0-9a-f-]{36}$'
             and c.id = (m->>'companyId')::uuid and c.org_id = v_org),
         m->>'companyNameHeard', m->>'companyName', m->>'trade', m->>'area',
         coalesce((m->>'workers')::int, 0), coalesce((m->>'totalHours')::numeric, 0),
         m->>'hoursBasis', m->'source'->0, (m->>'confidence')::numeric
  from jsonb_array_elements(coalesce(v_data->'manpower', '[]'::jsonb)) m;

  insert into work_items (report_id, version, area, activity, status, percent, quantity, source)
  select p_report_id, p_version, w->>'area', w->>'activity', w->>'status', (w->>'percentComplete')::int,
         case when w ? 'quantity' then (w->'quantity'->>'value') || ' ' || (w->'quantity'->>'unit') end,
         w->'source'->0
  from jsonb_array_elements(coalesce(v_data->'workPerformed', '[]'::jsonb)) w;

  insert into weather_events (report_id, version, site_id, date, start_local, end_local, condition, impact, lost_hours, full_day, audio_source, photo_count, observed)
  select p_report_id, p_version, v_site, v_date,
         nullif(p->>'start','')::time, nullif(p->>'end','')::time, p->>'condition', p->>'impact',
         coalesce((p->>'lostHours')::numeric, 0), coalesce((p->>'fullDay')::boolean, false),
         (select s from jsonb_array_elements(coalesce(p->'source','[]'::jsonb)) s where s->>'type' = 'audio' limit 1),
         v_photo_count, v_data->'weather'->'observed'
  from jsonb_array_elements(coalesce(v_data->'weather'->'periods', '[]'::jsonb)) p;
end $$;
