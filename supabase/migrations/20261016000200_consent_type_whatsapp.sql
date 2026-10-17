-- SiteLog · the WhatsApp consent label (W2-15; spec §4.5, §6.2, §19 Q25, Q40)
--
-- Spec §19 Q25 (decided 2026-10-15, the first option): WhatsApp only after an explicit opt-in on
-- the recorder's Welcome screen (Field-02) or in Settings, stored as a consent of its own type
-- (`method 'web_checkbox'`). Spec §19 Q40 (the first option): a WhatsApp opt-out (unticking it,
-- or STOP sent on WhatsApp, W2-16) is that consent revoked; `reporters.status 'opted_out'` stays
-- SMS-only.
--
-- Alone in its file: `ALTER TYPE … ADD VALUE` may run inside the CLI's per-file transaction, but
-- the label cannot be used before that transaction commits (see 20261013000006_enums_v1_2.sql).
-- 20261016000210_whatsapp_sender.sql uses it. Keep in sync with packages/shared/src/enums.ts.

alter type consent_type add value if not exists 'whatsapp';
