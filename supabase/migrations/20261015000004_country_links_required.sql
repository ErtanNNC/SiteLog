-- SiteLog · every country pack allows links in SMS for now (spec §19 Q24, decided by the owner
-- 2026-10-15)
--
-- On a pack with `sms_links_allowed = false` the `welcome` (it carries the personal link) has no
-- channel: under Q25 it goes by SMS only, WhatsApp needs an opt-in made through that link, and push
-- needs the installed app, reached the same way, so nobody on such a pack could be onboarded.
-- Such packs are forbidden until a link-free welcome or a WhatsApp template welcome exists; the
-- Notifier's handling of a pack without links stays (it is the rule when one is allowed again).
-- No launch pack forbids links, so every row already passes.
--
-- Forward-only and CLI-safe: one check constraint; the 20261014000004 check stays (it is what
-- applies again once this one is dropped). Spec §6.3 has both.

alter table countries add constraint countries_sms_links_required check (sms_links_allowed);
