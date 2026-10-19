-- A call that ended in the fallback recording (F6 failure handling) left its open question with
-- channel 'voice': post_call_fallback_report() did not hand it to the web as post_call_settle()
-- does on a hang-up (§19 Q122). The field app showed it (the newest open question) and
-- field-api refused the answer (`question_closed`), so the reporter could neither answer nor go
-- on (preview Talk now, 2026-10-19). Forward only: the function hands the call's open questions to
-- the web, and the questions already left so by an ended call are handed over once here.

create or replace function post_call_fallback_report(p_call_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  r reports%rowtype;
  v_date date;
  v_from report_status;
  v_created boolean := false;
  v_job bigint;
  v_handed int := 0;
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is null or c.outcome is distinct from 'fallback_recording' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if c.reporter_id is null or c.org_id is null then
    raise exception 'unknown_caller' using errcode = 'P0001';
  end if;
  if c.site_id is null then
    -- F14: the site was never picked; nothing names the report (the office hears the call).
    perform log_audit(c.org_id, 'system', null, 'call.fallback_unused', 'call', c.id,
      jsonb_build_object('reason', 'site_required'));
    return jsonb_build_object('status', 'site_required');
  end if;
  select * into s from sites where id = c.site_id;
  v_date := (coalesce(c.started_at, c.created_at) at time zone s.timezone)::date;
  sd := field_lock_site_day(s.id, v_date);
  select * into r from reports where site_day_id = sd.id and status <> 'void'
   order by created_at limit 1 for update;
  if (r.id is not null and r.status in ('filed', 'signed_off'))
     or (r.id is null and sd.status in ('filed', 'weather_day', 'no_work'))
     or (r.id is not null and exists (
           select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                                and status in ('queued', 'running'))) then
    perform log_audit(c.org_id, 'system', null, 'call.fallback_unused', 'call', c.id,
      jsonb_build_object('reason', 'report_closed', 'report_id', r.id));
    return jsonb_build_object('status', 'report_closed', 'reportId', r.id);
  end if;

  if r.id is null then
    insert into reports (org_id, site_id, site_day_id, report_no, status, kind, reporter_id,
                         received_at, channel, language)
    values (s.org_id, s.id, sd.id, next_report_no(s.id), 'processing', 'daily', c.reporter_id,
            now(), 'voice', org_report_language(s.org_id))
    returning * into r;
    v_created := true;
    perform log_audit(s.org_id, 'reporter', c.reporter_id, 'report.created', 'report', r.id,
      jsonb_build_object('report_no', r.report_no, 'date', v_date, 'channel', 'voice',
                         'status', r.status, 'call_id', c.id, 'fallback', true));
  elsif r.status <> 'processing' then
    -- §7.2: more audio puts the report back to processing.
    v_from := r.status;
    update reports set status = 'processing' where id = r.id returning * into r;
    perform log_audit(s.org_id, 'reporter', c.reporter_id, 'report.status_changed', 'report', r.id,
      jsonb_build_object('from', v_from, 'to', 'processing', 'call_id', c.id, 'fallback', true));
  end if;
  if not exists (select 1 from report_sources where report_id = r.id and call_id = c.id) then
    insert into report_sources (report_id, kind, call_id, taken_at)
    values (r.id, 'call', c.id, coalesce(c.answered_at, c.started_at, now()));
  end if;
  update calls set report_id = r.id, site_day_id = sd.id where id = c.id;
  -- The call's open question goes to the web, as on a hang-up (post_call_settle(), §19 Q122):
  -- the recorder answers only `web` questions (F7), and the view shows the newest open one, so a
  -- `voice` question left open after the fallback could be neither answered nor passed.
  update questions set channel = 'web'
   where call_id = c.id and answered_at is null and channel = 'voice';
  get diagnostics v_handed = row_count;
  if v_handed > 0 then
    perform log_audit(c.org_id, 'system', null, 'report.questions_handed_to_web', 'report', r.id,
      jsonb_build_object('call_id', c.id, 'questions', v_handed));
  end if;
  if sd.status in ('pending', 'reminded', 'missing') then
    update site_days set status = 'processing' where id = sd.id;
    perform log_audit(s.org_id, 'reporter', c.reporter_id, 'site_day.status_changed', 'site_day',
      sd.id, jsonb_build_object('from', sd.status, 'to', 'processing', 'report_id', r.id,
                                'call_id', c.id));
  end if;
  v_job := enqueue_job('extract_report', jsonb_build_object('reportId', r.id, 'reason', 'call:' || c.id),
                       null, 'extract:' || r.id || ':call:' || c.id);
  perform log_audit(c.org_id, 'system', null, 'call.fallback_report', 'call', c.id,
    jsonb_build_object('report_id', r.id, 'job_id', v_job, 'report_created', v_created));
  return jsonb_build_object('status', 'queued', 'reportId', r.id, 'jobId', v_job,
                            'created', v_created);
end $$;

-- The questions already stuck: an ended call's open `voice` question is the web's.
with handed as (
  update questions q set channel = 'web'
    from calls c
   where q.call_id = c.id and c.ended_at is not null and q.answered_at is null
     and q.channel = 'voice'
  returning q.report_id, c.id as call_id, c.org_id
)
select log_audit(h.org_id, 'system', null, 'report.questions_handed_to_web', 'report', h.report_id,
                 jsonb_build_object('call_id', h.call_id, 'questions', count(*)::int,
                                    'repair', '20261019000100'))
  from handed h
 group by h.org_id, h.report_id, h.call_id;
