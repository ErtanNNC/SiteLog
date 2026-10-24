-- TalkOlog · WhatsApp before SMS on the US pack (spec §19 Q372, decided by the owner 2026-10-20)
--
-- Until the SMS senders are registered, WhatsApp through Twilio carries the messages: Turkish
-- carriers silently drop link-bearing texts from the US long code (Twilio says `sent`, never
-- `delivered`), and US SMS waits for its 10DLC / toll-free registration. One Twilio WhatsApp
-- number works in every country, and since §19 Q372 the welcome and the device code may go by
-- WhatsApp too (`WHATSAPP_KEYS`, a template each), so the US pack now orders WhatsApp before SMS,
-- as the TR pack already does (20261016000250):
--
--   US {push, whatsapp, sms}    TR {push, whatsapp, sms} (unchanged)
--
-- Nobody is silenced: the Notifier takes WhatsApp out of a real org's order where the pack has no
-- WhatsApp sender in that database (§19 Q84), and a key with no approved template in the reporter's
-- language goes by SMS (§19 Q22, the channel is not reachable for it). A reporter's own preference
-- (Settings, `reporters.message_channel`) still goes first. A policy value, set here for every
-- environment (§4.6); back to SMS first is a forward migration of this one column.
--
-- Live database: one row update on a two-row table.

set local lock_timeout = '5s';

update countries set message_channels = '{push,whatsapp,sms}' where code = 'US';
