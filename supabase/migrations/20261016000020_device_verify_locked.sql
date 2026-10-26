-- SiteLog · device check locked (W2-03; spec F16, §6.5, §13)
--
-- F16: device codes are checked at most 5 times an hour per phone (`rate_limits`, the window from
-- the first attempt); once the limit is reached even the right code is refused until the window
-- ends, and the office is told (M6). field-api calls field_device_verify_locked() on the first
-- refused attempt of a window (the sixth), which in one transaction:
--   - audits `device.verify_locked` as the reporter on the device (the window's end `until`), as
--     field-api did before,
--   - posts a `device_verify_locked` panel notice (§13 row added: ops and admin, like the other
--     reporter notices), English title and body with its data for the panel's EN/TR copy
--     (20261015000080).
-- Once per lock window: the reporter's row lock serialises two callers, and a second call for the
-- same window (`until`) changes nothing (`locked` false).
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
    when 'device_verify_locked' then '{admin,ops}'        -- §13 "Device check locked" (F16, W2-03)
    else '{admin,pm,ops}'  -- needs_review (§13: ops, pm), glossary_review, processing_delayed, …
  end)::member_role[];
$$;

-- 2. field_device_verify_locked ----------------------------------------------------------------------------
create function field_device_verify_locked(p_reporter_id uuid, p_device_id uuid, p_until timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
begin
  -- The reporter's row lock serialises two callers of one window (one audit, one notice).
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;

  if exists (select 1 from audit_log
             where org_id = r.org_id and action = 'device.verify_locked' and actor_id = r.id
               and (diff ->> 'until')::timestamptz = p_until) then
    return jsonb_build_object('locked', false);
  end if;

  perform notify_org(
    r.org_id,
    'device_verify_locked',
    r.name || '''s phone check is locked for an hour',
    'Someone entered 5 wrong codes on their link within an hour, so SiteLog refuses new codes '
      || 'for an hour. If it was not them, their link may be in the wrong hands: contact them.',
    '/team',
    null,
    jsonb_build_object('key', 'device_verify_locked',
                       'params', jsonb_build_object('name', r.name)));

  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'device.verify_locked', 'field_device',
    p_device_id, jsonb_build_object('until', p_until, 'notified', true));
  return jsonb_build_object('locked', true);
end $$;

revoke execute on function field_device_verify_locked(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function field_device_verify_locked(uuid, uuid, timestamptz) to service_role;
