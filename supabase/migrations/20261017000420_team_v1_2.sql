-- SiteLog · Team on v1.2 (W4-03; spec P10, F3, F15, F16, F24, §2.2 "Manage reporters, phone
-- numbers & channel preferences": admin and ops; §19 Q241–Q244's recommended defaults)
--
--   1. org_members.ui_locale (F24): the office user's panel language, `en-US` or `tr-TR`; null =
--      the org's (§6.3). api-invite-office-user writes it for a new office user (the Add office
--      user dialog's "UI language"); the check keeps anything else out of the column, which the
--      member may also update (20261014000001's column grant).
--   2. update_reporter_contact() (F15 "Office", §19 Q21, Q243): Team → Edit writes the report
--      mode (`contact_pref`), the message channel (one of the pack's message channels other than
--      push, or null = the pack's order) and the language SiteLog uses with them (one of the
--      pack's field locales). A change of preference or channel needs the office's attestation
--      that the reporter asked for it (`p_attested`); no consent row is written (a preference is
--      not a consent): a channel without its consent stays unreachable until the reporter
--      consents in the recorder. Audited `reporter.preferences_changed` with `via office`, the
--      office user and `attested`. admin and ops.
--   3. revoke_reporter_devices() (F16 lost phone, §19 Q244): every live `field_devices` row of the
--      reporter revoked, and its web push subscriptions (`signed_out`, as the recorder's own Sign
--      out this phone); the consents and the personal link stay, so the next open asks for a code.
--      Audited `device.revoked` with `via office` and the counts. admin and ops.
--   4. clear_reporter_opt_out() (§19 Q94, Q242): on a one-way pack only, an admin clears an
--      opt-out the provider recorded (Twilio 21610 and the like: `sms_opt_outs` method
--      `provider_opt_out`), with the attestation that the person asked for texts again, stored as
--      an `sms` consent `office_attested` (the office user and the wording's version in its
--      evidence). Never on a two-way pack (START by the person only) and never a STOP the person
--      sent. The reporter is `active` again if they were ever activated, else `invited`. Audited
--      `reporter.opt_out_cleared` and `consent.given`, `via office`. The provider may still
--      refuse the next text.
--   5. team_reporter_states() (P10 statuses): per reporter of the org, what Team shows beside the
--      reporter row that admin and ops cannot read themselves: the phone's opt-out on the org's
--      pack (`sms_opt_outs.method`), the verified live devices, the consents held, and the
--      attempts of the latest `welcome` message (W2-01's walk: the panel reads "Can't text this
--      number" from them, not from the v1.0 `last_invite_error`). admin and ops.
--
-- Live database (staging): a check every row meets (ui_locale is null everywhere) and five new
-- functions. No table change; no existing row is written. The deployed panel calls none of them.

set local lock_timeout = '5s';

-- 1. The office user's panel language --------------------------------------------------------------
alter table org_members add constraint org_members_ui_locale_check
  check (ui_locale in ('en-US','tr-TR'));

-- 2. Team → Edit: preference, message channel, language --------------------------------------------
create function update_reporter_contact(
  p_reporter_id uuid,
  p_contact_pref contact_pref,
  p_message_channel message_channel,
  p_locale text,
  p_attested boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  c countries%rowtype;
  v_from jsonb := '{}'::jsonb;
  v_to jsonb := '{}'::jsonb;
begin
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then raise exception 'reporter not found' using errcode = 'P0002'; end if;
  if not has_role(r.org_id, '{admin,ops}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select c2.* into c from countries c2 join orgs o on o.country = c2.code where o.id = r.org_id;
  if p_contact_pref is null then raise exception 'contact_pref required' using errcode = '22023'; end if;
  if p_locale is null or not (p_locale = any(c.field_locales)) then
    raise exception 'locale_not_offered' using errcode = '22023';
  end if;
  -- As the recorder's Settings (settingsMessageChannels): the pack's channels other than push.
  if p_message_channel is not null
     and (p_message_channel = 'push' or not (p_message_channel = any(c.message_channels))) then
    raise exception 'channel_not_offered' using errcode = '22023';
  end if;

  if r.contact_pref is distinct from p_contact_pref then
    v_from := v_from || jsonb_build_object('contact_pref', r.contact_pref);
    v_to := v_to || jsonb_build_object('contact_pref', p_contact_pref);
  end if;
  if r.message_channel is distinct from p_message_channel then
    v_from := v_from || jsonb_build_object('message_channel', r.message_channel);
    v_to := v_to || jsonb_build_object('message_channel', p_message_channel);
  end if;
  -- §19 Q243: a preference or channel change only on the reporter's word, which the office attests.
  if v_to <> '{}'::jsonb and not coalesce(p_attested, false) then
    raise exception 'attestation_required' using errcode = 'P0001';
  end if;
  if r.locale is distinct from p_locale then
    v_from := v_from || jsonb_build_object('locale', r.locale);
    v_to := v_to || jsonb_build_object('locale', p_locale);
  end if;
  if v_to = '{}'::jsonb then
    return jsonb_build_object('id', r.id, 'changed', false);
  end if;

  update reporters
  set contact_pref = p_contact_pref, message_channel = p_message_channel, locale = p_locale
  where id = r.id;

  perform log_audit(r.org_id, 'user', auth.uid(), 'reporter.preferences_changed', 'reporter', r.id,
    jsonb_build_object('from', v_from, 'to', v_to, 'via', 'office',
                       'attested', coalesce(p_attested, false)));
  return jsonb_build_object('id', r.id, 'changed', true, 'contact_pref', p_contact_pref,
                            'message_channel', p_message_channel, 'locale', p_locale);
end $$;

-- 3. Revoke devices (lost phone) -------------------------------------------------------------------
create function revoke_reporter_devices(p_reporter_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  v_devices uuid[];
  v_subscriptions int;
begin
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then raise exception 'reporter not found' using errcode = 'P0002'; end if;
  if not has_role(r.org_id, '{admin,ops}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  with revoked as (
    update field_devices set revoked_at = now()
    where reporter_id = r.id and revoked_at is null
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_devices from revoked;

  -- No notifications to a phone that is signed out (W2-14); the push consent stays (§19 Q244).
  with gone as (
    update push_subscriptions set revoked_at = now(), revoked_reason = 'signed_out'
    where reporter_id = r.id and revoked_at is null
    returning id
  )
  select count(*)::int into v_subscriptions from gone;

  perform log_audit(r.org_id, 'user', auth.uid(), 'device.revoked', 'reporter', r.id,
    jsonb_build_object('via', 'office', 'devices', cardinality(v_devices),
                       'device_ids', to_jsonb(v_devices), 'push_subscriptions', v_subscriptions));
  return jsonb_build_object('id', r.id, 'devices', cardinality(v_devices),
                            'push_subscriptions', v_subscriptions);
end $$;

-- 4. Clear a provider's opt-out on a one-way pack --------------------------------------------------
create function clear_reporter_opt_out(
  p_reporter_id uuid,
  p_text_version text,
  p_attested boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  c countries%rowtype;
  v_method text;
  v_status reporter_status;
  v_consent uuid;
begin
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then raise exception 'reporter not found' using errcode = 'P0002'; end if;
  if not has_role(r.org_id, '{admin}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select c2.* into c from countries c2 join orgs o on o.country = c2.code where o.id = r.org_id;
  -- §19 Q242: on a two-way pack only the person undoes a STOP (START).
  if c.two_way_sms then raise exception 'two_way_pack' using errcode = 'P0001'; end if;
  if not coalesce(p_attested, false) then
    raise exception 'attestation_required' using errcode = 'P0001';
  end if;
  if p_text_version is null or btrim(p_text_version) = '' or length(p_text_version) > 64 then
    raise exception 'text_version required' using errcode = '22023';
  end if;
  select method into v_method from sms_opt_outs
  where phone_e164 = r.phone_e164 and country = c.code;
  if v_method = 'sms_keyword' then
    raise exception 'opted_out_by_person' using errcode = 'P0001';
  end if;
  if v_method is null and r.status <> 'opted_out' and r.opted_out_at is null then
    raise exception 'not_opted_out' using errcode = 'P0001';
  end if;

  delete from sms_opt_outs where phone_e164 = r.phone_e164 and country = c.code;
  v_status := case
    when r.status <> 'opted_out' then r.status
    when r.activated_at is not null then 'active'::reporter_status
    else 'invited'::reporter_status
  end;
  update reporters set status = v_status, opted_out_at = null where id = r.id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'reporter.opt_out_cleared', 'reporter', r.id,
    jsonb_build_object('via', 'office', 'method', coalesce(v_method, 'provider_opt_out'),
                       'status', jsonb_build_object('from', r.status, 'to', v_status)));

  if not exists (select 1 from consents
                 where reporter_id = r.id and type = 'sms' and revoked_at is null) then
    insert into consents (reporter_id, type, method, text_version, evidence)
    values (r.id, 'sms', 'office_attested', btrim(p_text_version),
            jsonb_build_object('user_id', auth.uid(), 'via', 'office', 'at', now()))
    returning id into v_consent;
    perform log_audit(r.org_id, 'user', auth.uid(), 'consent.given', 'consent', v_consent,
      jsonb_build_object('type', 'sms', 'method', 'office_attested',
                         'text_version', btrim(p_text_version), 'via', 'office',
                         'reporter_id', r.id));
  end if;
  return jsonb_build_object('id', r.id, 'status', v_status, 'consent_id', v_consent);
end $$;

-- 5. What Team shows beside each reporter row ------------------------------------------------------
create function team_reporter_states(p_org_id uuid)
returns table (
  reporter_id uuid,
  opt_out_method text,
  devices int,
  consents text[],
  welcome jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role(p_org_id, '{admin,ops}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
  select
    r.id,
    (select o.method from sms_opt_outs o
     where o.phone_e164 = r.phone_e164 and o.country = org.country),
    (select count(*)::int from field_devices d
     where d.reporter_id = r.id and d.revoked_at is null and d.verified_at is not null),
    array(select distinct k.type::text from consents k
          where k.reporter_id = r.id and k.revoked_at is null order by 1),
    (select coalesce(jsonb_agg(jsonb_build_object(
              'status', m.status, 'channel', m.channel,
              'provider_message_id', m.provider_message_id, 'error', m.error,
              'attempt', coalesce((m.payload->>'attempt')::int, 1),
              'dedupe_key', m.payload->>'dedupe_key', 'created_at', m.created_at)
            order by m.created_at), '[]'::jsonb)
     from messages m
     join lateral (
       select l.id, l.payload->>'dedupe_key' as k from messages l
       where l.reporter_id = r.id and l.copy_key = 'welcome' and l.direction = 'out'
       order by l.created_at desc, l.id desc limit 1
     ) latest on true
     where m.reporter_id = r.id and m.copy_key = 'welcome' and m.direction = 'out'
       and (m.id = latest.id or (latest.k is not null and m.payload->>'dedupe_key' = latest.k)))
  from reporters r join orgs org on org.id = r.org_id
  where r.org_id = p_org_id
  order by r.id;
end $$;

revoke execute on function
  update_reporter_contact(uuid, contact_pref, message_channel, text, boolean),
  revoke_reporter_devices(uuid),
  clear_reporter_opt_out(uuid, text, boolean),
  team_reporter_states(uuid)
  from public, anon;
grant execute on function
  update_reporter_contact(uuid, contact_pref, message_channel, text, boolean),
  revoke_reporter_devices(uuid),
  clear_reporter_opt_out(uuid, text, boolean),
  team_reporter_states(uuid)
  to authenticated, service_role;
