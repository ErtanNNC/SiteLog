-- SiteLog · the missing-report alert commits with the status change (review of spec §19 Q55)
--
-- scheduler-tick marked a day `missing` (the claim), then wrote the audit row, the office's
-- `missing_report` notice and the `report_missing` email job as separate calls. A failure after the
-- claim left a day `missing` with no alert, and no later tick would retry (the day is no longer
-- pending). mark_site_day_missing() does all four in one transaction: the guarded update is still
-- the claim, so only the call that made the day missing alerts (never twice), and if any step
-- fails nothing commits and the next tick tries the whole step again. The notice's title and body
-- come from the caller (scheduler-tick's `missingNotification`, the copy stays in code); the
-- email job keeps its dedupe key `email:report_missing:<site_day>`. Service role only.
--
-- Live database: one new function; no table changes. The deployed scheduler-tick keeps working
-- (it does not call it) until the new one is deployed.

set local lock_timeout = '5s';

create or replace function mark_site_day_missing(
  p_site_day_id uuid, p_missing_at timestamptz, p_title text, p_body text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_from site_day_status;
  v_site uuid;
  v_org uuid;
begin
  select sd.status, sd.site_id into v_from, v_site
    from site_days sd
   where sd.id = p_site_day_id and sd.status in ('pending', 'reminded') and sd.reminder_stage < 4
     for update;
  if v_site is null then return false; end if;
  update site_days set status = 'missing', reminder_stage = 4 where id = p_site_day_id;
  v_org := site_org(v_site);
  perform log_audit(v_org, 'system', null, 'site_day.status_changed', 'site_day', p_site_day_id,
                    jsonb_build_object('from', v_from, 'to', 'missing', 'reminder_stage', 4,
                                       'missing_at', p_missing_at, 'by', 'scheduler-tick'));
  perform notify_org(v_org, 'missing_report', p_title, p_body, '/', null);
  perform enqueue_job('send_email',
                      jsonb_build_object('kind', 'report_missing', 'siteDayId', p_site_day_id,
                                         'siteId', v_site, 'orgId', v_org),
                      null,
                      'email:report_missing:' || p_site_day_id);
  return true;
end $$;

revoke execute on function mark_site_day_missing(uuid, timestamptz, text, text)
  from public, anon, authenticated;
