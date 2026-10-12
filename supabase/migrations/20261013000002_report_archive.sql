-- SiteLog · Reports archive view (§P6, 2026-10-13)
--   One row per filed / signed-off report with what the archive filters, searches and sorts on,
--   all taken from the report's current version: the site-day date, the site name and project
--   code, the lost weather hours, whether it records an incident and its summary. The panel
--   filters, counts and pages this view server-side, so the "Has weather delay" and "Incident"
--   toggles no longer inline id lists into the request URL, an incident removed by a later edit no
--   longer matches, typed reports are found by their text, and the archive sorts by report date.
--
--   Like current_manpower / current_weather, the view runs with the owner's privileges and checks
--   membership itself: the same admin / pm / ops roles that the reports RLS policy allows.

-- Per-report lookup of the current version's weather rows (the view's lost_hours).
create index if not exists weather_events_report_version_idx on weather_events (report_id, version);

create view report_archive as
  select r.*,
         sd.date,
         s.name as site_name,
         s.project_code,
         -- Scalar subquery: only evaluated when a query reads or filters on lost_hours.
         coalesce((select sum(w.lost_hours) from weather_events w
                   where w.report_id = r.id and w.version = r.current_version), 0)::numeric as lost_hours,
         coalesce(case when jsonb_typeof(v.data->'safety'->'incidents') = 'array'
                       then jsonb_array_length(v.data->'safety'->'incidents') end, 0) > 0 as has_incident,
         coalesce(v.summary, v.data->>'summary') as summary
  from reports r
  join site_days sd on sd.id = r.site_day_id
  join sites s on s.id = r.site_id
  left join report_versions v on v.report_id = r.id and v.version = r.current_version
  where r.status in ('filed', 'signed_off')
    and (is_service() or exists (select 1 from org_members om where om.org_id = r.org_id and om.user_id = auth.uid()
                                 and om.role in ('admin', 'pm', 'ops')));

revoke all on report_archive from anon;
grant select on report_archive to authenticated, service_role;
