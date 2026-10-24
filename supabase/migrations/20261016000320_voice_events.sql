-- SiteLog · voice-events: LiveKit webhooks on calls (W3-04; spec §4.2 `voice-events`, §5.1, §6.3
-- `calls`, §7.3, §10.1 `post_call_reconcile`, §19 Q122)
--
--   1. livekit_events: one row per LiveKit webhook event id that voice-events acted on (a room
--      `call-{uuid}`; room_started, participant_joined, track_published, participant_left,
--      room_finished). A redelivery of a stored id runs nothing again. Service role only. No
--      body, identity or number is kept: the event, the room, the call and the time.
--   2. voice_call_event(): one transaction per event: store the id, find the room's call, move the
--      line status as the SIP participant says (never backwards, a final status stays; a hang-up
--      before anyone answered is `failed`), audited `call.updated` as `system`; and on
--      room_finished for a call the agent never ended (agent crash, network) the backstop: the
--      call ends as
--        - `not_reached` when nobody answered,
--        - `filed` when its report was confirmed by voice during the call (file_report ran, the
--          agent died before end_call),
--        - `draft_saved` when its report has a draft that is not filed (§19 Q122: the draft
--          continues on the web),
--        - `abandoned` otherwise (§19 Q122: too little said for any report value, no draft),
--      audited `call.ended` as `system` with `backstop: true`, and for a known caller the call's
--      one `post_call_reconcile` job (`post_call:<call>`, the key voice_call_end() uses: never a
--      second one). `metrics.backstop` marks the end.
--   3. voice_call_end() again: the agent's own end after the backstop (its request was in flight
--      when the room finished) replaces the backstop's guess with its outcome, dialog log and
--      metrics, once, audited `call.ended` with `late: true`; no second job. Any other repeat
--      still changes nothing.
--
-- Live database (staging): one new table (service only), one new function (service only), one
-- function replaced with the same signature. The deployed v1.0 code touches none of them.

set local lock_timeout = '5s';

-- 1. livekit_events ------------------------------------------------------------------------------------------
create table livekit_events (
  id text primary key check (id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  event text not null check (event in ('room_started', 'participant_joined', 'track_published',
                                       'participant_left', 'room_finished')),
  room text not null check (room ~ '^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  call_id uuid references calls on delete cascade,
  event_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index livekit_events_call_idx on livekit_events (call_id) where call_id is not null;

alter table livekit_events enable row level security;
revoke all on livekit_events from anon, authenticated;

comment on table livekit_events is
  'W3-04: LiveKit webhook events voice-events acted on, one row per event id (a redelivery runs nothing again). Service role only.';

-- 2. voice_call_event ----------------------------------------------------------------------------------------
create function voice_call_event(
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
begin
  if p_event_id is null or p_event_id !~ '^[A-Za-z0-9_.:-]{1,128}$'
     or p_event is null or p_event not in ('room_started', 'participant_joined', 'track_published',
                                           'participant_left', 'room_finished')
     or p_room is null
     or p_room !~ '^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_request' using errcode = 'P0001';
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

  -- The room's call: by its room (set when the agent started the call), else a row named by the
  -- room's uuid that has no room yet (an inbound SIP call's row takes the room's uuid as its id;
  -- Talk now and outbound rooms are expected to be named `call-{id}` too, W3-13, W3-17).
  select * into c from calls
   where provider_call_id = p_room
      or (provider_call_id is null and id = substr(p_room, 6)::uuid)
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

-- 3. voice_call_end: the agent's end after the backstop ---------------------------------------------------
create or replace function voice_call_end(
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
    -- W3-04: voice-events' backstop ended it first (the room finished while this request was on
    -- its way): the agent knows how the call went; its end replaces the guess, once.
    if c.metrics ? 'backstop' and c.dialog_log is null then
      update calls set
          outcome = p_outcome,
          dialog_log = p_dialog_log,
          metrics = p_metrics || jsonb_build_object('backstop', c.metrics -> 'backstop')
        where id = c.id
        returning * into c;
      if c.reporter_id is not null then
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

revoke execute on function voice_call_event(text, text, text, timestamptz, call_status, jsonb)
  from public, anon, authenticated;
grant execute on function voice_call_event(text, text, text, timestamptz, call_status, jsonb)
  to service_role;
