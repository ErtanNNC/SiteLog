-- SiteLog · the room of an inbound phone call (§19 Q227; spec §5.2 "Demo setup" step 1, §9.4 "How a
-- call starts", §4.2 `voice-events`)
--
-- LiveKit's SIP dispatch rules name an inbound call's room themselves (an individual rule:
-- `{room prefix}_{caller number}_{random}`), so such a room is never `call-{uuid}` and its name
-- carries the caller's number. A call's room is now keyed by its *room key*: the name when SiteLog
-- named the room (`call-{uuid}`: Talk now and outbound calls, §19 Q157, unchanged), else the room's
-- sid (`RM_…`, LiveKit's random id, no number in it). The dispatch rule's room name is never
-- stored, logged or audited.
--
--   1. livekit_events.room: `call-{uuid}` or a room sid.
--   2. voice_call_start(): the room is a room key; a room sid only for an inbound phone call
--      (`pstn`, no call id: Talk now and outbound calls name their `call-{id}` room). A new SIP
--      call in a sid-keyed room gets a new id (a `call-{uuid}` room still gives its uuid); its
--      `provider_call_id` is the sid. Same signature, same answers, same audit (`room` the key).
--   3. voice_call_event(): the room is a room key; the call by `provider_call_id`, else (a
--      `call-{uuid}` room only) the row with the room's uuid and no room yet. Same signature.
--
-- Live database (staging): one check constraint replaced on a table whose rows all pass it
-- (every stored room is `call-{uuid}`), two functions replaced with the same signatures (service
-- only). The deployed v1.0 code touches none of them.

set local lock_timeout = '5s';

-- 1. livekit_events.room ---------------------------------------------------------------------------------
alter table livekit_events drop constraint livekit_events_room_check;
alter table livekit_events add constraint livekit_events_room_check
  check (room ~ '^(call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|RM_[A-Za-z0-9]{1,64})$');

comment on column livekit_events.room is
  '§19 Q227: the room key: its name when SiteLog named it (call-{uuid}), else its sid (RM_…, an inbound phone call''s room named by the SIP dispatch rule). Never a dispatch rule''s room name.';

-- 2. voice_call_start ------------------------------------------------------------------------------------
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
                                'siteId', c.site_id, 'repeat', true);
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

  if c.id is not null then
    -- A known call starts: the agent is in the room, the reporter is on the line.
    if c.reporter_id is null then
      raise exception 'call_conflict' using errcode = 'P0001';
    end if;
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
                              'siteId', c.site_id, 'repeat', false);
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
                            'siteId', c.site_id, 'repeat', false);
end $$;

-- 3. voice_call_event ------------------------------------------------------------------------------------
create or replace function voice_call_event(
  p_event_id text, p_event text, p_room text, p_at timestamptz,
  p_status call_status default null, p_detail jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  n calls%rowtype;
  v_at timestamptz := least(coalesce(p_at, now()), now());
  v_status call_status := p_status;
  v_diff jsonb := '{}';
  v_changed boolean := false;
  v_ended boolean := false;
  v_outcome call_outcome;
  v_report reports%rowtype;
  v_job bigint;
  v_claimed text;
  -- The room's own call id: `call-{uuid}`, else null (a room sid, §19 Q227).
  v_room_call uuid;
begin
  if p_event_id is null or p_event_id !~ '^[A-Za-z0-9_.:-]{1,128}$'
     or p_event is null or p_event not in ('room_started', 'participant_joined', 'track_published',
                                           'participant_left', 'room_finished')
     or p_room is null
     or p_room !~ '^(call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|RM_[A-Za-z0-9]{1,64})$'
     or jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  if p_room ~ '^call-' then
    v_room_call := substr(p_room, 6)::uuid;
  end if;

  -- The event once: a redelivery (LiveKit retries, a replay) waits for the first to commit and
  -- then finds its row.
  insert into livekit_events (id, event, room, event_at)
  values (p_event_id, p_event, p_room, v_at)
  on conflict (id) do nothing
  returning id into v_claimed;
  if v_claimed is null then
    return jsonb_build_object('duplicate', true,
                              'callId', (select call_id from livekit_events where id = p_event_id),
                              'changed', false, 'ended', false, 'outcome', null, 'jobId', null);
  end if;

  -- The room's call: by its room key (set when the agent started the call: `call-{uuid}`, or an
  -- inbound phone call's room sid, §19 Q227), else a row named by a `call-{uuid}` room's uuid that
  -- has no room yet (Talk now and outbound rooms are named `call-{id}`, W3-13, W3-17).
  select * into c from calls
   where provider_call_id = p_room
      or (v_room_call is not null and provider_call_id is null and id = v_room_call)
   order by (provider_call_id is not null) desc
   limit 1
   for update;
  if c.id is null then
    return jsonb_build_object('duplicate', false, 'callId', null, 'changed', false,
                              'ended', false, 'outcome', null, 'jobId', null);
  end if;
  update livekit_events set call_id = c.id where id = p_event_id;

  -- The line status (§4.2: SIP status for outbound calls).
  if v_status = 'completed' and c.answered_at is null then
    v_status := 'failed';  -- hung up before anyone answered
  end if;
  if v_status is not null then
    update calls set
        status = case when call_status_rank(c.status) < 3
                       and call_status_rank(v_status) > call_status_rank(c.status)
                      then v_status else c.status end,
        answered_at = case when v_status = 'in_progress' and call_status_rank(c.status) <= 2
                           then coalesce(c.answered_at, v_at) else c.answered_at end,
        started_at = coalesce(c.started_at, case when v_status <> 'queued' then v_at end)
      where id = c.id
      returning * into n;
    if n.status <> c.status then
      v_diff := v_diff || jsonb_build_object('status', jsonb_build_object('from', c.status, 'to', n.status));
    end if;
    if n.answered_at is distinct from c.answered_at then
      v_diff := v_diff || jsonb_build_object('answered_at', n.answered_at);
    end if;
    if v_diff <> '{}' then
      v_changed := true;
      perform log_audit(c.org_id, 'system', null, 'call.updated', 'call', c.id,
        v_diff || jsonb_build_object('event', p_event, 'event_id', p_event_id)
               || coalesce(p_detail, '{}'::jsonb));
    end if;
    c := n;
  end if;

  -- The backstop: the room is gone and the agent never ended the call.
  if p_event = 'room_finished' and c.ended_at is null then
    if c.answered_at is null then
      v_outcome := 'not_reached';
    else
      select * into v_report from reports where id = c.report_id;
      v_outcome := case
        when v_report.id is null then 'abandoned'
        when v_report.status in ('filed', 'signed_off') and v_report.confirmed_via = 'voice'
             and v_report.confirmed_at >= coalesce(c.answered_at, c.started_at, c.created_at)
          then 'filed'
        when v_report.status not in ('filed', 'signed_off', 'void')
             and exists (select 1 from report_versions v where v.report_id = v_report.id)
          then 'draft_saved'
        else 'abandoned'
      end::call_outcome;
    end if;
    update calls set
        outcome = v_outcome,
        ended_at = greatest(v_at, coalesce(answered_at, started_at, v_at)),
        duration_s = greatest(0, round(extract(epoch from
                       greatest(v_at, coalesce(answered_at, started_at, v_at))
                       - coalesce(answered_at, started_at, v_at))))::int,
        status = case when call_status_rank(status) < 3
                      then (case when answered_at is null then 'failed' else 'completed' end)::call_status
                      else status end,
        metrics = coalesce(metrics, '{}'::jsonb)
                  || jsonb_build_object('backstop', jsonb_build_object(
                       'event', p_event, 'eventId', p_event_id, 'at', v_at, 'outcome', v_outcome))
      where id = c.id
      returning * into n;
    if n.reporter_id is not null then
      v_job := enqueue_job('post_call_reconcile', jsonb_build_object('callId', c.id), null,
                           'post_call:' || c.id);
    end if;
    perform log_audit(n.org_id, 'system', null, 'call.ended', 'call', n.id,
      jsonb_build_object('outcome', v_outcome, 'duration_s', n.duration_s, 'status', n.status,
                         'backstop', true, 'event_id', p_event_id, 'job_id', v_job));
    v_ended := true;
  end if;

  return jsonb_build_object('duplicate', false, 'callId', c.id, 'changed', v_changed,
                            'ended', v_ended, 'outcome', v_outcome, 'jobId', v_job);
end $$;

revoke execute on function voice_call_start(text, call_transport, uuid, text, text),
  voice_call_event(text, text, text, timestamptz, call_status, jsonb)
  from public, anon, authenticated;
grant execute on function voice_call_start(text, call_transport, uuid, text, text),
  voice_call_event(text, text, text, timestamptz, call_status, jsonb)
  to service_role;
