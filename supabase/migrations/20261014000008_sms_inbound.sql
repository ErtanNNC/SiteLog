-- SiteLog · inbound Twilio texts as worker jobs (W1-08 review; spec §9.5, §10.1)
--
-- sms-webhook stores an inbound Twilio text and enqueues `sms_inbound(messageId)` for the worker,
-- which runs the §9.5 keywords (STOP, START, HELP, CALL, TEXT), the F13 unknown-contact path and
-- the one reply. Handling then survives whatever Twilio's webhook retry policy does (its default
-- `rp=ct` retries only connection and TLS failures, never a 5xx).
--
--   1. job_priority(): a STOP must not wait behind transcriptions and evidence packs, so the job
--      joins the messages to and from the reporter at rank 0, like inbound_message and
--      send_welcome. Every existing name keeps its rank.
--   2. job_lock_key(): an `sms:<phone>` key for `sms_inbound`, so claim_jobs() runs one phone's
--      texts one at a time, oldest first (a queued STOP and START from one number, or two quick
--      STOPs, each read the reporter rows the one before wrote). A job waiting on a retry backoff
--      lets the next due one of its key run. The body is 20261014000001's plus that branch.
--   3. receive_sms_inbound(): the webhook's store, its `sms.received` audit and the job in one
--      transaction, so a stored text always has its job (before, a failed enqueue left a text no
--      one would pick up unless Twilio retried a 5xx). A redelivery of a text not yet handled
--      enqueues it again under the same dedupe key; a handled one enqueues nothing. Console rows
--      (the Demo phone, handled inline) are stored and audited with no job. Service role only.
--
-- Live database: two function bodies replaced (create or replace keeps their grants and the
-- revokes of 20261012000004 and 20261014000001) and one new function; no table changes, no rows
-- rewritten.

set local lock_timeout = '5s';

-- 1. Priorities (lower first) ---------------------------------------------------------------------
create or replace function job_priority(p_type text) returns int
language sql immutable set search_path = public as $$
  select case
    -- Messages and calls to and from the reporter.
    when p_type in ('inbound_message', 'sms_inbound', 'send_message', 'send_template',
                    'send_welcome', 'send_sms', 'notify', 'place_call') then 0
    -- The next step of a report someone is waiting for, its PDF and its email.
    when p_type in ('parse_reply', 'decide_next', 'file_report', 'render_pdf', 'send_email') then 1
    -- Transcription and extraction.
    when p_type in ('transcribe_audio', 'extract_report', 'transcribe_upload',
                    'post_call_reconcile') then 2
    -- Background: weather, evidence packs, digests, retention and anything else.
    when p_type in ('fetch_weather', 'build_evidence_pack') then 3
    else 3
  end;
$$;

-- 2. Lock key: one job at a time per report, per conversation and per texting phone ---------------
create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  with report as (
    select case
      when p_type in ('extract_report', 'decide_next', 'file_report')
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

-- 3. Store, audit and enqueue an inbound text in one transaction -----------------------------------
create or replace function receive_sms_inbound(
  p_id uuid, p_org_id uuid, p_reporter_id uuid, p_phone_e164 text, p_provider text,
  p_provider_message_id text, p_body text, p_payload jsonb
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
    raise exception 'receive_sms_inbound: unknown provider %', p_provider using errcode = '22023';
  end if;
  insert into messages (id, org_id, reporter_id, phone_e164, channel, direction, provider,
                        provider_message_id, body, status, payload)
  values (p_id, p_org_id, p_reporter_id, p_phone_e164, 'sms', 'in', p_provider,
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
      'sms.received', 'message', v_id,
      jsonb_build_object('provider', p_provider, 'keyword', p_payload -> 'keyword',
                         'pack', p_payload -> 'pack'));
  end if;

  if p_provider = 'twilio' and not v_handled then
    begin
      v_job := enqueue_job('sms_inbound', jsonb_build_object('messageId', v_id), null, v_key);
    exception when unique_violation then
      -- A redelivery enqueued it at the same moment: one job.
      select id into v_job from jobs where dedupe_key = v_key and status in ('queued', 'running')
        limit 1;
    end;
  end if;

  return jsonb_build_object('id', v_id, 'duplicate', v_duplicate, 'handled', v_handled,
                            'jobId', v_job);
end $$;

revoke execute on function receive_sms_inbound(uuid, uuid, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function receive_sms_inbound(uuid, uuid, uuid, text, text, text, text, jsonb)
  to service_role;
