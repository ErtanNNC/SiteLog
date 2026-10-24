-- SiteLog · The recording notice version a call played (W4-06; spec §9.1 "the recording notice
-- versioned", §9.4 "Disclosure", §15.2, §19 Q28)
--
-- A call says the pack's recording notice (`countries.legal_keys.recording_notice`, a versioned id
-- `<CC>.recording_notice.v<n>` whose sentence is in the shared legal copy) when the pack names one
-- and it has the call language, else the agent's own (`voice.recording_notice.v1`). Which one was
-- said is now kept on the call, next to `disclosure_played`:
--
--   1. calls.disclosure_version: the version the agent says it played, set with
--      `disclosure_played` and kept once set (the first opening is the disclosure; a repeat of the
--      mark changes nothing). Null for every call before this migration and any call whose
--      notice was never played.
--   2. voice_call_update() gains `p_disclosure_version` (default null): set only together with
--      `p_disclosure_played => true` and only while the column is null; audited in the same
--      `call.updated` diff as `disclosure_played`. field-api checks the version is the pack's key
--      or `voice.recording_notice.v1` before it calls this (POST /voice/calls/:id/disclosure).
--      The old four-argument signature is dropped (forward-only: a new function, same grants).
--
-- Live database (staging): one nullable column (no default, no rewrite) and one function replaced;
-- no existing row is written. Both launch packs have `legal_keys {}` until counsel's texts land
-- (W4-13), so every call keeps saying `voice.recording_notice.v1`.

-- 1. The column ---------------------------------------------------------------------------------
alter table calls
  add column disclosure_version text
    check (disclosure_version is null or disclosure_version ~ '^[A-Za-z0-9_.-]{1,64}$');

comment on column calls.disclosure_version is
  'W4-06: the recording notice version played (the pack''s legal_keys.recording_notice, else voice.recording_notice.v1).';

-- 2. voice_call_update ----------------------------------------------------------------------------
drop function voice_call_update(uuid, call_status, boolean, timestamptz);

create function voice_call_update(
  p_call_id uuid, p_status call_status default null, p_disclosure_played boolean default null,
  p_answered_at timestamptz default null, p_disclosure_version text default null
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
      -- W4-06: the version played, with the mark only, and kept once set.
      disclosure_version = coalesce(c.disclosure_version,
                                    case when coalesce(p_disclosure_played, false)
                                         then p_disclosure_version end),
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
  if n.disclosure_version is distinct from c.disclosure_version then
    v_diff := v_diff || jsonb_build_object('disclosure_version', n.disclosure_version);
  end if;
  if n.answered_at is distinct from c.answered_at then
    v_diff := v_diff || jsonb_build_object('answered_at', n.answered_at);
  end if;
  if v_diff <> '{}' then
    perform log_audit(c.org_id, 'agent', null, 'call.updated', 'call', c.id, v_diff);
  end if;
  return jsonb_build_object('status', n.status, 'disclosurePlayed', n.disclosure_played,
                            'disclosureVersion', n.disclosure_version, 'changed', v_diff <> '{}');
end $$;

revoke execute on function voice_call_update(uuid, call_status, boolean, timestamptz, text)
  from public, anon, authenticated;
grant execute on function voice_call_update(uuid, call_status, boolean, timestamptz, text)
  to service_role;
