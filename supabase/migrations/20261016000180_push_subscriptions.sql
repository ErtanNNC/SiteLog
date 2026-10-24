-- SiteLog · web push subscriptions (W2-14; spec §4.4, §4.5, §6.3, §9.3, F15, §19 Q27, Q40, Q107, Q108)
--
-- Web push is a message channel to the installed field app (spec §4.4: standard Web Push with
-- VAPID keys, no provider). Spec §19 Q27 (decided 2026-10-15): the keys `question_ready`,
-- `draft_ready`, `filed` and the ladder's; a `push` consent row; a `push_subscriptions` table
-- written by field-api; `messages` rows with `channel 'push'` and no phone.
--
--   1. push_subscriptions: one row per browser subscription of a reporter (the endpoint and its
--      keys, the device it came from, the user agent). RLS on, no client policy, no grant: field-api
--      and the worker (service role) only. A row is never deleted by SiteLog code: it is revoked
--      (`revoked_at`, `revoked_reason`) when the reporter turns notifications off, signs the phone
--      out, subscribes again from the same device (`replaced`), or the push service answers 404 or
--      410 for it (`gone`). Live: one row per reporter and endpoint.
--   2. messages: only `channel 'push'` rows may lack `phone_e164` (spec §6.3 per Q27). A v1.0 Meta
--      WhatsApp or office photo row has no channel, so the check lets it pass (NULL) until step 23.
--   3. countries: push is never a person's only channel (spec §9.3): a pack's order never ends with
--      push, so another channel always follows it. Spec §19 Q107 (open; the recommendation built):
--      both launch packs become `{push, sms}`. Push reaches only a reporter who turned notifications
--      on (consent and a live subscription), so everyone else still gets SMS first; one who did
--      gets a notification, and SMS when it fails for good (404/410, §19 Q22).
--   4. field_push_subscribe() (field-api): stores the subscription and, when not held, the `push`
--      consent (`web_checkbox`, the wording's version), under the reporter's row lock, audited
--      `push.subscribed` (and `consent.given`, type `push`, via settings).
--   5. field_push_unsubscribe() (field-api): revokes the device's live subscriptions (`unsubscribed`
--      from the Settings toggle, `signed_out` from *Sign out this phone*), audited
--      `push.unsubscribed`; on `unsubscribed` the `push` consent is revoked too once the reporter
--      has no live subscription left (spec §19 Q40 per channel; Q108 for a second phone).
--   6. push_subscription_gone() (worker): the push service said the endpoint is gone (404/410):
--      the row is revoked `gone`, audited `push.subscription_gone`. The consent stays: the person
--      did not turn notifications off; the channel simply has no subscription until they do again.
--
-- Live database (staging): one new table (service only), one check on messages (every v1.2 row
-- already has a phone; v1.0 rows have no channel), one check on countries after its rows gain
-- push, three new functions (service only). The deployed v1.0 code touches none of them.

set local lock_timeout = '5s';

-- 1. push_subscriptions ------------------------------------------------------------------------------------
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  reporter_id uuid not null references reporters on delete cascade,
  device_id uuid references field_devices on delete set null,   -- the phone it came from
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 2048),
  p256dh text not null check (length(p256dh) between 1 and 200),  -- the browser's keys (base64url)
  auth text not null check (length(auth) between 1 and 100),
  user_agent text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('unsubscribed', 'signed_out', 'replaced', 'gone')),
  check ((revoked_at is null) = (revoked_reason is null))
);

create unique index push_subscriptions_live_endpoint
  on push_subscriptions (reporter_id, endpoint) where revoked_at is null;
create index push_subscriptions_device_idx on push_subscriptions (device_id) where revoked_at is null;

alter table push_subscriptions enable row level security;
revoke all on push_subscriptions from anon, authenticated;

comment on table push_subscriptions is
  'Web push (W2-14, spec §19 Q27): a reporter''s browser subscriptions, written by field-api; service role only.';

-- 2. messages: only push rows may lack a phone --------------------------------------------------------------
alter table messages add check (channel = 'push' or phone_e164 is not null);

-- 3. countries: push never ends a pack's order; the launch packs list it first (§19 Q107) --------------------
update countries set message_channels = array['push']::message_channel[] || message_channels
where not ('push' = any (message_channels));
alter table countries add check (message_channels[cardinality(message_channels)] <> 'push');

-- 4. field_push_subscribe ------------------------------------------------------------------------------------
create function field_push_subscribe(
  p_reporter_id uuid,
  p_device_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text,
  p_text_version text,
  p_evidence jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  v_channels message_channel[];
  v_id uuid;
  v_existing push_subscriptions%rowtype;
  v_consent uuid;
  v_replaced uuid[];
begin
  -- The reporter's row lock: the same one the consent functions take.
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;
  select c.message_channels into v_channels
  from orgs o join countries c on c.code = o.country where o.id = r.org_id;
  if v_channels is null or not ('push' = any (v_channels)) then
    raise exception 'channel_not_offered' using errcode = 'P0001';
  end if;
  if p_text_version is null or btrim(p_text_version) = '' or length(p_text_version) > 64 then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  select * into v_existing from push_subscriptions
  where reporter_id = r.id and endpoint = p_endpoint and revoked_at is null;
  if v_existing.id is not null then
    -- The same subscription again (a reload, keys rotated by the browser): kept, keys updated.
    update push_subscriptions
       set p256dh = p_p256dh, auth = p_auth, device_id = coalesce(p_device_id, device_id),
           user_agent = coalesce(p_user_agent, user_agent)
     where id = v_existing.id;
    v_id := v_existing.id;
  else
    -- One live subscription per device and reporter: an older one from this phone is replaced.
    with replaced as (
      update push_subscriptions set revoked_at = now(), revoked_reason = 'replaced'
      where reporter_id = r.id and device_id = p_device_id and revoked_at is null
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_replaced from replaced;
    insert into push_subscriptions (org_id, reporter_id, device_id, endpoint, p256dh, auth, user_agent)
    values (r.org_id, r.id, p_device_id, p_endpoint, p_p256dh, p_auth, p_user_agent)
    returning id into v_id;
    perform log_audit(r.org_id, 'reporter', r.id, 'push.subscribed', 'push_subscription', v_id,
      jsonb_build_object('device_id', p_device_id, 'replaced', to_jsonb(v_replaced)));
  end if;

  if not exists (select 1 from consents
                 where reporter_id = r.id and type = 'push' and revoked_at is null) then
    insert into consents (reporter_id, type, method, text_version, evidence)
    values (r.id, 'push', 'web_checkbox', p_text_version, p_evidence)
    returning id into v_consent;
    perform log_audit(r.org_id, 'reporter', r.id, 'consent.given', 'consent', v_consent,
      jsonb_build_object('type', 'push', 'method', 'web_checkbox', 'text_version', p_text_version,
                         'via', 'settings', 'device_id', p_device_id));
  end if;

  return jsonb_build_object('subscription_id', v_id, 'consent_id', v_consent);
end $$;

-- 5. field_push_unsubscribe ----------------------------------------------------------------------------------
create function field_push_unsubscribe(p_reporter_id uuid, p_device_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  v_ids uuid[];
  v_consents uuid[] := '{}';
begin
  if p_reason is null or p_reason not in ('unsubscribed', 'signed_out') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then
    raise exception 'reporter_not_found' using errcode = 'P0002';
  end if;

  with revoked as (
    update push_subscriptions set revoked_at = now(), revoked_reason = p_reason
    where reporter_id = r.id and device_id is not distinct from p_device_id and revoked_at is null
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_ids from revoked;
  if cardinality(v_ids) > 0 then
    perform log_audit(r.org_id, 'reporter', r.id, 'push.unsubscribed', 'push_subscription', v_ids[1],
      jsonb_build_object('subscription_ids', to_jsonb(v_ids), 'reason', p_reason,
                         'device_id', p_device_id));
  end if;

  -- Turning notifications off is the push opt-out (§19 Q40): the consent goes with the last live
  -- subscription (§19 Q108: another phone that still has them on keeps them).
  if p_reason = 'unsubscribed'
     and not exists (select 1 from push_subscriptions where reporter_id = r.id and revoked_at is null) then
    with revoked as (
      update consents set revoked_at = now()
      where reporter_id = r.id and type = 'push' and revoked_at is null
      returning id
    )
    select coalesce(array_agg(id order by id), '{}') into v_consents from revoked;
    if cardinality(v_consents) > 0 then
      perform log_audit(r.org_id, 'reporter', r.id, 'consent.revoked', 'consent', v_consents[1],
        jsonb_build_object('type', 'push', 'consent_ids', to_jsonb(v_consents), 'method', 'web',
                           'device_id', p_device_id, 'notified', false));
    end if;
  end if;

  return jsonb_build_object('revoked', cardinality(v_ids), 'consent_revoked', cardinality(v_consents) > 0);
end $$;

-- 6. push_subscription_gone ----------------------------------------------------------------------------------
create function push_subscription_gone(p_id uuid, p_status int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  s push_subscriptions%rowtype;
begin
  update push_subscriptions set revoked_at = now(), revoked_reason = 'gone'
  where id = p_id and revoked_at is null
  returning * into s;
  if s.id is null then
    return false;
  end if;
  perform log_audit(s.org_id, 'system', null, 'push.subscription_gone', 'push_subscription', s.id,
    jsonb_build_object('reporter_id', s.reporter_id, 'device_id', s.device_id, 'status', p_status));
  return true;
end $$;

revoke execute on function field_push_subscribe(uuid, uuid, text, text, text, text, text, jsonb),
  field_push_unsubscribe(uuid, uuid, text), push_subscription_gone(uuid, int)
  from public, anon, authenticated;
grant execute on function field_push_subscribe(uuid, uuid, text, text, text, text, text, jsonb),
  field_push_unsubscribe(uuid, uuid, text), push_subscription_gone(uuid, int)
  to service_role;
