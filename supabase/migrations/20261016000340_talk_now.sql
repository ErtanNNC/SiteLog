-- W3-13: Talk now (spec §9.3, §9.4 "How a call starts", Appendix B `POST /field/voice/token`;
-- §19 Q121, Q157).
--
--   1. field_talk_now_start(): the `calls` row of a browser call the reporter starts from the
--      recorder, before its LiveKit room exists: transport `web`, direction `inbound`, purpose
--      `daily_report`, status `queued`, the reporter's locale as the call language, the site and
--      its site-day of today; the room is named by the call (`call-{callId}`, Q157's recommended
--      default) and stored as `provider_call_id` at once, so `voice-events` finds the row before
--      the agent calls `voice_call_start()` (which then starts this row: 20261016000300). Refused
--      for a disabled reporter, a site that is not the reporter's or not active, and without the
--      `recording` and `data_processing` consents (field-api checks all of it first). Audited
--      `call.requested` as the reporter, with the device; never a phone number.
--   2. field_talk_now_failed(): the room or the agent dispatch could not be made (LiveKit down):
--      the call ends at once as `failed` / `not_reached`, audited `call.ended` as system with the
--      reason; no `post_call_reconcile` job (nothing was said). A call already ended is left alone.
--
-- Both service role only: field-api calls them (§6.5); the field app never gets a session.
--
-- Live database (staging): two new functions (service only). No table, column or row changes.

set local lock_timeout = '5s';

-- 1. field_talk_now_start ------------------------------------------------------------------------------------
create function field_talk_now_start(p_reporter_id uuid, p_site_id uuid, p_device_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rep reporters%rowtype;
  v_site sites%rowtype;
  v_id uuid := gen_random_uuid();
  v_room text;
  c calls%rowtype;
begin
  select * into v_rep from reporters where id = p_reporter_id;
  if v_rep.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;
  if v_rep.status = 'disabled' then
    raise exception 'reporter_disabled' using errcode = 'P0001';
  end if;
  select s.* into v_site from sites s
    join site_reporters sr on sr.site_id = s.id and sr.reporter_id = v_rep.id
   where s.id = p_site_id and s.org_id = v_rep.org_id;
  if v_site.id is null then
    raise exception 'site_not_found' using errcode = 'P0002';
  end if;
  if v_site.status <> 'active' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  -- §9.4, CLAUDE.md "consent checked before any call": a call is recorded and processed.
  if (select count(distinct type) from consents
       where reporter_id = v_rep.id and revoked_at is null
         and type in ('recording', 'data_processing')) < 2 then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;

  v_room := 'call-' || v_id::text;
  insert into calls (id, org_id, reporter_id, site_id, direction, transport, purpose,
                     provider_call_id, status, language, site_day_id)
  values (v_id, v_rep.org_id, v_rep.id, v_site.id, 'inbound', 'web', 'daily_report',
          v_room, 'queued', v_rep.locale, call_site_day(v_site.id, now()))
  returning * into c;
  perform log_audit(c.org_id, 'reporter', v_rep.id, 'call.requested', 'call', c.id,
    jsonb_build_object('direction', 'inbound', 'transport', 'web', 'purpose', 'daily_report',
                       'site_id', v_site.id, 'device_id', p_device_id, 'room', v_room));
  return jsonb_build_object('callId', c.id, 'room', v_room);
end $$;

comment on function field_talk_now_start(uuid, uuid, uuid) is
  'W3-13: Talk now''s calls row (web, inbound, queued), room call-{id}, audited call.requested; service only.';

-- 2. field_talk_now_failed -----------------------------------------------------------------------------------
create function field_talk_now_failed(p_call_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
begin
  if p_reason is null or p_reason !~ '^[a-z_]{1,40}$' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id and transport = 'web' for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    return jsonb_build_object('ended', false, 'outcome', c.outcome);
  end if;
  update calls set
      status = 'failed',
      outcome = 'not_reached',
      ended_at = now(),
      metrics = coalesce(metrics, '{}'::jsonb) || jsonb_build_object('talkNowFailed', p_reason)
    where id = c.id
    returning * into c;
  perform log_audit(c.org_id, 'system', null, 'call.ended', 'call', c.id,
    jsonb_build_object('outcome', 'not_reached', 'status', 'failed', 'transport', 'web',
                       'reason', p_reason));
  return jsonb_build_object('ended', true, 'outcome', c.outcome);
end $$;

comment on function field_talk_now_failed(uuid, text) is
  'W3-13: a Talk now call whose room or agent dispatch failed ends at once (failed, not_reached); service only.';

revoke execute on function field_talk_now_start(uuid, uuid, uuid),
  field_talk_now_failed(uuid, text)
  from public, anon, authenticated;
grant execute on function field_talk_now_start(uuid, uuid, uuid),
  field_talk_now_failed(uuid, text)
  to service_role;
