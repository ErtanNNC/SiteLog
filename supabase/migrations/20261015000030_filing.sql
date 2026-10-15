-- SiteLog · filing, the `filed` text and the email (W1-15, GAP §7 step 19; spec §10.1 `file_report`,
-- §13, F8; GAP D16, D31)
--
--   1. console_emails.dedupe_key (unique): the send_email job's key, so a retried job files no
--      second row in the Demo phone's Email tab (Resend gets it as its Idempotency-Key). Existing
--      rows keep null (no key; unique allows any number of nulls).
--   2. create_report_version(): the office edit's render_pdf no longer carries `notifyReporter`
--      (D31: the v1.0 WhatsApp notice of an office edit ends; render_pdf ignores the flag, so jobs
--      queued before this keep parsing). Everything else as in 20261014000002.
--   3. field_confirm_report(): the filing it enqueues carries `via: 'web'` (§10.1
--      `file_report(report_id, via)`), which the worker stores as reports.confirmed_via.
--      Everything else as in 20261015000001.
--
-- Live database (staging): one nullable column with a unique constraint on a small table (the
-- console provider's), and two functions replaced with the same signatures (their grants are
-- kept). The deployed v1.0 functions and worker write none of these; the v1.0 worker ignores
-- `via` (its payload schema strips unknown keys).

set local lock_timeout = '5s';

-- 1. One console email per send_email job --------------------------------------------------------------
alter table console_emails add column dedupe_key text unique;

-- 2. create_report_version without the WhatsApp notice (D31) -------------------------------------------
create or replace function create_report_version(p_report_id uuid, p_data jsonb, p_change_note text, p_photos jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_next int;
  v_signer uuid;
  v_data jsonb;
  v_key text;         -- data.photos key of the new version: uploadId (v2) or messageId (v1)
  v_prev jsonb;       -- data.photos of the version this edit replaces (null: none recorded)
  v_listed jsonb;     -- the photo entries to keep, before checking them
  v_kept jsonb;
  v_added jsonb;
  v_photos jsonb;
  v_prev_ids uuid[];
  v_ids uuid[];
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.status not in ('filed','signed_off') then raise exception 'only filed reports can be edited by the office'; end if;
  if coalesce(trim(p_change_note), '') = '' then raise exception 'change note required'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'report data must be a JSON object'; end if;
  v_next := r.current_version + 1;
  v_key := report_photo_key(p_data);

  select case when jsonb_typeof(rv.data->'photos') = 'array' then rv.data->'photos' end into v_prev
  from report_versions rv where rv.report_id = p_report_id and rv.version = r.current_version;
  -- What the replaced version shows: its data.photos, or every photo of the report when it has none.
  v_prev_ids := case
    when v_prev is not null then array(
      select ps.media_id from jsonb_array_elements(v_prev) e
      join report_photo_sources(p_report_id) ps on ps.media_id::text = photo_entry_id(e))
    else array(select media_id from report_photo_sources(p_report_id))
  end;

  v_listed := case
    when jsonb_typeof(p_data->'photos') = 'array' then p_data->'photos'
    when v_prev is not null then v_prev
    else (select coalesce(jsonb_agg(jsonb_build_object('uploadId', ps.media_id, 'caption', ps.caption)
                                    order by ps.added_at, ps.media_id), '[]'::jsonb)
          from report_photo_sources(p_report_id) ps)
  end;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           v_key, k.media_id, 'caption', k.caption, 'takenAt', k.taken_at)) order by k.i), '[]'::jsonb)
  into v_kept
  from (
    select distinct on (ps.media_id) ps.media_id, e.i,
           nullif(btrim(case when jsonb_typeof(e.v->'caption') = 'string' then e.v->>'caption' end), '') as caption,
           coalesce(
             (select p->>'takenAt' from jsonb_array_elements(coalesce(v_prev, '[]'::jsonb)) p
              where photo_entry_id(p) = ps.media_id::text and jsonb_typeof(p->'takenAt') = 'string'
              limit 1),
             to_char(ps.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ) as taken_at
    from jsonb_array_elements(v_listed) with ordinality e(v, i)
    join report_photo_sources(p_report_id) ps on ps.media_id::text = photo_entry_id(e.v)
    order by ps.media_id, e.i
  ) k;
  if exists (select 1 from jsonb_array_elements(v_kept) x where length(x->>'caption') > 500) then
    raise exception 'photo caption is too long';
  end if;
  v_added := attach_office_photos(p_report_id, p_photos, v_key);
  v_photos := place_office_photos(v_kept, v_added, p_photos);
  v_ids := array(select photo_entry_id(x)::uuid from jsonb_array_elements(v_photos) x);

  v_data := link_typed_companies(r.org_id, p_report_id, p_data,
    array(select substr(x, length('unknown_company:') + 1)
          from unnest(r.review_reasons) x where x like 'unknown_company:%'));
  v_data := v_data || jsonb_build_object('photos', v_photos);
  insert into report_versions (report_id, version, data, summary, author, author_user_id, change_note)
  values (p_report_id, v_next, v_data, v_data->>'summary', 'office_user', auth.uid(), p_change_note);
  perform denormalize_report_version(p_report_id, v_next);
  v_signer := r.signed_off_by;
  update reports set current_version = v_next,
    status = 'filed', signed_off_by = null, signed_off_at = null
  where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.version_created', 'report', p_report_id,
    jsonb_build_object('version', v_next, 'change_note', p_change_note,
      'photos', cardinality(v_ids),
      'photos_added', (select count(*) from unnest(v_ids) x where not x = any(v_prev_ids)),
      'photos_removed', (select count(distinct x) from unnest(v_prev_ids) x where not x = any(v_ids))));
  if r.status = 'signed_off' then
    perform log_audit(r.org_id, 'user', auth.uid(), 'report.signoff_reverted', 'report', p_report_id, jsonb_build_object('version', v_next));
    perform notify_org(r.org_id, 'report_edited', r.report_no || ' was edited after sign-off', p_change_note, '/reports/' || p_report_id, v_signer);
  end if;
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', true, 'changeNote', p_change_note),
                      null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next);
end $$;

-- 3. reports/:id/confirm: the filing carries via 'web' ----------------------------------------------------
create or replace function field_confirm_report(p_report_id uuid, p_reporter_id uuid, p_version int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
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
  -- A filing already queued or running (a second tap, a WhatsApp confirm, a timeout; any key).
  select id into v_job from jobs
  where type = 'file_report' and payload ->> 'reportId' = r.id::text
    and status in ('queued', 'running')
  order by id limit 1;
  if v_job is not null then
    return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
  end if;
  -- D16: the first confirm of this draft version.
  v_job := enqueue_job('file_report',
    jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', p_version, 'via', 'web'), null,
    'file:' || r.id || ':v' || p_version);
  select status into v_status from jobs where id = v_job;
  if v_status = 'dead' then
    -- The version's job died (six failed attempts): this confirm runs it again.
    v_requeued := requeue_dead_job(v_job);
  elsif v_status in ('done', 'failed') then
    -- That job finished without filing (the report is still awaiting confirmation at this
    -- version: a stale confirm, a job ops discarded): this confirm is a new occurrence.
    select count(*) into v_n from audit_log
    where entity = 'report' and entity_id = r.id and action = 'report.confirm_requested';
    loop
      v_n := v_n + 1;
      v_job := enqueue_job('file_report',
        jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', p_version, 'via', 'web'), null,
        'file:' || r.id || ':v' || p_version || ':c' || v_n);
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
    jsonb_build_object('job_id', v_job, 'version', p_version, 'channel', 'web')
      || case when v_requeued then jsonb_build_object('requeued', true) else '{}'::jsonb end);
  return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
end $$;
