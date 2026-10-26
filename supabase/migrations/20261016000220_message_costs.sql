-- SiteLog · a per-channel messaging cost in a report's cost (W2-15; spec §15 cost guardrail,
-- GAP D45 amended by D49 (5))
--
-- D49 (5): COST_WA_TEMPLATE_USD prices v1.0 Meta templates and goes with step 22; a per-channel
-- messaging cost returns with the Twilio WhatsApp driver. report_cost_inputs() gains two counts of
-- the Notifier's messages about the report (`messages.payload.report_id`, written by the Notifier
-- since W2-15 for the report's texts: question_ready, draft_ready and its nudge, filed,
-- edit_applied), each one that a provider took (sent, delivered, read; never `console`):
--   sms_messages        texts (COST_SMS_USD each in the worker);
--   whatsapp_templates  business-initiated WhatsApp templates (`payload.whatsapp_mode
--                       'template'`; COST_WHATSAPP_TEMPLATE_USD each). A free-form message inside
--                       the 24-hour window is a service message and is not counted.
-- Push costs nothing. The v1.0 columns stay first and unchanged, so the deployed worker's
-- `select ai_usd, job_count, wa_templates` still reads them; a new return type needs drop and
-- create (one transaction, so no caller sees it missing).

set local lock_timeout = '5s';

create index messages_out_report_id on messages ((payload ->> 'report_id'))
  where direction = 'out' and payload ? 'report_id';

drop function report_cost_inputs(uuid);

create function report_cost_inputs(p_report_id uuid)
returns table (ai_usd numeric, job_count int, wa_templates int,
               sms_messages int, whatsapp_templates int)
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
  ),
  notifier as (
    select m.channel, m.payload ->> 'whatsapp_mode' as mode
    from messages m
    where m.direction = 'out' and m.payload ? 'report_id'
      and m.payload ->> 'report_id' = p_report_id::text
      and m.provider is distinct from 'console'
      and m.status in ('sent', 'delivered', 'read')
  )
  select coalesce((select sum(usd) from costs), 0)::numeric,
         (select count(*) from costs)::int,
         (select count(*) from templates)::int,
         (select count(*) from notifier where channel = 'sms')::int,
         (select count(*) from notifier where channel = 'whatsapp' and mode = 'template')::int;
$$;
revoke execute on function report_cost_inputs(uuid) from public, anon, authenticated;
