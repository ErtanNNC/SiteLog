-- SiteLog · the starter glossary of a new org (§19 Q238's recommended default, W4-08; spec §16
-- "glossary seeds", §16.2 M11 "TR glossary seeds", F21, §18.3)
--
-- A new org starts with SiteLog's short built-in glossary in its report language (§9.6:
-- org_report_language(), tr-TR → Turkish, otherwise English), as `built_in` rows of the org:
-- they count as confirmed for the extraction prompt and the speech-recognition key terms
-- (buildKeyterms: voice notes and get_context), and the office changes or rejects them on the
-- glossary page through review_glossary_term() (audited, unchanged).
--
--   1. starter_glossary_terms(language): the lists, the same rows as
--      packages/shared/src/glossary/starter.{en,tr}.ts (supabase/db-tests/src/starter-glossary.test.ts
--      holds them equal). A changed list is a new migration replacing this function.
--   2. seed_starter_glossary(org): adds the org's starter terms it has no row for yet (the same
--      kind and heard phrase in any case, at any scope and status: a term the office rejected or
--      changed is never put back), org-wide, `built_in`, never heard; audited
--      `glossary.starter_seeded` when it adds any. Returns the number added; a second run adds
--      none. Service role only (and on_org_created).
--   3. on_org_created(): also seeds the starter glossary. Everything else as
--      20261014000004_country_packs.sql wrote it (the pack's paper, the self-perform company).
--
-- Orgs that exist already are not seeded here: the live database's orgs are the owner's, and a
-- backfill (`select seed_starter_glossary(id) from orgs where not is_demo`) is the owner's call.
--
-- Live database (staging): two new functions and the trigger function replaced in place (same
-- signature). No table change; no existing row is written.

-- 1. The lists ------------------------------------------------------------------------------------
create or replace function starter_glossary_terms(p_language text)
returns table (heard text, official text, kind term_kind)
language sql immutable set search_path = public as $$
  select s.heard, s.official, s.kind::term_kind
  from (values
    ('en', 'the deck', 'Elevated concrete slab', 'term'),
    ('en', 'the iron', 'Reinforcing steel (rebar)', 'term'),
    ('en', 'forms', 'Concrete formwork', 'term'),
    ('en', 'stripped forms', 'Formwork stripped', 'term'),
    ('en', 'pump truck', 'Concrete pump truck', 'term'),
    ('en', 'ready-mix', 'Ready-mix concrete', 'term'),
    ('en', 'block', 'Concrete masonry units (CMU)', 'term'),
    ('en', 'topped out', 'Structural frame complete to roof level', 'term'),
    ('en', 'drywall', 'Gypsum board (drywall)', 'term'),
    ('en', 'mud', 'Joint compound', 'term'),
    ('en', 'rough-in', 'MEP rough-in', 'term'),
    ('en', 'MEP', 'Mechanical, electrical and plumbing (MEP)', 'term'),
    ('en', 'punch', 'Punch list items', 'term'),
    ('en', 'man lift', 'Aerial work platform', 'term'),
    ('en', 'scissor lift', 'Aerial work platform (scissor lift)', 'term'),
    ('en', 'toolbox talk', 'Toolbox safety talk', 'term'),
    ('en', 'tailgate meeting', 'Toolbox safety talk', 'term'),
    ('en', 'PPE', 'Personal protective equipment (PPE)', 'term'),
    ('en', 'near miss', 'Near-miss incident', 'term'),
    ('en', 'first aid', 'First-aid case', 'term'),
    ('en', 'green tag', 'Inspection passed (green tag)', 'term'),
    ('en', 'red tag', 'Inspection failed (red tag)', 'term'),
    ('en', 'stood down', 'Work stoppage', 'term'),
    ('en', 'rained out', 'Work stoppage (rain)', 'term'),
    ('en', 'the GC', 'General contractor', 'term'),
    ('en', 'subs', 'Subcontractors', 'term'),
    ('en', 'OT', 'Overtime', 'term'),
    ('en', 'RFI', 'Request for information (RFI)', 'term'),
    ('en', 'yards', 'Cubic yards (yd³)', 'unit'),
    ('tr', 'döküm', 'Beton dökümü', 'term'),
    ('tr', 'grobeton', 'Grobeton (zayıf beton)', 'term'),
    ('tr', 'kür', 'Beton kürü', 'term'),
    ('tr', 'vibre', 'Beton vibrasyonu', 'term'),
    ('tr', 'pompa', 'Beton pompası', 'term'),
    ('tr', 'mikser', 'Transmikser', 'term'),
    ('tr', 'paspayı', 'Beton paspayı', 'term'),
    ('tr', 'filiz', 'Filiz donatısı', 'term'),
    ('tr', 'demir işleri', 'Donatı işleri', 'term'),
    ('tr', 'perde', 'Betonarme perde duvar', 'term'),
    ('tr', 'hafriyat', 'Hafriyat (kazı) işleri', 'term'),
    ('tr', 'dolgu', 'Dolgu işleri', 'term'),
    ('tr', 'beko', 'Kazıcı yükleyici (beko loder)', 'term'),
    ('tr', 'şap', 'Şap uygulaması', 'term'),
    ('tr', 'sıva', 'Sıva işleri', 'term'),
    ('tr', 'alçı', 'Alçı sıva', 'term'),
    ('tr', 'fayans', 'Fayans kaplama', 'term'),
    ('tr', 'izolasyon', 'Yalıtım işleri', 'term'),
    ('tr', 'mantolama', 'Dış cephe ısı yalıtımı (mantolama)', 'term'),
    ('tr', 'TBM', 'İş güvenliği bilgilendirmesi', 'term'),
    ('tr', 'tool box', 'İş güvenliği bilgilendirmesi', 'term'),
    ('tr', 'İSG', 'İş sağlığı ve güvenliği', 'term'),
    ('tr', 'KKD', 'Kişisel koruyucu donanım', 'term'),
    ('tr', 'ramak kala', 'Ramak kala olay', 'term'),
    ('tr', 'taşeron', 'Alt yüklenici', 'term'),
    ('tr', 'puantaj', 'Puantaj (personel devam kaydı)', 'term'),
    ('tr', 'fazla mesai', 'Fazla mesai', 'term'),
    ('tr', 'küp', 'm³', 'unit'),
    ('tr', 'metreküp', 'm³', 'unit')
  ) as s(language, heard, official, kind)
  where s.language = p_language;
$$;

revoke execute on function starter_glossary_terms(text) from public, anon, authenticated;
grant execute on function starter_glossary_terms(text) to service_role;

-- 2. seed_starter_glossary(org) -------------------------------------------------------------------
create or replace function seed_starter_glossary(p_org_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_language text;
  v_added int;
begin
  if not exists (select 1 from orgs where id = p_org_id) then
    raise exception 'org not found' using errcode = '22023';
  end if;
  v_language := org_report_language(p_org_id);
  insert into glossary_terms (org_id, heard, official, language, kind, status, times_heard, last_seen_at)
  select p_org_id, s.heard, s.official, v_language, s.kind, 'built_in', 0, null
  from starter_glossary_terms(v_language) s
  where not exists (
    select 1 from glossary_terms g
    where g.org_id = p_org_id and g.kind = s.kind and lower(g.heard) = lower(s.heard)
  );
  get diagnostics v_added = row_count;
  if v_added > 0 then
    perform log_audit(p_org_id, 'system', null, 'glossary.starter_seeded', 'org', p_org_id,
      jsonb_build_object('language', v_language, 'added', v_added));
  end if;
  return v_added;
end $$;

revoke execute on function seed_starter_glossary(uuid) from public, anon, authenticated;
grant execute on function seed_starter_glossary(uuid) to service_role;

-- 3. New orgs get their pack's paper and the starter glossary --------------------------------------
create or replace function on_org_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into org_settings (org_id, pdf_paper)
  values (new.id, coalesce((select paper from countries where code = new.country), 'letter'))
  on conflict do nothing;
  insert into companies (org_id, name, trade, is_self_perform)
  values (new.id, new.name || ' self-perform', 'General labor', true)
  on conflict do nothing;
  perform seed_starter_glossary(new.id);
  return new;
end $$;
