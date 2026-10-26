-- SiteLog · calls data for the voice agent's field-api routes (W3-03; spec §4.6, §6.3 `calls`, §6.5,
-- §9.4 "How a call starts", Appendix B "field-api voice routes", §19 Q29, Q44)
--
--   1. countries_voice_number_key: a voice number belongs to one pack (§4.6: an inbound call finds
--      the pack by the number called, as sms-webhook finds it by the receiving sender id).
--   2. calls: `language` (the call language, the reporter's locale when the call starts),
--      `call_token_issued_at` (field-api's per-call token was handed out: the call started),
--      `attempt` (1, 2 for the ladder's R1 and R2 calls, 3 for the one callback, §19 Q128; W3-17
--      writes it), `site_day_id` (the call's site-day once its site is known), `fallback` (§9.4 rule 9:
--      the simple recording mode started, `{reason, at}`; W3-11 reads it). Two indexes: a phone's
--      calls (the ladder's attempts, W3-17) and the open calls (voice-events' backstop, W3-04).
--   3. voice_call_start(): the agent's first request in a room. A SIP call (no row yet) finds the
--      pack by the number called and the caller among the reporters of the pack's real orgs (§19
--      Q44: active, then invited, then opted out; newest first; disabled never); none is an unknown
--      caller (F13: org and reporter null). A Talk now or outbound call names the row it has. One
--      row per room (`provider_call_id`), idempotent; audited `call.started` (never the number).
--   4. voice_call_update(): status (never backwards), disclosure played, answered (voice-events,
--      W3-04; the agent, W3-12); audited `call.updated` when something changed.
--   5. voice_call_pick_site(): F14 on a call, the call's site (and, for a number in two orgs, the
--      reporter of that site's org), with its site-day; audited `call.site_picked`.
--   6. voice_call_fallback(): §9.4 rule 9, audited `call.fallback_started` (W3-11 records the rest).
--   7. voice_call_recording(): the recording's path when its upload URL is signed, audited.
--   8. voice_call_end(): outcome, dialog log, metrics, duration; audited `call.ended`; for a known
--      caller one `post_call_reconcile` job (`post_call:<call>`, W3-11; voice-events' backstop uses
--      the same key, W3-04). Idempotent: a second end changes nothing.
--   9. voice_tool_requests: a tool request named by `X-Request-Id` runs once per call; the agent's
--      retry gets the first answer (service only).
--
-- Every function is service-role only: field-api calls them for the voice agent, which never gets
-- a database session (§6.5), and no office user writes calls.
--
-- Live database (staging): one new table (service only), one unique index on a column that is null on every row (no conflict),
-- five nullable columns, two indexes and seven new functions (service only). The deployed v1.0
-- code touches none of them.

set local lock_timeout = '5s';

-- 1. A voice number belongs to one pack -------------------------------------------------------------------
create unique index countries_voice_number_key on countries (voice_number)
  where voice_number is not null;

-- 2. calls bookkeeping --------------------------------------------------------------------------------------
alter table calls
  add column language text check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  add column call_token_issued_at timestamptz,
  add column attempt smallint check (attempt between 1 and 3),
  add column site_day_id uuid references site_days on delete set null,
  add column fallback jsonb check (fallback is null or jsonb_typeof(fallback) = 'object');

create index calls_from_idx on calls (from_e164, created_at desc) where from_e164 is not null;
create index calls_open_idx on calls (created_at) where ended_at is null;

comment on column calls.call_token_issued_at is
  'W3-03: field-api handed the agent this call''s token (voice_call_start); tools are refused before it.';
comment on column calls.fallback is
  'W3-03 (§9.4 rule 9): the simple recording mode started: {reason, at (seconds into the call)}.';

-- The site-day of a call's site on the call's day (the site's local date when the call started).
create function call_site_day(p_site_id uuid, p_at timestamptz) returns uuid
language sql stable security definer set search_path = public as $$
  select d.id from site_days d join sites s on s.id = d.site_id
   where d.site_id = p_site_id and d.date = (coalesce(p_at, now()) at time zone s.timezone)::date;
$$;

-- 3. voice_call_start -----------------------------------------------------------------------------------------
create function voice_call_start(
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
begin
  if p_room is null or p_room !~ '^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
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

  -- A SIP call into a pack's number: the room names the call (`call-{uuid}`).
  if p_transport <> 'pstn' or p_from is null or p_to is null
     or p_from !~ '^\+[1-9][0-9]{6,14}$' or p_to !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_id := substr(p_room, 6)::uuid;
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

-- 4. voice_call_update ----------------------------------------------------------------------------------------
create function call_status_rank(p_status call_status) returns int
language sql immutable set search_path = public as $$
  select case p_status when 'queued' then 0 when 'ringing' then 1 when 'in_progress' then 2 else 3 end;
$$;

create function voice_call_update(
  p_call_id uuid, p_status call_status default null, p_disclosure_played boolean default null,
  p_answered_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  n calls%rowtype;
  v_diff jsonb := '{}';
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  update calls set
      -- Never backwards, and a final status stays (completed, no_answer, busy, failed, voicemail).
      status = case when p_status is not null and call_status_rank(c.status) < 3
                     and call_status_rank(p_status) > call_status_rank(c.status)
                    then p_status else c.status end,
      -- Once played, always played.
      disclosure_played = coalesce(c.disclosure_played, false) or coalesce(p_disclosure_played, false),
      answered_at = coalesce(c.answered_at, p_answered_at),
      started_at = coalesce(c.started_at, case when p_status is not null and p_status <> 'queued'
                                               then now() end)
    where id = c.id
    returning * into n;
  if n.status <> c.status then
    v_diff := v_diff || jsonb_build_object('status', jsonb_build_object('from', c.status, 'to', n.status));
  end if;
  if n.disclosure_played is distinct from c.disclosure_played then
    v_diff := v_diff || jsonb_build_object('disclosure_played', true);
  end if;
  if n.answered_at is distinct from c.answered_at then
    v_diff := v_diff || jsonb_build_object('answered_at', n.answered_at);
  end if;
  if v_diff <> '{}' then
    perform log_audit(c.org_id, 'agent', null, 'call.updated', 'call', c.id, v_diff);
  end if;
  return jsonb_build_object('status', n.status, 'disclosurePlayed', n.disclosure_played,
                            'changed', v_diff <> '{}');
end $$;

-- 5. voice_call_pick_site --------------------------------------------------------------------------------------
-- field-api has checked that the site is one of the caller's (§19 Q44: the reporter of that site's
-- org); this checks it again.
create function voice_call_pick_site(p_call_id uuid, p_site_id uuid, p_reporter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  rp reporters%rowtype;
  v_day uuid;
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    raise exception 'call_ended' using errcode = 'P0001';
  end if;
  select * into rp from reporters where id = p_reporter_id;
  if rp.id is null or c.reporter_id is null
     or (rp.id <> c.reporter_id
         and (c.direction <> 'inbound' or c.transport <> 'pstn' or rp.phone_e164 is distinct from c.from_e164))
     or not exists (select 1 from site_reporters sr join sites s on s.id = sr.site_id
                     where sr.site_id = p_site_id and sr.reporter_id = rp.id
                       and s.org_id = rp.org_id and s.status = 'active') then
    raise exception 'site_not_found' using errcode = 'P0002';
  end if;
  if c.site_id is not distinct from p_site_id and c.reporter_id = rp.id then
    return jsonb_build_object('siteId', c.site_id, 'siteDayId', c.site_day_id, 'changed', false);
  end if;
  v_day := call_site_day(p_site_id, coalesce(c.started_at, now()));
  update calls set site_id = p_site_id, reporter_id = rp.id, org_id = rp.org_id,
                   language = coalesce(language, rp.locale), site_day_id = v_day
   where id = c.id;
  perform log_audit(rp.org_id, 'agent', null, 'call.site_picked', 'call', c.id,
    jsonb_build_object('site_id', p_site_id, 'reporter_id', rp.id,
                       'from_site_id', c.site_id, 'from_reporter_id', c.reporter_id));
  return jsonb_build_object('siteId', p_site_id, 'siteDayId', v_day, 'changed', true);
end $$;

-- 6. voice_call_fallback ---------------------------------------------------------------------------------------
create function voice_call_fallback(p_call_id uuid, p_reason text, p_at numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare c calls%rowtype;
begin
  if p_reason not in ('not_understood', 'stt_low_confidence', 'agent_error')
     or p_at is null or p_at < 0 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    raise exception 'call_ended' using errcode = 'P0001';
  end if;
  if c.fallback is not null then
    return jsonb_build_object('marked', false);
  end if;
  update calls set fallback = jsonb_build_object('reason', p_reason, 'at', p_at) where id = c.id;
  perform log_audit(c.org_id, 'agent', null, 'call.fallback_started', 'call', c.id,
    jsonb_build_object('reason', p_reason, 'at', p_at));
  return jsonb_build_object('marked', true);
end $$;

-- 7. voice_call_recording -------------------------------------------------------------------------------------
create function voice_call_recording(p_call_id uuid, p_path text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare c calls%rowtype;
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.org_id is null or p_path is distinct from c.org_id || '/' || c.id || '.ogg' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if c.recording_path is not distinct from p_path then
    return jsonb_build_object('changed', false);
  end if;
  update calls set recording_path = p_path where id = c.id;
  perform log_audit(c.org_id, 'agent', null, 'call.recording_requested', 'call', c.id,
    jsonb_build_object('path', p_path));
  return jsonb_build_object('changed', true);
end $$;

-- 8. voice_call_end -------------------------------------------------------------------------------------------
create function voice_call_end(
  p_call_id uuid, p_outcome call_outcome, p_dialog_log jsonb, p_metrics jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_job bigint;
begin
  if jsonb_typeof(p_dialog_log) is distinct from 'array'
     or jsonb_typeof(p_metrics) is distinct from 'object' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    return jsonb_build_object('ended', false, 'outcome', c.outcome, 'jobId', null);
  end if;
  update calls set
      outcome = p_outcome,
      dialog_log = p_dialog_log,
      metrics = p_metrics,
      ended_at = now(),
      duration_s = greatest(0, round(extract(epoch from now() - coalesce(answered_at, started_at, now()))))::int,
      status = case when call_status_rank(status) < 3 then 'completed'::call_status else status end
    where id = c.id
    returning * into c;
  if c.reporter_id is not null then
    v_job := enqueue_job('post_call_reconcile', jsonb_build_object('callId', c.id), null,
                         'post_call:' || c.id);
  end if;
  perform log_audit(c.org_id, 'agent', null, 'call.ended', 'call', c.id,
    jsonb_build_object('outcome', p_outcome, 'duration_s', c.duration_s, 'status', c.status,
                       'turns', p_metrics -> 'turns', 'job_id', v_job));
  return jsonb_build_object('ended', true, 'outcome', c.outcome, 'jobId', v_job);
end $$;

-- 9. voice_tool_requests: one answer per agent request ----------------------------------------------------
-- The agent retries a tool once after a 5xx or a transport error (W3-02). A request that names
-- itself (`X-Request-Id`, the same on the retry) is run once per call: the first claims its key,
-- its 2xx answer is kept, and a retry gets that answer again instead of a second effect (a second
-- filing, a second answer). A request that failed (an error, a refusal) frees its key. Service
-- role only (field-api); the rows go with their call.
create table voice_tool_requests (
  call_id uuid not null references calls on delete cascade,
  request_key text not null check (request_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  tool text not null check (tool ~ '^[a-z_]{1,64}$'),
  status smallint check (status between 200 and 299),  -- null while the first request runs
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (call_id, request_key)
);

alter table voice_tool_requests enable row level security;
revoke all on voice_tool_requests from anon, authenticated;

comment on table voice_tool_requests is
  'W3-03: the voice agent''s tool requests by X-Request-Id, run once per call; a retry gets the kept answer.';

revoke execute on function call_site_day(uuid, timestamptz),
  voice_call_start(text, call_transport, uuid, text, text),
  call_status_rank(call_status),
  voice_call_update(uuid, call_status, boolean, timestamptz),
  voice_call_pick_site(uuid, uuid, uuid),
  voice_call_fallback(uuid, text, numeric),
  voice_call_recording(uuid, text),
  voice_call_end(uuid, call_outcome, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function call_site_day(uuid, timestamptz),
  voice_call_start(text, call_transport, uuid, text, text),
  call_status_rank(call_status),
  voice_call_update(uuid, call_status, boolean, timestamptz),
  voice_call_pick_site(uuid, uuid, uuid),
  voice_call_fallback(uuid, text, numeric),
  voice_call_recording(uuid, text),
  voice_call_end(uuid, call_outcome, jsonb, jsonb)
  to service_role;
