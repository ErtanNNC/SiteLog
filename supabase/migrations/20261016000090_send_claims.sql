-- SiteLog · One sender per Notifier key in field-api (W2-03 follow-up; spec F16 "Send me today's link")
--
-- `POST /field/expired/daily-link` sends today's link through the Notifier under the dedupe key
-- `expired_daily_link:<expired link>:<site day>`. The Notifier dedupes by reading the messages
-- written under the key, so two taps at once could both read none and both send. field-api now
-- claims the key first:
--   - field_claim_send(key, ttl): true for the one caller that holds the claim; false while
--     another caller holds it (a claim older than `ttl` seconds is taken over: a crashed request
--     never blocks the key for good). The claim is a `rate_limits` row keyed `send_claim:<key>`,
--     taken under the same advisory lock pattern as field_rate_limit(), so no new table.
--   - field_release_send(key): the holder lets go once the Notifier answered; a waiting caller
--     then claims it and gets the Notifier's answer for the message already sent.
--
-- Forward-only and CLI-safe: two new functions, service role only; no table changes.

set local lock_timeout = '5s';

create function field_claim_send(p_key text, p_ttl_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_key text;
begin
  if p_key is null or p_ttl_seconds < 1 then
    raise exception 'invalid send claim' using errcode = '22023';
  end if;
  v_key := 'send_claim:' || p_key;
  perform pg_advisory_xact_lock(hashtextextended('rate_limits:' || v_key, 0));
  if exists (select 1 from rate_limits where key = v_key
               and window_start > now() - make_interval(secs => p_ttl_seconds)) then
    return false;
  end if;
  delete from rate_limits where key = v_key;
  insert into rate_limits (key, window_start, count) values (v_key, now(), 1);
  return true;
end $$;

create function field_release_send(p_key text) returns void
language sql security definer set search_path = public as $$
  delete from rate_limits where key = 'send_claim:' || p_key;
$$;

revoke execute on function field_claim_send(text, int), field_release_send(text)
  from public, anon, authenticated;
grant execute on function field_claim_send(text, int), field_release_send(text) to service_role;
