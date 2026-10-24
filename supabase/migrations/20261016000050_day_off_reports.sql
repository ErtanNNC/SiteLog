-- SiteLog · No work and Weather as reports (W2-08; spec F12, §7.1, §12, §19 Q41, Q79)
--
-- Spec §19 Q41 (decided: the second): the recorder's *Site closed: weather* and *No work today*
-- make a report like the v1.0 WhatsApp day-off path: numbered, a version built from the
-- reporter's details, filed by the worker through file_report with trigger `weather_day` /
-- `no_work`. Its values need a §10.3 source and a tap has none, so the details are answered web
-- `questions` rows ("Since when?" as `weather.impact`, "How many were on site before?" as
-- `manpower.workers`) and the values cite them (`{type: 'answer', questionId}`).
--
-- field_report_day_off() (service role; field-api's `POST day-status` from W2-08) does it in one
-- transaction under the site-day lock (field_lock_site_day, as every field write):
--   - the site-day must be `pending` or `reminded` with no live report: a filed report refuses
--     (`report_filed`), a report on its way refuses (`report_in_progress`, spec §19 Q79's default:
--     the reporter says it in the report), any other state (`wrong_state`); the same status again
--     answers what the first call made (`changed: false`, a retried tap);
--   - the site-day becomes `weather_day` / `no_work` at once, so the reminder ladder stops
--     (claim_site_day_reminder() and the `notify` guard of W2-06 read the status);
--   - a weather day always, and a no-work day when the org keeps a no-work PDF
--     (`org_settings.no_work_pdf`; otherwise the site-day only, as the WhatsApp path and the
--     office's mark_no_work()), gets the report: `processing`, `kind` = the status, channel `web`,
--     the org's report language, the reporter; the questions (ids from field-api, answered now);
--     version 1 with the data field-api built in code (lost hours, crew hours: `dayOffReportData`,
--     packages/shared/src/report/day-off.ts), author `reporter`, via `web`; and `file_report`
--     {reportId, trigger} keyed `file:<report>:v1:<status>` (a report is made once). Filing
--     denormalises the version (weather_events with its lost hours) and renders the PDF; the
--     weather day's photo of the conditions is F9's *Add more photos* on the Filed screen
--     (field_attach_photos, 20261016000030), which raises weather_events.photo_count.
--   - audited: `report.created` (with the question ids) and `site_day.<status>` (the details, the
--     report).
--
-- field_set_day_status() (20261014000006) stays as it is for a field-api deployed before this
-- migration; the W2-08 field-api no longer calls it.
--
-- Live database: one new function (service role only); nothing changes for existing rows.

set local lock_timeout = '5s';

create function field_report_day_off(
  p_reporter_id uuid, p_site_id uuid, p_date date, p_status text,
  p_details jsonb, p_questions jsonb, p_data jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sd site_days%rowtype;
  r reports%rowtype;
  v_org uuid;
  v_make boolean;
  v_q jsonb;
  v_ids uuid[] := '{}';
  v_job bigint;
begin
  if p_status not in ('no_work', 'weather_day') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if not field_reporter_on_site(p_reporter_id, p_site_id) then
    raise exception 'site_not_found' using errcode = 'P0002';
  end if;
  v_org := site_org(p_site_id);
  sd := field_lock_site_day(p_site_id, p_date);
  if sd.status::text = p_status then
    -- A retried tap: what the first call made.
    select * into r from reports where id = sd.report_id and kind = p_status;
    return jsonb_build_object('siteDayId', sd.id, 'status', sd.status, 'changed', false,
      'report', case when r.id is null then null
                     else jsonb_build_object('id', r.id, 'reportNo', r.report_no) end);
  end if;
  select * into r from reports where site_day_id = sd.id and status <> 'void'
  order by created_at limit 1;
  if r.id is not null and r.status in ('filed', 'signed_off') then
    raise exception 'report_filed' using errcode = 'P0001';
  end if;
  if r.id is not null then
    -- Spec §19 Q79 (open; default): keep refusing while the day's report is on its way.
    raise exception 'report_in_progress' using errcode = 'P0001';
  end if;
  if sd.status not in ('pending', 'reminded') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;

  v_make := p_status = 'weather_day'
    or coalesce((select no_work_pdf from org_settings where org_id = v_org), false);
  if v_make then
    if jsonb_typeof(p_data) is distinct from 'object' or p_data ->> 'schemaVersion' is distinct from '2'
       or jsonb_typeof(coalesce(p_questions, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) > 2 then
      raise exception 'invalid_day_off_data' using errcode = 'P0001';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) q
               where q ->> 'field' not in ('weather.impact', 'manpower.workers')
                  or coalesce(q ->> 'id', '') !~ '^[0-9a-f-]{36}$'
                  or coalesce(q ->> 'prompt', '') = '') then
      raise exception 'invalid_day_off_data' using errcode = 'P0001';
    end if;
    insert into reports (org_id, site_id, site_day_id, report_no, status, kind, reporter_id,
                         received_at, channel, language, current_version)
    values (v_org, p_site_id, sd.id, next_report_no(p_site_id), 'processing', p_status,
            p_reporter_id, now(), 'web', org_report_language(v_org), 1)
    returning * into r;
    for v_q in select * from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) loop
      insert into questions (id, report_id, field, target, prompt, options, asked_at, answered_at,
                             answer, answer_source, channel)
      values ((v_q ->> 'id')::uuid, r.id, v_q ->> 'field', v_q -> 'target', v_q ->> 'prompt',
              null, now(), now(), v_q -> 'answer',
              jsonb_build_object('type', 'answer', 'questionId', v_q ->> 'id'), 'web');
      v_ids := v_ids || (v_q ->> 'id')::uuid;
    end loop;
    insert into report_versions (report_id, version, data, summary, author, via)
    values (r.id, 1, p_data, nullif(p_data ->> 'summary', ''), 'reporter', 'web');
    v_job := enqueue_job('file_report', jsonb_build_object('reportId', r.id, 'trigger', p_status),
                         null, 'file:' || r.id || ':v1:' || p_status);
    perform log_audit(v_org, 'reporter', p_reporter_id, 'report.created', 'report', r.id,
      jsonb_build_object('report_no', r.report_no, 'date', p_date, 'channel', 'web',
                         'kind', p_status, 'status', r.status, 'question_ids', to_jsonb(v_ids),
                         'job_id', v_job));
  end if;

  update site_days set status = p_status::site_day_status, report_id = coalesce(r.id, report_id)
  where id = sd.id;
  perform log_audit(v_org, 'reporter', p_reporter_id, 'site_day.' || p_status, 'site_day', sd.id,
    jsonb_build_object('from', sd.status, 'to', p_status, 'date', p_date, 'channel', 'web',
                       'details', coalesce(p_details, '{}'::jsonb), 'report_id', r.id));
  return jsonb_build_object('siteDayId', sd.id, 'status', p_status, 'changed', true,
    'report', case when r.id is null then null
                   else jsonb_build_object('id', r.id, 'reportNo', r.report_no) end);
end $$;

revoke execute on function field_report_day_off(uuid, uuid, date, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function field_report_day_off(uuid, uuid, date, text, jsonb, jsonb, jsonb)
  to service_role;
