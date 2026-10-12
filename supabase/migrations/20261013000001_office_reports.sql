-- SiteLog · office-entered daily reports (2026-10-13)
--   An office user (admin, pm, ops) types a daily report in the panel: no WhatsApp, no AI. It is
--   filed at once as version 1; the browser renders the PDF, uploads it to `pdfs` and attaches it.
--   1. create_office_report() — files the report for a site and a local date (today or earlier),
--      creating the site-day when the scheduler never did. A day that already has a live report
--      (WhatsApp in flight, filed, weather day) is left alone and that report is returned, so a
--      double submit never files twice. No jobs are enqueued: the browser renders the PDF.
--   2. attach_version_pdf()   — records the uploaded PDF on the version. The path must be the one
--                                pdfStoragePath() builds ({org}/{site}/{report_no}_v{n}.pdf).
--   3. Storage: office roles may upload (and upsert) PDFs under their org's folder in `pdfs`.

-- 1. File an office-entered report ----------------------------------------------------------------
-- p_data is a full DailyReportData (packages/shared/src/schemas/report.ts); reportDate and
-- schemaVersion are set here so they always match the day. Returns {reportId, reportNo, created}.
create or replace function create_office_report(p_site_id uuid, p_date date, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sites%rowtype;
  sd site_days%rowtype;
  v_existing reports%rowtype;
  v_deadline time;
  v_data jsonb;
  v_report_id uuid;
  v_report_no text;
  v_late boolean;
begin
  select * into s from sites where id = p_site_id;
  if s.id is null then raise exception 'site not found'; end if;
  if not has_role(s.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if s.status = 'archived' then raise exception 'site is archived'; end if;
  if p_date is null then raise exception 'date required'; end if;
  if p_date > (now() at time zone s.timezone)::date then raise exception 'date is in the future'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'report data must be a JSON object'; end if;
  v_data := p_data || jsonb_build_object('reportDate', to_char(p_date, 'YYYY-MM-DD'), 'schemaVersion', 1);

  -- The row lock serialises concurrent calls for one day; a concurrent first insert is absorbed
  -- by "on conflict do nothing" and the re-select then waits for the winner's lock.
  select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  if sd.id is null then
    v_deadline := coalesce(
      s.deadline,
      (select default_deadline from org_settings where org_id = s.org_id),
      '17:30'::time);
    insert into site_days (site_id, date, status, deadline_at)
    values (p_site_id, p_date, 'pending', (p_date + v_deadline)::timestamp at time zone s.timezone)
    on conflict (site_id, date) do nothing;
    select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  end if;

  select * into v_existing from reports
  where site_day_id = sd.id and status <> 'void'
  order by created_at
  limit 1;
  if v_existing.id is not null then
    return jsonb_build_object('reportId', v_existing.id, 'reportNo', v_existing.report_no, 'created', false);
  end if;

  v_report_no := next_report_no(p_site_id);
  v_late := now() > sd.deadline_at;
  insert into reports (org_id, site_id, site_day_id, report_no, status, kind, current_version,
                       reporter_id, received_at, confirmed_at, filed_at, is_late)
  values (s.org_id, p_site_id, sd.id, v_report_no, 'filed', 'daily', 1,
          null, now(), null, now(), v_late)  -- confirmed_at: only a WhatsApp confirm sets it
  returning id into v_report_id;

  insert into report_versions (report_id, version, data, summary, author, author_user_id)
  values (v_report_id, 1, v_data, nullif(v_data->>'summary', ''), 'office_user', auth.uid());
  perform denormalize_report_version(v_report_id, 1);

  update site_days set status = 'filed', report_id = v_report_id, is_late = v_late where id = sd.id;

  perform log_audit(s.org_id, 'user', auth.uid(), 'report.filed', 'report', v_report_id,
    jsonb_build_object('trigger', 'office_entry', 'version', 1, 'is_late', v_late, 'date', p_date));

  return jsonb_build_object('reportId', v_report_id, 'reportNo', v_report_no, 'created', true);
end $$;

-- 2. Attach a browser-rendered PDF ------------------------------------------------------------------
create or replace function attach_version_pdf(p_report_id uuid, p_version int, p_path text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  perform 1 from report_versions where report_id = p_report_id and version = p_version for update;
  if not found then raise exception 'version not found'; end if;
  if p_path is distinct from (r.org_id || '/' || r.site_id || '/' || r.report_no || '_v' || p_version || '.pdf') then
    raise exception 'unexpected pdf path';
  end if;
  update report_versions set pdf_path = p_path where report_id = p_report_id and version = p_version;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.pdf_rendered', 'report', p_report_id,
    jsonb_build_object('version', p_version, 'path', p_path, 'renderer', 'browser'));
  return jsonb_build_object('path', p_path);
end $$;

revoke execute on function create_office_report(uuid, date, jsonb),
  attach_version_pdf(uuid, int, text) from public, anon;
grant execute on function create_office_report(uuid, date, jsonb),
  attach_version_pdf(uuid, int, text) to authenticated;

-- 3. Storage: office uploads PDFs -------------------------------------------------------------------
-- `upload(..., { upsert: true })` needs INSERT, and UPDATE (plus SELECT, "members read org files")
-- when the object already exists, e.g. a re-render of the same version.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute $p$ create policy "office writes pdfs" on storage.objects for insert to authenticated
      with check (bucket_id = 'pdfs' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin,pm,ops}')) $p$;
    execute $p$ create policy "office updates pdfs" on storage.objects for update to authenticated
      using (bucket_id = 'pdfs' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin,pm,ops}'))
      with check (bucket_id = 'pdfs' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin,pm,ops}')) $p$;
  end if;
end $$;
