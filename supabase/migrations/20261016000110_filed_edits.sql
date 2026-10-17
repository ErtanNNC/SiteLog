-- SiteLog · Edit after filing on the web (W2-11; spec F10, §7.2 `filed → filed`, `signed_off → filed`,
-- §9.2 `edit_applied`, §12 `_v{n}`, §13 "Report updated", §19 Q80, Q81)
--
-- F10 on the web: Past reports → a report of the last 14 days (site time) → *Change something* →
-- said or typed (W2-10's flow: a correction clip through the upload queue, `apply_correction`, the
-- preview made in code) → **Save change** → version n+1. A filed or signed-off version is never
-- changed: the change is a new version (author 'reporter', via 'web', the change note code wrote
-- from the preview's lines, the reporter who made it: §19 Q81 "each version naming its author").
--
--   1. draft_corrections.after_filing: a fix of a filed report (its preview made from the current
--      version; saved as a new version, never written on the draft). version_created: the version
--      Save change made (a retried save answers it again).
--      report_versions.author_reporter_id: the reporter who made a reporter version on the web
--      (a backup who covered the day, §19 Q81), for the panel's version history.
--   2. field_request_filed_correction() (service role): a fix of a filed (or signed-off) report of a
--      site the reporter covers, dated within the last 14 days in the site's time zone (else
--      `report_locked`: "That report is locked. Ask the office to change it."); one at a time per
--      report (`correction_pending`); an older preview not saved is discarded; apply_correction
--      (`correction:<id>`), audited `report.correction_requested` (`after_filing`).
--   3. field_settle_correction(): a fix after filing is previewed while the report is filed or
--      signed off (a draft's while it awaits confirmation, as before); the version check is the same.
--   4. field_save_filed_correction() (service role): **Save change**: version n+1 from the preview
--      at the version it was made from (else `stale`: field-api's 409 `draft_changed`), inside the
--      14 days (`report_locked`), the photos of that version kept as they were, re-denormalised; a
--      signed-off report back to `filed` with its signer told (`report_edited` panel notice, as the
--      office path); audited `report.version_created` (actor the reporter, via web) and
--      `report.correction_saved`; then render_pdf for `_v{n+1}` (`render_pdf:<report>:<n+1>`), whose
--      worker queues the "Updated" email to the recipients and the signer (`signerId`) and the
--      reporter's `edit_applied` text (`editApplied`: the weekday and the change in the reporter's
--      language, field-api's) once each. A retry answers the version it made.
--
-- Live database (staging): two nullable columns and one boolean with a constant default (no
-- rewrite since Postgres 11) on small tables, one check, one function body replaced (grants kept),
-- two new functions (service role only). The deployed v1.0 code writes none of these.

set local lock_timeout = '5s';

-- 1. Columns ------------------------------------------------------------------------------------------------
alter table draft_corrections
  add column after_filing boolean not null default false,
  add column version_created int,
  add constraint draft_corrections_version_created_check
    check (version_created is null or (after_filing and status = 'applied'));

comment on column draft_corrections.after_filing is
  'F10 (W2-11): a change of a filed report; Save change makes version n+1 instead of writing the draft.';
comment on column draft_corrections.version_created is
  'F10: the version Save change made from this fix.';

alter table report_versions
  add column author_reporter_id uuid references reporters on delete set null;

comment on column report_versions.author_reporter_id is
  'F10 (W2-11, §19 Q81): the reporter who made a reporter version on the web (a backup may change a day they covered).';

-- 2. field_request_filed_correction ------------------------------------------------------------------------
-- The 14 days (§19 Q81, HISTORY_DAYS): the report's date is today or one of the 13 days before it,
-- in the site's time zone (Past reports lists the same days).
create function field_report_changeable(p_date date, p_timezone text) returns boolean
language sql stable set search_path = public as $$
  select p_date >= (now() at time zone p_timezone)::date - 13;
$$;

revoke execute on function field_report_changeable(date, text) from public, anon, authenticated;
grant execute on function field_report_changeable(date, text) to service_role;

create function field_request_filed_correction(
  p_report_id uuid, p_reporter_id uuid, p_upload_id uuid default null, p_text text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  s sites%rowtype;
  u uploads%rowtype;
  c draft_corrections%rowtype;
  v_date date;
  v_job bigint;
begin
  if (p_upload_id is null) = (p_text is null) then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_complete_upload()'s and field_attach_photos()' lock.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  -- A retry of the same clip (a lost response) gets what the first call did.
  if p_upload_id is not null then
    select * into c from draft_corrections where upload_id = p_upload_id;
    if c.id is not null then
      if c.report_id <> r.id then
        raise exception 'upload_not_found' using errcode = 'P0002';
      end if;
      return jsonb_build_object('id', c.id, 'status', c.status, 'jobId', null, 'repeat', true);
    end if;
  end if;
  if r.status not in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select * into s from sites where id = r.site_id;
  select date into v_date from site_days where id = r.site_day_id;
  if not field_report_changeable(v_date, s.timezone) then
    raise exception 'report_locked' using errcode = 'P0001';
  end if;
  if exists (select 1 from draft_corrections where report_id = r.id and status = 'listening'
               and created_at > now() - interval '5 minutes') then
    raise exception 'correction_pending' using errcode = 'P0001';
  end if;
  if p_upload_id is not null then
    select * into u from uploads where id = p_upload_id;
    if u.id is null or u.correction_report_id is distinct from r.id
       or u.reporter_id is distinct from p_reporter_id or u.report_id is distinct from r.id
       or u.kind <> 'audio' or u.purged_at is not null then
      raise exception 'upload_not_found' using errcode = 'P0002';
    end if;
  end if;
  update draft_corrections set status = 'discarded', settled_at = coalesce(settled_at, now())
  where report_id = r.id and status in ('ready', 'unclear', 'listening');
  insert into draft_corrections (org_id, report_id, reporter_id, via, upload_id, text, after_filing)
  values (r.org_id, r.id, p_reporter_id, case when p_upload_id is null then 'text' else 'voice' end,
          p_upload_id, nullif(btrim(p_text), ''), true)
  returning * into c;
  v_job := enqueue_job('apply_correction',
    jsonb_build_object('reportId', r.id, 'correctionId', c.id), null, 'correction:' || c.id);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_requested', 'report',
    r.id, jsonb_build_object('correction_id', c.id, 'via', c.via, 'upload_id', p_upload_id,
                             'channel', 'web', 'job_id', v_job, 'after_filing', true,
                             'version', r.current_version));
  return jsonb_build_object('id', c.id, 'status', 'listening', 'jobId', v_job);
end $$;

revoke execute on function field_request_filed_correction(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function field_request_filed_correction(uuid, uuid, uuid, text) to service_role;

-- 3. field_settle_correction: a fix after filing is previewed on the filed report -------------------------
create or replace function field_settle_correction(p_correction_id uuid, p_outcome text, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c draft_corrections%rowtype;
  r reports%rowtype;
  v_rev int;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_moved boolean;
begin
  if p_outcome not in ('ready', 'unclear', 'stale') then
    raise exception 'invalid outcome %', p_outcome;
  end if;
  select * into c from draft_corrections where id = p_correction_id;
  if c.id is null then
    raise exception 'correction_not_found' using errcode = 'P0002';
  end if;
  select * into r from reports where id = c.report_id;
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = c.report_id for update;
  select * into c from draft_corrections where id = p_correction_id for update;
  -- Settled before (a retried job): what it was.
  if c.status <> 'listening' then
    return jsonb_build_object('settled', false, 'status', c.status);
  end if;
  -- W2-11: a fix after filing needs the report filed (or signed off); a draft's, awaiting confirmation.
  v_moved := case when c.after_filing then r.status not in ('filed', 'signed_off')
                  else r.status <> 'awaiting_confirmation' end;
  if p_outcome = 'stale' or v_moved then
    update draft_corrections set status = 'stale', settled_at = now(),
      reason = coalesce(v_detail ->> 'reason', 'report_moved_on')
    where id = c.id;
    perform log_audit(r.org_id, 'agent', null, 'report.correction_stale', 'report', r.id,
      jsonb_build_object('correction_id', c.id, 'status', r.status, 'after_filing', c.after_filing));
    return jsonb_build_object('settled', true, 'status', 'stale');
  end if;

  if p_outcome = 'ready' then
    if jsonb_typeof(v_detail -> 'data') is distinct from 'object'
       or v_detail -> 'data' ->> 'schemaVersion' is distinct from '2'
       or jsonb_typeof(v_detail -> 'changes') is distinct from 'array'
       or jsonb_typeof(v_detail -> 'baseVersion') is distinct from 'number'
       or jsonb_typeof(v_detail -> 'baseRev') is distinct from 'number' then
      raise exception 'invalid_correction' using errcode = 'P0001';
    end if;
    -- The preview is made from the current version: one that moved meanwhile is parsed again.
    select draft_rev into v_rev from report_versions
    where report_id = r.id and version = r.current_version;
    if r.current_version <> (v_detail ->> 'baseVersion')::int
       or v_rev is distinct from (v_detail ->> 'baseRev')::int then
      raise exception 'draft_changed' using errcode = 'P0001';
    end if;
    update draft_corrections set status = 'ready', settled_at = now(),
      data = v_detail -> 'data', changes = v_detail -> 'changes',
      operations = v_detail -> 'operations', source = v_detail -> 'source',
      change_note = nullif(v_detail ->> 'changeNote', ''),
      base_version = r.current_version, base_rev = v_rev
    where id = c.id;
    perform log_audit(r.org_id, 'agent', null, 'report.correction_previewed', 'report', r.id,
      jsonb_build_object('correction_id', c.id, 'changes', v_detail -> 'changes',
                         'change_note', v_detail ->> 'changeNote', 'version', r.current_version,
                         'draft_rev', v_rev, 'dropped_totals', v_detail -> 'droppedTotals',
                         'after_filing', c.after_filing));
    return jsonb_build_object('settled', true, 'status', 'ready');
  end if;

  update draft_corrections set status = 'unclear', settled_at = now(),
    reason = v_detail ->> 'reason', clarification = nullif(v_detail ->> 'clarification', '')
  where id = c.id;
  perform log_audit(r.org_id, 'agent', null, 'report.correction_unclear', 'report', r.id,
    jsonb_build_object('correction_id', c.id, 'reason', v_detail ->> 'reason',
                       'clarification', v_detail ? 'clarification' and v_detail ->> 'clarification' <> '',
                       'after_filing', c.after_filing));
  return jsonb_build_object('settled', true, 'status', 'unclear');
end $$;

-- 4. field_save_filed_correction (Save change → version n+1) ------------------------------------------------
create function field_save_filed_correction(
  p_correction_id uuid, p_report_id uuid, p_reporter_id uuid, p_change_note text,
  p_message jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  s sites%rowtype;
  c draft_corrections%rowtype;
  v_date date;
  v_rev int;
  v_prev jsonb;
  v_data jsonb;
  v_next int;
  v_signer uuid;
  v_note text := left(btrim(coalesce(p_change_note, '')), 500);
  v_payload jsonb;
  v_job bigint;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  select * into c from draft_corrections where id = p_correction_id and report_id = r.id for update;
  if c.id is null or c.reporter_id <> p_reporter_id or not c.after_filing then
    raise exception 'correction_not_found' using errcode = 'P0002';
  end if;
  -- Saved before (a lost response): the version it made.
  if c.status = 'applied' then
    return jsonb_build_object('status', 'applied', 'reportStatus', r.status,
                              'version', c.version_created, 'repeat', true);
  end if;
  if c.status <> 'ready' then
    raise exception 'correction_not_ready' using errcode = 'P0001';
  end if;
  if r.status not in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select * into s from sites where id = r.site_id;
  select date into v_date from site_days where id = r.site_day_id;
  if not field_report_changeable(v_date, s.timezone) then
    raise exception 'report_locked' using errcode = 'P0001';
  end if;
  if v_note = '' then
    raise exception 'change note required';
  end if;
  select draft_rev, data into v_rev, v_prev from report_versions
  where report_id = r.id and version = r.current_version;
  -- Only on the version the preview was made from (the office edited it, photos were added: stale).
  if r.current_version <> c.base_version or v_rev is distinct from c.base_rev then
    update draft_corrections set status = 'stale', reason = 'version_changed' where id = c.id;
    perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_stale', 'report', r.id,
      jsonb_build_object('correction_id', c.id, 'status', r.status, 'version', r.current_version,
                         'base_version', c.base_version, 'after_filing', true));
    return jsonb_build_object('status', 'stale', 'reportStatus', r.status,
                              'currentVersion', r.current_version, 'draftRev', v_rev);
  end if;

  -- A fix never changes photos (CORRECTION_ROOTS): the version keeps its photos exactly as they were.
  v_data := c.data - 'photos';
  if v_prev ? 'photos' then
    v_data := v_data || jsonb_build_object('photos', v_prev -> 'photos');
  end if;
  v_next := r.current_version + 1;
  insert into report_versions (report_id, version, data, summary, author, author_reporter_id, via, change_note)
  values (r.id, v_next, v_data, nullif(v_data ->> 'summary', ''), 'reporter', p_reporter_id, 'web', v_note);
  perform denormalize_report_version(r.id, v_next);
  v_signer := r.signed_off_by;
  update reports set current_version = v_next,
    status = 'filed', signed_off_by = null, signed_off_at = null
  where id = r.id;
  update draft_corrections set status = 'applied', applied_at = now(), version_created = v_next
  where id = c.id;

  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.version_created', 'report', r.id,
    jsonb_build_object('version', v_next, 'change_note', v_note, 'via', 'web',
                       'correction_id', c.id, 'changes', c.changes));
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_saved', 'report', r.id,
    jsonb_build_object('correction_id', c.id, 'via', c.via, 'upload_id', c.upload_id,
                       'channel', 'web', 'from_version', r.current_version, 'version', v_next));
  if r.status = 'signed_off' then
    -- F10: a change after sign-off reopens it (re-sign required), and the signer is told.
    perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.signoff_reverted', 'report', r.id,
      jsonb_build_object('version', v_next, 'signed_off_by', v_signer));
    perform notify_org(r.org_id, 'report_edited', r.report_no || ' was edited after sign-off', v_note,
                       '/reports/' || r.id, v_signer,
                       jsonb_build_object('key', 'report_edited', 'params', jsonb_build_object('reportNo', r.report_no)));
  end if;

  v_payload := jsonb_build_object('reportId', r.id, 'version', v_next, 'emailRecipients', true,
                                  'changeNote', v_note);
  if v_signer is not null then
    v_payload := v_payload || jsonb_build_object('signerId', v_signer);
  end if;
  if jsonb_typeof(p_message) = 'object' and jsonb_typeof(p_message -> 'weekday') = 'string'
     and jsonb_typeof(p_message -> 'change') = 'string' then
    v_payload := v_payload || jsonb_build_object('editApplied', jsonb_build_object(
      'reporterId', p_reporter_id,
      'weekday', left(p_message ->> 'weekday', 40),
      'change', left(p_message ->> 'change', 300)));
  end if;
  v_job := enqueue_job('render_pdf', v_payload, null, 'render_pdf:' || r.id || ':' || v_next);
  return jsonb_build_object('status', 'applied', 'reportStatus', 'filed', 'version', v_next,
                            'jobId', v_job);
end $$;

revoke execute on function field_save_filed_correction(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function field_save_filed_correction(uuid, uuid, uuid, text, jsonb) to service_role;
