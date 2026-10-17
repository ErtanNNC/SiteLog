-- SiteLog · message channel columns (W1-06a, GAP step 12a; GAP D48, D49)
--
--   1. reporters.message_channel: the person's preferred message channel; null = the country
--      pack's order (spec §4.5). The Notifier tries it first when the pack offers it. Not granted
--      to authenticated (the reporters column lockdown of 20261013000007 grants status and
--      invited_at only): field-api and update_reporter() write it from week 2.
--   2. messages.channel: the channel a message went out or came in on. Null = a v1.0 Meta
--      WhatsApp row or an office photo row (the D13 convention); every v1.2 writer sets it, and it
--      becomes NOT NULL at step 23 after the legacy rows are archived (D49). The backfill marks
--      the SMS rows (a phone number and no WhatsApp conversation) of a database seeded before this
--      file: none on staging, whose rows are all v1.0 Meta WhatsApp; the W1-06 demo texts on a
--      preview project or a local stack upgraded with migration up. A fresh db reset seeds after
--      it, and seed.sql sets channel itself.
--
-- Live database: two nullable columns (no table rewrite) and an update that matches no staging
-- row. The v1.0 worker keeps inserting messages without a channel (= Meta), which readers treat
-- as WhatsApp, never as SMS. Locks: each ALTER holds its lock until the file commits.

set local lock_timeout = '5s';

alter table reporters add column message_channel message_channel;

alter table messages add column channel message_channel;
update messages set channel = 'sms' where conversation_id is null and phone_e164 is not null;
