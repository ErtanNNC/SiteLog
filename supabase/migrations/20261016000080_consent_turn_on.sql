-- SiteLog · Turn texts back on in field Settings (W2-02 follow-up; spec F15, §9.3 Settings, §19 Q86,
-- Appendix B `POST /field/consent/grant`)
--
-- Spec §19 Q86 (decided 2026-10-16): the recorder's Settings offers *Turn on* for the texts (`sms`)
-- consent. field-api calls field_grant_consent(), which in one transaction, under the reporter's
-- row lock (the same lock field_revoke_consent() takes, so a turn-on and a turn-off of one person
-- never interleave):
--   - refuses a phone that opted out of texts: the reporter row is `opted_out` (SMS STOP, or the
--     provider's opt-out list) or the phone has an `sms_opt_outs` row on the org's pack
--     ('texts_opted_out'). A consent never overrides an opt-out: START undoes STOP (§9.5);
--   - with an `sms` consent already held, changes nothing (`granted` false);
--   - otherwise inserts a fresh consent row (`method 'web_checkbox'`, the wording's version and
--     the evidence field-api hands over: device, user agent, address) and audits `consent.given`
--     as the reporter, with `via 'settings'` and the device it came from.
-- The revoked row stays as it was: the history of a consent is its rows.
--
-- Only `sms` is accepted ('consent_not_offered' otherwise): recording and processing come back
-- through the Welcome & consent screen (`POST consent`), and the automated-call consent with M8.
--
-- Forward-only and CLI-safe: one new function, service role only; no table changes.

set local lock_timeout = '5s';

create function field_grant_consent(
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
  if p_type is distinct from 'sms'::consent_type then
    raise exception 'consent_not_offered' using errcode = 'P0001';
  end if;
  if p_text_version is null or btrim(p_text_version) = '' or length(p_text_version) > 64 then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  select country into v_country from orgs where id = r.org_id;
  if r.status = 'opted_out'
     or exists (select 1 from sms_opt_outs o
                where o.phone_e164 = r.phone_e164 and o.country = v_country) then
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

revoke execute on function field_grant_consent(uuid, consent_type, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function field_grant_consent(uuid, consent_type, text, uuid, jsonb)
  to service_role;
