-- SiteLog · spoken answers to a question (W2-09; spec F7, §9.3 Question, §10.5 step 5, §10.7, §6.3,
-- Appendix B `reports/:id/answer {questionId, uploadId}`)
--
-- F7 *Other…*: besides the answers to tap and the number to type, the reporter may say the answer.
-- The field app records a short clip (30 s at most) for the open question, uploads it like any
-- clip, then `reports/:id/answer {uploadId}`; the worker transcribes it and `parse_answer`
-- (§10.7) reads `{field, value, confidence}`. At 0.7 or more code applies the value (the answer,
-- and the clip as a `voice_note` source of it) and decide_next goes on; below, the question is
-- asked once more with its choices ("I didn't catch that"); unclear twice, it is recorded
-- unanswered and flagged `unanswered:<field>` (F7 "then move on and flag").
--
--   1. uploads.question_id: the clip names the question it answers. Such an upload is never
--      report material: field_complete_upload() attaches it to the question's report (for scope
--      and retention) without a report source, a status change or a transcription job, and the
--      worker's voice-note lists leave it out. questions.voice_answers: the spoken tries, oldest
--      first, `{uploadId, at, status: listening | applied | unclear | stale, confidence?, reason?}`.
--   2. field_complete_upload(): the answer-clip branch (everything else as in 20261016000030).
--   3. field_answer_question_voice() (service role): the open web question of a report awaiting an
--      answer, a completed clip of that question; appends the `listening` try and enqueues
--      `parse_answer` (`answer:<question>:<upload>`), audited `report.answer_spoken`. The report
--      stays `awaiting_answer`. A retry with the same clip answers what the first call did; a
--      second clip while one is being listened to is `answer_pending`.
--   4. field_settle_voice_answer() (service role, the worker): `applied` writes the draft the
--      worker built in code (refused as `draft_changed` when the draft moved: the job retries on
--      the new one), answers the question and enqueues decide_next (`decide:<report>:answer:<q>`,
--      the key a tapped answer uses: a question is answered once); `unclear` marks the try, and
--      at the second unclear try records the question unanswered, flags the report and enqueues
--      the same decide_next. A try already settled, or a question answered meanwhile (a tap, the
--      60-minute timeout), changes nothing.
--   5. job_lock_key(): parse_answer runs under the report's key (one job of a report at a time);
--      job_priority(): with decide_next (someone is waiting for it).
--
-- Live database (staging): two columns with constant defaults (no rewrite), a check and a partial
-- index on uploads, functions replaced with the same signatures (grants kept) and two new ones
-- (service role only). The deployed v1.0 code writes none of these.

set local lock_timeout = '5s';

-- 1. Columns ----------------------------------------------------------------------------------------------
alter table uploads
  -- A question goes only with its report (and the demo prune deletes questions first): its
  -- answer clips, never report material, go with it (their transcripts cascade from uploads).
  add column question_id uuid references questions (id) on delete cascade,
  add constraint uploads_answer_clip_check check (
    question_id is null or (kind = 'audio' and batch_id is null)
  );

create index uploads_question_idx on uploads (question_id) where question_id is not null;

comment on column uploads.question_id is
  'W2-09 (F7 Other…): the web question a spoken answer clip answers; never report material.';

alter table questions add column voice_answers jsonb not null default '[]'::jsonb;

comment on column questions.voice_answers is
  'W2-09: spoken answers to a web question, oldest first: {uploadId, at, status, confidence?, reason?}.';

-- 2. field_complete_upload with answer clips --------------------------------------------------------------
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

-- 3. field_answer_question_voice ------------------------------------------------------------------------
create function field_answer_question_voice(
  p_report_id uuid, p_question_id uuid, p_reporter_id uuid, p_upload_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  q questions%rowtype;
  u uploads%rowtype;
  v_try jsonb;
  v_last jsonb;
  v_job bigint;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_answer_question()'s lock: a tap, a voice note or a confirm waits for this, or this for them.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  select * into q from questions where id = p_question_id and report_id = r.id for update;
  if q.id is null then
    raise exception 'question_not_found' using errcode = 'P0002';
  end if;
  -- A retry of the same clip (a lost response) gets what the first call did.
  select e into v_try from jsonb_array_elements(q.voice_answers) e
  where e ->> 'uploadId' = p_upload_id::text limit 1;
  if v_try is not null then
    return jsonb_build_object('status', 'listening', 'reportStatus', r.status, 'jobId', null,
                              'repeat', true);
  end if;
  if q.answered_at is not null or q.channel is distinct from 'web' then
    raise exception 'question_closed' using errcode = 'P0001';
  end if;
  if r.status <> 'awaiting_answer' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  v_last := q.voice_answers -> (jsonb_array_length(q.voice_answers) - 1);
  if v_last ->> 'status' = 'listening' then
    raise exception 'answer_pending' using errcode = 'P0001';
  end if;
  select * into u from uploads where id = p_upload_id;
  if u.id is null or u.question_id is distinct from q.id or u.reporter_id is distinct from p_reporter_id
     or u.report_id is distinct from r.id or u.kind <> 'audio' or u.purged_at is not null then
    raise exception 'upload_not_found' using errcode = 'P0002';
  end if;

  update questions set voice_answers = voice_answers || jsonb_build_array(jsonb_build_object(
      'uploadId', u.id, 'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'status', 'listening'))
  where id = q.id;
  v_job := enqueue_job('parse_answer',
    jsonb_build_object('reportId', r.id, 'questionId', q.id, 'uploadId', u.id), null,
    'answer:' || q.id || ':' || u.id);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.answer_spoken', 'report', r.id,
    jsonb_build_object('question_id', q.id, 'field', q.field, 'channel', 'web', 'upload_id', u.id,
                       'job_id', v_job));
  return jsonb_build_object('status', 'listening', 'reportStatus', r.status, 'jobId', v_job);
end $$;

revoke execute on function field_answer_question_voice(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function field_answer_question_voice(uuid, uuid, uuid, uuid) to service_role;

-- 4. field_settle_voice_answer ---------------------------------------------------------------------------
create function field_settle_voice_answer(
  p_question_id uuid, p_upload_id uuid, p_outcome text, p_detail jsonb default '{}'::jsonb,
  p_base jsonb default null, p_data jsonb default null, p_answer jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q questions%rowtype;
  r reports%rowtype;
  v_idx int;
  v_try jsonb;
  v_current jsonb;
  v_unclear int;
  v_reason text;
  v_job bigint;
  v_tries jsonb;
begin
  if p_outcome not in ('applied', 'unclear') then
    raise exception 'invalid outcome %', p_outcome;
  end if;
  select * into q from questions where id = p_question_id;
  if q.id is null then
    raise exception 'question_not_found' using errcode = 'P0002';
  end if;
  select * into r from reports where id = q.report_id;
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = q.report_id for update;
  select * into q from questions where id = p_question_id for update;

  select (o.n - 1)::int, o.e into v_idx, v_try
  from jsonb_array_elements(q.voice_answers) with ordinality o(e, n)
  where o.e ->> 'uploadId' = p_upload_id::text limit 1;
  if v_try is null then
    raise exception 'voice_answer_not_found' using errcode = 'P0002';
  end if;
  -- Settled before (a retried job): what it was.
  if v_try ->> 'status' <> 'listening' then
    return jsonb_build_object('settled', false, 'status', v_try ->> 'status');
  end if;
  -- Answered meanwhile (a tap, the 60-minute timeout) or the report moved on: the try is stale.
  if q.answered_at is not null or r.status <> 'awaiting_answer' then
    update questions set voice_answers = jsonb_set(voice_answers, array[v_idx::text],
        v_try || jsonb_build_object('status', 'stale'))
    where id = q.id;
    return jsonb_build_object('settled', false, 'status', 'stale');
  end if;

  if p_outcome = 'applied' then
    if jsonb_typeof(p_data) is distinct from 'object' or p_data ->> 'schemaVersion' is distinct from '2'
       or jsonb_typeof(p_answer) is distinct from 'object' then
      raise exception 'invalid_answer_data' using errcode = 'P0001';
    end if;
    select data into v_current from report_versions
    where report_id = r.id and version = r.current_version for update;
    if v_current is null or v_current is distinct from p_base then
      raise exception 'draft_changed' using errcode = 'P0001';
    end if;
    update report_versions set data = p_data, summary = nullif(p_data ->> 'summary', '')
    where report_id = r.id and version = r.current_version;
    update questions set
      voice_answers = jsonb_set(voice_answers, array[v_idx::text],
        v_try || jsonb_build_object('status', 'applied') || (coalesce(p_detail, '{}'::jsonb) - 'reviewReasons')),
      answer = p_answer,
      answer_source = jsonb_build_object('type', 'answer', 'questionId', q.id),
      answered_at = now()
    where id = q.id;
    update reports set status = 'processing' where id = r.id;
    -- "Add <company>" said: the worker created the unconfirmed company; the office reviews it.
    if jsonb_typeof(p_detail -> 'reviewReasons') = 'array'
       and jsonb_array_length(p_detail -> 'reviewReasons') > 0 then
      update reports set needs_review = true,
        review_reasons = array(select distinct x from unnest(review_reasons
          || array(select jsonb_array_elements_text(p_detail -> 'reviewReasons'))) x)
      where id = r.id;
    end if;
    v_job := enqueue_job('decide_next', jsonb_build_object('reportId', r.id), null,
                         'decide:' || r.id || ':answer:' || q.id);
    perform log_audit(r.org_id, 'agent', null, 'report.question_answered', 'report', r.id,
      jsonb_build_object('question_id', q.id, 'field', q.field, 'channel', 'web', 'via', 'voice',
                         'upload_id', p_upload_id, 'confidence', p_detail -> 'confidence',
                         'job_id', v_job));
    return jsonb_build_object('settled', true, 'status', 'applied', 'jobId', v_job);
  end if;

  -- unclear
  v_tries := jsonb_set(q.voice_answers, array[v_idx::text],
    v_try || jsonb_build_object('status', 'unclear') || coalesce(p_detail, '{}'::jsonb));
  select count(*) into v_unclear from jsonb_array_elements(v_tries) e where e ->> 'status' = 'unclear';
  if v_unclear < 2 then
    update questions set voice_answers = v_tries where id = q.id;
    perform log_audit(r.org_id, 'agent', null, 'report.answer_unclear', 'report', r.id,
      jsonb_build_object('question_id', q.id, 'field', q.field, 'upload_id', p_upload_id,
                         'tries', v_unclear, 'reason', p_detail -> 'reason'));
    return jsonb_build_object('settled', true, 'status', 'unclear', 'retry', true, 'jobId', null);
  end if;
  -- F7: asked once more and still unclear → move on and flag.
  v_reason := 'unanswered:' || q.field;
  update questions set voice_answers = v_tries,
    answer = jsonb_build_object('unanswered', true, 'unclear', true, 'via', 'web',
      'uploadIds', (select jsonb_agg(e -> 'uploadId') from jsonb_array_elements(v_tries) e)),
    answered_at = now()
  where id = q.id;
  update reports set status = 'processing', needs_review = true,
    review_reasons = array(select distinct x from unnest(review_reasons || v_reason) x)
  where id = r.id;
  v_job := enqueue_job('decide_next', jsonb_build_object('reportId', r.id), null,
                       'decide:' || r.id || ':answer:' || q.id);
  perform log_audit(r.org_id, 'agent', null, 'report.question_unanswered', 'report', r.id,
    jsonb_build_object('question_id', q.id, 'field', q.field, 'channel', 'web', 'reason', 'unclear',
                       'tries', v_unclear, 'review_reason', v_reason, 'job_id', v_job));
  return jsonb_build_object('settled', true, 'status', 'unclear', 'retry', false, 'jobId', v_job);
end $$;

revoke execute on function field_settle_voice_answer(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function field_settle_voice_answer(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb)
  to service_role;

-- 5. Queue: parse_answer under the report's lock, with decide_next's priority ---------------------------
create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  with report as (
    select case
      when p_type in ('extract_report', 'decide_next', 'file_report', 'render_pdf', 'parse_answer')
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
                    'parse_answer') then 1
    -- Transcription and extraction.
    when p_type in ('transcribe_audio', 'extract_report', 'transcribe_upload',
                    'post_call_reconcile') then 2
    -- Background: weather, evidence packs, digests, retention and anything else.
    when p_type in ('fetch_weather', 'build_evidence_pack') then 3
    else 3
  end;
$$;
