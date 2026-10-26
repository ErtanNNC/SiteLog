-- SiteLog · the reminder ladder through the Notifier (W2-06; spec §7.1, §7.4, F11, §13, §19 Q55,
-- Q76, Q77)
--
-- scheduler-tick claims each ladder stage of a site-day (the daily link, the weather heads-up,
-- R1, R2) and queues the stage's `notify` jobs in one transaction, like mark_site_day_missing():
--
--   1. claim_site_day_reminder() (service role): locks the site-day and claims the stage only
--      while it still waits for a report: status `pending` or `reminded` (re-read after a
--      concurrent filing or upload commits, so a race never overwrites `filed` or `processing`),
--      reminders not paused, the site active, the date one of the org's working days, no live
--      report (any report of the day that is not void), and the stage not yet run (R1–R2 and the
--      heads-up by `reminder_stage` 1–3; the daily link, which is not a stage value, by its audit
--      row). Then, together: `reminder_stage` (and `reminded` from R1), the stage's audit row
--      `site_day.reminder` (who was sent what, who was skipped and why, the remind() reasons),
--      `site_day.status_changed` when the status moves, and one `notify` job per message, keyed
--      `notify:<key>:<site_day>:<reporter>` (the Notifier's dedupe key too), with the guard the
--      job checks again before sending (the statuses, and the call window's end when quiet hours
--      skip, §19 Q77). False when the claim lost: nothing is written.
--   2. mark_site_day_missing(): the missing step also leaves a non-working day alone (a site-day
--      created on a Saturday by a stray upload is never escalated), and takes `p_reminders`, the
--      reminders (R1, R2) that reached the reporter, for the `report_missing` email's wording
--      (§13 "{first} didn't answer {n} reminders"; none: §19 Q55's wording).
--
-- Closes docs/AUDIT_BACKLOG.md "Reminder-ladder claim overwrites a site-day…", "Ladder claim and
-- reminder send are not guarded by the site-day status", "Site-days created on non-working days…"
-- (with scheduler-tick's planLadder / planMissing).
--
-- Live database (staging): one new function, one replaced by a version with one more defaulted
-- argument (service role only, as before); no table changes. The deployed scheduler-tick keeps
-- calling mark_site_day_missing() with named arguments and never calls the new function.

set local lock_timeout = '5s';

-- 1. The stage claim ---------------------------------------------------------------------------------
create function claim_site_day_reminder(
  p_site_day_id uuid,
  p_stage text,
  p_messages jsonb,
  p_skipped jsonb default '[]'::jsonb,
  p_not_after timestamptz default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  sd site_days%rowtype;
  v_org uuid;
  v_stage int;
  v_key_name text;
  v_working int[];
  v_to site_day_status;
  v_guard jsonb;
  m jsonb;
  v_key text;
  v_sent jsonb := '[]'::jsonb;
begin
  v_stage := case p_stage
    when 'daily_link' then null when 'heads_up' then 1 when 'reminder_1' then 2
    when 'reminder_2' then 3 else -1 end;
  if v_stage = -1 then
    raise exception 'unknown ladder stage %', p_stage using errcode = '22023';
  end if;
  v_key_name := case p_stage
    when 'daily_link' then 'daily_link' when 'heads_up' then 'weather_headsup'
    when 'reminder_1' then 'reminder_1' else 'reminder_2' end;
  if jsonb_typeof(p_messages) is distinct from 'array'
     or jsonb_typeof(p_skipped) is distinct from 'array' then
    raise exception 'p_messages and p_skipped must be arrays' using errcode = '22023';
  end if;

  -- The claim: the row lock re-reads the status after a concurrent writer commits.
  select * into sd from site_days
   where id = p_site_day_id and status in ('pending', 'reminded') and not reminders_paused
     for update;
  if sd.id is null then return false; end if;
  select s.org_id into v_org from sites s where s.id = sd.site_id and s.status = 'active';
  if v_org is null then return false; end if;
  select working_days into v_working from org_settings where org_id = v_org;
  if v_working is null or not (extract(isodow from sd.date)::int = any (v_working)) then
    return false;
  end if;
  if exists (select 1 from reports r where r.site_day_id = sd.id and r.status <> 'void') then
    return false;
  end if;
  if v_stage is null then
    if sd.reminder_stage >= 2 or exists (
      select 1 from audit_log a
       where a.org_id = v_org and a.entity = 'site_day' and a.entity_id = sd.id
         and a.action = 'site_day.reminder' and a.diff ->> 'stage' = 'daily_link') then
      return false;
    end if;
  elsif sd.reminder_stage >= v_stage then
    return false;
  end if;

  v_guard := jsonb_build_object('siteDayId', sd.id, 'statuses', jsonb_build_array('pending', 'reminded'));
  if p_not_after is not null then
    v_guard := v_guard || jsonb_build_object('notAfter', p_not_after);
  end if;

  for m in select * from jsonb_array_elements(p_messages) loop
    if m ->> 'key' is distinct from v_key_name then
      raise exception 'stage % sends %, not %', p_stage, v_key_name, m ->> 'key' using errcode = '22023';
    end if;
    if not exists (select 1 from site_reporters sr
                    where sr.site_id = sd.site_id and sr.reporter_id = (m ->> 'reporterId')::uuid) then
      raise exception 'reporter % is not on the site', m ->> 'reporterId' using errcode = '22023';
    end if;
    v_key := 'notify:' || (m ->> 'key') || ':' || p_site_day_id || ':' || (m ->> 'reporterId');
    perform enqueue_job('notify',
                        jsonb_build_object('reporterId', m ->> 'reporterId', 'key', m ->> 'key',
                                           'vars', coalesce(m -> 'vars', '{}'::jsonb),
                                           'dedupeKey', v_key, 'guard', v_guard),
                        null,
                        v_key);
    v_sent := v_sent || to_jsonb(m ->> 'reporterId');
  end loop;

  v_to := sd.status;
  if v_stage is not null then
    if v_stage >= 2 then v_to := 'reminded'; end if;
    update site_days set reminder_stage = v_stage, status = v_to where id = sd.id;
  end if;
  perform log_audit(v_org, 'system', null, 'site_day.reminder', 'site_day', sd.id,
                    jsonb_build_object('stage', p_stage, 'key', v_key_name,
                                       'reminder_stage', coalesce(v_stage, sd.reminder_stage),
                                       'sent', v_sent, 'skipped', p_skipped,
                                       'not_after', p_not_after, 'by', 'scheduler-tick'));
  if v_to is distinct from sd.status then
    perform log_audit(v_org, 'system', null, 'site_day.status_changed', 'site_day', sd.id,
                      jsonb_build_object('from', sd.status, 'to', v_to, 'reminder_stage', v_stage,
                                         'by', 'scheduler-tick'));
  end if;
  return true;
end $$;

revoke execute on function claim_site_day_reminder(uuid, text, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function claim_site_day_reminder(uuid, text, jsonb, jsonb, timestamptz)
  to service_role;

-- 2. The missing step: working days only, and the reminders it counts --------------------------------
drop function mark_site_day_missing(uuid, timestamptz, text, text, jsonb);

create function mark_site_day_missing(
  p_site_day_id uuid, p_missing_at timestamptz, p_title text, p_body text, p_data jsonb default null,
  p_reminders int default 0
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_from site_day_status;
  v_site uuid;
  v_date date;
  v_org uuid;
begin
  select sd.status, sd.site_id, sd.date into v_from, v_site, v_date
    from site_days sd
   where sd.id = p_site_day_id and sd.status in ('pending', 'reminded') and sd.reminder_stage < 4
     for update;
  if v_site is null then return false; end if;
  v_org := site_org(v_site);
  -- A site-day on a day the org does not work (a stray upload or STOP on a Saturday) is never
  -- escalated (docs/AUDIT_BACKLOG.md "Site-days created on non-working days…").
  if not exists (select 1 from org_settings os
                  where os.org_id = v_org and extract(isodow from v_date)::int = any (os.working_days)) then
    return false;
  end if;
  update site_days set status = 'missing', reminder_stage = 4 where id = p_site_day_id;
  perform log_audit(v_org, 'system', null, 'site_day.status_changed', 'site_day', p_site_day_id,
                    jsonb_build_object('from', v_from, 'to', 'missing', 'reminder_stage', 4,
                                       'missing_at', p_missing_at, 'by', 'scheduler-tick'));
  perform notify_org(v_org, 'missing_report', p_title, p_body, '/', null, p_data);
  perform enqueue_job('send_email',
                      jsonb_build_object('kind', 'report_missing', 'siteDayId', p_site_day_id,
                                         'siteId', v_site, 'orgId', v_org,
                                         'reminders', greatest(coalesce(p_reminders, 0), 0)),
                      null,
                      'email:report_missing:' || p_site_day_id);
  return true;
end $$;

revoke execute on function mark_site_day_missing(uuid, timestamptz, text, text, jsonb, int)
  from public, anon, authenticated;
grant execute on function mark_site_day_missing(uuid, timestamptz, text, text, jsonb, int)
  to service_role;
