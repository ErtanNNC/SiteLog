-- SiteLog · Settings on v1.2: the Field channels tab, the report language and units (W4-05;
-- spec F22, P12, §6.3, §19 Q231, Q232, Q233)
--
--   1. org_settings.default_contact_pref (contact_pref, default 'link'): the preference a new
--      reporter starts with in Setup and Invite (§19 Q231). Admin-editable like every Settings
--      column (the column grant below), audited by the existing `settings.updated` trigger.
--   2. org_settings.daily_link_ttl_hours (1–168, null = the environment's DAILY_LINK_TTL_HOURS):
--      how long a new daily link lives (§19 Q231). Every writer of a daily link reads it before
--      the env value (`ensureDailyLink`'s store); a link already made keeps its expiry.
--   3. update_org() gains p_locale and p_units (§19 Q233, Settings → PDF template "Report language
--      and units"): admin only, audited `org.updated` with the changed fields as before. New
--      report versions take the org's language and units; a filed version keeps its own (the
--      version's data carries `reportLanguage` and `units`, §12). The five-argument signature is
--      dropped (forward-only: a new function with defaults, so the deployed panel's named call
--      `update_org(p_org_id, p_name, p_timezone, p_address, p_license_no)` still resolves).
--   4. settings_test_message_claim() (§19 Q232, Settings' "Send me a test message"): the service
--      role's claim before api-test-message sends: at most 5 an hour per org, counted on the audit
--      rows it writes (`settings.test_message`, the number masked, never stored whole), under a
--      per-org advisory lock so two clicks cannot both pass the fifth.
--
-- Live database (staging): two nullable/defaulted columns on org_settings (a constant default, no
-- rewrite), one function replaced, one added; no existing row is written.

set local lock_timeout = '5s';

-- 1–2. The columns --------------------------------------------------------------------------------
alter table org_settings
  add column default_contact_pref contact_pref not null default 'link',
  add column daily_link_ttl_hours int check (daily_link_ttl_hours between 1 and 168);

comment on column org_settings.default_contact_pref is
  'W4-05 (§19 Q231): the preference Setup and Invite preselect for a new reporter.';
comment on column org_settings.daily_link_ttl_hours is
  'W4-05 (§19 Q231): hours a new daily link lives; null = DAILY_LINK_TTL_HOURS.';

-- The admin's column grant (20261014000001 step 9) gains both.
grant update (default_contact_pref, daily_link_ttl_hours) on org_settings to authenticated;

-- 3. update_org with the report language and units -------------------------------------------------
drop function update_org(uuid, text, text, text, text);

create function update_org(
  p_org_id uuid,
  p_name text,
  p_timezone text default null,
  p_address text default null,
  p_license_no text default null,
  p_locale text default null,
  p_units text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_old orgs%rowtype;
  v_new orgs%rowtype;
  v_diff jsonb := '{}'::jsonb;
  k text;
begin
  if not has_role(p_org_id, '{admin}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'company name required'; end if;
  if p_locale is not null and p_locale not in ('en-US', 'tr-TR') then
    raise exception 'invalid_locale' using errcode = '22023';
  end if;
  if p_units is not null and p_units not in ('imperial', 'metric') then
    raise exception 'invalid_units' using errcode = '22023';
  end if;
  select * into v_old from orgs where id = p_org_id for update;
  update orgs set
    name = btrim(p_name),
    timezone = coalesce(nullif(btrim(p_timezone), ''), v_old.timezone),
    address = nullif(btrim(p_address), ''),
    license_no = nullif(btrim(p_license_no), ''),
    locale = coalesce(p_locale, v_old.locale),
    units = coalesce(p_units, v_old.units)
  where id = p_org_id
  returning * into v_new;

  foreach k in array array['name', 'timezone', 'address', 'license_no', 'locale', 'units'] loop
    if to_jsonb(v_new) -> k is distinct from to_jsonb(v_old) -> k then
      v_diff := v_diff || jsonb_build_object(k,
        jsonb_build_object('from', to_jsonb(v_old) -> k, 'to', to_jsonb(v_new) -> k));
    end if;
  end loop;
  if v_diff <> '{}'::jsonb then
    perform log_audit(p_org_id, 'user', auth.uid(), 'org.updated', 'org', p_org_id, v_diff);
  end if;

  return jsonb_build_object(
    'id', v_new.id,
    'name', v_new.name,
    'timezone', v_new.timezone,
    'address', v_new.address,
    'license_no', v_new.license_no,
    'locale', v_new.locale,
    'units', v_new.units,
    'changed', v_diff <> '{}'::jsonb
  );
end $$;

revoke execute on function update_org(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function update_org(uuid, text, text, text, text, text, text) to authenticated, service_role;

-- 4. The test message's claim ---------------------------------------------------------------------
-- The service role only (api-test-message checks the caller is an admin of the org first).
-- Returns {allowed: true} after writing the audit row, or {allowed: false, retry_at} when five
-- were claimed in the last hour.
create function settings_test_message_claim(
  p_org_id uuid, p_user_id uuid, p_phone_masked text, p_driver text, p_language text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_oldest timestamptz;
begin
  if not is_service() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('settings_test_message:' || p_org_id::text, 0));
  select count(*), min(created_at) into v_count, v_oldest
  from audit_log
  where org_id = p_org_id and action = 'settings.test_message'
    and created_at > now() - interval '1 hour';
  if v_count >= 5 then
    return jsonb_build_object('allowed', false, 'retry_at', v_oldest + interval '1 hour');
  end if;
  perform log_audit(p_org_id, 'user', p_user_id, 'settings.test_message', 'org', p_org_id,
    jsonb_build_object('to', p_phone_masked, 'driver', p_driver, 'language', p_language));
  return jsonb_build_object('allowed', true);
end $$;

revoke execute on function settings_test_message_claim(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function settings_test_message_claim(uuid, uuid, text, text, text) to service_role;
