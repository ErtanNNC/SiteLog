-- SiteLog · render_pdf runs one at a time per report (review of 20261015000010)
--
-- 20261015000010 re-renders the stored PDF on sign-off and on undo. Both jobs overwrite the same
-- file (`pdfs/{org}/{site}/{report_no}_v{n}.pdf`) and read the sign-off as they run, but
-- render_pdf had no lock key, so a sign-off followed by a quick Undo could run two renders at
-- once and the slower one could store the wrong sign-off state. job_lock_key() now gives
-- render_pdf the report's key (`report:<id>`, or the reporter's `convo:<id>` for a WhatsApp
-- report, as for the other report jobs), so claim_jobs() runs them in order and the last one
-- reads the final state. The body is 20261014000008's with `render_pdf` added to the report
-- branch.
--
-- Live database: one function body replaced (create or replace keeps its grants and the revokes
-- of 20261012000004 and 20261014000001); render_pdf jobs already queued keep a null key.

set local lock_timeout = '5s';

create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  with report as (
    select case
      when p_type in ('extract_report', 'decide_next', 'file_report', 'render_pdf')
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
