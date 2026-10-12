-- SiteLog · edit the company from the setup wizard (2026-10-13)
--   The wizard's company step called create_org() whenever it was submitted. An admin of an org
--   that already exists reaches that step too (Back from "First site", or "Connect your first
--   site" then Back), so every submit created a second org with its own trial, settings and
--   admin membership, and the edits never reached the real org. The wizard now saves the company
--   details of the current org through update_org(): admin only, audited with the changed fields.
--   create_org() stays for a signed-in user without any org.

create or replace function update_org(
  p_org_id uuid,
  p_name text,
  p_timezone text default null,
  p_address text default null,
  p_license_no text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_old orgs%rowtype;
  v_new orgs%rowtype;
  v_diff jsonb := '{}'::jsonb;
begin
  if not has_role(p_org_id, '{admin}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'company name required'; end if;
  select * into v_old from orgs where id = p_org_id for update;
  update orgs set
    name = btrim(p_name),
    timezone = coalesce(nullif(btrim(p_timezone), ''), v_old.timezone),
    address = nullif(btrim(p_address), ''),
    license_no = nullif(btrim(p_license_no), '')
  where id = p_org_id
  returning * into v_new;

  if v_new.name is distinct from v_old.name then
    v_diff := v_diff || jsonb_build_object('name', jsonb_build_object('from', v_old.name, 'to', v_new.name));
  end if;
  if v_new.timezone is distinct from v_old.timezone then
    v_diff := v_diff || jsonb_build_object('timezone', jsonb_build_object('from', v_old.timezone, 'to', v_new.timezone));
  end if;
  if v_new.address is distinct from v_old.address then
    v_diff := v_diff || jsonb_build_object('address', jsonb_build_object('from', v_old.address, 'to', v_new.address));
  end if;
  if v_new.license_no is distinct from v_old.license_no then
    v_diff := v_diff || jsonb_build_object('license_no', jsonb_build_object('from', v_old.license_no, 'to', v_new.license_no));
  end if;
  if v_diff <> '{}'::jsonb then
    perform log_audit(p_org_id, 'user', auth.uid(), 'org.updated', 'org', p_org_id, v_diff);
  end if;

  return jsonb_build_object(
    'id', v_new.id,
    'name', v_new.name,
    'timezone', v_new.timezone,
    'address', v_new.address,
    'license_no', v_new.license_no,
    'changed', v_diff <> '{}'::jsonb
  );
end $$;

revoke execute on function update_org(uuid, text, text, text, text) from public, anon;
grant execute on function update_org(uuid, text, text, text, text) to authenticated;
