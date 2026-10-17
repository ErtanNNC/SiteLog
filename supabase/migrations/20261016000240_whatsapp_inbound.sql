-- SiteLog · inbound WhatsApp through sms-webhook (W2-16; spec §9.5, §19 Q26, Q40, Q85, GAP D49 (2))
--
-- Twilio posts an inbound WhatsApp message to the same messaging webhook as a text, with
-- `whatsapp:` addresses; sms-webhook (never a function named whatsapp-webhook, D49 (2)) finds the
-- pack by the WhatsApp sender that received it (`countries.whatsapp_sender_id`), stores it with
-- `channel 'whatsapp'` and hands it to the worker's `sms_inbound` job, as for a text. The message
-- opens the person's 24-hour window (the newest inbound WhatsApp message of the phone).
--
--   1. receive_inbound_message(p_channel, …): receive_sms_inbound() for any inbound channel (the
--      row, its `<channel>.received` audit and the `sms_inbound` job in one transaction, per
--      provider message id); receive_sms_inbound() keeps its signature for the deployed code and
--      goes through it with 'sms'.
--   2. inbound_whatsapp_consent(): STOP on WhatsApp revokes the reporter's `whatsapp` consent (§19
--      Q40, the first option: WhatsApp's opt-out is its consent, SMS is untouched); START on
--      WhatsApp gives it again to a reporter who had given and revoked it (§19 Q112; never a first
--      opt-in, which is Field-02's, §19 Q25). Audited as the reporter, `method 'whatsapp_keyword'`.
--   3. sms_request_filed_correction(): an EDIT sent on WhatsApp too (the message's channel is
--      audited).
--   4. field_answer_question(): the channel of the answer (`p_channel`, default 'web') and the
--      message it came in (`p_message_id`): a WhatsApp answer (§19 Q26) is applied by the worker's
--      `whatsapp_answer` job with `field_channel 'whatsapp'`, `questions.answered_message_id` its
--      message. The deployed field-api's named call (eight arguments) resolves to it unchanged.
--   5. job_lock_key(): `whatsapp_answer` under the phone's lock (`sms:<phone>`), so a phone's
--      messages are handled in order; job_priority(): with the report steps (1).
--
-- Forward-only, CLI-safe: function replacements and two new functions, service role only; no
-- table changes (unknown_contacts.channel takes 'whatsapp' from 20261016000230).

set local lock_timeout = '5s';

-- 1. Store, audit and enqueue an inbound message of any channel ------------------------------------
create function receive_inbound_message(
  p_channel message_channel, p_id uuid, p_org_id uuid, p_reporter_id uuid, p_phone_e164 text,
  p_provider text, p_provider_message_id text, p_body text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_duplicate boolean := false;
  v_handled boolean := false;
  v_job bigint;
  v_key text := 'sms_inbound:' || p_provider_message_id;
begin
  if p_provider not in ('twilio', 'console') then
    raise exception 'receive_inbound_message: unknown provider %', p_provider using errcode = '22023';
  end if;
  if p_channel not in ('sms', 'whatsapp') then
    raise exception 'receive_inbound_message: % is never inbound', p_channel using errcode = '22023';
  end if;
  insert into messages (id, org_id, reporter_id, phone_e164, channel, direction, provider,
                        provider_message_id, body, status, payload)
  values (p_id, p_org_id, p_reporter_id, p_phone_e164, p_channel, 'in', p_provider,
          p_provider_message_id, p_body, 'received', p_payload)
  on conflict (provider_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    v_duplicate := true;
    select m.id, (m.payload ->> 'handled_at') is not null into v_id, v_handled
      from messages m where m.provider_message_id = p_provider_message_id;
  else
    perform log_audit(p_org_id,
      case when p_reporter_id is null then 'system' else 'reporter' end, p_reporter_id,
      p_channel || '.received', 'message', v_id,
      jsonb_build_object('provider', p_provider, 'keyword', p_payload -> 'keyword',
                         'pack', p_payload -> 'pack')
      || case when p_channel = 'whatsapp'
              then jsonb_build_object('media', coalesce(p_payload -> 'num_media', '0'::jsonb))
              else '{}'::jsonb end);
  end if;

  if p_provider = 'twilio' and not v_handled then
    -- D16: the message's one job (a redelivery joins it, whatever its status).
    v_job := enqueue_job('sms_inbound', jsonb_build_object('messageId', v_id), null, v_key);
    if requeue_dead_job(v_job) then
      perform log_audit(p_org_id, 'system', null, 'job.requeued', 'message', v_id,
        jsonb_build_object('job_id', v_job, 'type', 'sms_inbound', 'reason', 'redelivery'));
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'duplicate', v_duplicate, 'handled', v_handled,
                            'jobId', v_job);
end $$;
revoke execute on function receive_inbound_message(message_channel, uuid, uuid, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function receive_inbound_message(message_channel, uuid, uuid, uuid, text, text, text, text, jsonb)
  to service_role;

create or replace function receive_sms_inbound(
  p_id uuid, p_org_id uuid, p_reporter_id uuid, p_phone_e164 text, p_provider text,
  p_provider_message_id text, p_body text, p_payload jsonb
) returns jsonb
language sql security definer set search_path = public as $$
  select receive_inbound_message('sms', p_id, p_org_id, p_reporter_id, p_phone_e164, p_provider,
                                 p_provider_message_id, p_body, p_payload);
$$;

-- 2. STOP and START on WhatsApp: the whatsapp consent -------------------------------------------------
create function inbound_whatsapp_consent(p_reporter_id uuid, p_grant boolean, p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  v_ids uuid[];
  v_version text;
  v_id uuid;
begin
  -- field_grant_consent()'s and field_revoke_consent()'s lock: one change of a person at a time.
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;
  if not p_grant then
    with revoked as (
      update consents set revoked_at = now()
      where reporter_id = r.id and type = 'whatsapp' and revoked_at is null
      returning id
    )
    select array_agg(id) into v_ids from revoked;
    if v_ids is null then
      return jsonb_build_object('changed', false);
    end if;
    foreach v_id in array v_ids loop
      perform log_audit(r.org_id, 'reporter', r.id, 'consent.revoked', 'consent', v_id,
        jsonb_build_object('type', 'whatsapp', 'method', 'whatsapp_keyword', 'keyword', 'stop',
                           'message_id', p_message_id));
    end loop;
    return jsonb_build_object('changed', true);
  end if;
  if exists (select 1 from consents
             where reporter_id = r.id and type = 'whatsapp' and revoked_at is null) then
    return jsonb_build_object('changed', false);
  end if;
  -- §19 Q112: START gives back a WhatsApp consent the person gave and revoked; a first opt-in is
  -- Field-02's (§19 Q25), so a reporter who never ticked it gets nothing here.
  select text_version into v_version from consents
  where reporter_id = r.id and type = 'whatsapp' and revoked_at is not null
  order by revoked_at desc limit 1;
  if v_version is null then
    return jsonb_build_object('changed', false);
  end if;
  insert into consents (reporter_id, type, method, text_version, evidence)
  values (r.id, 'whatsapp', 'whatsapp_keyword', v_version,
          jsonb_build_object('message_id', p_message_id))
  returning id into v_id;
  perform log_audit(r.org_id, 'reporter', r.id, 'consent.given', 'consent', v_id,
    jsonb_build_object('type', 'whatsapp', 'method', 'whatsapp_keyword', 'keyword', 'start',
                       'text_version', v_version, 'message_id', p_message_id));
  return jsonb_build_object('changed', true, 'consent_id', v_id);
end $$;
revoke execute on function inbound_whatsapp_consent(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function inbound_whatsapp_consent(uuid, boolean, uuid) to service_role;

-- 3. EDIT on WhatsApp ----------------------------------------------------------------------------------
create or replace function sms_request_filed_correction(
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
  if m.id is null or m.direction <> 'in' or m.channel not in ('sms', 'whatsapp') then
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
                             'channel', m.channel, 'message_id', p_message_id, 'job_id', v_job,
                             'after_filing', true, 'version', r.current_version));
  return jsonb_build_object('id', c.id, 'status', 'listening', 'jobId', v_job);
end $$;

-- 4. field_answer_question() with the answer's channel --------------------------------------------------
drop function field_answer_question(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb);

create function field_answer_question(
  p_report_id uuid, p_question_id uuid, p_reporter_id uuid,
  p_base jsonb, p_data jsonb, p_answer jsonb, p_answer_source jsonb,
  p_new_company jsonb default null,
  p_channel field_channel default 'web',
  p_message_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  q questions%rowtype;
  c companies%rowtype;
  m messages%rowtype;
  v_current jsonb;
  v_data jsonb := p_data;
  v_job bigint;
  v_name text;
  v_index int;
begin
  if p_channel not in ('web', 'whatsapp') then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if p_channel = 'whatsapp' then
    -- W2-16 (§19 Q26): the reporter's own inbound WhatsApp message.
    select * into m from messages where id = p_message_id;
    if m.id is null or m.direction <> 'in' or m.channel is distinct from 'whatsapp'
       or m.phone_e164 is distinct from (select phone_e164 from reporters where id = p_reporter_id) then
      raise exception 'message_not_found' using errcode = 'P0002';
    end if;
  end if;
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object' or p_data ->> 'schemaVersion' is distinct from '2' then
    raise exception 'invalid_answer_data' using errcode = 'P0001';
  end if;
  -- field_complete_upload()'s and field_confirm_report()'s lock: a voice note, a photo on the
  -- draft or a confirm waits for this answer, or this answer for them.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  select * into q from questions where id = p_question_id and report_id = r.id for update;
  if q.id is null then
    raise exception 'question_not_found' using errcode = 'P0002';
  end if;
  if q.answered_at is not null then
    -- A retry of the same answer (a lost response) gets what the first call did.
    if q.answer = p_answer then
      return jsonb_build_object('status', 'already_answered', 'reportStatus', r.status, 'jobId', null);
    end if;
    raise exception 'question_closed' using errcode = 'P0001';
  end if;
  if q.channel is distinct from 'web' then
    raise exception 'question_closed' using errcode = 'P0001';
  end if;
  if r.status <> 'awaiting_answer' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select data into v_current from report_versions
  where report_id = r.id and version = r.current_version for update;
  if v_current is null or v_current is distinct from p_base then
    raise exception 'draft_changed' using errcode = 'P0001';
  end if;

  -- "Add <company>" (F7): the name the reporter confirmed becomes an unconfirmed company of the
  -- org (or the one of that name already there), the crew points at it, and the office reviews it.
  if p_new_company is not null then
    v_name := btrim(p_new_company ->> 'name');
    v_index := (p_new_company ->> 'manpowerIndex')::int;
    if coalesce(v_name, '') = '' or v_index is null
       or jsonb_typeof(v_data -> 'manpower' -> v_index) is distinct from 'object' then
      raise exception 'invalid_answer_data' using errcode = 'P0001';
    end if;
    select * into c from companies where org_id = r.org_id and lower(name) = lower(v_name) limit 1;
    if c.id is null then
      insert into companies (org_id, name, status) values (r.org_id, v_name, 'unconfirmed')
      returning * into c;
      perform log_audit(r.org_id, 'reporter', p_reporter_id, 'company.added_unconfirmed', 'company',
        c.id, jsonb_build_object('report_id', r.id, 'question_id', q.id));
    end if;
    v_data := jsonb_set(v_data, array['manpower', v_index::text, 'companyId'], to_jsonb(c.id::text));
    v_data := jsonb_set(v_data, array['manpower', v_index::text, 'companyName'], to_jsonb(c.name));
    update reports set needs_review = true,
      review_reasons = array(select distinct x from unnest(review_reasons || ('unknown_company:' || c.name)) x)
    where id = r.id;
  end if;

  update report_versions set data = v_data, summary = nullif(v_data ->> 'summary', '')
  where report_id = r.id and version = r.current_version;
  update questions set answer = p_answer, answer_source = p_answer_source, answered_at = now(),
                       answered_message_id = coalesce(p_message_id, answered_message_id)
  where id = q.id;
  update reports set status = 'processing' where id = r.id;
  v_job := enqueue_job('decide_next', jsonb_build_object('reportId', r.id), null,
                       'decide:' || r.id || ':answer:' || q.id);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.question_answered', 'report', r.id,
    jsonb_build_object('question_id', q.id, 'field', q.field, 'channel', p_channel,
                       'option_id', p_answer -> 'optionId', 'company_id', c.id, 'job_id', v_job,
                       'message_id', p_message_id));
  return jsonb_build_object('status', 'processing', 'reportStatus', 'processing', 'jobId', v_job);
end $$;

revoke execute on function field_answer_question(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, field_channel, uuid)
  from public, anon, authenticated;
grant execute on function field_answer_question(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, field_channel, uuid)
  to service_role;

-- 5. Queue: whatsapp_answer under the phone's lock, with the report steps ---------------------------------
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
    -- W1-08: one phone's inbound texts one at a time, oldest first; W2-12: their keywords too;
    -- W2-16: its WhatsApp messages and their answers.
    when p_type in ('sms_inbound', 'sms_keyword', 'whatsapp_answer')
         and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
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
                    'parse_answer', 'transcribe_test_clip', 'apply_correction',
                    'whatsapp_answer') then 1
    -- Transcription and extraction.
    when p_type in ('transcribe_audio', 'extract_report', 'transcribe_upload',
                    'post_call_reconcile') then 2
    -- Background: weather, evidence packs, digests, retention and anything else.
    when p_type in ('fetch_weather', 'build_evidence_pack') then 3
    else 3
  end;
$$;
