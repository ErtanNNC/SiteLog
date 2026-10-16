-- SiteLog · the WhatsApp field channel label (W2-16; spec §6.2, §9.5, §19 Q26)
--
-- Spec §19 Q26 (decided 2026-10-15): keywords and answers over WhatsApp, no voice notes. An answer
-- given on WhatsApp, an inbound WhatsApp message's unknown contact and a WhatsApp keyword name the
-- channel they came by: `field_channel 'whatsapp'` (permanent; labels cannot be dropped).
--
-- Alone in its file: `ALTER TYPE … ADD VALUE` may run inside the CLI's per-file transaction, but
-- the label cannot be used before that transaction commits (see 20261013000006_enums_v1_2.sql).
-- 20261016000240_whatsapp_inbound.sql uses it. Keep in sync with packages/shared/src/enums.ts.

alter type field_channel add value if not exists 'whatsapp';
