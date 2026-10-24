-- SiteLog · İletimerkezi delivery status (W4-11; spec §4.5, §19 Q237's recommended first option,
-- README "İletimerkezi status")
--
-- İletimerkezi has no delivery callback wired, so its `messages` rows stayed `sent`: a TR text that
-- never arrived never fell back to the person's next channel nor told the office. The worker's
-- `sms_status` job now reads the order's delivery report +2 min, +15 min and +2 h after the send
-- (apps/worker/src/jobs/sms_status.ts, `SMS_STATUS_POLL_OFFSETS_MS`), and moves the row through
-- the §4.5 statuses as sms-webhook's `/status` does for Twilio (`applyLateStatus`).
--
--   1. enqueue_sms_status_poll(): an outbound İletimerkezi row that becomes `sent` (the Notifier
--      writes it `queued`, then `sent` with the order id, from the worker or an edge function)
--      queues the first poll, at the database's now() + 2 minutes, under the job key
--      `sms_status:<message id>:1` (`jobKeys.smsStatus`), with `sentAt` (now(), UTC) for the
--      later polls. One trigger for every writer, in the same transaction as the row: no send
--      path can forget it, and a row written `sent` again queues nothing more (the key is taken,
--      D16). The worker's ILETIMERKEZI_STATUS=off makes the job do nothing.
--   2. The trigger on messages, for inserts and status updates.
--
-- `sms_status` is a background job: job_priority() gives it the default (3), unchanged.
--
-- Live database (staging): one function and one trigger, no table change; no existing row is
-- written. The TR pack has no sender id on any database yet (W4-13), so no row matches today.

-- 1. The first poll -----------------------------------------------------------------------------
create or replace function enqueue_sms_status_poll() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'out' and new.provider = 'iletimerkezi' and new.status = 'sent'
     and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    perform enqueue_job(
      'sms_status',
      jsonb_build_object(
        'messageId', new.id,
        'poll', 1,
        'sentAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      now() + interval '2 minutes',
      'sms_status:' || new.id::text || ':1');
  end if;
  return new;
end $$;

revoke execute on function enqueue_sms_status_poll() from public, anon, authenticated;

-- 2. The trigger --------------------------------------------------------------------------------
create trigger messages_sms_status_poll
  after insert or update of status on messages
  for each row execute function enqueue_sms_status_poll();
