-- SiteLog · the real message channel orders (W2-16; spec §4.6, §19 Q19, Q84, Q107)
--
-- Spec §19 Q19 (decided 2026-10-15): from M6 the US pack orders SMS first and then WhatsApp (US site
-- staff expect texts), the TR pack WhatsApp first and then SMS (TR SMS is one-way, so WhatsApp gives
-- TR reporters replies). §19 Q107 (built in W2-14) keeps web push first in both: it reaches only a
-- reporter who turned *Notifications* on, and the table refuses an order that ends with push.
--
--   US {push, sms, whatsapp}    TR {push, whatsapp, sms}
--
-- Shipped after W2-15's §19 Q84 rule (decided 2026-10-16, 20261016000210 and the Notifier): a
-- database with no WhatsApp sender for a pack takes WhatsApp out of a real org's order before any
-- attempt, so SMS carries the message, and nobody on an environment without a WhatsApp sender is
-- silenced. WhatsApp reaches only a reporter who ticked *Message me on WhatsApp* (§19 Q25), so
-- everyone else's messages are unchanged. A policy value, set here for every environment (§4.6).

set local lock_timeout = '5s';

update countries set message_channels = '{push,sms,whatsapp}' where code = 'US';
update countries set message_channels = '{push,whatsapp,sms}' where code = 'TR';
