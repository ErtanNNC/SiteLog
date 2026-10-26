-- SiteLog · the web push consent label (W2-14; spec §4.5, §6.2, §19 Q27)
--
-- Spec §19 Q27 (decided 2026-10-15): push needs a consent row of its own type, given when the
-- reporter turns notifications on in the field app's Settings (`method 'web_checkbox'`) and
-- revoked when they turn them off (the per-channel opt-out of §19 Q40, the first option).
--
-- Alone in its file: `ALTER TYPE … ADD VALUE` may run inside the CLI's per-file transaction, but
-- the label cannot be used before that transaction commits (see 20261013000006_enums_v1_2.sql).
-- 20261016000180_push_subscriptions.sql uses it. Keep in sync with packages/shared/src/enums.ts.

alter type consent_type add value if not exists 'push';
