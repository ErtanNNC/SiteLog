-- SiteLog · Team's Call now with the office's attestation (W4-04; spec F3 edge cases, P10 row
-- menu, §9.4 "Calls policy", §15.2 (TCPA: prior express consent), §19 Q131, Q128, Q230's
-- recommended default `OFFICE_CALL_POLICY`, Q330)
--
--   1. office_call_start() (admin and ops, the panel's RPC): one call to a reporter now, about
--      today's report at one of their sites (purpose `daily_report`), only with the office's
--      attestation that the person agreed to get calls from SiteLog. Its guards, in one
--      transaction under the reporter's and the site-day's locks: the attestation; the org places
--      calls (a demo org's `console` telephony, or a pack with an outbound trunk here, §19 Q132);
--      the reporter neither disabled nor opted out of texts; not a reporter who turned automated
--      calls off themselves (their own latest `auto_call` consent revoked: the office never
--      overrides it); not "Don't call me today" (§19 Q129); the site active; inside the org's call
--      window at the site (§9.4); today's site-day not filed (filed, weather day, no work, or a
--      filed report); no call to the reporter live; at most OFFICE_CALL_POLICY.maxPerDay office
--      calls a site-day and reporter (§19 Q330). A refusal writes nothing and answers its reason
--      (`{status: 'refused', reason}`); the panel words it.
--      Then: the attestation as an `auto_call` consent `office_attested` (the office user, the
--      wording's version and the call in its evidence), audited `consent.given` via office; the
--      `calls` row (outbound, pstn, `daily_report`, queued, `call-{id}`, attempt null: outside
--      §19 Q128's ladder attempts), audited `call.requested` via office with the office user; and
--      one `place_call {phase: office}` job keyed `call:<site_day>:<reporter>:office:<n>`.
--   2. office_call_dial() (the worker's place_call, service only): the call still queued, the day
--      still not filed and, for the `livekit` telephony, the capacity (§19 Q127, the open calls of
--      real orgs); else the call ends `failed` / `not_reached` with its reason, audited. An office
--      call that is not reached gets no `missed_call` text (§19 Q230: the office sees the outcome).
--   3. field_grant_consent(): an office attestation is not the reporter's own consent (§19 Q131),
--      so it never stands in for Settings' *Turn on*: the reporter's own `auto_call` is stored
--      beside it. (field-api's views read the reporter's own consents the same way.)
--
-- The ladder is unchanged: outbound_call_start() and voice_schedule_callback() already ignore
-- `office_attested` (§19 Q131).
--
-- Live database (staging): new functions and one function replacement with the same signature.
-- No table change; no existing row is written.

set local lock_timeout = '5s';

-- 1. Call now -----------------------------------------------------------------------------------------------
create function office_call_start(
  p_reporter_id uuid,
  p_site_id uuid,
  p_text_version text,
  p_attested boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  v_org orgs%rowtype;
  v_pack countries%rowtype;
  v_now timestamptz := now();
  v_local time;
  v_start time;
  v_end time;
  v_inside boolean;
  v_own consents%rowtype;
  v_n int;
  v_max constant int := 3;  -- OFFICE_CALL_POLICY.maxPerDay (§19 Q330)
  v_id uuid := gen_random_uuid();
  v_room text;
  v_key text;
  v_job bigint;
  v_consent uuid;
  v_telephony text;
  v_version text := btrim(p_text_version);
begin
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then raise exception 'reporter not found' using errcode = 'P0002'; end if;
  if not has_role(r.org_id, '{admin,ops}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_version is null or v_version = '' or length(v_version) > 64 then
    raise exception 'text_version required' using errcode = '22023';
  end if;
  select * into s from sites where id = p_site_id and org_id = r.org_id;
  if s.id is null or not exists (select 1 from site_reporters sr
                                  where sr.site_id = s.id and sr.reporter_id = r.id) then
    raise exception 'site not found' using errcode = 'P0002';
  end if;
  select * into v_org from orgs where id = r.org_id;
  select * into v_pack from countries where code = v_org.country;

  if not coalesce(p_attested, false) then
    return jsonb_build_object('status', 'refused', 'reason', 'attestation_required');
  end if;
  if not org_places_calls(r.org_id) then
    return jsonb_build_object('status', 'refused', 'reason', 'no_trunk');
  end if;
  if r.status in ('disabled', 'opted_out') then
    return jsonb_build_object('status', 'refused', 'reason', 'reporter_inactive');
  end if;
  -- The reporter's own word wins: their latest own `auto_call` consent revoked = calls off.
  select * into v_own from consents k
   where k.reporter_id = r.id and k.type = 'auto_call' and k.method <> 'office_attested'
   order by k.given_at desc, k.id desc limit 1;
  if v_own.id is not null and v_own.revoked_at is not null then
    return jsonb_build_object('status', 'refused', 'reason', 'calls_turned_off');
  end if;
  if r.no_calls_until is not null and r.no_calls_until > v_now then
    return jsonb_build_object('status', 'refused', 'reason', 'no_calls_today');
  end if;
  if s.status <> 'active' then
    return jsonb_build_object('status', 'refused', 'reason', 'site_not_active');
  end if;
  -- §9.4: inside the org's call window at the site (DEFAULT_CALL_WINDOW 07:00–20:00).
  select coalesce(os.call_window_start, '07:00'::time), coalesce(os.call_window_end, '20:00'::time)
    into v_start, v_end from org_settings os where os.org_id = r.org_id;
  v_start := coalesce(v_start, '07:00'::time);
  v_end := coalesce(v_end, '20:00'::time);
  v_local := (v_now at time zone s.timezone)::time;
  v_inside := case
    when v_start = v_end then false
    when v_start < v_end then v_local >= v_start and v_local < v_end
    else v_local >= v_start or v_local < v_end end;
  if not v_inside then
    return jsonb_build_object('status', 'refused', 'reason', 'outside_window');
  end if;

  sd := field_lock_site_day(s.id, (v_now at time zone s.timezone)::date);
  if sd.status in ('filed', 'weather_day', 'no_work')
     or exists (select 1 from reports x where x.site_day_id = sd.id
                 and x.status in ('filed', 'signed_off')) then
    return jsonb_build_object('status', 'refused', 'reason', 'day_filed');
  end if;
  -- One call at a time: a call to the reporter still open (a row older than a call can last is
  -- stale, as outbound_call_start()'s capacity count reads it).
  if exists (select 1 from calls x
              where x.reporter_id = r.id and x.ended_at is null
                and x.status in ('queued', 'ringing', 'in_progress')
                and x.created_at > v_now - interval '20 minutes') then
    return jsonb_build_object('status', 'refused', 'reason', 'call_live');
  end if;
  select count(*) into v_n from calls x
   where x.site_day_id = sd.id and x.reporter_id = r.id and x.direction = 'outbound'
     and x.purpose = 'daily_report';
  if v_n >= v_max then
    return jsonb_build_object('status', 'refused', 'reason', 'limit_reached');
  end if;
  v_n := v_n + 1;

  -- The office's attestation (§19 Q131, Q230): an `auto_call` consent the ladder never reads.
  insert into consents (reporter_id, type, method, text_version, evidence)
  values (r.id, 'auto_call', 'office_attested', v_version,
          jsonb_build_object('user_id', auth.uid(), 'via', 'office', 'at', v_now, 'call_id', v_id))
  returning id into v_consent;
  perform log_audit(r.org_id, 'user', auth.uid(), 'consent.given', 'consent', v_consent,
    jsonb_build_object('type', 'auto_call', 'method', 'office_attested', 'text_version', v_version,
                       'via', 'office', 'reporter_id', r.id, 'call_id', v_id));

  v_telephony := case when v_org.is_demo then 'console' else 'livekit' end;
  v_room := 'call-' || v_id::text;
  insert into calls (id, org_id, reporter_id, site_id, site_day_id, direction, transport, purpose,
                     attempt, provider_call_id, status, language, to_e164, from_e164, metrics)
  values (v_id, r.org_id, r.id, s.id, sd.id, 'outbound', 'pstn', 'daily_report',
          null, v_room, 'queued', r.locale, r.phone_e164, v_pack.voice_number,
          jsonb_build_object('telephony', v_telephony, 'stage', 'office', 'via', 'office',
                             'requested_by', auth.uid(), 'office_call', v_n,
                             'consent_id', v_consent));
  perform log_audit(r.org_id, 'user', auth.uid(), 'call.requested', 'call', v_id,
    jsonb_build_object('direction', 'outbound', 'transport', 'pstn', 'purpose', 'daily_report',
                       'stage', 'office', 'via', 'office', 'office_call', v_n,
                       'telephony', v_telephony, 'site_id', s.id, 'site_day_id', sd.id,
                       'reporter_id', r.id, 'room', v_room, 'consent_id', v_consent));

  v_key := 'call:' || sd.id || ':' || r.id || ':office:' || v_n;
  v_job := enqueue_job('place_call', jsonb_build_object('phase', 'office', 'callId', v_id),
                       null, v_key);
  return jsonb_build_object('status', 'requested', 'callId', v_id, 'consentId', v_consent,
                            'siteDayId', sd.id, 'jobId', v_job);
end $$;

comment on function office_call_start(uuid, uuid, text, boolean) is
  'W4-04 (F3, §19 Q230): Team''s Call now with the office''s attestation (auto_call office_attested); admin and ops.';

-- 2. The worker's dial of an office call ---------------------------------------------------------------------
create function office_call_dial(p_call_id uuid, p_telephony text, p_max_concurrent int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_reason text;
  v_open int;
begin
  if p_telephony is null or p_telephony not in ('livekit', 'console') then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls
   where id = p_call_id and direction = 'outbound' and purpose = 'daily_report' for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null or c.status <> 'queued' then
    return jsonb_build_object('status', 'gone', 'callStatus', c.status);
  end if;
  if exists (select 1 from site_days sd where sd.id = c.site_day_id
                and sd.status in ('filed', 'weather_day', 'no_work'))
     or exists (select 1 from reports x where x.site_day_id = c.site_day_id
                 and x.status in ('filed', 'signed_off')) then
    v_reason := 'day_filed';
  elsif p_telephony = 'livekit' and p_max_concurrent is not null then
    perform pg_advisory_xact_lock(hashtext('outbound_call_capacity'));
    select count(*) into v_open
      from calls x join orgs o on o.id = x.org_id
     where x.id <> c.id and x.ended_at is null and x.status in ('queued', 'ringing', 'in_progress')
       and x.created_at > now() - interval '20 minutes' and not o.is_demo;
    if v_open >= p_max_concurrent then v_reason := 'capacity'; end if;
  end if;
  if v_reason is not null then
    update calls set
        status = 'failed',
        outcome = 'not_reached',
        ended_at = now(),
        duration_s = 0,
        metrics = coalesce(metrics, '{}'::jsonb) || jsonb_build_object('unanswered', v_reason)
      where id = c.id;
    perform log_audit(c.org_id, 'system', null, 'call.ended', 'call', c.id,
      jsonb_build_object('outcome', 'not_reached', 'status', 'failed', 'direction', 'outbound',
                         'stage', 'office', 'reason', v_reason));
    return jsonb_build_object('status', 'skipped', 'reason', v_reason);
  end if;
  update calls set metrics = coalesce(metrics, '{}'::jsonb)
                             || jsonb_build_object('telephony', p_telephony)
   where id = c.id;
  return jsonb_build_object('status', 'dial', 'callId', c.id, 'room', c.provider_call_id,
                            'to', c.to_e164, 'from', c.from_e164);
end $$;

comment on function office_call_dial(uuid, text, int) is
  'W4-04 (§19 Q230): the worker''s last check before it dials an office call; service only.';

-- 3. Settings' Turn on beside an office attestation -----------------------------------------------------------
-- 20261016000380's function: an `office_attested` auto_call is not the reporter's own consent.
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

  -- W4-04 (§19 Q131): the office's attestation is not the reporter's own consent.
  if exists (select 1 from consents
             where reporter_id = p_reporter_id and type = p_type and revoked_at is null
               and not (type = 'auto_call' and method = 'office_attested')) then
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

revoke execute on function office_call_start(uuid, uuid, text, boolean) from public, anon;
grant execute on function office_call_start(uuid, uuid, text, boolean)
  to authenticated, service_role;
revoke execute on function office_call_dial(uuid, text, int) from public, anon, authenticated;
grant execute on function office_call_dial(uuid, text, int) to service_role;
