-- SiteLog · the test recording on first open (W2-13; spec F4 step 3, §9.3 Welcome & consent, §19 Q52)
--
-- F4: after the consents, an optional 20-second test: "Say anything — nothing gets filed." → the
-- snippet shown back ("Heard you clearly: '…'"). The clip is outside any report, never a source,
-- and goes with its transcript as soon as the snippet is read, or after 10 minutes at the latest.
--
--   1. test_clips: one row per test (reporter, device, the `audio` bucket path under `test/`, what
--      the worker heard). RLS on, no client policy, no grant: field-api and the worker (service
--      role) only. The row stays without its file or words, for the audit and the rate limit.
--   2. field_test_clip_create() (service role): the row, audited `test_clip.created`, and the
--      10-minute backstop `delete_test_clip` (`test_clip:<id>:delete`, run_after now + 10 min).
--   3. field_test_clip_complete(): the file is in Storage; queues `transcribe_test_clip`
--      (`test_clip:<id>`). A retry answers the same.
--   4. field_test_clip_read(): the snippet once: `heard` (with the words) or `silent` once the
--      worker transcribed it, then the words are deleted (`test_clip.deleted`, reason `read`);
--      `pending` before; `failed` when the worker could not transcribe it; `gone` once deleted.
--   5. job_priority(): transcribe_test_clip with the steps a reporter waits for.
--
-- Live database (staging): one new table (service only), three new functions (service only), one
-- function body replaced (grants kept). The deployed v1.0 code touches none of them.

set local lock_timeout = '5s';

-- 1. test_clips ---------------------------------------------------------------------------------------------
create table test_clips (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  reporter_id uuid not null references reporters on delete cascade,
  device_id uuid references field_devices on delete set null,
  storage_path text not null,                    -- audio bucket: test/{org}/{id}.{ext}
  mime text not null,
  bytes int,
  created_at timestamptz not null default now(),
  completed_at timestamptz,                      -- the file reached Storage
  transcribed_at timestamptz,
  heard boolean,                                 -- the transcript had words
  snippet text,                                  -- what was heard (at most 160 characters), until read
  failed_at timestamptz,                         -- the worker could not transcribe it
  read_at timestamptz,
  deleted_at timestamptz,                        -- the file and the words are gone
  check (storage_path like 'test/%'),
  check (snippet is null or length(snippet) <= 160)
);

create index test_clips_open_idx on test_clips (created_at) where deleted_at is null;

alter table test_clips enable row level security;
revoke all on test_clips from anon, authenticated;

comment on table test_clips is
  'F4 (W2-13): the Welcome screen''s test recording; outside any report, deleted once read or after 10 minutes.';

-- 2. field_test_clip_create ---------------------------------------------------------------------------------
create function field_test_clip_create(
  p_id uuid, p_reporter_id uuid, p_device_id uuid, p_path text, p_mime text, p_bytes int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rp reporters%rowtype;
  v_job bigint;
begin
  select * into rp from reporters where id = p_reporter_id;
  if rp.id is null or rp.status = 'disabled' then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- F4: the test is covered by the recording consent, which must be held.
  if not exists (select 1 from consents where reporter_id = rp.id and type = 'recording'
                   and revoked_at is null) then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;
  insert into test_clips (id, org_id, reporter_id, device_id, storage_path, mime, bytes)
  values (p_id, rp.org_id, rp.id, p_device_id, p_path, p_mime, p_bytes);
  v_job := enqueue_job('delete_test_clip', jsonb_build_object('testClipId', p_id),
                       now() + interval '10 minutes', 'test_clip:' || p_id || ':delete');
  perform log_audit(rp.org_id, 'reporter', rp.id, 'test_clip.created', 'test_clip', p_id,
    jsonb_build_object('device_id', p_device_id, 'mime', p_mime, 'bytes', p_bytes,
                       'delete_job_id', v_job));
  return jsonb_build_object('id', p_id, 'deleteJobId', v_job);
end $$;

-- 3. field_test_clip_complete -------------------------------------------------------------------------------
create function field_test_clip_complete(p_id uuid, p_reporter_id uuid, p_bytes int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t test_clips%rowtype;
  v_job bigint;
begin
  select * into t from test_clips where id = p_id for update;
  if t.id is null or t.reporter_id is distinct from p_reporter_id then
    raise exception 'test_clip_not_found' using errcode = 'P0002';
  end if;
  if t.deleted_at is not null then
    return jsonb_build_object('status', 'gone', 'jobId', null);
  end if;
  if t.completed_at is null then
    update test_clips set completed_at = now(), bytes = coalesce(p_bytes, bytes) where id = t.id;
  end if;
  v_job := enqueue_job('transcribe_test_clip', jsonb_build_object('testClipId', t.id), null,
                       'test_clip:' || t.id);
  return jsonb_build_object('status', 'pending', 'jobId', v_job);
end $$;

-- 4. field_test_clip_read -----------------------------------------------------------------------------------
create function field_test_clip_read(p_id uuid, p_reporter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t test_clips%rowtype;
  v_status text;
begin
  select * into t from test_clips where id = p_id for update;
  if t.id is null or t.reporter_id is distinct from p_reporter_id then
    raise exception 'test_clip_not_found' using errcode = 'P0002';
  end if;
  if t.deleted_at is not null then
    return jsonb_build_object('status', case when t.failed_at is not null then 'failed' else 'gone' end,
                              'snippet', null);
  end if;
  if t.failed_at is not null then
    v_status := 'failed';
  elsif t.transcribed_at is null then
    return jsonb_build_object('status', 'pending', 'snippet', null);
  else
    v_status := case when t.heard then 'heard' else 'silent' end;
  end if;
  -- Read once: the words go now (the worker removed the file after transcribing it).
  update test_clips set read_at = now(), deleted_at = now(), snippet = null where id = t.id;
  perform log_audit(t.org_id, 'reporter', t.reporter_id, 'test_clip.deleted', 'test_clip', t.id,
    jsonb_build_object('reason', 'read', 'status', v_status));
  return jsonb_build_object('status', v_status,
                            'snippet', case when v_status = 'heard' then t.snippet end);
end $$;

revoke execute on function field_test_clip_create(uuid, uuid, uuid, text, text, int),
  field_test_clip_complete(uuid, uuid, int), field_test_clip_read(uuid, uuid)
  from public, anon, authenticated;
grant execute on function field_test_clip_create(uuid, uuid, uuid, text, text, int),
  field_test_clip_complete(uuid, uuid, int), field_test_clip_read(uuid, uuid)
  to service_role;

-- 5. Queue priority: the reporter waits on the Welcome screen for the snippet ------------------------------
create or replace function job_priority(p_type text) returns int
language sql immutable set search_path = public as $$
  select case
    -- Messages and calls to and from the reporter.
    when p_type in ('inbound_message', 'sms_inbound', 'send_message', 'send_template',
                    'send_welcome', 'send_sms', 'notify', 'place_call') then 0
    -- The next step of a report someone is waiting for, its PDF and its email.
    when p_type in ('parse_reply', 'decide_next', 'file_report', 'render_pdf', 'send_email',
                    'parse_answer', 'transcribe_test_clip') then 1
    -- Transcription and extraction.
    when p_type in ('transcribe_audio', 'extract_report', 'transcribe_upload',
                    'post_call_reconcile') then 2
    -- Background: weather, evidence packs, digests, retention and anything else.
    when p_type in ('fetch_weather', 'build_evidence_pack') then 3
    else 3
  end;
$$;
