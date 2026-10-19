-- TalkOlog · one sender for every pack (spec §19 Q370, decided by the owner 2026-10-19)
--
-- The owner runs one Twilio number for SMS and WhatsApp in every country. Until now a sender id
-- belonged to one pack (20261014000007, 20261016000210): sms-webhook found the pack of an
-- inbound text by the number that received it. Now:
--
--   1. The two unique indexes go; a sender may serve several packs. Plain indexes keep the
--      lookup. sms-webhook chooses among the packs of a shared sender (`chooseInboundPack`):
--      the pack of the last text sent to that phone from this channel in 30 days, else the one
--      pack of the phone's reporters, else the phone's own country, else the sender's.
--   2. An opt-out is the number's, not the pack's: a carrier's STOP binds the sender. A row of
--      sms_opt_outs (STOP, or Twilio 21610) is copied to every pack sharing that pack's SMS
--      sender, and START (a delete) clears it on all of them. One trigger covers every writer
--      (the worker, the edge functions); readers keep asking per pack.
--   3. The TR pack sends its texts through Twilio from a long code (§19 Q20 revisited: until the
--      İletimerkezi title is approved). It stays one-way (`two_way_sms` false: the Turkish texts
--      ask for no reply); STOP still works. Its sender is cleared with the type change, as
--      RUNBOOK "Country packs per environment" says; set it again with `pnpm countries:set`.
--      Back to İletimerkezi is a forward migration of the same three columns.
--
-- Live database: two index swaps on a two-row table, one trigger on a small table, one row
-- update. No row of another table changes.

set local lock_timeout = '5s';

-- 1. Shared senders ----------------------------------------------------------------------------------
drop index countries_sms_sender_id_key;
drop index countries_whatsapp_sender_id_key;
create index countries_sms_sender_id_idx on countries (sms_sender_id) where sms_sender_id is not null;
create index countries_whatsapp_sender_id_idx on countries (whatsapp_sender_id)
  where whatsapp_sender_id is not null;

-- 2. An opt-out binds every pack of the sender ---------------------------------------------------------
create function sms_opt_outs_share() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The copies' own trigger runs find nothing new (on conflict, or rows already gone).
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'INSERT' then
    insert into sms_opt_outs (phone_e164, country, method, opted_out_at)
    select new.phone_e164, other.code, new.method, new.opted_out_at
      from countries own
      join countries other on other.sms_sender_id = own.sms_sender_id and other.code <> own.code
     where own.code = new.country and own.sms_sender_id is not null
    on conflict (phone_e164, country) do nothing;
  else
    delete from sms_opt_outs o
     using countries own, countries other
     where own.code = old.country and own.sms_sender_id is not null
       and other.sms_sender_id = own.sms_sender_id and other.code <> own.code
       and o.phone_e164 = old.phone_e164 and o.country = other.code;
  end if;
  return null;
end $$;
revoke execute on function sms_opt_outs_share() from public, anon, authenticated;

create trigger sms_opt_outs_share
  after insert or delete on sms_opt_outs
  for each row execute function sms_opt_outs_share();

-- 3. TR texts through Twilio -----------------------------------------------------------------------
update countries
   set sms_provider = 'twilio', sms_sender_type = 'long_code', sms_sender_id = null
 where code = 'TR';
