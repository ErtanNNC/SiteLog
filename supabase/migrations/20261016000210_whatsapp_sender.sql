-- SiteLog · the pack's WhatsApp sender and template ids (W2-15; spec §4.6, §6.3, §19 Q29, Q39)
--
-- Spec §19 Q39 (decided 2026-10-15): the WhatsApp sender and its approved template ids live in the
-- country pack, per environment, like the SMS sender (§19 Q29): null in every migration, set per
-- database with the service-only, audited set_country_endpoints() (`pnpm countries:set`,
-- owner-approved on hosted databases). A null sender is the `console` transport for demo orgs and,
-- for a real org, a channel that leaves the order (§19 Q84, decided 2026-10-16: SMS carries the
-- message).
--
--   1. countries.whatsapp_sender_id: the Twilio WhatsApp sender, E.164 (Twilio addresses it as
--      `whatsapp:+1…`); unique across packs, since sms-webhook finds the pack of an inbound
--      WhatsApp message by the sender that received it (W2-16), as it does for SMS.
--   2. countries.whatsapp_templates: `{<message key>: {<language>: <content sid>}}`, the Twilio
--      Content API ids of the templates Meta approved for business-initiated messages outside the
--      24-hour window (`en`, `es`, `tr`; a content sid is `HX` and 32 hex digits). null = none: a
--      key without an approved template for the reporter's language is not deliverable on
--      WhatsApp outside the window, and the Notifier falls back to the next channel (W2-01).
--   3. set_country_endpoints(p_code, p_sms_sender_id, p_voice_number, p_whatsapp_sender_id,
--      p_whatsapp_templates): every per-environment value of a pack in one audited call
--      (`country.endpoints_set`, the WhatsApp values in its from/to). It replaces the
--      three-argument function, which only `pnpm countries:set` called (the script passes every
--      value, the ones it keeps included); no deployed code calls it.
--   4. field_grant_consent(): Settings' *Turn on* also takes `whatsapp` (Message me on WhatsApp,
--      §19 Q25, Q40). An SMS opt-out (STOP, the provider's list) blocks texts only (§19 Q40, the
--      first option), so it never refuses the WhatsApp consent.
--
-- Live database: two nullable columns on a two-row table, one partial unique index, function
-- replacements. No row is rewritten; the deployed code reads `countries` with `select *` and
-- ignores the new columns (the shared row schema drops unknown columns).

set local lock_timeout = '5s';

-- 1–2. The columns (spec §6.3 holds this DDL verbatim) --------------------------------------------
alter table countries
  add column whatsapp_sender_id text
    check (whatsapp_sender_id is null or whatsapp_sender_id ~ '^\+[1-9][0-9]{6,14}$'),
  add column whatsapp_templates jsonb
    check (whatsapp_templates is null or jsonb_typeof(whatsapp_templates) = 'object');

create unique index countries_whatsapp_sender_id_key on countries (whatsapp_sender_id)
  where whatsapp_sender_id is not null;

-- 3. set_country_endpoints() with the WhatsApp values ----------------------------------------------
drop function set_country_endpoints(text, text, text);

create function set_country_endpoints(
  p_code text, p_sms_sender_id text, p_voice_number text,
  p_whatsapp_sender_id text, p_whatsapp_templates jsonb
)
returns countries language plpgsql security definer set search_path = public as $$
declare
  v_old countries%rowtype;
  v_new countries%rowtype;
  v_sender text := nullif(btrim(p_sms_sender_id), '');
  v_voice text := nullif(btrim(p_voice_number), '');
  v_wa text := nullif(btrim(p_whatsapp_sender_id), '');
  v_templates jsonb := p_whatsapp_templates;
  v_key text;
  v_langs jsonb;
  v_lang text;
  v_sid jsonb;
begin
  select * into v_old from countries where code = upper(btrim(p_code)) for update;
  if not found then raise exception 'unknown country' using errcode = '22023'; end if;
  if v_voice is not null and v_voice !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'voice number must be E.164 (+ and 7 to 15 digits)' using errcode = '22023';
  end if;
  if v_sender is not null and not (case v_old.sms_sender_type
      when 'alphanumeric' then v_sender ~ '^[A-Za-z0-9 ]{1,11}$'
      when 'short_code' then v_sender ~ '^[0-9]{3,8}$'
      else v_sender ~ '^\+[1-9][0-9]{6,14}$'
    end) then
    raise exception 'not a valid % sender id for %', v_old.sms_sender_type, v_old.code
      using errcode = '22023';
  end if;
  if v_wa is not null and v_wa !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'WhatsApp sender must be E.164 (+ and 7 to 15 digits)' using errcode = '22023';
  end if;
  if v_templates is not null then
    if jsonb_typeof(v_templates) <> 'object' then
      raise exception 'WhatsApp templates must be an object of message keys' using errcode = '22023';
    end if;
    for v_key, v_langs in select key, value from jsonb_each(v_templates) loop
      if v_key !~ '^[a-z][a-z0-9_]{0,39}$' or jsonb_typeof(v_langs) <> 'object' then
        raise exception 'WhatsApp template key % must map languages to content sids', v_key
          using errcode = '22023';
      end if;
      for v_lang, v_sid in select key, value from jsonb_each(v_langs) loop
        if v_lang not in ('en', 'es', 'tr') or jsonb_typeof(v_sid) <> 'string'
           or (v_sid #>> '{}') !~ '^HX[0-9a-fA-F]{32}$' then
          raise exception 'WhatsApp template %.% must be a content sid (HX and 32 hex digits)',
            v_key, v_lang using errcode = '22023';
        end if;
      end loop;
    end loop;
    if v_templates = '{}'::jsonb then v_templates := null; end if;
  end if;
  update countries set sms_sender_id = v_sender, voice_number = v_voice,
                       whatsapp_sender_id = v_wa, whatsapp_templates = v_templates
  where code = v_old.code
  returning * into v_new;
  insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id, diff)
  values (null, 'system', null, 'country.endpoints_set', 'country', null,
          jsonb_build_object(
            'code', v_new.code,
            'from', jsonb_build_object('sms_sender_id', v_old.sms_sender_id,
                                       'voice_number', v_old.voice_number,
                                       'whatsapp_sender_id', v_old.whatsapp_sender_id,
                                       'whatsapp_templates', v_old.whatsapp_templates),
            'to', jsonb_build_object('sms_sender_id', v_new.sms_sender_id,
                                     'voice_number', v_new.voice_number,
                                     'whatsapp_sender_id', v_new.whatsapp_sender_id,
                                     'whatsapp_templates', v_new.whatsapp_templates)));
  return v_new;
end $$;
revoke execute on function set_country_endpoints(text, text, text, text, jsonb)
  from public, anon, authenticated;

-- 4. Settings' Turn on: texts or WhatsApp -----------------------------------------------------------
-- 20261016000080's function with `whatsapp` accepted; the SMS opt-out blocks `sms` only.
create or replace function field_grant_consent(
  p_reporter_id uuid,
  p_type consent_type,
  p_text_version text,
  p_device_id uuid,
  p_evidence jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  v_country text;
  v_id uuid;
begin
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;
  if p_type is null or p_type::text not in ('sms', 'whatsapp') then
    raise exception 'consent_not_offered' using errcode = 'P0001';
  end if;
  if p_text_version is null or btrim(p_text_version) = '' or length(p_text_version) > 64 then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  select country into v_country from orgs where id = r.org_id;
  if p_type::text = 'sms' and (r.status = 'opted_out'
     or exists (select 1 from sms_opt_outs o
                where o.phone_e164 = r.phone_e164 and o.country = v_country)) then
    raise exception 'texts_opted_out' using errcode = 'P0001';
  end if;

  if exists (select 1 from consents
             where reporter_id = p_reporter_id and type = p_type and revoked_at is null) then
    return jsonb_build_object('granted', false);
  end if;

  insert into consents (reporter_id, type, method, text_version, evidence)
  values (p_reporter_id, p_type, 'web_checkbox', p_text_version, p_evidence)
  returning id into v_id;

  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'consent.given', 'consent', v_id,
    jsonb_build_object('type', p_type, 'method', 'web_checkbox', 'text_version', p_text_version,
                       'via', 'settings', 'device_id', p_device_id));
  return jsonb_build_object('granted', true, 'consent_id', v_id);
end $$;
