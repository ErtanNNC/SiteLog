-- SiteLog · Fix by voice and steppers on the draft (W2-10; spec F8, §9.3 Draft, §10.6, §7.2, §10.3,
-- §19 Q80, Appendix B `reports/:id/correction {text or uploadId}`, `…/correction/:cid/apply`)
--
-- F8 on the web: each line of the draft can be fixed by voice ("Apex had seven, not six") or, for a
-- crew's workers and hours, with a stepper. A spoken (or typed) fix is a correction: the worker
-- transcribes it, `apply_correction` (§10.6) proposes JSON-patch operations, and code applies them
-- to the draft into a **preview** (totals recomputed, never a model total; a changed value cites
-- the clip, `voice_note` with its seconds, or `reporter_edit` for typed words, §19 Q80). Nothing
-- changes until the reporter saves the preview, and then only on the draft the preview was made
-- from (version and draft revision; `draft_changed` otherwise). Saving moves the report
-- `awaiting_confirmation → processing` (§7.2 "fix requested") and decide_next shows the draft again
-- with its new revision (and starts its §7.2 clock). A stepper saves at once, the same way.
--
--   1. uploads.correction_report_id: a correction clip names the draft it fixes; like an answer
--      clip (W2-09) it is never report material. draft_corrections: one row per fix (spoken, typed
--      or a stepper) with its preview; RLS on, no client policy, no grant (field-api and the worker).
--   2. field_complete_upload(): the correction-clip branch (everything else as in 20261016000060).
--   3. field_request_correction() (service role): a fix of a draft awaiting confirmation; one at a
--      time per report (`correction_pending`), an older preview not saved is discarded; enqueues
--      apply_correction (`correction:<id>`), audited `report.correction_requested`.
--   4. field_settle_correction() (service role, the worker): `ready` with the preview built in code
--      on the current draft (`draft_changed` when the draft moved: the job retries on the new one),
--      `unclear` (a reason, or the model's clarification), `stale` (the report moved on). Audited.
--   5. field_apply_correction() (service role): **Save change**: the preview written to the draft at
--      its version and revision only (else answers `stale`: field-api's 409 `draft_changed`), the
--      report to processing, decide_next (`decide:<report>:correction:<id>`), audited
--      `report.draft_corrected`. A retry answers `applied` again.
--   6. field_edit_draft() (service role): a stepper's crew line, built in code by field-api, written
--      on the draft the reporter saw (version, revision and data; else `stale`), recorded as a fix
--      (via `stepper`), the report to processing, decide_next (`decide:<report>:edit:v<n>:r<rev>`),
--      audited `report.draft_edited`.
--   7. job_lock_key(): apply_correction under the report's key; job_priority(): with decide_next.
--
-- Live database (staging): one column with no default on uploads (no rewrite), a check and a
-- partial index; one new table (service only); one function body replaced (grants kept); four new
-- functions (service only). The deployed v1.0 code touches none of them.

set local lock_timeout = '5s';

-- 1. Columns and the table --------------------------------------------------------------------------------
alter table uploads
  add column correction_report_id uuid references reports (id) on delete cascade,
  add constraint uploads_correction_clip_check check (
    correction_report_id is null or (kind = 'audio' and batch_id is null and question_id is null)
  );

create index uploads_correction_idx on uploads (correction_report_id)
  where correction_report_id is not null;

comment on column uploads.correction_report_id is
  'W2-10 (F8 Fix by voice): the draft a correction clip fixes; never report material.';

create table draft_corrections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  report_id uuid not null references reports on delete cascade,
  reporter_id uuid not null references reporters on delete cascade,
  via text not null check (via in ('voice', 'text', 'stepper')),
  upload_id uuid references uploads on delete set null,
  text text,
  status text not null default 'listening'
    check (status in ('listening', 'ready', 'unclear', 'applied', 'stale', 'discarded')),
  base_version int,
  base_rev int,
  data jsonb,
  changes jsonb,
  operations jsonb,
  source jsonb,                                  -- what each changed value cites (§10.3): the clip or reporter_edit
  change_note text,
  clarification text,
  reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  applied_at timestamptz,
  check (via <> 'text' or text is not null),
  check (status not in ('ready', 'applied') or (data is not null and base_version is not null and base_rev is not null))
);

create index draft_corrections_report_idx on draft_corrections (report_id, created_at);
create unique index draft_corrections_upload_idx on draft_corrections (upload_id) where upload_id is not null;

alter table draft_corrections enable row level security;
revoke all on draft_corrections from anon, authenticated;

comment on table draft_corrections is
  'F8 (W2-10): fixes of a web draft (spoken, typed or a stepper) and their previews; service role only.';

-- 2. field_complete_upload with correction clips ----------------------------------------------------------
create or replace function field_complete_upload(p_upload_id uuid, p_reporter_id uuid, p_bytes int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uploads%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  r reports%rowtype;
  v_date date;
  v_created boolean := false;
  v_from report_status;
  v_job bigint;
  v_reextract boolean := false;
  v_done int;
  v_caption uuid;
  q questions%rowtype;
begin
  select * into u from uploads where id = p_upload_id for update;
  if u.id is null or u.reporter_id is distinct from p_reporter_id
     or not field_reporter_on_site(p_reporter_id, u.site_id) then
    raise exception 'upload_not_found' using errcode = 'P0002';
  end if;
  select * into s from sites where id = u.site_id;

  -- Completing twice (a retry after a lost answer) returns what the first call did.
  if u.report_id is not null then
    select * into r from reports where id = u.report_id;
    if u.batch_id is not null then
      select count(*) into v_done from uploads where batch_id = u.batch_id and report_id is not null;
      select id into v_caption from uploads
      where batch_id = u.batch_id and kind = 'audio' and report_id is not null limit 1;
    end if;
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', true, 'jobId', null)
      || case when u.question_id is null then '{}'::jsonb else jsonb_build_object('answerClip', true) end
      || case when u.correction_report_id is null then '{}'::jsonb
              else jsonb_build_object('correctionClip', true) end
      || case when u.batch_id is null then '{}'::jsonb else jsonb_build_object('batch',
           jsonb_build_object('id', u.batch_id, 'ready', v_done >= u.batch_size,
                              'captionUploadId', v_caption)) end;
  end if;

  -- field-api writes the path {org}/{site}/{date}/{upload id}.{ext} (uploadStoragePath()).
  if split_part(u.storage_path, '/', 1) <> s.org_id::text
     or split_part(u.storage_path, '/', 2) <> s.id::text
     or split_part(u.storage_path, '/', 3) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'upload_path_mismatch' using errcode = 'P0001';
  end if;
  v_date := split_part(u.storage_path, '/', 3)::date;

  -- W2-09 (F7 *Other…*): a spoken answer's clip joins its question's report, staged: no report
  -- source, no status change, no transcription job (reports/:id/answer hands it to parse_answer).
  if u.question_id is not null then
    select * into q from questions where id = u.question_id;
    select * into r from reports where id = q.report_id;
    if q.id is null or r.id is null or r.status = 'void' or r.site_id <> s.id
       or not exists (select 1 from site_days x where x.id = r.site_day_id and x.date = v_date) then
      raise exception 'upload_path_mismatch' using errcode = 'P0001';
    end if;
    update uploads set report_id = r.id, received_at = now(), bytes = coalesce(p_bytes, bytes)
    where id = u.id;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
      jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', null,
                         'question_id', q.id, 'answer_clip', true));
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', false, 'jobId', null,
                              'answerClip', true);
  end if;

  -- W2-10 (F8 *Fix by voice*): a correction clip joins the draft it fixes, staged the same way:
  -- no report source, no status change, no transcription job (reports/:id/correction hands it to
  -- apply_correction).
  if u.correction_report_id is not null then
    select * into r from reports where id = u.correction_report_id;
    if r.id is null or r.status = 'void' or r.site_id <> s.id
       or not exists (select 1 from site_days x where x.id = r.site_day_id and x.date = v_date) then
      raise exception 'upload_path_mismatch' using errcode = 'P0001';
    end if;
    update uploads set report_id = r.id, received_at = now(), bytes = coalesce(p_bytes, bytes)
    where id = u.id;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
      jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', null,
                         'correction_clip', true));
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', false, 'jobId', null,
                              'correctionClip', true);
  end if;

  sd := field_lock_site_day(s.id, v_date);
  select * into r from reports where site_day_id = sd.id and status <> 'void'
  order by created_at limit 1 for update;

  -- F9 (W2-04): a photo or caption added to the filed report, staged until its batch is whole.
  if u.batch_id is not null then
    if r.id is null or r.status not in ('filed', 'signed_off') then
      raise exception 'wrong_state' using errcode = 'P0001';
    end if;
    if now() > ((v_date + 1)::timestamp + time '23:59') at time zone s.timezone then
      raise exception 'photos_window_closed' using errcode = 'P0001';
    end if;
    -- One batch: one reporter, site, day and size.
    if exists (select 1 from uploads x where x.batch_id = u.batch_id
                 and (x.reporter_id is distinct from u.reporter_id or x.site_id <> u.site_id
                      or x.batch_size <> u.batch_size
                      or split_part(x.storage_path, '/', 3) <> split_part(u.storage_path, '/', 3)
                      or (x.report_id is not null and x.report_id <> r.id))) then
      raise exception 'invalid_batch' using errcode = 'P0001';
    end if;
    if u.kind = 'photo' and (select count(*) from uploads x
                             where x.report_id = r.id and x.batch_id is not null and x.kind = 'photo') >= 4 then
      raise exception 'photo_limit' using errcode = 'P0001';
    end if;
    if u.kind = 'audio' and exists (select 1 from uploads x where x.batch_id = u.batch_id
                                      and x.kind = 'audio' and x.report_id is not null) then
      raise exception 'invalid_batch' using errcode = 'P0001';
    end if;

    update uploads set report_id = r.id, received_at = now(), bytes = coalesce(p_bytes, bytes)
    where id = u.id;
    select count(*) into v_done from uploads where batch_id = u.batch_id and report_id is not null;
    if v_done >= u.batch_size then
      select id into v_caption from uploads
      where batch_id = u.batch_id and kind = 'audio' and report_id is not null limit 1;
      if v_caption is not null then
        -- The worker transcribes the caption, then attaches the batch with it (no re-extraction).
        v_job := enqueue_job('transcribe_upload',
          jsonb_build_object('uploadId', v_caption, 'purpose', 'caption'), null,
          'transcribe_upload:' || v_caption);
      end if;
    end if;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
      jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', v_job,
                         'batch_id', u.batch_id, 'after_filing', true));
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', false, 'jobId', v_job,
                              'batch', jsonb_build_object('id', u.batch_id,
                                'ready', v_done >= u.batch_size, 'captionUploadId', v_caption));
  end if;

  if r.id is not null and r.status in ('filed', 'signed_off') then
    raise exception 'report_filed' using errcode = 'P0001';
  end if;
  if r.id is null and sd.status in ('filed', 'weather_day', 'no_work') then
    raise exception 'day_closed' using errcode = 'P0001';
  end if;
  -- Confirmed and being filed (field_confirm_report(), a WhatsApp confirm or a timeout): nothing
  -- joins the draft the reporter confirmed. A filing job of the report, whatever its key (W1-10:
  -- `file:<report>:v<version>`; a job queued before this migration: `file:<report>`).
  if r.id is not null and exists (
       select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                            and status in ('queued', 'running')) then
    raise exception 'report_filing' using errcode = 'P0001';
  end if;

  if r.id is null then
    insert into reports (org_id, site_id, site_day_id, report_no, status, kind, reporter_id,
                         received_at, channel, language)
    values (s.org_id, s.id, sd.id, next_report_no(s.id),
            case when u.kind = 'audio' then 'processing' else 'collecting' end::report_status,
            'daily', p_reporter_id, now(), 'web', org_report_language(s.org_id))
    returning * into r;
    v_created := true;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.created', 'report', r.id,
      jsonb_build_object('report_no', r.report_no, 'date', v_date, 'channel', 'web',
                         'status', r.status, 'upload_id', u.id));
  elsif u.kind = 'audio' and r.status <> 'processing' then
    -- §7.2: more audio puts a report back to processing (collecting, a question, a draft).
    v_from := r.status;
    update reports set status = 'processing' where id = r.id returning * into r;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.status_changed', 'report', r.id,
      jsonb_build_object('from', v_from, 'to', 'processing', 'upload_id', u.id));
  elsif u.kind = 'photo' and r.status = 'awaiting_confirmation' then
    -- W1-12, §7.2 "more photos": a photo on the draft reopens it for a new extraction.
    v_from := r.status;
    v_reextract := true;
    update reports set status = 'processing' where id = r.id returning * into r;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.status_changed', 'report', r.id,
      jsonb_build_object('from', v_from, 'to', 'processing', 'upload_id', u.id));
  end if;

  update uploads set report_id = r.id, received_at = now(), bytes = coalesce(p_bytes, bytes)
  where id = u.id;
  insert into report_sources (report_id, kind, upload_id, taken_at)
  values (r.id, case when u.kind = 'audio' then 'voice_note' else 'photo' end, u.id, u.recorded_at);

  if u.kind = 'audio' then
    -- §7.1: a voice note starts the day's processing (a late one too: missing → processing).
    if sd.status in ('pending', 'reminded', 'missing') then
      update site_days set status = 'processing' where id = sd.id;
      perform log_audit(s.org_id, 'reporter', p_reporter_id, 'site_day.status_changed', 'site_day',
        sd.id, jsonb_build_object('from', sd.status, 'to', 'processing', 'report_id', r.id));
    end if;
    v_job := enqueue_job('transcribe_upload', jsonb_build_object('uploadId', u.id), null,
                         'transcribe_upload:' || u.id);
  elsif v_reextract then
    -- Every voice note is transcribed (the draft exists), so the extraction can run now.
    v_job := enqueue_job('extract_report',
      jsonb_build_object('reportId', r.id, 'reason', 'photo:' || u.id), null,
      'extract:' || r.id || ':photo:' || u.id);
  end if;

  perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
    jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', v_job));
  return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                            'created', v_created, 'alreadyComplete', false, 'jobId', v_job);
end $$;

-- 3. field_request_correction ------------------------------------------------------------------------------
create function field_request_correction(
  p_report_id uuid, p_reporter_id uuid, p_upload_id uuid default null, p_text text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  u uploads%rowtype;
  c draft_corrections%rowtype;
  v_job bigint;
begin
  if (p_upload_id is null) = (p_text is null) then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_complete_upload()'s and field_confirm_report()'s lock.
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
  if r.status <> 'awaiting_confirmation' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  -- One fix listened to at a time; one still listening after 5 minutes (a job that keeps failing)
  -- no longer holds the draft (CORRECTION_LISTEN_TIMEOUT_S).
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
  -- One preview at a time: an older one not saved goes.
  update draft_corrections set status = 'discarded', settled_at = coalesce(settled_at, now())
  where report_id = r.id and status in ('ready', 'unclear', 'listening');
  insert into draft_corrections (org_id, report_id, reporter_id, via, upload_id, text)
  values (r.org_id, r.id, p_reporter_id, case when p_upload_id is null then 'text' else 'voice' end,
          p_upload_id, nullif(btrim(p_text), ''))
  returning * into c;
  v_job := enqueue_job('apply_correction',
    jsonb_build_object('reportId', r.id, 'correctionId', c.id), null, 'correction:' || c.id);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_requested', 'report',
    r.id, jsonb_build_object('correction_id', c.id, 'via', c.via, 'upload_id', p_upload_id,
                             'channel', 'web', 'job_id', v_job));
  return jsonb_build_object('id', c.id, 'status', 'listening', 'jobId', v_job);
end $$;

revoke execute on function field_request_correction(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function field_request_correction(uuid, uuid, uuid, text) to service_role;

-- 4. field_settle_correction -------------------------------------------------------------------------------
create function field_settle_correction(p_correction_id uuid, p_outcome text, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c draft_corrections%rowtype;
  r reports%rowtype;
  v_rev int;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
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
  if p_outcome = 'stale' or r.status <> 'awaiting_confirmation' then
    update draft_corrections set status = 'stale', settled_at = now(),
      reason = coalesce(v_detail ->> 'reason', 'report_moved_on')
    where id = c.id;
    perform log_audit(r.org_id, 'agent', null, 'report.correction_stale', 'report', r.id,
      jsonb_build_object('correction_id', c.id, 'status', r.status));
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
    -- The preview is made from the current draft: one that moved meanwhile is parsed again.
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
                         'draft_rev', v_rev, 'dropped_totals', v_detail -> 'droppedTotals'));
    return jsonb_build_object('settled', true, 'status', 'ready');
  end if;

  update draft_corrections set status = 'unclear', settled_at = now(),
    reason = v_detail ->> 'reason', clarification = nullif(v_detail ->> 'clarification', '')
  where id = c.id;
  perform log_audit(r.org_id, 'agent', null, 'report.correction_unclear', 'report', r.id,
    jsonb_build_object('correction_id', c.id, 'reason', v_detail ->> 'reason',
                       'clarification', v_detail ? 'clarification' and v_detail ->> 'clarification' <> ''));
  return jsonb_build_object('settled', true, 'status', 'unclear');
end $$;

revoke execute on function field_settle_correction(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function field_settle_correction(uuid, text, jsonb) to service_role;

-- 5. field_apply_correction (Save change) -------------------------------------------------------------------
create function field_apply_correction(p_correction_id uuid, p_report_id uuid, p_reporter_id uuid)
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

revoke execute on function field_apply_correction(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function field_apply_correction(uuid, uuid, uuid) to service_role;

-- 6. field_edit_draft (the steppers) -----------------------------------------------------------------------
create function field_edit_draft(
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

revoke execute on function field_edit_draft(uuid, uuid, int, int, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function field_edit_draft(uuid, uuid, int, int, jsonb, jsonb, jsonb, jsonb) to service_role;

-- 7. Queue: apply_correction under the report's lock, with decide_next's priority -------------------------
create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  with report as (
    select case
      when p_type in ('extract_report', 'decide_next', 'file_report', 'render_pdf', 'parse_answer',
                      'apply_correction')
           and p_payload ->> 'reportId' ~ '^[0-9a-f-]{36}$'
        then (p_payload ->> 'reportId')::uuid
      when p_type = 'transcribe_upload' and p_payload ->> 'uploadId' ~ '^[0-9a-f-]{36}$'
        then (select u.report_id from uploads u where u.id = (p_payload ->> 'uploadId')::uuid)
      when p_type = 'post_call_reconcile' and p_payload ->> 'callId' ~ '^[0-9a-f-]{36}$'
        then (select c.report_id from calls c where c.id = (p_payload ->> 'callId')::uuid)
    end as id
  )
  select case
    when p_type in ('inbound_message', 'transcribe_audio', 'parse_reply')
         and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
      then (select 'convo:' || m.conversation_id from messages m
             where m.id = (p_payload ->> 'messageId')::uuid and m.conversation_id is not null)
    -- W1-08: one phone's inbound texts one at a time, oldest first.
    when p_type = 'sms_inbound' and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
      then (select 'sms:' || m.phone_e164 from messages m
             where m.id = (p_payload ->> 'messageId')::uuid and m.phone_e164 is not null)
    when (select id from report) is not null
      -- WhatsApp (until step 22): the reporter's conversation, so a photo sent meanwhile waits.
      then coalesce(
        (select 'convo:' || c.id from reports r
           join reporters rp on rp.id = r.reporter_id
           join conversations c on c.phone_e164 = rp.phone_e164
          where r.id = (select id from report)
          limit 1),
        'report:' || (select id from report))
  end;
$$;

create or replace function job_priority(p_type text) returns int
language sql immutable set search_path = public as $$
  select case
    -- Messages and calls to and from the reporter.
    when p_type in ('inbound_message', 'sms_inbound', 'send_message', 'send_template',
                    'send_welcome', 'send_sms', 'notify', 'place_call') then 0
    -- The next step of a report someone is waiting for, its PDF and its email.
    when p_type in ('parse_reply', 'decide_next', 'file_report', 'render_pdf', 'send_email',
                    'parse_answer', 'transcribe_test_clip', 'apply_correction') then 1
    -- Transcription and extraction.
    when p_type in ('transcribe_audio', 'extract_report', 'transcribe_upload',
                    'post_call_reconcile') then 2
    -- Background: weather, evidence packs, digests, retention and anything else.
    when p_type in ('fetch_weather', 'build_evidence_pack') then 3
    else 3
  end;
$$;
