-- SiteLog · org-less unknown contacts for SiteLog support (spec §19 Q44, decided by the owner
-- 2026-10-15; W1-16)
--
-- An SMS from an unknown number arrives on a sender every org of the pack shares. sms-webhook's
-- handling now guesses the org when the number has history in exactly one real org of the pack (a
-- disabled reporter, an earlier contact that org linked: `processInboundSms`); every other such
-- contact stays org-less, and no office user sees it (a privacy leak otherwise). SiteLog support
-- (platform admins, /ops) sees them here and either hands one to an org, which then sees it on its
-- Overview and Team page and links it with consent (api-link-unknown-contact), or ignores it.
--
--   ops_unknown_contacts(p_limit)              pending contacts with no org, newest first
--   ops_assign_unknown_contact(p_id, p_org_id) gives a pending org-less contact to a real org
--   ops_ignore_unknown_contact(p_id)           ignores a pending org-less contact
--   ops_real_orgs()                            the real (non-demo) orgs to assign to
--
-- Each checks is_platform_admin() and audits (`ops.unknown_contact_assigned`, `…_ignored`).
-- Forward-only and CLI-safe: three new functions; nothing existing changes.

create function ops_unknown_contacts(p_limit int default 100)
returns table (
  id uuid, phone_e164 text, channel field_channel, snippet text, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select u.id, u.phone_e164, u.channel, left(u.snippet, 200), u.created_at
    from unknown_contacts u
    where u.org_id is null and u.status = 'pending'
    order by u.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;

create function ops_assign_unknown_contact(p_id uuid, p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u unknown_contacts%rowtype;
  o orgs%rowtype;
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into u from unknown_contacts where unknown_contacts.id = p_id for update;
  if u.id is null then raise exception 'contact not found'; end if;
  if u.org_id is not null or u.status <> 'pending' then
    raise exception 'only a pending contact with no organisation can be assigned';
  end if;
  select * into o from orgs where orgs.id = p_org_id;
  if o.id is null then raise exception 'organisation not found'; end if;
  -- A real sender never reaches a demo org (sms-webhook files real texts under real orgs only).
  if o.is_demo then raise exception 'a demo organisation cannot take a real contact'; end if;
  update unknown_contacts set org_id = o.id where unknown_contacts.id = u.id;
  perform log_audit(o.id, 'user', auth.uid(), 'ops.unknown_contact_assigned', 'unknown_contact',
    u.id, jsonb_build_object('channel', u.channel));
  return jsonb_build_object('id', u.id, 'orgId', o.id);
end $$;

create function ops_ignore_unknown_contact(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u unknown_contacts%rowtype;
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into u from unknown_contacts where unknown_contacts.id = p_id for update;
  if u.id is null then raise exception 'contact not found'; end if;
  if u.org_id is not null or u.status <> 'pending' then
    raise exception 'only a pending contact with no organisation can be ignored here';
  end if;
  update unknown_contacts set status = 'ignored' where unknown_contacts.id = u.id;
  perform log_audit(null, 'user', auth.uid(), 'ops.unknown_contact_ignored', 'unknown_contact',
    u.id, jsonb_build_object('channel', u.channel));
  return jsonb_build_object('id', u.id, 'status', 'ignored');
end $$;

create function ops_real_orgs()
returns table (id uuid, name text, country text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select o.id, o.name, o.country from orgs o where not o.is_demo order by o.name;
end $$;

revoke execute on function ops_unknown_contacts(int), ops_assign_unknown_contact(uuid, uuid),
  ops_ignore_unknown_contact(uuid), ops_real_orgs() from public, anon;
grant execute on function ops_unknown_contacts(int), ops_assign_unknown_contact(uuid, uuid),
  ops_ignore_unknown_contact(uuid), ops_real_orgs() to authenticated;
