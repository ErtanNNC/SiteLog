-- TalkOlog · a "yes" to the consent question on a call gives WhatsApp, not SMS (spec §19 Q375,
-- decided by the owner 2026-10-23)
--
-- §19 Q120's call consent stored `recording`, `data_processing` and `sms`. Since §19 Q374 no pack
-- lists SMS (`message_channels {push, whatsapp}`), so that `sms` consent reached no one. The owner:
-- the call's yes gives a `whatsapp` consent instead, always (not "the pack's first channel"): the
-- question now names WhatsApp (`consent_ask`, `voice.consent.v2`), and a stored consent must match
-- the words the person agreed to.
--
--   voice_record_consent(): yes stores `recording`, `data_processing` and `whatsapp` (each one not
--   held, `voice_yes`, the wording's version, `{call_id, at}`), audited `consent.given` as before.
--   A `whatsapp` consent revoked earlier (unticked, or STOP on WhatsApp) is given again by this
--   yes, as `sms` was: a spoken yes to a question that names WhatsApp is a fresh opt-in.
--   The answer gains `messagesBefore`: an `sms` or `whatsapp` consent held before this call. A "no"
--   sends the daily link (through the Notifier, on the pack's channels) only then; `smsBefore` stays
--   in the answer, unchanged, for the field-api deployed before this migration.
--
-- Live database: one function replaced, same signature and grants; no row is written. Consents
-- already stored as `sms` by a call stay as they are.

set local lock_timeout = '5s';

create or replace function voice_record_consent(
  p_call_id uuid, p_answer text, p_at numeric, p_text_version text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  rep reporters%rowtype;
  v_type consent_type;
  v_id uuid;
  v_given text[] := '{}';
  v_sms boolean;
  v_messages boolean;
  v_at numeric := round(greatest(0, least(coalesce(p_at, 0), 3600))::numeric, 2);
begin
  if p_answer is null or p_answer not in ('yes', 'no')
     or coalesce(btrim(p_text_version), '') = '' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    raise exception 'call_ended' using errcode = 'P0001';
  end if;
  if c.reporter_id is null or c.org_id is null then
    raise exception 'unknown_caller' using errcode = 'P0001';
  end if;
  select * into rep from reporters where id = c.reporter_id for update;
  if rep.status = 'disabled' then
    raise exception 'reporter_disabled' using errcode = 'P0001';
  end if;
  v_sms := exists (select 1 from consents where reporter_id = rep.id and type = 'sms'
                                            and revoked_at is null);
  v_messages := v_sms or exists (select 1 from consents where reporter_id = rep.id
                                   and type = 'whatsapp' and revoked_at is null);

  if p_answer = 'no' then
    if c.consent_declined_at is null then
      update calls set consent_declined_at = now() where id = c.id returning * into c;
      perform log_audit(c.org_id, 'reporter', rep.id, 'consent.declined', 'reporter', rep.id,
        jsonb_build_object('via', 'voice', 'call_id', c.id, 'at', v_at,
                           'text_version', p_text_version));
    end if;
    return jsonb_build_object('status', 'declined', 'smsBefore', v_sms,
                              'messagesBefore', v_messages,
                              'recordingPath', c.recording_path, 'given', '[]'::jsonb);
  end if;

  -- A yes after this call's no would process a call the reporter refused: not on this call.
  if c.consent_declined_at is not null then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  foreach v_type in array array['recording', 'data_processing', 'whatsapp']::consent_type[] loop
    if not exists (select 1 from consents where reporter_id = rep.id and type = v_type
                                            and revoked_at is null) then
      insert into consents (reporter_id, type, method, text_version, evidence)
      values (rep.id, v_type, 'voice_yes', p_text_version,
              jsonb_build_object('call_id', c.id, 'at', v_at))
      returning id into v_id;
      v_given := v_given || v_type::text;
      perform log_audit(c.org_id, 'reporter', rep.id, 'consent.given', 'consent', v_id,
        jsonb_build_object('type', v_type, 'method', 'voice_yes', 'via', 'voice',
                           'text_version', p_text_version, 'call_id', c.id, 'at', v_at));
    end if;
  end loop;
  -- F3 step 3: the first consent makes the reporter active (opted out stays opted out).
  if rep.status = 'invited' then
    update reporters set status = 'active', activated_at = coalesce(activated_at, now())
     where id = rep.id;
    perform log_audit(c.org_id, 'reporter', rep.id, 'reporter.activated', 'reporter', rep.id,
      jsonb_build_object('from', 'invited', 'via', 'voice', 'call_id', c.id));
  end if;
  return jsonb_build_object('status', 'given', 'smsBefore', v_sms,
                            'messagesBefore', v_messages, 'recordingPath', null,
                            'given', to_jsonb(v_given));
end $$;

revoke execute on function voice_record_consent(uuid, text, numeric, text)
  from public, anon, authenticated;
grant execute on function voice_record_consent(uuid, text, numeric, text) to service_role;
