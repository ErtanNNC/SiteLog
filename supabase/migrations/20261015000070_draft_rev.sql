-- SiteLog · the draft revision a confirm names (W1-13 / W1-15 review; spec §6.2 report_versions,
-- §8 F8, Appendix B `reports/:id/confirm`)
--
-- Drafts are overwritten in place until filing (the worker's storeWebDraft / insertVersion, the
-- WhatsApp drafts, field_answer_question()), so `reports.current_version` stays 1 while the draft
-- changes: a late photo re-runs extract_report while the Draft screen (which stops polling) is
-- open, and a confirm of `{version: 1}` filed a draft the reporter never saw.
--
--   1. report_versions.draft_rev (int not null default 1): bumped by a trigger on every write that
--      changes `data` (whoever writes it), never set by a caller. A new version starts at 1.
--   2. field_confirm_report(p_report_id, p_reporter_id, p_version, p_draft_rev): the confirm names
--      the version AND the revision the reporter saw (`ReportView.draftRev`); either differing (or
--      a null revision) is `draft_changed`. The file_report job carries `draftRev`, and the worker
--      files only while the version is still at that revision (apps/worker/src/pipeline/file.ts),
--      else `report.confirm_stale`. The key names the revision (`file:<report>:v<n>:r<rev>`), and a
--      queued web confirm of another revision is not reused: it goes stale, this one files.
--      The 3-argument function is dropped: field-api is deployed with this migration.
--
-- Live database (staging): one column with a constant default on report_versions (no rewrite),
-- one trigger, one function replaced by a 4-argument one (service role only, as before). The
-- deployed v1.0 functions and worker do not call field_confirm_report and never set draft_rev.

set local lock_timeout = '5s';

-- 1. The draft revision ----------------------------------------------------------------------------------
alter table report_versions add column draft_rev int not null default 1;

create function report_versions_draft_rev() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.draft_rev := 1;
  else
    new.draft_rev := old.draft_rev + case when new.data is distinct from old.data then 1 else 0 end;
  end if;
  return new;
end $$;

create trigger report_versions_draft_rev
  before insert or update on report_versions
  for each row execute function report_versions_draft_rev();

-- 2. reports/:id/confirm names the revision --------------------------------------------------------------
drop function field_confirm_report(uuid, uuid, int);

create function field_confirm_report(p_report_id uuid, p_reporter_id uuid, p_version int, p_draft_rev int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_rev int;
  v_job bigint;
  v_status job_status;
  v_n int;
  v_requeued boolean := false;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_complete_upload()'s lock: no voice note attaches between this check and the enqueue,
  -- and a second tap waits for the first.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  if r.status in ('filed', 'signed_off') then
    return jsonb_build_object('status', 'filed', 'jobId', null, 'version', r.current_version);
  end if;
  if r.status <> 'awaiting_confirmation' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  if p_version is null or r.current_version <> p_version then
    raise exception 'draft_changed' using errcode = 'P0001';
  end if;
  -- The draft is overwritten in place: the revision tells the draft the reporter saw from a newer
  -- one at the same version (a late photo's re-extraction).
  select draft_rev into v_rev from report_versions
  where report_id = r.id and version = r.current_version for share;
  if p_draft_rev is null or v_rev is distinct from p_draft_rev then
    raise exception 'draft_changed' using errcode = 'P0001';
  end if;
  -- A filing already queued or running (a second tap, a WhatsApp confirm, a timeout; any key),
  -- except a web confirm of another draft: that one goes stale in the worker, this one files.
  select id into v_job from jobs
  where type = 'file_report' and payload ->> 'reportId' = r.id::text
    and status in ('queued', 'running')
    and not (payload ? 'draftRev'
             and (payload ->> 'version' is distinct from p_version::text
                  or payload ->> 'draftRev' is distinct from p_draft_rev::text))
  order by id limit 1;
  if v_job is not null then
    return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
  end if;
  -- D16: the first confirm of this draft (version and revision).
  v_job := enqueue_job('file_report',
    jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', p_version,
                       'draftRev', p_draft_rev, 'via', 'web'), null,
    'file:' || r.id || ':v' || p_version || ':r' || p_draft_rev);
  select status into v_status from jobs where id = v_job;
  if v_status = 'dead' then
    -- The draft's job died (six failed attempts): this confirm runs it again.
    v_requeued := requeue_dead_job(v_job);
  elsif v_status in ('done', 'failed') then
    -- That job finished without filing (the report is still awaiting confirmation at this
    -- draft: a stale confirm, a job ops discarded): this confirm is a new occurrence.
    select count(*) into v_n from audit_log
    where entity = 'report' and entity_id = r.id and action = 'report.confirm_requested';
    loop
      v_n := v_n + 1;
      v_job := enqueue_job('file_report',
        jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', p_version,
                           'draftRev', p_draft_rev, 'via', 'web'), null,
        'file:' || r.id || ':v' || p_version || ':r' || p_draft_rev || ':c' || v_n);
      select status into v_status from jobs where id = v_job;
      exit when v_status in ('queued', 'running');
      if v_status = 'dead' then
        v_requeued := requeue_dead_job(v_job);
        exit;
      end if;
      -- A finished job holds this n (retention purged audit rows, or a job outlived its audit):
      -- the next n.
      if v_n > 10000 then
        raise exception 'field_confirm_report: no free filing key for report %', r.id;
      end if;
    end loop;
  end if;
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.confirm_requested', 'report', r.id,
    jsonb_build_object('job_id', v_job, 'version', p_version, 'draft_rev', p_draft_rev,
                       'channel', 'web')
      || case when v_requeued then jsonb_build_object('requeued', true) else '{}'::jsonb end);
  return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
end $$;

revoke execute on function field_confirm_report(uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function field_confirm_report(uuid, uuid, int, int) to service_role;
