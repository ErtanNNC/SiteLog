-- SiteLog · Settings' Call me now: a short scripted test call to the admin's own phone (W4-05;
-- spec P12 Field channels, §19 Q232's recommended default, §19 Q350)
--
--   1. settings_test_call_start() (admin, the panel's RPC): one test call to a number the admin
--      types in the sheet and attests is their own, only where the org places calls (a demo org's
--      `console` telephony, or a pack with an outbound trunk here, §19 Q132). Refusals write
--      nothing and answer their reason (`{status: 'refused', reason}`): `attestation_required`,
--      `invalid_phone` (not E.164), `no_trunk`, `call_live` (a test call of the org still queued,
--      ringing or in progress) and `rate_limited` (five an hour per org, its own budget beside the
--      test message's, counted on the `settings.test_call` audit rows under a per-org advisory
--      lock, with `retry_at`). Then, in one transaction: the `calls` row (outbound, pstn, purpose
--      `settings_test`, no reporter, no site, `attempt` null, queued, `call-{id}`, the language the
--      admin picked among the pack's field locales, the pack's voice number as caller id), audited
--      `settings.test_call` (the number masked, `+1555***290`) and `call.requested`; one
--      `place_call {phase: settings_test}` keyed `call:settings_test:<call>`.
--      The number is not stored: the call row holds it in `to_e164` only until the worker dials
--      (step 2 hands it to the telephony and blanks it in the same transaction); a call ended
--      before its dial is blanked too. Every audit row has it masked.
--   2. settings_test_call_dial() (the worker's place_call, service only): the call still queued
--      and younger than ten minutes (`stale` after), the org still placing calls, capacity on
--      LiveKit (§19 Q127, as office_call_dial()), else the call ends `failed` / `not_reached` with
--      its reason, audited; a skip the worker found (no telephony here) comes as `p_skip`. Answers
--      the number for the dial and blanks it.
--   3. voice_call_start() (20261016000390's, same signature): a known outbound call with no
--      reporter starts when it is a test call (`settings_test`; anything else stays
--      `call_conflict`), and every answer names the call's `purpose`, so field-api answers the
--      agent `settingsTest` (the short script: disclosure, one line, goodbye; nothing recorded,
--      no report tool).
--
-- The ladder, Team's Call now and the post-call job are unchanged: a test call has no reporter,
-- so voice_call_end() and voice-events' backstop queue no post_call_reconcile for it, and the
-- worker's missed step texts nobody.
--
-- Live database (staging): new functions and one function replacement with the same signature.
-- No table change; no existing row is written.

set local lock_timeout = '5s';

-- 1. Call me now ----------------------------------------------------------------------------------------------
create function settings_test_call_start(
  p_org_id uuid,
  p_phone_e164 text,
  p_language text,
  p_attested boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org orgs%rowtype;
  v_pack countries%rowtype;
  v_phone text := btrim(p_phone_e164);
  v_digits text;
  v_masked text;
  v_locale text;
  v_count int;
  v_oldest timestamptz;
  v_max constant int := 5;  -- SETTINGS_TEST_CALL_POLICY.maxPerHour (§19 Q350)
  v_now timestamptz := now();
  v_id uuid := gen_random_uuid();
  v_room text;
  v_telephony text;
  v_job bigint;
begin
  if not has_role(p_org_id, '{admin}') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_language is null or p_language not in ('en', 'es', 'tr') then
    raise exception 'invalid_language' using errcode = '22023';
  end if;
  select * into v_org from orgs where id = p_org_id;
  select * into v_pack from countries where code = v_org.country;

  if not coalesce(p_attested, false) then
    return jsonb_build_object('status', 'refused', 'reason', 'attestation_required');
  end if;
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    return jsonb_build_object('status', 'refused', 'reason', 'invalid_phone');
  end if;
  if not org_places_calls(p_org_id) then
    return jsonb_build_object('status', 'refused', 'reason', 'no_trunk');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('settings_test_call:' || p_org_id::text, 0));
  -- One at a time: a test call of the org still open (a row older than a call can last is stale).
  if exists (select 1 from calls x
              where x.org_id = p_org_id and x.purpose = 'settings_test' and x.ended_at is null
                and x.status in ('queued', 'ringing', 'in_progress')
                and x.created_at > v_now - interval '20 minutes') then
    return jsonb_build_object('status', 'refused', 'reason', 'call_live');
  end if;
  select count(*), min(created_at) into v_count, v_oldest
    from audit_log
   where org_id = p_org_id and action = 'settings.test_call'
     and created_at > v_now - interval '1 hour';
  if v_count >= v_max then
    return jsonb_build_object('status', 'refused', 'reason', 'rate_limited',
                              'retry_at', v_oldest + interval '1 hour');
  end if;

  -- The call's language: the pack's field locale of the language picked, else its first.
  select l into v_locale from unnest(v_pack.field_locales) l
   where split_part(l, '-', 1) = p_language limit 1;
  v_locale := coalesce(v_locale, v_pack.field_locales[1], 'en-US');
  v_digits := regexp_replace(v_phone, '\D', '', 'g');
  v_masked := '+' || left(v_digits, 4) || '***' || right(v_digits, 3);
  v_telephony := case when v_org.is_demo then 'console' else 'livekit' end;
  v_room := 'call-' || v_id::text;

  insert into calls (id, org_id, reporter_id, site_id, site_day_id, direction, transport, purpose,
                     attempt, provider_call_id, status, language, to_e164, from_e164, metrics)
  values (v_id, p_org_id, null, null, null, 'outbound', 'pstn', 'settings_test',
          null, v_room, 'queued', v_locale, v_phone, v_pack.voice_number,
          jsonb_build_object('telephony', v_telephony, 'stage', 'settings_test',
                             'via', 'settings', 'requested_by', auth.uid(), 'to_masked', v_masked));
  perform log_audit(p_org_id, 'user', auth.uid(), 'settings.test_call', 'org', p_org_id,
    jsonb_build_object('to', v_masked, 'telephony', v_telephony, 'language', p_language,
                       'call_id', v_id));
  perform log_audit(p_org_id, 'user', auth.uid(), 'call.requested', 'call', v_id,
    jsonb_build_object('direction', 'outbound', 'transport', 'pstn', 'purpose', 'settings_test',
                       'stage', 'settings_test', 'via', 'settings', 'telephony', v_telephony,
                       'to', v_masked, 'room', v_room));

  v_job := enqueue_job('place_call', jsonb_build_object('phase', 'settings_test', 'callId', v_id),
                       null, 'call:settings_test:' || v_id);
  return jsonb_build_object('status', 'requested', 'callId', v_id, 'telephony', v_telephony,
                            'jobId', v_job);
end $$;

comment on function settings_test_call_start(uuid, text, text, boolean) is
  'W4-05 (P12, §19 Q232, Q350): Settings'' Call me now, a short scripted test call to the admin''s own number; admin only.';

-- 2. The worker's dial of a test call -------------------------------------------------------------------------
create function settings_test_call_dial(
  p_call_id uuid, p_telephony text, p_max_concurrent int default null, p_skip text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_reason text := p_skip;
  v_open int;
  v_to text;
begin
  if (p_telephony is null and p_skip is null)
     or (p_telephony is not null and p_telephony not in ('livekit', 'console'))
     or (p_skip is not null and p_skip !~ '^[a-z0-9_]{1,40}$') then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls
   where id = p_call_id and direction = 'outbound' and purpose = 'settings_test' for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null or c.status <> 'queued' then
    update calls set to_e164 = null where id = c.id and to_e164 is not null;
    return jsonb_build_object('status', 'gone', 'callStatus', c.status);
  end if;
  if v_reason is null then
    if c.created_at < now() - interval '10 minutes' then
      v_reason := 'stale';
    elsif not org_places_calls(c.org_id) then
      v_reason := 'no_trunk';
    elsif c.to_e164 is null then
      v_reason := 'no_number';
    elsif p_telephony = 'livekit' and p_max_concurrent is not null then
      perform pg_advisory_xact_lock(hashtext('outbound_call_capacity'));
      select count(*) into v_open
        from calls x join orgs o on o.id = x.org_id
       where x.id <> c.id and x.ended_at is null and x.status in ('queued', 'ringing', 'in_progress')
         and x.created_at > now() - interval '20 minutes' and not o.is_demo;
      if v_open >= p_max_concurrent then v_reason := 'capacity'; end if;
    end if;
  end if;
  if v_reason is not null then
    update calls set
        status = 'failed',
        outcome = 'not_reached',
        ended_at = now(),
        duration_s = 0,
        to_e164 = null,
        metrics = coalesce(metrics, '{}'::jsonb) || jsonb_build_object('unanswered', v_reason)
      where id = c.id;
    perform log_audit(c.org_id, 'system', null, 'call.ended', 'call', c.id,
      jsonb_build_object('outcome', 'not_reached', 'status', 'failed', 'direction', 'outbound',
                         'stage', 'settings_test', 'reason', v_reason));
    return jsonb_build_object('status', 'skipped', 'reason', v_reason);
  end if;
  v_to := c.to_e164;
  update calls set
      to_e164 = null,
      metrics = coalesce(metrics, '{}'::jsonb) || jsonb_build_object('telephony', p_telephony)
   where id = c.id;
  return jsonb_build_object('status', 'dial', 'callId', c.id, 'room', c.provider_call_id,
                            'to', v_to, 'from', c.from_e164);
end $$;

comment on function settings_test_call_dial(uuid, text, int, text) is
  'W4-05 (§19 Q232, Q350): the worker''s last check before it dials a test call; hands the number over and blanks it; service only.';

-- 3. voice_call_start: a test call starts with no reporter --------------------------------------------------
-- 20261016000390's function; the changes are marked W4-05.
create or replace function voice_call_start(
  p_room text, p_transport call_transport, p_call_id uuid default null,
  p_from text default null, p_to text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_pack text;
  v_rep reporters%rowtype;
  v_site uuid;
  v_site_rep uuid;
  v_pairs int;
  v_candidates int;
  v_id uuid;
  -- The room's own call id: `call-{uuid}` (a room SiteLog named), else null (a room sid, §19 Q227).
  v_room_call uuid;
begin
  if p_room is null or p_room !~ '^(call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|RM_[A-Za-z0-9]{1,64})$' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if p_room ~ '^call-' then
    v_room_call := substr(p_room, 6)::uuid;
  elsif p_call_id is not null or p_transport <> 'pstn' then
    -- A room sid keys only an inbound phone call; Talk now and outbound rooms are `call-{id}`.
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  -- The room's call already started: the same answer (the agent retried).
  select * into c from calls where provider_call_id = p_room for update;
  if c.id is not null then
    if (p_call_id is not null and c.id <> p_call_id) or c.transport <> p_transport
       or (p_call_id is null and c.from_e164 is distinct from p_from) then
      raise exception 'call_conflict' using errcode = 'P0001';
    end if;
    if c.ended_at is not null then
      raise exception 'call_ended' using errcode = 'P0001';
    end if;
    if c.call_token_issued_at is not null then
      return jsonb_build_object('callId', c.id, 'reporterId', c.reporter_id, 'orgId', c.org_id,
                                'siteId', c.site_id, 'purpose', c.purpose, 'repeat', true);
    end if;
  elsif p_call_id is not null then
    -- Talk now (W3-13) and outbound calls (W3-17): the row exists before the room.
    select * into c from calls where id = p_call_id for update;
    if c.id is null then
      raise exception 'call_not_found' using errcode = 'P0002';
    end if;
    if c.transport <> p_transport
       or (c.provider_call_id is not null and c.provider_call_id <> p_room) then
      raise exception 'call_conflict' using errcode = 'P0001';
    end if;
    if c.ended_at is not null then
      raise exception 'call_ended' using errcode = 'P0001';
    end if;
  end if;

  if c.id is not null and c.reporter_id is null then
    -- W4-05 (§19 Q232, Q350): Settings' Call me now, a test call with no reporter.
    if c.direction <> 'outbound' or c.purpose is distinct from 'settings_test' then
      raise exception 'call_conflict' using errcode = 'P0001';
    end if;
    update calls set
        provider_call_id = p_room,
        status = case when status in ('queued', 'ringing') then 'in_progress'::call_status else status end,
        started_at = coalesce(started_at, now()),
        answered_at = coalesce(answered_at, now()),
        call_token_issued_at = now(),
        to_e164 = null
      where id = c.id
      returning * into c;
    perform log_audit(c.org_id, 'agent', null, 'call.started', 'call', c.id,
      jsonb_build_object('direction', c.direction, 'transport', c.transport,
                         'purpose', c.purpose, 'room', p_room));
    return jsonb_build_object('callId', c.id, 'reporterId', null, 'orgId', c.org_id,
                              'siteId', null, 'purpose', c.purpose, 'repeat', false);
  end if;

  if c.id is not null then
    -- A known call starts: the agent is in the room, the reporter is on the line.
    select * into v_rep from reporters where id = c.reporter_id;
    if v_rep.id is null or v_rep.status = 'disabled' then
      raise exception 'reporter_disabled' using errcode = 'P0001';
    end if;
    update calls set
        provider_call_id = p_room,
        status = case when status in ('queued', 'ringing') then 'in_progress'::call_status else status end,
        started_at = coalesce(started_at, now()),
        answered_at = coalesce(answered_at, now()),
        call_token_issued_at = now(),
        language = coalesce(language, v_rep.locale),
        site_day_id = coalesce(site_day_id, case when site_id is not null
                                                 then call_site_day(site_id, coalesce(started_at, now())) end)
      where id = c.id
      returning * into c;
    perform log_audit(c.org_id, 'agent', null, 'call.started', 'call', c.id,
      jsonb_build_object('direction', c.direction, 'transport', c.transport,
                         'reporter_id', c.reporter_id, 'site_id', c.site_id, 'room', p_room));
    return jsonb_build_object('callId', c.id, 'reporterId', c.reporter_id, 'orgId', c.org_id,
                              'siteId', c.site_id, 'purpose', c.purpose, 'repeat', false);
  end if;

  -- A SIP call into a pack's number: a `call-{uuid}` room names the call; a room the dispatch
  -- rule named is keyed by its sid and the call gets a new id (§19 Q227).
  if p_transport <> 'pstn' or p_from is null or p_to is null
     or p_from !~ '^\+[1-9][0-9]{6,14}$' or p_to !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_id := coalesce(v_room_call, gen_random_uuid());
  if exists (select 1 from calls where id = v_id) then
    raise exception 'call_conflict' using errcode = 'P0001';
  end if;
  select code into v_pack from countries where voice_number = p_to;
  if v_pack is null then
    raise exception 'voice_number_unknown' using errcode = 'P0002';
  end if;

  -- §19 Q44: the caller among the pack's real orgs; one row is the call's, the sites of every
  -- one of them are asked about (F14) until the call's site is known.
  select count(*) into v_candidates
    from reporters r join orgs o on o.id = r.org_id
   where r.phone_e164 = p_from and o.country = v_pack and not o.is_demo and r.status <> 'disabled';
  select r.* into v_rep
    from reporters r join orgs o on o.id = r.org_id
   where r.phone_e164 = p_from and o.country = v_pack and not o.is_demo and r.status <> 'disabled'
   order by case r.status when 'active' then 0 when 'invited' then 1 else 2 end, r.created_at desc
   limit 1;
  if v_rep.id is not null then
    -- One active site among them: the call's site from the start.
    select count(*), min(sr.site_id::text)::uuid, min(sr.reporter_id::text)::uuid
      into v_pairs, v_site, v_site_rep
      from site_reporters sr
      join reporters r on r.id = sr.reporter_id
      join orgs o on o.id = r.org_id
      join sites s on s.id = sr.site_id and s.org_id = r.org_id
     where r.phone_e164 = p_from and o.country = v_pack and not o.is_demo
       and r.status <> 'disabled' and s.status = 'active';
    if v_pairs = 1 then
      select * into v_rep from reporters where id = v_site_rep;
    else
      v_site := null;
    end if;
  end if;

  insert into calls (id, org_id, reporter_id, site_id, direction, transport, purpose,
                     provider_call_id, from_e164, to_e164, status, started_at, answered_at,
                     call_token_issued_at, language, site_day_id)
  values (v_id, v_rep.org_id, v_rep.id, v_site, 'inbound', 'pstn', 'daily_report',
          p_room, p_from, p_to, 'in_progress', now(), now(), now(), v_rep.locale,
          case when v_site is not null then call_site_day(v_site, now()) end)
  returning * into c;
  perform log_audit(c.org_id, 'agent', null, 'call.started', 'call', c.id,
    jsonb_build_object('direction', 'inbound', 'transport', 'pstn', 'pack', v_pack,
                       'reporter_id', c.reporter_id, 'site_id', c.site_id, 'room', p_room,
                       'unknown', v_rep.id is null, 'orgs', v_candidates));
  return jsonb_build_object('callId', c.id, 'reporterId', c.reporter_id, 'orgId', c.org_id,
                            'siteId', c.site_id, 'purpose', c.purpose, 'repeat', false);
end $$;

-- Grants ------------------------------------------------------------------------------------------------------
revoke execute on function settings_test_call_start(uuid, text, text, boolean) from public, anon;
grant execute on function settings_test_call_start(uuid, text, text, boolean)
  to authenticated, service_role;
revoke execute on function settings_test_call_dial(uuid, text, int, text)
  from public, anon, authenticated;
grant execute on function settings_test_call_dial(uuid, text, int, text) to service_role;
revoke execute on function voice_call_start(text, call_transport, uuid, text, text)
  from public, anon, authenticated;
grant execute on function voice_call_start(text, call_transport, uuid, text, text) to service_role;
