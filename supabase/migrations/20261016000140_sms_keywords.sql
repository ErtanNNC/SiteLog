-- SiteLog · SMS keywords OK, NO WORK, WEATHER, EDIT on two-way packs (W2-12; spec §9.5, F10 SMS,
-- F12 SMS, §10.8, §19 Q80, Q82, Q83, Q102–Q105)
--
-- sms-webhook stores an inbound text and the worker's `sms_inbound` job (or the Demo phone's inline
-- handler) reads its keyword. A report keyword from a reporter who is not opted out, on a pack with
-- two-way SMS, is handed to the worker's new `sms_keyword` job (`sms_keyword:<message>`): OK
-- answers with the open draft's link (§19 Q82), NO WORK and WEATHER with the day sheet's link
-- (F12; the day changes only when the details are saved, W2-08), and EDIT ("EDIT FRI Apex was 7
-- not 6", F10) asks `classify_utterance` for the day and the change, then requests a change of that
-- day's filed report here; apply_correction makes the preview in code, and a second `sms_keyword`
-- job (`sms_keyword:<message>:<correction>`) texts the preview with a link to confirm it on the
-- recorder. Nothing is applied without Save change on the recorder (F10).
--
--   1. draft_corrections.message_id: the inbound text an EDIT came from (one correction per text).
--      A typed change cites `reporter_edit` with `via 'sms'` (§19 Q80) when it is set.
--   2. sms_request_filed_correction() (service role): field_request_filed_correction()'s typed
--      path for an SMS EDIT: the same checks (a filed or signed-off report of a site the reporter
--      covers, inside the 14 days: `report_locked`; one at a time: `correction_pending`), the
--      text's id on the correction, audited `report.correction_requested` with channel 'sms'; a
--      retry of the same text answers the correction it made.
--   3. job_lock_key(): `sms_keyword` under the phone's lock (`sms:<phone>`), as `sms_inbound`, so a
--      phone's texts are answered in order; job_priority(): with the other messages (0).
--
-- Live database (staging): one nullable column (no rewrite) with a partial unique index on a small
-- table, one new function (service role only), two function bodies replaced with the same
-- signatures. The deployed v1.0 code writes none of these.

set local lock_timeout = '5s';

-- 1. The text of an SMS EDIT ---------------------------------------------------------------------------------
alter table draft_corrections
  add column message_id uuid references messages on delete set null;

create unique index draft_corrections_message_idx on draft_corrections (message_id)
  where message_id is not null;

comment on column draft_corrections.message_id is
  'W2-12: the inbound SMS of an EDIT (F10 by SMS); its preview is texted back with a link to confirm.';

-- 2. sms_request_filed_correction ----------------------------------------------------------------------------
create function sms_request_filed_correction(
  p_report_id uuid, p_reporter_id uuid, p_text text, p_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  s sites%rowtype;
  m messages%rowtype;
  c draft_corrections%rowtype;
  v_date date;
  v_job bigint;
begin
  if coalesce(btrim(p_text), '') = '' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into m from messages where id = p_message_id;
  if m.id is null or m.direction <> 'in' or m.channel <> 'sms' then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_complete_upload()'s, field_attach_photos()' and field_request_filed_correction()'s lock.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  -- A retry of the same text (the job ran again): the correction it made.
  select * into c from draft_corrections where message_id = p_message_id;
  if c.id is not null then
    if c.report_id <> r.id then
      raise exception 'message_not_found' using errcode = 'P0002';
    end if;
    return jsonb_build_object('id', c.id, 'status', c.status, 'jobId', null, 'repeat', true);
  end if;
  if r.status not in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select * into s from sites where id = r.site_id;
  if s.status <> 'active' then
    -- §19 Q99: a paused or archived site's reports are not changed from the phone.
    raise exception 'site_inactive' using errcode = 'P0001';
  end if;
  select date into v_date from site_days where id = r.site_day_id;
  if not field_report_changeable(v_date, s.timezone) then
    raise exception 'report_locked' using errcode = 'P0001';
  end if;
  if exists (select 1 from draft_corrections where report_id = r.id and status = 'listening'
               and created_at > now() - interval '5 minutes') then
    raise exception 'correction_pending' using errcode = 'P0001';
  end if;
  update draft_corrections set status = 'discarded', settled_at = coalesce(settled_at, now())
  where report_id = r.id and status in ('ready', 'unclear', 'listening');
  insert into draft_corrections (org_id, report_id, reporter_id, via, text, after_filing, message_id)
  values (r.org_id, r.id, p_reporter_id, 'text', left(btrim(p_text), 1000), true, p_message_id)
  returning * into c;
  v_job := enqueue_job('apply_correction',
    jsonb_build_object('reportId', r.id, 'correctionId', c.id), null, 'correction:' || c.id);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_requested', 'report',
    r.id, jsonb_build_object('correction_id', c.id, 'via', 'text', 'upload_id', null,
                             'channel', 'sms', 'message_id', p_message_id, 'job_id', v_job,
                             'after_filing', true, 'version', r.current_version));
  return jsonb_build_object('id', c.id, 'status', 'listening', 'jobId', v_job);
end $$;

revoke execute on function sms_request_filed_correction(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function sms_request_filed_correction(uuid, uuid, text, uuid) to service_role;

-- 3. Queue: sms_keyword under the phone's lock, with the messages' priority -----------------------------------
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
    -- W1-08: one phone's inbound texts one at a time, oldest first; W2-12: their keywords too.
    when p_type in ('sms_inbound', 'sms_keyword') and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
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
    when p_type in ('inbound_message', 'sms_inbound', 'sms_keyword', 'send_message', 'send_template',
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
