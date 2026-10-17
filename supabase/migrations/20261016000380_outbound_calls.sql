-- SiteLog · outbound reminder calls (W3-17, M8; spec §7.4, F6 step 1, F11, F15, §9.4 "Calls
-- policy", §4.5 Notifier.call, §10.1 place_call, §19 Q33, Q38, Q51, Q76, Q125–Q132)
--
--   1. countries.outbound_trunk_id (§19 Q125): the LiveKit outbound SIP trunk of the pack, per
--      environment like the voice number (null in every migration, set with `pnpm countries:set --
--      --outbound-trunk`, audited); `LIVEKIT_SIP_OUTBOUND_TRUNKS` is retired. Its caller id is the
--      pack's `voice_number` (§19 Q126: one number per pack for both directions), so a trunk needs
--      a voice number: set_country_endpoints() refuses one without the other.
--   2. org_places_calls() (§19 Q51, Q132): an org places automated calls when it is a demo org
--      (the `console` telephony: the call rings the panel's Demo phone, never a real phone, §19
--      Q116) or its pack has an outbound trunk here. field-api's `placesCalls` and the worker read
--      the same rule (`placesCalls()` in packages/shared/src/voice-outbound.ts).
--   3. field_grant_consent(): Settings' *Turn on* also takes `auto_call` (§19 Q131: the reporter's
--      own consent), only where the org places calls (§19 Q33: never asked otherwise).
--      field_no_calls_today(): Settings' "Don't call me today" (§19 Q129), as the call's
--      voice_no_calls_today() does: `reporters.no_calls_until` = the end of that day in the org's
--      time zone, audited `reporter.preferences_changed` via web with the device.
--   4. claim_site_day_reminder() with the stage's calls (`p_calls`): one `place_call` job per call
--      reporter, keyed `call:<site_day>:<reporter>:<stage>` (R1, R2), in the same transaction as the
--      stage's messages; the daily link stage may send `call_coming` (§19 Q130). The deployed
--      scheduler-tick (no `p_calls`) keeps working: the argument defaults to none.
--   5. outbound_call_start() (the worker's place_call, §19 Q127, Q128, Q129, Q131): the guards
--      that need the database, in one transaction under the site-day's lock: the day still waits
--      for a report (a callback: not yet filed), the reporter active (a ladder call: prefers calls),
--      the `auto_call` consent, no "not today", the org's `auto_call_enabled`, the attempt unused (R1 = 1, R2 = 2, the one
--      callback = 3, per site-day; the partial unique index below), the org placing calls, and for
--      the `livekit` telephony the capacity (open calls of real orgs, `p_max_concurrent`, under an
--      advisory lock). Then the `calls` row (outbound, pstn, queued, `call-{id}` as its room, §19
--      Q157), audited `call.requested`. A refusal writes nothing and answers its reason (the
--      worker audits `call.skipped`).
--      outbound_call_ringing() / outbound_call_unanswered(): the dial's progress and its end
--      before an answer (`no_answer`, `busy`, `voicemail`, `failed`): outcome `not_reached`,
--      audited `call.ended`; no post_call job (nothing was said).
--   6. voice_call_end() for an outbound call the agent ended `not_reached` (its first utterance a
--      voicemail greeting, F6 step 1): status `voicemail` (or `no_answer`), and instead of the
--      post-call job the `missed_call` step (`place_call {phase: missed}`, `call_missed:<call>`).
--   7. voice_schedule_callback() (§19 Q128, "call me back in half an hour"): field-api planned the
--      time inside the window (`callbackPlan()`); the one callback of the site-day as a delayed
--      `place_call` (`call:<site_day>:<reporter>:callback`), audited `call.callback_requested`.
--   8. outbound_call_share() and ops_outbound_call_share() (M8, §16.2): per org and ISO week, the
--      site-days SiteLog called a reporter about (an outbound ladder call or callback) and those
--      filed by the reporter's yes on such a call (no office help). The worker's digest and /ops.
--
-- Every function is service-role only except ops_outbound_call_share() (platform admins, as the
-- other /ops RPCs). Live database (staging): one nullable column on a two-row table, one partial
-- unique index on a column every outbound row would fill (none exists: no pack places calls yet),
-- function replacements with defaulted new arguments, new functions. The deployed code calls
-- set_country_endpoints() only from `pnpm countries:set` (replaced with this migration) and
-- claim_site_day_reminder() with named arguments, which the new default keeps working.

set local lock_timeout = '5s';

-- 1. The pack's outbound trunk -----------------------------------------------------------------------------
alter table countries
  add column outbound_trunk_id text
    check (outbound_trunk_id is null or outbound_trunk_id ~ '^ST_[A-Za-z0-9]{4,64}$'),
  add constraint countries_outbound_trunk_caller_id_check
    check (outbound_trunk_id is null or voice_number is not null);

comment on column countries.outbound_trunk_id is
  'W3-17 (§19 Q125): the LiveKit outbound SIP trunk (ST_…) per environment; null = no automated calls for real orgs. Caller id: voice_number (§19 Q126).';

drop function set_country_endpoints(text, text, text, text, jsonb);

create function set_country_endpoints(
  p_code text, p_sms_sender_id text, p_voice_number text,
  p_whatsapp_sender_id text, p_whatsapp_templates jsonb, p_outbound_trunk_id text default null
)
returns countries language plpgsql security definer set search_path = public as $$
declare
  v_old countries%rowtype;
  v_new countries%rowtype;
  v_sender text := nullif(btrim(p_sms_sender_id), '');
  v_voice text := nullif(btrim(p_voice_number), '');
  v_wa text := nullif(btrim(p_whatsapp_sender_id), '');
  v_trunk text := nullif(btrim(p_outbound_trunk_id), '');
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
  if v_trunk is not null and v_trunk !~ '^ST_[A-Za-z0-9]{4,64}$' then
    raise exception 'outbound trunk must be a LiveKit SIP trunk id (ST_…)' using errcode = '22023';
  end if;
  -- §19 Q126: the trunk's calls show the pack's voice number, which reporters call back.
  if v_trunk is not null and v_voice is null then
    raise exception 'an outbound trunk needs the pack''s voice number (its caller id)'
      using errcode = '22023';
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
                       whatsapp_sender_id = v_wa, whatsapp_templates = v_templates,
                       outbound_trunk_id = v_trunk
  where code = v_old.code
  returning * into v_new;
  insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id, diff)
  values (null, 'system', null, 'country.endpoints_set', 'country', null,
          jsonb_build_object(
            'code', v_new.code,
            'from', jsonb_build_object('sms_sender_id', v_old.sms_sender_id,
                                       'voice_number', v_old.voice_number,
                                       'whatsapp_sender_id', v_old.whatsapp_sender_id,
                                       'whatsapp_templates', v_old.whatsapp_templates,
                                       'outbound_trunk_id', v_old.outbound_trunk_id),
            'to', jsonb_build_object('sms_sender_id', v_new.sms_sender_id,
                                     'voice_number', v_new.voice_number,
                                     'whatsapp_sender_id', v_new.whatsapp_sender_id,
                                     'whatsapp_templates', v_new.whatsapp_templates,
                                     'outbound_trunk_id', v_new.outbound_trunk_id)));
  return v_new;
end $$;
revoke execute on function set_country_endpoints(text, text, text, text, jsonb, text)
  from public, anon, authenticated;

-- 2. org_places_calls -----------------------------------------------------------------------------------------
create function org_places_calls(p_org_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select o.is_demo or c.outbound_trunk_id is not null
                     from orgs o join countries c on c.code = o.country
                    where o.id = p_org_id), false);
$$;

comment on function org_places_calls(uuid) is
  'W3-17 (§19 Q51, Q132): a demo org (console telephony) or a pack with an outbound trunk here; service only.';

-- 3. Settings: Turn on automated calls; Don't call me today ---------------------------------------------------
-- 20261016000210's function with `auto_call` accepted where the org places calls.
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
  if p_type is null or p_type::text not in ('sms', 'whatsapp', 'auto_call') then
    raise exception 'consent_not_offered' using errcode = 'P0001';
  end if;
  -- §19 Q33, Q131: the automated-call consent only where SiteLog places calls.
  if p_type::text = 'auto_call' and not org_places_calls(r.org_id) then
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

create function field_no_calls_today(p_reporter_id uuid, p_device_id uuid, p_now timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rep reporters%rowtype;
  v_tz text;
  v_now timestamptz := coalesce(p_now, now());
  v_until timestamptz;
begin
  select * into rep from reporters where id = p_reporter_id for update;
  if rep.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;
  select timezone into v_tz from orgs where id = rep.org_id;
  -- §19 Q129: the end of today in the org's time zone (as voice_no_calls_today()).
  v_until := (((v_now at time zone v_tz)::date + 1)::timestamp) at time zone v_tz;
  if rep.no_calls_until is not null and rep.no_calls_until >= v_until then
    return jsonb_build_object('until', rep.no_calls_until, 'changed', false);
  end if;
  update reporters set no_calls_until = v_until where id = rep.id;
  perform log_audit(rep.org_id, 'reporter', rep.id, 'reporter.preferences_changed', 'reporter',
    rep.id, jsonb_build_object('from', jsonb_build_object('no_calls_until', rep.no_calls_until),
                               'to', jsonb_build_object('no_calls_until', v_until),
                               'channel', 'web', 'device_id', p_device_id));
  return jsonb_build_object('until', v_until, 'changed', true);
end $$;

-- 4. The ladder's claim with calls ----------------------------------------------------------------------------
drop function claim_site_day_reminder(uuid, text, jsonb, jsonb, timestamptz);

create function claim_site_day_reminder(
  p_site_day_id uuid,
  p_stage text,
  p_messages jsonb,
  p_skipped jsonb default '[]'::jsonb,
  p_not_after timestamptz default null,
  p_calls jsonb default '[]'::jsonb
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  sd site_days%rowtype;
  v_org uuid;
  v_stage int;
  v_key_name text;
  v_keys text[];
  v_working int[];
  v_to site_day_status;
  v_guard jsonb;
  m jsonb;
  v_key text;
  v_call_key text;
  v_sent jsonb := '[]'::jsonb;
  v_called jsonb := '[]'::jsonb;
begin
  v_stage := case p_stage
    when 'daily_link' then null when 'heads_up' then 1 when 'reminder_1' then 2
    when 'reminder_2' then 3 else -1 end;
  if v_stage = -1 then
    raise exception 'unknown ladder stage %', p_stage using errcode = '22023';
  end if;
  v_key_name := case p_stage
    when 'daily_link' then 'daily_link' when 'heads_up' then 'weather_headsup'
    when 'reminder_1' then 'reminder_1' else 'reminder_2' end;
  -- §19 Q130 (W3-17): the daily link stage tells a call reporter whose R1 call will come.
  v_keys := case p_stage when 'daily_link' then array['daily_link', 'call_coming']
                         else array[v_key_name] end;
  if jsonb_typeof(p_messages) is distinct from 'array'
     or jsonb_typeof(p_skipped) is distinct from 'array'
     or jsonb_typeof(coalesce(p_calls, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'p_messages, p_skipped and p_calls must be arrays' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_calls, '[]'::jsonb)) > 0
     and p_stage not in ('reminder_1', 'reminder_2') then
    raise exception 'stage % places no calls', p_stage using errcode = '22023';
  end if;

  -- The claim: the row lock re-reads the status after a concurrent writer commits.
  select * into sd from site_days
   where id = p_site_day_id and status in ('pending', 'reminded') and not reminders_paused
     for update;
  if sd.id is null then return false; end if;
  select s.org_id into v_org from sites s where s.id = sd.site_id and s.status = 'active';
  if v_org is null then return false; end if;
  select working_days into v_working from org_settings where org_id = v_org;
  if v_working is null or not (extract(isodow from sd.date)::int = any (v_working)) then
    return false;
  end if;
  if exists (select 1 from reports r where r.site_day_id = sd.id and r.status <> 'void') then
    return false;
  end if;
  if v_stage is null then
    if sd.reminder_stage >= 2 or exists (
      select 1 from audit_log a
       where a.org_id = v_org and a.entity = 'site_day' and a.entity_id = sd.id
         and a.action = 'site_day.reminder' and a.diff ->> 'stage' = 'daily_link') then
      return false;
    end if;
  elsif sd.reminder_stage >= v_stage then
    return false;
  end if;

  v_guard := jsonb_build_object('siteDayId', sd.id, 'statuses', jsonb_build_array('pending', 'reminded'));
  if p_not_after is not null then
    v_guard := v_guard || jsonb_build_object('notAfter', p_not_after);
  end if;

  for m in select * from jsonb_array_elements(p_messages) loop
    if not ((m ->> 'key') = any (v_keys)) then
      raise exception 'stage % sends %, not %', p_stage, v_key_name, m ->> 'key' using errcode = '22023';
    end if;
    if not exists (select 1 from site_reporters sr
                    where sr.site_id = sd.site_id and sr.reporter_id = (m ->> 'reporterId')::uuid) then
      raise exception 'reporter % is not on the site', m ->> 'reporterId' using errcode = '22023';
    end if;
    v_key := 'notify:' || (m ->> 'key') || ':' || p_site_day_id || ':' || (m ->> 'reporterId');
    perform enqueue_job('notify',
                        jsonb_build_object('reporterId', m ->> 'reporterId', 'key', m ->> 'key',
                                           'vars', coalesce(m -> 'vars', '{}'::jsonb),
                                           'dedupeKey', v_key, 'guard', v_guard),
                        null,
                        v_key);
    v_sent := v_sent || to_jsonb(m ->> 'reporterId');
  end loop;

  -- W3-17: the stage's calls (R1; R2 when the org has second calls), one place_call job each.
  for m in select * from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) loop
    if not exists (select 1 from site_reporters sr
                    where sr.site_id = sd.site_id and sr.reporter_id = (m ->> 'reporterId')::uuid) then
      raise exception 'reporter % is not on the site', m ->> 'reporterId' using errcode = '22023';
    end if;
    v_call_key := 'call:' || p_site_day_id || ':' || (m ->> 'reporterId') || ':' || p_stage;
    perform enqueue_job('place_call',
                        jsonb_strip_nulls(jsonb_build_object(
                          'reporterId', m ->> 'reporterId', 'siteDayId', sd.id, 'stage', p_stage,
                          'notAfter', p_not_after, 'giveUpAt', m ->> 'giveUpAt')),
                        null,
                        v_call_key);
    v_called := v_called || to_jsonb(m ->> 'reporterId');
  end loop;

  v_to := sd.status;
  if v_stage is not null then
    if v_stage >= 2 then v_to := 'reminded'; end if;
    update site_days set reminder_stage = v_stage, status = v_to where id = sd.id;
  end if;
  perform log_audit(v_org, 'system', null, 'site_day.reminder', 'site_day', sd.id,
                    jsonb_build_object('stage', p_stage, 'key', v_key_name,
                                       'reminder_stage', coalesce(v_stage, sd.reminder_stage),
                                       'sent', v_sent, 'called', v_called, 'skipped', p_skipped,
                                       'not_after', p_not_after, 'by', 'scheduler-tick'));
  if v_to is distinct from sd.status then
    perform log_audit(v_org, 'system', null, 'site_day.status_changed', 'site_day', sd.id,
                      jsonb_build_object('from', sd.status, 'to', v_to, 'reminder_stage', v_stage,
                                         'by', 'scheduler-tick'));
  end if;
  return true;
end $$;

-- 5. The worker's call: guards, row, progress -----------------------------------------------------------------
-- §19 Q128: R1 = attempt 1, R2 = 2, the one callback = 3, once each per site-day and reporter.
create unique index calls_outbound_attempt_key on calls (site_day_id, reporter_id, attempt)
  where direction = 'outbound' and attempt is not null;

create function outbound_call_start(
  p_reporter_id uuid, p_site_day_id uuid, p_stage text, p_now timestamptz,
  p_telephony text, p_max_concurrent int default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sd site_days%rowtype;
  rep reporters%rowtype;
  v_site sites%rowtype;
  v_pack countries%rowtype;
  v_attempt smallint;
  v_purpose text;
  v_open int;
  v_id uuid := gen_random_uuid();
  v_room text;
  c calls%rowtype;
  v_now timestamptz := coalesce(p_now, now());
begin
  v_attempt := case p_stage when 'reminder_1' then 1 when 'reminder_2' then 2
                            when 'callback' then 3 end;
  if v_attempt is null or p_telephony is null or p_telephony not in ('livekit', 'console') then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_purpose := case when p_stage = 'callback' then 'callback' else 'reminder' end;

  select * into sd from site_days where id = p_site_day_id for update;
  if sd.id is null then
    raise exception 'site_day_not_found' using errcode = 'P0002';
  end if;
  select * into v_site from sites where id = sd.site_id;
  select * into rep from reporters where id = p_reporter_id for update;
  if rep.id is null or rep.org_id <> v_site.org_id
     or not exists (select 1 from site_reporters sr
                     where sr.site_id = v_site.id and sr.reporter_id = rep.id) then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;

  -- The day: a ladder call only while it still waits for a report (the claim's rule); a callback
  -- while nothing is filed (the call that asked for it may have left a draft).
  if v_site.status <> 'active' or sd.reminders_paused then
    return jsonb_build_object('status', 'skipped', 'reason', 'stale_stage');
  end if;
  if v_purpose = 'reminder' and (sd.status not in ('pending', 'reminded')
      or exists (select 1 from reports r where r.site_day_id = sd.id and r.status <> 'void')) then
    return jsonb_build_object('status', 'skipped', 'reason', 'stale_stage');
  end if;
  if v_purpose = 'callback' and (sd.status not in ('pending', 'reminded', 'processing')
      or exists (select 1 from reports r where r.site_day_id = sd.id
                  and r.status in ('filed', 'signed_off'))) then
    return jsonb_build_object('status', 'skipped', 'reason', 'stale_stage');
  end if;
  -- The reporter: active; a ladder call only for a reporter who prefers calls.
  if rep.status <> 'active' then
    return jsonb_build_object('status', 'skipped', 'reason', 'inactive');
  end if;
  if v_purpose = 'reminder' and rep.contact_pref <> 'call' then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_call_reporter');
  end if;
  -- §19 Q131: the reporter's own automated-call consent (never office_attested for the ladder).
  if not exists (select 1 from consents k
                  where k.reporter_id = rep.id and k.type = 'auto_call' and k.revoked_at is null
                    and k.method <> 'office_attested') then
    return jsonb_build_object('status', 'skipped', 'reason', 'no_consent');
  end if;
  -- §19 Q129: "Don't call me today".
  if rep.no_calls_until is not null and rep.no_calls_until > v_now then
    return jsonb_build_object('status', 'skipped', 'reason', 'no_calls_today');
  end if;
  if not org_places_calls(rep.org_id) then
    return jsonb_build_object('status', 'skipped', 'reason', 'no_trunk');
  end if;
  -- The org's own switch (org_settings.auto_call_enabled; its panel control is M10).
  if not coalesce((select os.auto_call_enabled from org_settings os where os.org_id = rep.org_id),
                  true) then
    return jsonb_build_object('status', 'skipped', 'reason', 'org_calls_off');
  end if;
  -- §19 Q128: each attempt once per site-day (a voicemail or no answer uses it).
  if exists (select 1 from calls x where x.site_day_id = sd.id and x.reporter_id = rep.id
                                     and x.direction = 'outbound' and x.attempt = v_attempt) then
    return jsonb_build_object('status', 'skipped', 'reason', 'attempt_used');
  end if;
  -- §19 Q127: LiveKit's concurrent sessions, one kept for inbound calls and Talk now. Open calls
  -- of real orgs (console calls use no session); a row open longer than a call can last is stale.
  if p_telephony = 'livekit' and p_max_concurrent is not null then
    perform pg_advisory_xact_lock(hashtext('outbound_call_capacity'));
    select count(*) into v_open
      from calls x join orgs o on o.id = x.org_id
     where x.ended_at is null and x.status in ('queued', 'ringing', 'in_progress')
       and x.created_at > now() - interval '20 minutes' and not o.is_demo;
    if v_open >= p_max_concurrent then
      return jsonb_build_object('status', 'skipped', 'reason', 'capacity', 'open', v_open);
    end if;
  end if;

  select c2.* into v_pack from countries c2 join orgs o on o.country = c2.code where o.id = rep.org_id;
  v_room := 'call-' || v_id::text;
  insert into calls (id, org_id, reporter_id, site_id, site_day_id, direction, transport, purpose,
                     attempt, provider_call_id, status, language, to_e164, from_e164, metrics)
  values (v_id, rep.org_id, rep.id, v_site.id, sd.id, 'outbound', 'pstn', v_purpose,
          v_attempt, v_room, 'queued', rep.locale, rep.phone_e164, v_pack.voice_number,
          jsonb_build_object('telephony', p_telephony, 'stage', p_stage))
  returning * into c;
  perform log_audit(c.org_id, 'system', null, 'call.requested', 'call', c.id,
    jsonb_build_object('direction', 'outbound', 'transport', 'pstn', 'purpose', v_purpose,
                       'attempt', v_attempt, 'stage', p_stage, 'telephony', p_telephony,
                       'site_id', v_site.id, 'site_day_id', sd.id, 'reporter_id', rep.id,
                       'room', v_room));
  return jsonb_build_object('status', 'placed', 'callId', c.id, 'room', v_room,
                            'attempt', v_attempt, 'purpose', v_purpose, 'language', c.language,
                            'trunkId', v_pack.outbound_trunk_id, 'from', v_pack.voice_number,
                            'to', rep.phone_e164);
end $$;

comment on function outbound_call_start(uuid, uuid, text, timestamptz, text, int) is
  'W3-17 (§19 Q127–Q131): the outbound call''s guards and its calls row (queued, room call-{id}); service only.';

create function outbound_call_ringing(p_call_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c calls%rowtype;
begin
  select * into c from calls where id = p_call_id and direction = 'outbound' for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null or c.status <> 'queued' then
    return jsonb_build_object('changed', false, 'status', c.status);
  end if;
  update calls set status = 'ringing', started_at = coalesce(started_at, now()) where id = c.id;
  return jsonb_build_object('changed', true, 'status', 'ringing');
end $$;

create function outbound_call_unanswered(p_call_id uuid, p_status call_status, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare c calls%rowtype;
begin
  if p_status is null or p_status not in ('no_answer', 'busy', 'failed', 'voicemail')
     or p_reason is null or p_reason !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id and direction = 'outbound' for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  -- Answered (the agent started it) or already ended: the call is not this function's.
  if c.ended_at is not null or c.status not in ('queued', 'ringing') then
    return jsonb_build_object('ended', false, 'status', c.status, 'outcome', c.outcome);
  end if;
  update calls set
      status = p_status,
      outcome = 'not_reached',
      ended_at = now(),
      duration_s = 0,
      metrics = coalesce(metrics, '{}'::jsonb) || jsonb_build_object('unanswered', p_reason)
    where id = c.id
    returning * into c;
  perform log_audit(c.org_id, 'system', null, 'call.ended', 'call', c.id,
    jsonb_build_object('outcome', 'not_reached', 'status', p_status, 'direction', 'outbound',
                       'attempt', c.attempt, 'reason', p_reason));
  return jsonb_build_object('ended', true, 'status', p_status, 'outcome', 'not_reached');
end $$;

-- 6. voice_call_end: an outbound call the agent ended unreached (a voicemail greeting) ----------------------
create or replace function voice_call_end(
  p_call_id uuid, p_outcome call_outcome, p_dialog_log jsonb, p_metrics jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_job bigint;
  v_unreached boolean;
begin
  if jsonb_typeof(p_dialog_log) is distinct from 'array'
     or jsonb_typeof(p_metrics) is distinct from 'object' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  v_unreached := c.direction = 'outbound' and p_outcome = 'not_reached';
  if c.ended_at is not null then
    -- W3-04: voice-events' backstop ended it first (the room finished while this request was on
    -- its way): the agent knows how the call went; its end replaces the guess, once.
    if c.metrics ? 'backstop' and c.dialog_log is null then
      update calls set
          outcome = p_outcome,
          dialog_log = p_dialog_log,
          metrics = p_metrics || jsonb_build_object('backstop', c.metrics -> 'backstop')
        where id = c.id
        returning * into c;
      if v_unreached then
        v_job := enqueue_job('place_call', jsonb_build_object('phase', 'missed', 'callId', c.id),
                             null, 'call_missed:' || c.id);
      elsif c.reporter_id is not null then
        -- The key's job (never a second one).
        v_job := enqueue_job('post_call_reconcile', jsonb_build_object('callId', c.id), null,
                             'post_call:' || c.id);
      end if;
      perform log_audit(c.org_id, 'agent', null, 'call.ended', 'call', c.id,
        jsonb_build_object('outcome', p_outcome, 'duration_s', c.duration_s, 'status', c.status,
                           'turns', p_metrics -> 'turns', 'job_id', v_job, 'late', true,
                           'backstop_outcome', c.metrics -> 'backstop' -> 'outcome'));
      return jsonb_build_object('ended', true, 'outcome', c.outcome, 'jobId', v_job);
    end if;
    return jsonb_build_object('ended', false, 'outcome', c.outcome, 'jobId', null);
  end if;
  update calls set
      outcome = p_outcome,
      dialog_log = p_dialog_log,
      metrics = coalesce(c.metrics, '{}'::jsonb) || p_metrics,
      ended_at = now(),
      duration_s = greatest(0, round(extract(epoch from now() - coalesce(answered_at, started_at, now()))))::int,
      status = case
        -- F6 step 1 (W3-17): the agent heard a voicemail greeting and left no message.
        when v_unreached and p_metrics ->> 'answeredBy' = 'machine' then 'voicemail'::call_status
        when v_unreached then 'no_answer'::call_status
        when call_status_rank(status) < 3 then 'completed'::call_status
        else status end
    where id = c.id
    returning * into c;
  if v_unreached then
    -- Nothing was said: no post-call job; the `missed_call` text instead (F6 step 1, F11).
    v_job := enqueue_job('place_call', jsonb_build_object('phase', 'missed', 'callId', c.id),
                         null, 'call_missed:' || c.id);
  elsif c.reporter_id is not null then
    v_job := enqueue_job('post_call_reconcile', jsonb_build_object('callId', c.id), null,
                         'post_call:' || c.id);
  end if;
  perform log_audit(c.org_id, 'agent', null, 'call.ended', 'call', c.id,
    jsonb_build_object('outcome', p_outcome, 'duration_s', c.duration_s, 'status', c.status,
                       'turns', p_metrics -> 'turns', 'job_id', v_job));
  return jsonb_build_object('ended', true, 'outcome', c.outcome, 'jobId', v_job);
end $$;

-- 7. voice_schedule_callback ----------------------------------------------------------------------------------
create function voice_schedule_callback(p_call_id uuid, p_at timestamptz, p_minutes int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_key text;
  v_job bigint;
begin
  if p_at is null or p_minutes is null or p_minutes < 1 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    raise exception 'call_ended' using errcode = 'P0001';
  end if;
  if c.reporter_id is null then
    raise exception 'unknown_caller' using errcode = 'P0001';
  end if;
  if c.site_day_id is null then
    raise exception 'site_required' using errcode = 'P0001';
  end if;
  -- §19 Q131: a callback is an automated call too.
  if not org_places_calls(c.org_id)
     or not coalesce((select os.auto_call_enabled from org_settings os where os.org_id = c.org_id), true)
     or not exists (
      select 1 from consents k where k.reporter_id = c.reporter_id and k.type = 'auto_call'
         and k.revoked_at is null and k.method <> 'office_attested') then
    raise exception 'not_available' using errcode = 'P0001';
  end if;
  v_key := 'call:' || c.site_day_id || ':' || c.reporter_id || ':callback';
  -- §19 Q128: one callback the reporter asked for per site-day.
  if exists (select 1 from jobs j where j.dedupe_key = v_key)
     or exists (select 1 from calls x where x.site_day_id = c.site_day_id
                  and x.reporter_id = c.reporter_id and x.direction = 'outbound' and x.attempt = 3) then
    return jsonb_build_object('status', 'limit_reached');
  end if;
  v_job := enqueue_job('place_call',
                       jsonb_build_object('reporterId', c.reporter_id, 'siteDayId', c.site_day_id,
                                          'stage', 'callback', 'requestedOn', c.id),
                       p_at, v_key);
  perform log_audit(c.org_id, 'agent', null, 'call.callback_requested', 'call', c.id,
    jsonb_build_object('at', p_at, 'minutes', p_minutes, 'site_day_id', c.site_day_id,
                       'job_id', v_job));
  return jsonb_build_object('status', 'scheduled', 'at', p_at, 'jobId', v_job);
end $$;

-- 8. The M8 measure ------------------------------------------------------------------------------------------
-- Per org and ISO week (Monday): the site-days SiteLog called a reporter about (an outbound ladder
-- call or callback), and those filed by the reporter's yes on such a call (the call's outcome
-- `filed`: code filed it on the reporter's words, no office step in between).
create function outbound_call_share(p_org_id uuid, p_from date, p_to date)
returns table (org_id uuid, week_start date, call_days int, filed_by_call int)
language sql stable security definer set search_path = public as $$
  with called as (
    select s.org_id, sd.id as site_day_id, date_trunc('week', sd.date)::date as week_start,
           bool_or(x.outcome = 'filed') as filed
      from calls x
      join site_days sd on sd.id = x.site_day_id
      join sites s on s.id = sd.site_id
     where x.direction = 'outbound' and x.purpose in ('reminder', 'callback')
       and (p_org_id is null or s.org_id = p_org_id)
       and sd.date between p_from and p_to
     group by s.org_id, sd.id, sd.date
  )
  select called.org_id, called.week_start, count(*)::int,
         count(*) filter (where called.filed)::int
    from called
   group by called.org_id, called.week_start
   order by called.week_start, called.org_id;
$$;

create function ops_outbound_call_share(p_weeks int default 8)
returns table (org_id uuid, org_name text, is_demo boolean, week_start date, call_days int,
               filed_by_call int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select x.org_id, o.name, o.is_demo, x.week_start, x.call_days, x.filed_by_call
      from outbound_call_share(null,
             (date_trunc('week', now())::date - 7 * (greatest(1, least(coalesce(p_weeks, 8), 52)) - 1)),
             (now() at time zone 'UTC')::date) x
      join orgs o on o.id = x.org_id
     order by x.week_start desc, o.name;
end $$;

-- Grants ----------------------------------------------------------------------------------------------------
revoke execute on function org_places_calls(uuid),
  field_no_calls_today(uuid, uuid, timestamptz),
  claim_site_day_reminder(uuid, text, jsonb, jsonb, timestamptz, jsonb),
  outbound_call_start(uuid, uuid, text, timestamptz, text, int),
  outbound_call_ringing(uuid),
  outbound_call_unanswered(uuid, call_status, text),
  voice_schedule_callback(uuid, timestamptz, int),
  outbound_call_share(uuid, date, date)
  from public, anon, authenticated;
grant execute on function org_places_calls(uuid),
  field_no_calls_today(uuid, uuid, timestamptz),
  claim_site_day_reminder(uuid, text, jsonb, jsonb, timestamptz, jsonb),
  outbound_call_start(uuid, uuid, text, timestamptz, text, int),
  outbound_call_ringing(uuid),
  outbound_call_unanswered(uuid, call_status, text),
  voice_schedule_callback(uuid, timestamptz, int),
  outbound_call_share(uuid, date, date)
  to service_role;
revoke execute on function ops_outbound_call_share(int) from public, anon;
grant execute on function ops_outbound_call_share(int) to authenticated;
