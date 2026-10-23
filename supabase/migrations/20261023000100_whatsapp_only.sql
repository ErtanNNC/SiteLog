-- TalkOlog · SMS passive in every country pack: web push and WhatsApp only (spec §19 Q374, decided
-- by the owner 2026-10-23)
--
-- Until the SMS senders are registered (US 10DLC / toll-free verification; the TR `TALKOLOG` title),
-- texts reach no one reliably: Turkish carriers drop link-bearing texts from the US long code and
-- US SMS waits for its registration. Since §19 Q372 every key may go by WhatsApp through Twilio
-- (`WHATSAPP_KEYS`: the welcome and the device code by their approved templates), so the owner
-- takes SMS out of every pack's order:
--
--   US {push, whatsapp}    TR {push, whatsapp}    (both {push, whatsapp, sms} before)
--
-- The pack's `message_channels` is the Notifier's allow-list (§4.5, §19 Q21): with no `sms` in it
-- nothing is sent by SMS, not even the device code (the SMS fallback of `CONSENT_FREE_KEYS` goes
-- with this migration, §19 Q374), and a message WhatsApp cannot carry (no sender here, no approved
-- template in the reporter's language, a late failure) is undeliverable like any other: nothing
-- deliverable is audited and the office is told, as for every channel. A reporter's stored `sms`
-- preference is ignored while the pack does not list it (§19 Q21). SMS stays built: its drivers,
-- sms-webhook (inbound texts, STOP still honoured, START, HELP), the copy and the consents.
-- Back to SMS is a forward migration of this one column, per pack, once its sender is registered.
--
-- Every row, not only US and TR: no pack sends texts until the owner says so. The table's checks
-- hold (`sms_links_allowed or` a WhatsApp/push channel; push never last). A policy value, set
-- here for every environment (§4.6).
--
-- Live database: one update on a two-row table.

set local lock_timeout = '5s';

-- Guard first: a pack that lists SMS but not WhatsApp (none today) would be left with push only or
-- nothing, which the table refuses; say which pack instead. Every launch pack lists WhatsApp.
do $$
declare v_bad text;
begin
  select string_agg(code, ', ' order by code) into v_bad
  from countries
  where 'sms' = any (message_channels) and not ('whatsapp' = any (message_channels));
  if v_bad is not null then
    raise exception 'packs with SMS and no WhatsApp: %', v_bad;
  end if;
end $$;

update countries
   set message_channels = array_remove(message_channels, 'sms'::message_channel)
 where 'sms' = any (message_channels);
