-- SiteLog · late clips (spec §19 Q53, decided by the owner 2026-10-15)
--
-- A clip recorded inside a day's window that reaches field-api after the window closed (recorded
-- offline in the evening and sent the next afternoon) is filed under the day it was recorded when
-- it arrives within 48 h of the window's end (field-api `lateClipAllowed`). field-api completes it
-- as usual (field_complete_upload()) and then calls field_flag_late_upload(), which:
--   - marks the report and its site-day late (`is_late`, the panel's Late badge and filter; filing
--     sets `is_late` again from the deadline, which a late clip has passed),
--   - audits `upload.accepted_late` as the reporter (the upload, its report, date and recording
--     time),
--   - tells the office once per report: a `late_upload` panel notice (admin, pm, ops: a kind §13
--     does not list, `notification_audience()`'s default), English like the worker's notices.
-- Once per upload: a retried complete flags nothing twice (`flagged` false).
--
-- Forward-only and CLI-safe: one new function, service role only; nothing existing changes.

create function field_flag_late_upload(p_upload_id uuid, p_reporter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uploads%rowtype;
  r reports%rowtype;
  sd site_days%rowtype;
  v_site text;
  v_reporter text;
  v_notified boolean := false;
begin
  select * into u from uploads where id = p_upload_id;
  if u.id is null or u.reporter_id is distinct from p_reporter_id or u.report_id is null
     or not field_reporter_on_site(p_reporter_id, u.site_id) then
    raise exception 'upload_not_found' using errcode = 'P0002';
  end if;
  -- The report's row lock serialises two late clips of one report (one notice).
  select * into r from reports where id = u.report_id for update;
  if exists (select 1 from audit_log
             where org_id = r.org_id and action = 'upload.accepted_late' and entity = 'upload'
               and entity_id = u.id) then
    return jsonb_build_object('flagged', false, 'reportId', r.id);
  end if;
  select * into sd from site_days where id = r.site_day_id;

  update reports set is_late = true where id = r.id and not is_late;
  update site_days set is_late = true where id = sd.id and not is_late;

  if not exists (select 1 from audit_log
                 where org_id = r.org_id and action = 'upload.accepted_late'
                   and diff ->> 'report_id' = r.id::text) then
    select name into v_site from sites where id = r.site_id;
    select name into v_reporter from reporters where id = p_reporter_id;
    perform notify_org(
      r.org_id,
      'late_upload',
      v_site || ' — late ' || case when u.kind = 'audio' then 'voice note' else 'photo' end
        || ' for ' || to_char(sd.date, 'Dy Mon FMDD'),
      coalesce(v_reporter, 'The site manager') || ' recorded it on that day, and it arrived after '
        || 'the day''s reporting window had closed. It is on report ' || r.report_no
        || ', marked late.',
      '/reports/' || r.id);
    v_notified := true;
  end if;
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'upload.accepted_late', 'upload', u.id,
    jsonb_build_object('report_id', r.id, 'date', sd.date, 'kind', u.kind,
                       'recorded_at', u.recorded_at, 'received_at', u.received_at,
                       'notified', v_notified));
  return jsonb_build_object('flagged', true, 'reportId', r.id, 'notified', v_notified);
end $$;

revoke execute on function field_flag_late_upload(uuid, uuid) from public, anon, authenticated;
grant execute on function field_flag_late_upload(uuid, uuid) to service_role;
