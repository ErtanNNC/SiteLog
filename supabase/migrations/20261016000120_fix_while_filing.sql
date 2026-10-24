-- SiteLog · no fix of a draft while it is being filed (W2-10 review; spec F8, §7.2)
--
-- field_complete_upload() refuses a clip or photo while a file_report job of the report is queued
-- or running (`report_filing`): the reporter confirmed that draft, and it is what gets filed.
-- field_apply_correction() (Save change of a fix) and field_edit_draft() (a stepper) did not, so a
-- fix saved between Confirm & send and the filing changed the confirmed draft. Both now refuse
-- with `report_filing` too (field-api's 409 `report_filing`). Everything else as in
-- 20261016000100.
--
-- Live database (staging): two function bodies replaced with the same signatures (grants kept).

set local lock_timeout = '5s';

create or replace function field_apply_correction(p_correction_id uuid, p_report_id uuid, p_reporter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  c draft_corrections%rowtype;
  v_rev int;
  v_job bigint;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  select * into c from draft_corrections where id = p_correction_id and report_id = r.id for update;
  if c.id is null or c.reporter_id <> p_reporter_id then
    raise exception 'correction_not_found' using errcode = 'P0002';
  end if;
  -- Saved before (a lost response): the same answer.
  if c.status = 'applied' then
    return jsonb_build_object('status', 'applied', 'reportStatus', r.status, 'jobId', null,
                              'repeat', true);
  end if;
  if c.status <> 'ready' then
    raise exception 'correction_not_ready' using errcode = 'P0001';
  end if;
  if r.status in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  -- Confirmed and being filed (a file_report job queued or running): the draft the reporter
  -- confirmed is the one filed, so no fix changes it meanwhile (as field_complete_upload()).
  if exists (select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
               and status in ('queued', 'running')) then
    raise exception 'report_filing' using errcode = 'P0001';
  end if;
  select draft_rev into v_rev from report_versions
  where report_id = r.id and version = r.current_version for update;
  -- Only on the draft the preview was made from (a late photo or clip re-extracted it, or a
  -- stepper changed it: the preview is stale).
  if r.status <> 'awaiting_confirmation' or r.current_version <> c.base_version
     or v_rev is distinct from c.base_rev then
    update draft_corrections set status = 'stale', reason = 'draft_changed' where id = c.id;
    perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_stale', 'report', r.id,
      jsonb_build_object('correction_id', c.id, 'status', r.status, 'version', r.current_version,
                         'draft_rev', v_rev, 'base_version', c.base_version, 'base_rev', c.base_rev));
    return jsonb_build_object('status', 'stale', 'reportStatus', r.status,
                              'currentVersion', r.current_version, 'draftRev', v_rev);
  end if;
  update report_versions set data = c.data, summary = nullif(c.data ->> 'summary', '')
  where report_id = r.id and version = r.current_version;
  update draft_corrections set status = 'applied', applied_at = now() where id = c.id;
  -- §7.2: awaiting_confirmation → processing (fix requested); decide_next shows the new draft.
  update reports set status = 'processing' where id = r.id;
  v_job := enqueue_job('decide_next', jsonb_build_object('reportId', r.id), null,
                       'decide:' || r.id || ':correction:' || c.id);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.draft_corrected', 'report', r.id,
    jsonb_build_object('correction_id', c.id, 'via', c.via, 'upload_id', c.upload_id,
                       'channel', 'web', 'changes', c.changes, 'change_note', c.change_note,
                       'version', r.current_version, 'from_rev', v_rev, 'job_id', v_job));
  return jsonb_build_object('status', 'applied', 'reportStatus', 'processing', 'jobId', v_job);
end $$;

create or replace function field_edit_draft(
  p_report_id uuid, p_reporter_id uuid, p_version int, p_draft_rev int,
  p_base jsonb, p_data jsonb, p_changes jsonb, p_source jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_rev int;
  v_current jsonb;
  v_id uuid;
  v_job bigint;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or p_data ->> 'schemaVersion' is distinct from '2'
     or jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'invalid_edit' using errcode = 'P0001';
  end if;
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  if r.status in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  -- Confirmed and being filed (a file_report job queued or running): the draft the reporter
  -- confirmed is the one filed, so no fix changes it meanwhile (as field_complete_upload()).
  if exists (select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
               and status in ('queued', 'running')) then
    raise exception 'report_filing' using errcode = 'P0001';
  end if;
  select draft_rev, data into v_rev, v_current from report_versions
  where report_id = r.id and version = r.current_version for update;
  if r.status <> 'awaiting_confirmation' or r.current_version <> p_version
     or v_rev is distinct from p_draft_rev or v_current is distinct from p_base then
    return jsonb_build_object('status', 'stale', 'reportStatus', r.status,
                              'currentVersion', r.current_version, 'draftRev', v_rev);
  end if;
  update report_versions set data = p_data, summary = nullif(p_data ->> 'summary', '')
  where report_id = r.id and version = r.current_version;
  -- A preview made from the draft before this edit can no longer be saved.
  update draft_corrections set status = 'discarded', settled_at = coalesce(settled_at, now())
  where report_id = r.id and status in ('ready', 'unclear');
  insert into draft_corrections (org_id, report_id, reporter_id, via, status, base_version, base_rev,
                                 data, changes, source, settled_at, applied_at)
  values (r.org_id, r.id, p_reporter_id, 'stepper', 'applied', p_version, p_draft_rev, p_data,
          p_changes, p_source, now(), now())
  returning id into v_id;
  update reports set status = 'processing' where id = r.id;
  v_job := enqueue_job('decide_next', jsonb_build_object('reportId', r.id), null,
                       'decide:' || r.id || ':edit:v' || p_version || ':r' || p_draft_rev);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.draft_edited', 'report', r.id,
    jsonb_build_object('correction_id', v_id, 'via', 'stepper', 'channel', 'web',
                       'changes', p_changes, 'version', p_version, 'from_rev', p_draft_rev,
                       'job_id', v_job));
  return jsonb_build_object('status', 'processing', 'reportStatus', 'processing', 'jobId', v_job);
end $$;
