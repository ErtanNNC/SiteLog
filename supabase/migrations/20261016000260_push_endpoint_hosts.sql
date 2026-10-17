-- SiteLog · push subscriptions only on the known push services (W2-14 review; spec §6.3, §19 Q115)
--
-- The worker posts every notification to the endpoint a browser handed to field-api, so an
-- endpoint on any other https host would let a field client point the worker at an address of its
-- choosing (SSRF). field-api's request schema now takes only the known push services
-- (`PUSH_ENDPOINT_RE`, packages/shared/src/notify/push.ts); this is the same rule in the database:
--
--   1. push_subscriptions.revoked_reason gains `endpoint_not_allowed`.
--   2. A live row whose endpoint is not on a known push service is revoked with that reason,
--      audited `push.endpoint_not_allowed` (one row per subscription; the `push` consent stays, as
--      for `gone`: the person did not turn notifications off). Nothing fails on such a row.
--   3. A check: a live row's endpoint is https on fcm.googleapis.com, *.push.services.mozilla.com,
--      *.notify.windows.com or *.push.apple.com (web.push.apple.com), with no user info and no
--      port. Revoked rows keep what they had.
--
-- Live database (staging): one check replaced, one added, the rows it revokes audited. The
-- deployed v1.0 code never touches push_subscriptions.

set local lock_timeout = '5s';

-- 1. the new revoke reason --------------------------------------------------------------------------------
alter table push_subscriptions drop constraint push_subscriptions_revoked_reason_check;
alter table push_subscriptions add constraint push_subscriptions_revoked_reason_check
  check (revoked_reason in ('unsubscribed', 'signed_out', 'replaced', 'gone', 'endpoint_not_allowed'));

-- 2. revoke the live rows on any other host ---------------------------------------------------------------
with revoked as (
  update push_subscriptions set revoked_at = now(), revoked_reason = 'endpoint_not_allowed'
  where revoked_at is null
    and endpoint !~* '^https://(fcm\.googleapis\.com|([a-z0-9-]+\.)+push\.services\.mozilla\.com|([a-z0-9-]+\.)+notify\.windows\.com|([a-z0-9-]+\.)+push\.apple\.com)(/[^[:space:]]*)?$'
  returning id, org_id, reporter_id, device_id
)
select log_audit(org_id, 'system', null, 'push.endpoint_not_allowed', 'push_subscription', id,
  jsonb_build_object('reporter_id', reporter_id, 'device_id', device_id,
                     'migration', '20261016000260'))
from revoked;

-- 3. the check on live rows ---------------------------------------------------------------------------------
alter table push_subscriptions add constraint push_subscriptions_endpoint_host check (
  revoked_at is not null
  or endpoint ~* '^https://(fcm\.googleapis\.com|([a-z0-9-]+\.)+push\.services\.mozilla\.com|([a-z0-9-]+\.)+notify\.windows\.com|([a-z0-9-]+\.)+push\.apple\.com)(/[^[:space:]]*)?$'
);
