-- SiteLog · spec v1.2 backfill and compat (W1-05 step 10; docs/GAP_ANALYSIS.md §7, D13, D14, D20)
--
-- Backfill (GAP §4.1 stage 3), set-based and idempotent: a second run changes nothing.
--   1. reports.language: the §6.3 report language, from the org locale ('en' for every existing
--      org: none is tr-TR yet), then NOT NULL with no default, as §6.3 has it: every writer of
--      this commit sets the language itself (the worker's insertReport and the office RPCs below
--      from org_report_language(), the seed generator from the dataset), and a writer that
--      forgets it fails (23502) instead of filing a tr-TR report in English. No writer from
--      before this commit runs against a database that has it: no worker runs on staging (GAP
--      §8), the panel writes reports only through the RPCs this migration replaces, and the
--      worker ships with this migration (step 21). Reports typed in the panel before this
--      migration get channel 'office', as create_office_report writes it from now on (D13);
--      WhatsApp-era reports keep a null channel.
--   2. reporters.activated_at: when a 'verified' reporter (step 11: 'active') became active, its
--      verified_at (else invited_at, else created_at).
--   3. uploads from the media of messages: every inbound audio, photo (image, or document with an
--      image type) and office-photo message that is a source of a report and still has its file
--      gets an uploads row with the SAME id, so the ids immutable report data stores
--      (data.photos[].messageId, Source.messageId) resolve as uploads too. report_id, site_id
--      from the report; reporter_id the sender for WhatsApp media (the reporter of the
--      conversation's phone in the report's org, else the report's reporter), null for office
--      photos (D14), whose uploaded_by is the office user recorded on the message; kind audio or
--      photo by the source's kind; file, type, duration, waveform peaks, caption and times from
--      the message and its source row. A message without a file (never downloaded, or purged by
--      retention) gets none: uploads.storage_path is NOT NULL, and readers fall back to the
--      message. A message that is a source of two reports gets one upload, for the live report.
--      Stored voice notes of a report that are not its sources get an audio upload of that
--      report too: voice answers (questions.answered_message_id) and voice corrections
--      (report_versions.author_message_id). Audio of no report (an unknown sender, a pending
--      message no report took) keeps its message and transcript until step 23 archives them.
--   4. report_sources keys: upload_id where the message now has an upload; kind in the §6.2
--      source_kind labels: audio → voice_note, reply → answer with question_id when that message
--      answered a question of the report (questions.answered_message_id), else text; photo and
--      text stay. transcripts.upload_id for the transcript of a backfilled voice note.
--   One audit_log row (org null, 'migration.backfill_uploads') records the counts.
--
-- Office photos (D13, D14): attach_office_photos() now writes an uploads row (reporter_id null,
--   uploaded_by = auth.uid(), received_at = now()) and a photo source with upload_id only; no
--   messages row. No reader needs one any more: every media reader of this commit reads uploads
--   first and messages as the fallback (panel, report/photos.ts, PDF inputs, evidence pack,
--   retention, cost). create_office_report() files with channel 'office' and the org's report
--   language. A version's data.photos entry keys the photo by its media id: `messageId` in v1
--   data, `uploadId` in v2 data (the same UUID either way). create_report_version() reads both
--   keys in p_data.photos and in the replaced version, and writes the key of p_data's version.
--   list_orphan_office_photos() skips objects an upload stores; report_cost_inputs() also counts
--   the jobs of a report's uploads (payload.uploadId: transcribe_upload, W1-11).
--
-- Retention: uploads.purged_at (+, D12). The worker's retention job deletes an expired file and
--   its transcript and sets purged_at; the upload row and the report_sources key stay (an office
--   photo has no message to fall back on), and readers treat a purged upload as a missing file.
--
-- Report data v1 and v2 (D20): denormalize_report_version() reads the sources of either version:
--   weather_events.audio_source is the first 'audio' (v1) or 'voice_note' (v2) source, stored as
--   written, and it writes report_sources with the v1.2 keys for the field sources the version
--   cites: a voice note (v1 audio messageId / v2 voice_note uploadId) re-keys the report's source
--   row of that media (kind voice_note, upload_id when the upload exists) or adds one for an
--   audio upload of this report; an answer (v1 reply messageId, v2 answer questionId, or a v1
--   reply UUID carried into v2 by the upgrade) names its question of this report (kind answer,
--   question_id, message_id of the reply); a reply that answered no question becomes text; a call
--   names its call of this report. Only text rows (reply, text) become answers and only audio rows
--   voice notes: when the reply is a photo or voice note of the report (a photo that answered a
--   photo question), that row stays as it is and the answer gets a row of its own with question_id
--   and no message_id (unique (report_id, message_id)). It only re-keys the report's own source
--   rows and adds rows for uploads, questions and calls of the same report, so data an office edit
--   sends cannot link another report's media. Rows are never deleted: sources belong to the
--   report, not a version.
--
-- Live database: one transaction. The Supabase CLI sends each file as one extended-protocol
-- pipeline with a single Sync and no BEGIN: one transaction, but on Postgres 17 not a transaction
-- block, where a top-level LOCK TABLE fails (25P01), so the lock is taken inside a DO block; it is
-- still held until the file commits. That is the first statement after lock_timeout: it takes the
-- reports lock (ACCESS EXCLUSIVE), so every RPC or worker write already running finishes first and
-- the backfill sees its rows, and the writes that wait for the lock run against the new functions
-- and the NOT NULL column (an old create_office_report call already inside the function fails with
-- 23502 and is submitted again). A write from the old code that commits after the backfill (an
-- office photo stored as a message, a WhatsApp voice note) needs nothing from it: readers fall
-- back to the message, and denormalize_report_version re-keys its source on the next filing or
-- edit.
-- Batches would not shorten the locks inside one transaction; the tables are small (staging
-- holds 0 messages and 0 reports, GAP §8), so each step is one set-based statement.

set local lock_timeout = '5s';

-- 1. reports.language and the office channel ------------------------------------------------------
do $$ begin lock table reports in access exclusive mode; end $$;

-- §9.6: the report language of an org (packages/shared/src/locale.ts reportLanguageFor()).
create or replace function org_report_language(p_org_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when split_part(coalesce((select locale from orgs where id = p_org_id), 'en-US'), '-', 1) = 'tr'
              then 'tr' else 'en' end;
$$;
revoke execute on function org_report_language(uuid) from public, anon, authenticated;
grant execute on function org_report_language(uuid) to service_role;

-- One upload per stored object (as messages_office_storage_path did for office messages): two
-- concurrent calls cannot attach one file twice. Before the backfill, whose `on conflict do
-- nothing` then also skips a second message with the same file (none is expected: every path
-- embeds its message id or a random id).
create unique index uploads_storage_path on uploads (storage_path);

-- + Retention (§15: files deleted after AUDIO_RETENTION_DAYS, reports kept) deletes the file and
-- its transcript and keeps the upload with purged_at, as it keeps a WhatsApp message with
-- storage_path null and payload.purged_at: the report's photo and voice-note sources keep their
-- key, so a version still lists a purged photo and an office edit does not drop it unaudited.
-- Readers treat a purged upload as a missing file. A recorded addition (D12, schema-allowlist.ts).
alter table uploads add column purged_at timestamptz;

-- A backfilled column is not an edit of the report: updated_at keeps its value (the reports lock
-- is held since the first statement, so no other writer runs meanwhile).
alter table reports disable trigger reports_updated_at;

do $$
declare
  v_language int;
  v_office int;
  v_activated int;
  v_uploads int;
  v_voice_replies int;
  v_upload_keys int;
  v_voice int;
  v_answers int;
  v_texts int;
  v_transcripts int;
begin
  update reports r set language = org_report_language(r.org_id) where r.language is null;
  get diagnostics v_language = row_count;

  -- Typed in the panel: no reporter, version 1 by an office user (isOfficeEntry in the panel).
  update reports r set channel = 'office'
  where r.channel is null and r.reporter_id is null
    and exists (select 1 from report_versions v
                where v.report_id = r.id and v.version = 1 and v.author = 'office_user');
  get diagnostics v_office = row_count;

  -- 2. reporters.activated_at ---------------------------------------------------------------------
  update reporters set activated_at = coalesce(verified_at, invited_at, created_at)
  where status::text = 'verified' and activated_at is null;
  get diagnostics v_activated = row_count;

  -- 3. uploads from message media (same id) -------------------------------------------------------
  -- reporter_id: the reporter who sent the file, i.e. the reporter of its conversation's phone in
  -- the report's org (intake merges any reporter's media into the site-day's open report, and a
  -- shared phone's conversation may name another org's reporter), else the report's reporter;
  -- null for office photos (no conversation).
  insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path, mime, duration_s,
                       peaks, recorded_at, received_at, caption, uploaded_by)
  select distinct on (m.id)
         m.id, r.id,
         case when m.conversation_id is not null then
           coalesce((select rp.id from conversations c
                     join reporters rp on rp.org_id = r.org_id and rp.phone_e164 = c.phone_e164
                     where c.id = m.conversation_id
                     order by rp.created_at, rp.id limit 1),
                    r.reporter_id)
         end,
         r.site_id,
         (case when rs.kind in ('audio', 'voice_note') then 'audio' else 'photo' end)::upload_kind,
         m.storage_path, m.media_mime, m.duration_s,
         case when jsonb_typeof(m.payload -> 'peaks') = 'array' then m.payload -> 'peaks' end,
         case when rs.kind = 'photo' then coalesce(rs.taken_at, m.created_at) else m.created_at end,
         m.created_at,
         case when rs.kind = 'photo' then coalesce(rs.caption, m.body) end,
         case when m.payload ->> 'source' = 'office_upload'
                   and m.payload ->> 'uploaded_by' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (m.payload ->> 'uploaded_by')::uuid end
  from report_sources rs
  join messages m on m.id = rs.message_id
  join reports r on r.id = rs.report_id
  where rs.kind in ('audio', 'voice_note', 'photo')
    and m.direction = 'in'
    and m.storage_path is not null
    and (m.type in ('audio', 'image') or (m.type = 'document' and m.media_mime like 'image/%'))
  order by m.id, (r.status = 'void'), r.created_at, r.id
  on conflict do nothing;
  get diagnostics v_uploads = row_count;

  -- Stored voice notes of a report that are not its sources: a voice answer to a question
  -- (questions.answered_message_id, through storeForReply and parse_reply) and a voice correction
  -- (report_versions.author_message_id). Each gets an upload of that report too, so its
  -- transcript gets the upload key below and no recording is left on messages alone.
  insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path, mime, duration_s,
                       peaks, recorded_at, received_at)
  select distinct on (m.id)
         m.id, r.id,
         coalesce((select rp.id from conversations c
                   join reporters rp on rp.org_id = r.org_id and rp.phone_e164 = c.phone_e164
                   where c.id = m.conversation_id
                   order by rp.created_at, rp.id limit 1),
                  r.reporter_id),
         r.site_id, 'audio'::upload_kind, m.storage_path, m.media_mime, m.duration_s,
         case when jsonb_typeof(m.payload -> 'peaks') = 'array' then m.payload -> 'peaks' end,
         m.created_at, m.created_at
  from (select q.answered_message_id as message_id, q.report_id from questions q
        where q.answered_message_id is not null
        union all
        select rv.author_message_id, rv.report_id from report_versions rv
        where rv.author_message_id is not null) ref
  join messages m on m.id = ref.message_id
  join reports r on r.id = ref.report_id
  where m.direction = 'in' and m.type = 'audio' and m.storage_path is not null
    and not exists (select 1 from uploads u where u.id = m.id)
  order by m.id, (r.status = 'void'), r.created_at, r.id
  on conflict do nothing;
  get diagnostics v_voice_replies = row_count;

  -- 4. report_sources and transcripts keys -------------------------------------------------------
  update report_sources rs set upload_id = rs.message_id
  where rs.upload_id is null and rs.message_id is not null
    and exists (select 1 from uploads u where u.id = rs.message_id);
  get diagnostics v_upload_keys = row_count;

  update report_sources set kind = 'voice_note' where kind = 'audio';
  get diagnostics v_voice = row_count;

  update report_sources rs
  set kind = 'answer',
      question_id = (select q.id from questions q
                     where q.report_id = rs.report_id and q.answered_message_id = rs.message_id
                     order by q.answered_at nulls last, q.created_at, q.id limit 1)
  where rs.kind = 'reply'
    and exists (select 1 from questions q
                where q.report_id = rs.report_id and q.answered_message_id = rs.message_id);
  get diagnostics v_answers = row_count;

  update report_sources set kind = 'text' where kind = 'reply';
  get diagnostics v_texts = row_count;

  update transcripts t set upload_id = t.message_id
  where t.upload_id is null and t.call_id is null and t.message_id is not null
    and exists (select 1 from uploads u where u.id = t.message_id and u.kind = 'audio');
  get diagnostics v_transcripts = row_count;

  if v_language + v_office + v_activated + v_uploads + v_voice_replies + v_upload_keys + v_voice
     + v_answers + v_texts + v_transcripts > 0 then
    insert into audit_log (org_id, actor_type, action, entity, diff)
    values (null, 'system', 'migration.backfill_uploads', 'migration',
            jsonb_build_object('migration', '20261014000002',
              'reports_language', v_language, 'reports_office_channel', v_office,
              'reporters_activated', v_activated, 'uploads', v_uploads,
              'uploads_voice_replies', v_voice_replies, 'sources_upload_id', v_upload_keys, 'sources_voice_note', v_voice,
              'sources_answer', v_answers, 'sources_text', v_texts,
              'transcripts_upload_id', v_transcripts));
  end if;
end $$;

alter table reports enable trigger reports_updated_at;
alter table reports alter column language set not null;

-- 5. Helpers: report data photos and sources -----------------------------------------------------------
-- The media id of a data.photos entry: uploadId (v2) or messageId (v1), the same UUID.
create or replace function photo_entry_id(p_entry jsonb) returns text
language sql immutable set search_path = public as $$
  select lower(case
    when jsonb_typeof(p_entry) <> 'object' then null
    when jsonb_typeof(p_entry -> 'uploadId') = 'string' then p_entry ->> 'uploadId'
    when jsonb_typeof(p_entry -> 'messageId') = 'string' then p_entry ->> 'messageId'
  end);
$$;

-- The key a version's data.photos entries use: uploadId in v2 data, messageId in v1 (and in data
-- written before schemaVersion existed).
create or replace function report_photo_key(p_data jsonb) returns text
language sql immutable set search_path = public as $$
  select case when p_data ->> 'schemaVersion' = '2' then 'uploadId' else 'messageId' end;
$$;

-- The photos of a report: its photo sources with their media id (upload_id, else message_id) and
-- the recorded time, from the upload or, for WhatsApp photos without one, the message.
create or replace function report_photo_sources(p_report_id uuid)
returns table (media_id uuid, caption text, taken_at timestamptz, added_at timestamptz)
language sql stable security definer set search_path = public as $$
  select coalesce(rs.upload_id, rs.message_id), rs.caption,
         coalesce(rs.taken_at, m.created_at, u.recorded_at, u.received_at),
         coalesce(m.created_at, u.received_at, rs.created_at)
  from report_sources rs
  left join uploads u on u.id = coalesce(rs.upload_id, rs.message_id)
  left join messages m on m.id = rs.message_id
  where rs.report_id = p_report_id and rs.kind = 'photo'
    and coalesce(rs.upload_id, rs.message_id) is not null;
$$;

-- Every Source object of a version's data (§10.3: the source[] lists of weather periods,
-- manpower, work, deliveries, equipment, safety and its incidents, issues and next workday).
create or replace function report_data_sources(p_data jsonb) returns setof jsonb
language sql immutable set search_path = public as $$
  with lists(list) as (
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'weather' -> 'periods') = 'array' then p_data -> 'weather' -> 'periods' else '[]' end) x
    union all
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'manpower') = 'array' then p_data -> 'manpower' else '[]' end) x
    union all
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'workPerformed') = 'array' then p_data -> 'workPerformed' else '[]' end) x
    union all
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'deliveries') = 'array' then p_data -> 'deliveries' else '[]' end) x
    union all
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'equipment') = 'array' then p_data -> 'equipment' else '[]' end) x
    union all
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'safety' -> 'incidents') = 'array' then p_data -> 'safety' -> 'incidents' else '[]' end) x
    union all
    select p_data -> 'safety' -> 'source'
    union all
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'issues') = 'array' then p_data -> 'issues' else '[]' end) x
    union all
    select x -> 'source' from jsonb_array_elements(
      case when jsonb_typeof(p_data -> 'nextWorkday') = 'array' then p_data -> 'nextWorkday' else '[]' end) x
  )
  select s from lists, jsonb_array_elements(case when jsonb_typeof(list) = 'array' then list else '[]' end) s
  where jsonb_typeof(s) = 'object';
$$;

revoke execute on function photo_entry_id(jsonb), report_photo_key(jsonb),
  report_photo_sources(uuid), report_data_sources(jsonb) from public, anon, authenticated;

-- 6. Office photos as uploads --------------------------------------------------------------------------
-- attach_office_photos (20261013000005) with the data.photos key of the version it attaches to.
drop function attach_office_photos(uuid, jsonb);
create function attach_office_photos(p_report_id uuid, p_photos jsonb, p_key text default 'messageId')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_item jsonb;
  v_path text;
  v_mime text;
  v_caption text;
  v_taken timestamptz;
  v_uploaded boolean;
  v_upload_id uuid;
  v_out jsonb := '[]'::jsonb;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null then raise exception 'report not found'; end if;
  -- Both callers check this already; it also guards a direct call should the revoke below lapse.
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_key is null or p_key not in ('messageId', 'uploadId') then raise exception 'unexpected photo key'; end if;
  if jsonb_typeof(v_photos) is distinct from 'array' then raise exception 'photos must be a JSON array'; end if;
  if jsonb_array_length(v_photos) > 20 then raise exception 'at most 20 photos at a time'; end if;

  for v_item in select e from jsonb_array_elements(v_photos) e loop
    if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'photo must be a JSON object'; end if;
    v_path := case when jsonb_typeof(v_item->'path') = 'string' then v_item->>'path' end;
    if v_path is null or v_path !~ ('^' || r.org_id || '/' || r.site_id
        || '/office/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$') then
      raise exception 'unexpected photo path';
    end if;
    v_mime := v_item->>'mime';
    if v_mime is null or v_mime not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception 'unsupported photo type';
    end if;
    -- The PDF renderers pick the image decoder from the file name.
    if v_mime <> (case substring(v_path from '\.([a-z]+)$')
                    when 'png' then 'image/png' when 'webp' then 'image/webp' else 'image/jpeg' end) then
      raise exception 'photo type does not match its file name';
    end if;
    if jsonb_typeof(v_item->'caption') not in ('string', 'null') then raise exception 'photo caption must be text'; end if;
    v_caption := nullif(btrim(v_item->>'caption'), '');
    if length(v_caption) > 500 then raise exception 'photo caption is too long'; end if;
    -- When the photo was taken (the panel reads it from the file); never later than now.
    v_taken := now();
    if jsonb_typeof(v_item->'takenAt') = 'string' then
      begin
        v_taken := (v_item->>'takenAt')::timestamptz;
      exception when others then
        raise exception 'invalid photo time';
      end;
      if not isfinite(v_taken) then raise exception 'invalid photo time'; end if;
      v_taken := least(v_taken, now());
    elsif jsonb_typeof(v_item->'takenAt') is distinct from 'null' and v_item ? 'takenAt' then
      raise exception 'invalid photo time';
    end if;
    -- Where the photo goes in the version's list (place_office_photos); absent or null: at the end.
    if jsonb_typeof(v_item->'position') = 'number' then
      if (v_item->>'position')::numeric <> trunc((v_item->>'position')::numeric)
         or (v_item->>'position')::numeric not between 0 and 1000 then
        raise exception 'invalid photo position';
      end if;
    elsif jsonb_typeof(v_item->'position') is distinct from 'null' and v_item ? 'position' then
      raise exception 'invalid photo position';
    end if;

    -- An upload, or an office message from before this migration, already stores the object.
    if exists (select 1 from uploads u where u.storage_path = v_path)
       or exists (select 1 from messages m where m.org_id = r.org_id and m.storage_path = v_path) then
      raise exception 'photo already attached';
    end if;
    if to_regclass('storage.objects') is not null then
      execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
        into v_uploaded using 'photos', v_path;
      if not v_uploaded then raise exception 'photo not uploaded'; end if;
    end if;

    insert into uploads (report_id, reporter_id, site_id, kind, storage_path, mime, recorded_at, caption, uploaded_by)
    values (p_report_id, null, r.site_id, 'photo', v_path, v_mime, v_taken, v_caption, auth.uid())
    returning id into v_upload_id;
    insert into report_sources (report_id, upload_id, kind, caption, taken_at)
    values (p_report_id, v_upload_id, 'photo', v_caption, v_taken);
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      p_key, v_upload_id,
      'caption', v_caption,
      'takenAt', to_char(v_taken at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
  end loop;
  return v_out;
end $$;

-- create_office_report (20261013000005), filed with channel 'office' and the org's language.
create or replace function create_office_report(p_site_id uuid, p_date date, p_data jsonb, p_photos jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sites%rowtype;
  sd site_days%rowtype;
  v_existing reports%rowtype;
  v_deadline time;
  v_data jsonb;
  v_photos jsonb;
  v_report_id uuid;
  v_report_no text;
  v_late boolean;
begin
  select * into s from sites where id = p_site_id;
  if s.id is null then raise exception 'site not found'; end if;
  if not has_role(s.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if s.status = 'archived' then raise exception 'site is archived'; end if;
  if p_date is null then raise exception 'date required'; end if;
  if p_date > (now() at time zone s.timezone)::date then raise exception 'date is in the future'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'report data must be a JSON object'; end if;
  -- v1 until W1-12 replaces this function with a v2 writer (GAP §7 step 17).
  v_data := p_data || jsonb_build_object('reportDate', to_char(p_date, 'YYYY-MM-DD'), 'schemaVersion', 1);

  -- The row lock serialises concurrent calls for one day; a concurrent first insert is absorbed
  -- by "on conflict do nothing" and the re-select then waits for the winner's lock.
  select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  if sd.id is null then
    v_deadline := coalesce(
      s.deadline,
      (select default_deadline from org_settings where org_id = s.org_id),
      '17:30'::time);
    insert into site_days (site_id, date, status, deadline_at)
    values (p_site_id, p_date, 'pending', (p_date + v_deadline)::timestamp at time zone s.timezone)
    on conflict (site_id, date) do nothing;
    select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  end if;

  -- A double submit returns the report the first call filed (its photos are attached already).
  select * into v_existing from reports
  where site_day_id = sd.id and status <> 'void'
  order by created_at
  limit 1;
  if v_existing.id is not null then
    return jsonb_build_object('reportId', v_existing.id, 'reportNo', v_existing.report_no, 'created', false);
  end if;

  v_report_no := next_report_no(p_site_id);
  v_late := now() > sd.deadline_at;
  insert into reports (org_id, site_id, site_day_id, report_no, status, kind, current_version,
                       reporter_id, received_at, confirmed_at, filed_at, is_late, channel, language)
  values (s.org_id, p_site_id, sd.id, v_report_no, 'filed', 'daily', 1,
          null, now(), null, now(), v_late,  -- confirmed_at: only a field confirm sets it
          'office', org_report_language(s.org_id))
  returning id into v_report_id;

  v_photos := place_office_photos('[]'::jsonb,
    attach_office_photos(v_report_id, p_photos, report_photo_key(v_data)), p_photos);
  v_data := v_data || jsonb_build_object('photos', v_photos);
  -- Every crew row here was typed by the office: each "Add new…" name becomes a company.
  v_data := link_typed_companies(s.org_id, v_report_id, v_data);
  insert into report_versions (report_id, version, data, summary, author, author_user_id)
  values (v_report_id, 1, v_data, nullif(v_data->>'summary', ''), 'office_user', auth.uid());
  perform denormalize_report_version(v_report_id, 1);

  update site_days set status = 'filed', report_id = v_report_id, is_late = v_late where id = sd.id;

  perform log_audit(s.org_id, 'user', auth.uid(), 'report.filed', 'report', v_report_id,
    jsonb_build_object('trigger', 'office_entry', 'version', 1, 'is_late', v_late, 'date', p_date,
                       'photos', jsonb_array_length(v_photos)));

  return jsonb_build_object('reportId', v_report_id, 'reportNo', v_report_no, 'created', true);
end $$;

-- create_report_version (20261013000005) for v1 and v2 data. data.photos of the new version: the
-- entries of p_data.photos (uploadId or messageId) that are photos of this report (first
-- occurrence, in that order, caption as sent, time as recorded), with the uploads in p_photos
-- placed among them (place_office_photos), each keyed as p_data's version keys photos.
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
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', true, 'changeNote', p_change_note, 'notifyReporter', true),
                      null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next);
end $$;

revoke execute on function attach_office_photos(uuid, jsonb, text) from public, anon, authenticated;

-- Office uploads never attached: objects under {org}/{site}/office/ older than p_before that no
-- upload stores (an attached photo always has one; retention deletes the object and keeps the
-- upload, purged_at) and no office message from before this migration stores.
create or replace function list_orphan_office_photos(p_before timestamptz, p_limit int default 200)
returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  return query execute
    $q$select o.name::text from storage.objects o
       where o.bucket_id = 'photos'
         and o.name ~ '^[^/]+/[^/]+/office/[^/]+$'
         and o.created_at < $1
         and not exists (select 1 from public.uploads u where u.storage_path = o.name)
         and not exists (select 1 from public.messages m
                         where m.org_id is not null and m.storage_path = o.name)
       order by o.created_at, o.name
       limit $2$q$
    using p_before, greatest(coalesce(p_limit, 200), 0);
end $$;

-- 7. denormalize_report_version: v1 and v2 data (D20) -----------------------------------------------
-- 20261012000002, plus the voice_note source for the delay record and the report_sources sync.
create or replace function denormalize_report_version(p_report_id uuid, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_data jsonb; v_site uuid; v_org uuid; v_date date; v_photo_count int;
  v_src jsonb;
  v_type text;
  v_id uuid;
  v_question questions%rowtype;
  v_row_id uuid;
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  select rv.data, r.site_id, r.org_id, (rv.data->>'reportDate')::date
    into v_data, v_site, v_org, v_date
  from report_versions rv join reports r on r.id = rv.report_id
  where rv.report_id = p_report_id and rv.version = p_version;
  if v_data is null then raise exception 'version not found'; end if;
  v_photo_count := coalesce(jsonb_array_length(v_data->'photos'), 0);

  delete from manpower_entries where report_id = p_report_id and version = p_version;
  delete from work_items where report_id = p_report_id and version = p_version;
  delete from weather_events where report_id = p_report_id and version = p_version;

  insert into manpower_entries (report_id, version, company_id, company_name_heard, company_name, trade, area, workers, hours, hours_basis, source, confidence)
  select p_report_id, p_version,
         (select c.id from companies c
           where (m->>'companyId') ~ '^[0-9a-f-]{36}$'
             and c.id = (m->>'companyId')::uuid and c.org_id = v_org),
         m->>'companyNameHeard', m->>'companyName', m->>'trade', m->>'area',
         coalesce((m->>'workers')::int, 0), coalesce((m->>'totalHours')::numeric, 0),
         m->>'hoursBasis', m->'source'->0, (m->>'confidence')::numeric
  from jsonb_array_elements(coalesce(v_data->'manpower', '[]'::jsonb)) m;

  insert into work_items (report_id, version, area, activity, status, percent, quantity, source)
  select p_report_id, p_version, w->>'area', w->>'activity', w->>'status', (w->>'percentComplete')::int,
         case when w ? 'quantity' then (w->'quantity'->>'value') || ' ' || (w->'quantity'->>'unit') end,
         w->'source'->0
  from jsonb_array_elements(coalesce(v_data->'workPerformed', '[]'::jsonb)) w;

  insert into weather_events (report_id, version, site_id, date, start_local, end_local, condition, impact, lost_hours, full_day, audio_source, photo_count, observed)
  select p_report_id, p_version, v_site, v_date,
         nullif(p->>'start','')::time, nullif(p->>'end','')::time, p->>'condition', p->>'impact',
         coalesce((p->>'lostHours')::numeric, 0), coalesce((p->>'fullDay')::boolean, false),
         (select s from jsonb_array_elements(coalesce(p->'source','[]'::jsonb)) s
          where s->>'type' in ('audio', 'voice_note') limit 1),
         v_photo_count, v_data->'weather'->'observed'
  from jsonb_array_elements(coalesce(v_data->'weather'->'periods', '[]'::jsonb)) p;

  -- report_sources with the v1.2 keys for the field sources the version cites.
  for v_src in select distinct s from report_data_sources(v_data) s loop
    v_type := v_src->>'type';
    v_id := null;
    v_row_id := null;
    v_question := null;

    if v_type in ('audio', 'voice_note') then
      if coalesce(v_src->>'uploadId', v_src->>'messageId') !~ c_uuid then continue; end if;
      v_id := coalesce(v_src->>'uploadId', v_src->>'messageId')::uuid;
      -- Only a voice-note row: a photo or answer row with that id is not re-keyed.
      select rs.id into v_row_id from report_sources rs
      where rs.report_id = p_report_id and (rs.upload_id = v_id or rs.message_id = v_id)
        and rs.kind in ('audio', 'voice_note')
      order by rs.created_at nulls first, rs.id limit 1;
      if v_row_id is not null then
        update report_sources rs
        set kind = case when rs.kind = 'audio' then 'voice_note' else rs.kind end,
            upload_id = coalesce(rs.upload_id,
                                 (select u.id from uploads u where u.id = v_id and u.site_id = v_site))
        where rs.id = v_row_id
          and (rs.kind = 'audio' or (rs.upload_id is null
               and exists (select 1 from uploads u where u.id = v_id and u.site_id = v_site)));
      elsif exists (select 1 from uploads u
                    where u.id = v_id and u.report_id = p_report_id and u.kind = 'audio') then
        insert into report_sources (report_id, kind, upload_id) values (p_report_id, 'voice_note', v_id);
      end if;

    elsif v_type in ('reply', 'answer') then
      if v_type = 'reply' then
        if v_src->>'messageId' !~ c_uuid then continue; end if;
        v_id := (v_src->>'messageId')::uuid;  -- the reply message
        select q.* into v_question from questions q
        where q.report_id = p_report_id and q.answered_message_id = v_id
        order by q.answered_at nulls last, q.created_at, q.id limit 1;
      else
        if v_src->>'questionId' !~ c_uuid then continue; end if;
        -- A v2 answer names its question; a v1 reply carried into v2 by the upgrade names the
        -- reply message (that question's answered_message_id).
        select q.* into v_question from questions q
        where q.report_id = p_report_id
          and (q.id = (v_src->>'questionId')::uuid or q.answered_message_id = (v_src->>'questionId')::uuid)
        order by (q.id = (v_src->>'questionId')::uuid) desc, q.answered_at nulls last, q.created_at, q.id
        limit 1;
        v_id := v_question.answered_message_id;
      end if;

      if v_question.id is not null then
        -- The answer row of the question, else the reply's own text row (a WhatsApp 'reply' or a
        -- 'text' row, or an answer row that names no question). Never a media row: a photo that
        -- answered a photo question, or a voice note, stays a photo or voice_note source.
        select rs.id into v_row_id from report_sources rs
        where rs.report_id = p_report_id
          and (rs.question_id = v_question.id
               or (v_id is not null and rs.message_id = v_id
                   and (rs.kind in ('reply', 'text') or (rs.kind = 'answer' and rs.question_id is null))))
        order by (rs.question_id = v_question.id) desc nulls last, rs.created_at nulls first, rs.id limit 1;
        if v_row_id is not null then
          update report_sources set kind = 'answer', question_id = v_question.id
          where id = v_row_id and (kind <> 'answer' or question_id is distinct from v_question.id);
        else
          -- When the reply message is already a source of this report (a photo, a voice note, the
          -- answer of another question), the answer row names only its question: unique
          -- (report_id, message_id) allows one row per message.
          insert into report_sources (report_id, kind, question_id, message_id)
          values (p_report_id, 'answer', v_question.id,
                  case when v_id is not null
                            and not exists (select 1 from report_sources rs
                                            where rs.report_id = p_report_id and rs.message_id = v_id)
                       then v_id end);
        end if;
      elsif v_type = 'reply' then
        -- A reply that answered no question (a typed weather or no-work message): text.
        update report_sources set kind = 'text'
        where report_id = p_report_id and message_id = v_id and kind = 'reply';
      end if;

    elsif v_type = 'call' then
      if v_src->>'callId' !~ c_uuid then continue; end if;
      v_id := (v_src->>'callId')::uuid;
      if exists (select 1 from calls c where c.id = v_id and c.report_id = p_report_id)
         and not exists (select 1 from report_sources rs
                         where rs.report_id = p_report_id and rs.call_id = v_id) then
        insert into report_sources (report_id, kind, call_id) values (p_report_id, 'call', v_id);
      end if;
    end if;
  end loop;
end $$;

-- 8. Cost per report: the jobs of the report's uploads too ---------------------------------------------
create index jobs_payload_upload_id on jobs ((payload ->> 'uploadId'));

create or replace function report_cost_inputs(p_report_id uuid)
returns table (ai_usd numeric, job_count int, wa_templates int)
language sql stable security definer set search_path = public as $$
  with ids as (
    select j.id from jobs j where j.payload ->> 'reportId' = p_report_id::text
    union
    select j.id
    from report_sources rs
    join jobs j on j.payload ->> 'messageId' = rs.message_id::text
    where rs.report_id = p_report_id
    union
    -- transcribe_upload (W1-11) and any job keyed by an upload of the report.
    select j.id
    from uploads u
    join jobs j on j.payload ->> 'uploadId' = u.id::text
    where u.report_id = p_report_id
    union
    select j.id
    from report_sources rs
    join jobs j on j.payload ->> 'uploadId' = rs.upload_id::text
    where rs.report_id = p_report_id
  ),
  costs as (
    select case
             when jsonb_typeof(j.payload #> '{metrics,costUsdTotal}') = 'number'
               then (j.payload #>> '{metrics,costUsdTotal}')::numeric
             when jsonb_typeof(j.payload #> '{metrics,estCostUsd}') = 'number'
               then (j.payload #>> '{metrics,estCostUsd}')::numeric
             else 0
           end as usd
    from jobs j join ids using (id)
  ),
  templates as (
    select m.id
    from messages m
    where m.direction = 'out' and m.type = 'template' and m.status <> 'failed'
      and m.payload ->> 'reportId' = p_report_id::text
    union
    select m.id
    from reports r
    join messages m on m.payload ->> 'siteDayId' = r.site_day_id::text
    where r.id = p_report_id
      and m.direction = 'out' and m.type = 'template' and m.status <> 'failed'
  )
  select coalesce((select sum(usd) from costs), 0)::numeric,
         (select count(*) from costs)::int,
         (select count(*) from templates)::int;
$$;
