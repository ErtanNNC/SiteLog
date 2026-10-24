-- SiteLog · Field Settings (W2-02; spec F15, §9.3 Settings, §13, Appendix B `POST /field/consent/revoke`)
--
-- The recorder's Settings screen turns a consent off. field-api calls field_revoke_consent(), which
-- in one transaction:
--   - sets `revoked_at` on the reporter's unrevoked consents of that type (`consent.revoked`,
--     audited as the reporter, with the device it came from); a type not held changes nothing,
--   - for `recording` or `data_processing` (F15 "Revoking recording consent → reporter can no
--     longer submit; office notified") tells the office: a `reporter_consent_revoked` panel notice
--     (§13 row added: ops and admin, like the other reporter notices), English title and body with
--     its data for the panel's EN/TR copy (20261015000080).
-- Per §19 Q40 (decided: the first) a revoked `sms` consent is the per-channel opt-out of texts;
-- `reporters.status 'opted_out'` stays SMS STOP only, and nothing here touches it.
--
-- notification_audience() gains the new kind (packages/shared/src/notifications.ts holds the same
-- table; supabase/db-tests compares them).
--
-- Forward-only and CLI-safe: one function replaced in place (same signature), one new function,
-- service role only; no table changes.

set local lock_timeout = '5s';

-- 1. Notification audience ------------------------------------------------------------------------------
create or replace function notification_audience(p_kind text) returns member_role[]
language sql stable set search_path = public as $$
  select (case p_kind
    when 'invoice_gap' then '{admin,ops,accounts}'        -- §13 "Invoice gap: ops, accounts"
    when 'billing' then '{admin}'                         -- §13 "Billing: admin"
    when 'missing_report' then '{admin,ops}'              -- §13 "Report missing: ops + admin"
    when 'unknown_sender' then '{admin,ops}'              -- §13 "Unknown contact: ops, admin"
    when 'unknown_contact' then '{admin,ops}'
    when 'reporter_invite_failed' then '{admin,ops}'      -- §13 "Message undeliverable / opted out"
    when 'reporter_opted_out' then '{admin,ops}'          -- the same row of §13
    when 'message_failed' then '{admin,ops}'              -- the same row: a message job that died (W1-10)
    when 'reporter_wrong_site' then '{admin,ops}'         -- §2.2 "Manage reporters": admin, ops
    when 'reporter_consent_revoked' then '{admin,ops}'    -- §13 "Consent revoked" (F15, W2-02)
    else '{admin,pm,ops}'  -- needs_review (§13: ops, pm), glossary_review, processing_delayed, …
  end)::member_role[];
$$;

-- 2. field_revoke_consent ----------------------------------------------------------------------------------
create function field_revoke_consent(p_reporter_id uuid, p_type consent_type, p_device_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  v_ids uuid[];
  v_what text;
  v_notified boolean := false;
begin
  -- The reporter's row lock serialises two revocations of one person (one audit, one notice).
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;

  with revoked as (
    update consents set revoked_at = now()
    where reporter_id = p_reporter_id and type = p_type and revoked_at is null
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_ids from revoked;

  if cardinality(v_ids) = 0 then
    return jsonb_build_object('revoked', false, 'notified', false);
  end if;

  if p_type in ('recording', 'data_processing') then
    v_what := case p_type when 'recording' then 'recording' else 'processing' end;
    perform notify_org(
      r.org_id,
      'reporter_consent_revoked',
      r.name || ' turned off consent to the ' || v_what || ' of their reports',
      'They turned it off in Settings on their phone, so SiteLog takes no reports from them until '
        || 'they consent again on their phone. Contact them if that is unexpected.',
      '/team',
      null,
      jsonb_build_object('key', 'reporter_consent_revoked',
                         'params', jsonb_build_object('name', r.name, 'type', p_type)));
    v_notified := true;
  end if;

  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'consent.revoked', 'consent', v_ids[1],
    jsonb_build_object('type', p_type, 'consent_ids', to_jsonb(v_ids), 'method', 'web',
                       'device_id', p_device_id, 'notified', v_notified));
  return jsonb_build_object('revoked', true, 'notified', v_notified);
end $$;

revoke execute on function field_revoke_consent(uuid, consent_type, uuid)
  from public, anon, authenticated;
grant execute on function field_revoke_consent(uuid, consent_type, uuid) to service_role;
