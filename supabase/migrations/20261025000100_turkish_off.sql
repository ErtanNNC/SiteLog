-- TalkOlog · Turkish off: English everywhere (spec §19 Q378, decided by the owner 2026-10-25)
--
-- The owner turns Turkish off in every surface: the panel, the field app, the messages, the voice
-- assistant, the report PDF and the emails. Turkish stays built (copy, prompts, PDF labels, voices,
-- templates): turning it back on is a forward migration that puts the TR pack's locales back, plus
-- a panel and field build with `VITE_TURKISH=true`.
--
-- Everything that picks a language reads it from these rows, so this migration is the switch for
-- the server side (the Notifier, WhatsApp templates, the voice agent, the worker's reports and
-- emails, Auth emails by `ui_locale`):
--
--   1. The TR pack: `default_locale` en-US (a new TR org reports in English), `field_locales`
--      without tr-TR (Team, the wizard and the field app offer English only). The rest of the pack
--      (TRY, metric, A4, Europe/Istanbul, WhatsApp, its numbers and templates) is unchanged.
--   2. Orgs reporting in Turkish report in English: new report versions take the org locale; a filed
--      version keeps its own language (versions are immutable).
--   3. Office users who chose Turkish: `ui_locale` back to null (the org's locale, now English).
--   4. Reporters with Turkish: en-US, so their messages, calls and field app are in English.
--
-- Audit: org and member changes are logged by their triggers; reporters get one row per org here.
-- Live database: a handful of rows.

set local lock_timeout = '5s';

update countries
   set default_locale = 'en-US',
       field_locales = case
         when 'en-US' = any (array_remove(field_locales, 'tr-TR')) then array_remove(field_locales, 'tr-TR')
         else array['en-US'] || array_remove(field_locales, 'tr-TR')
       end
 where default_locale = 'tr-TR' or 'tr-TR' = any (field_locales);

update orgs set locale = 'en-US' where locale = 'tr-TR';

update org_members set ui_locale = null where ui_locale = 'tr-TR';

with changed as (
  update reporters set locale = 'en-US' where locale = 'tr-TR'
  returning org_id, id
)
insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id, diff)
select org_id, 'system', null, 'reporter.locale_set', 'org', org_id,
       jsonb_build_object('from', 'tr-TR', 'to', 'en-US', 'reporters', count(*),
                          'reason', 'turkish_off')
from changed
group by org_id;
