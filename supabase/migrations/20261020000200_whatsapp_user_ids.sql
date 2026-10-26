-- TalkOlog · WhatsApp business-scoped user ids on reporters (spec §19 Q372)
--
-- Meta's username rollout (2026): Twilio's WhatsApp webhooks carry the person's business-scoped
-- user id (BSUID) in `ExternalUserId` (`whatsapp:CC.<id>`, a two-letter country code, a dot, up to
-- 128 alphanumerics). When WhatsApp hides the person's number (a username, not in the business's
-- contacts), `From` holds that id instead of `whatsapp:+E164`. sms-webhook matched WhatsApp
-- messages by number only, so such a message reached no one.
--
--   1. reporters.whatsapp_user_id: the id (without `whatsapp:`), learned from a message that came
--      with both the number and the id. Nullable, format-checked, a partial index for the lookup.
--      The office cannot write it: the reporters lockdown (20261013000007, step 11) grants
--      authenticated `update (status, invited_at)` only, and a new column gets no grant. Anon
--      reads no reporter (RLS).
--   2. record_whatsapp_user_id(): sms-webhook (service role) sets the id on every reporter row
--      of the number in real orgs (a person in several orgs is one WhatsApp user of TalkOlog's
--      business portfolio) and takes it off rows of any other number (the person moved
--      number: the id is theirs, the old number's rows no longer are). Audited per row,
--      `reporter.whatsapp_user_id_set` / `reporter.whatsapp_user_id_cleared`, never with the
--      value (an identifier like a phone number).
--   3. A reporter's phone number changed by anyone (update_reporter(), the office's typo fix)
--      drops the id: it belonged to whoever held the old number.
--
-- Live database: one nullable column with a check (no rewrite; the check scans the empty column),
-- one partial index on a small table, one trigger, one function. No row changes.

set local lock_timeout = '5s';

-- 1. The column ---------------------------------------------------------------------------------------
alter table reporters add column whatsapp_user_id text
  constraint reporters_whatsapp_user_id_format
  check (whatsapp_user_id ~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$');

create index reporters_whatsapp_user_id_idx on reporters (whatsapp_user_id)
  where whatsapp_user_id is not null;

-- 2. Recording the id ---------------------------------------------------------------------------------
create function record_whatsapp_user_id(p_phone_e164 text, p_user_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_set integer := 0;
  v_cleared integer := 0;
begin
  if p_user_id is null or p_user_id !~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$' then
    raise exception 'invalid_whatsapp_user_id' using errcode = '22023';
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  -- The id moved to another number: the old number's rows let it go.
  for r in
    update reporters t set whatsapp_user_id = null
      from orgs o
     where o.id = t.org_id and not o.is_demo
       and t.whatsapp_user_id = p_user_id and t.phone_e164 <> p_phone_e164
    returning t.id, t.org_id
  loop
    v_cleared := v_cleared + 1;
    perform log_audit(r.org_id, 'system', null, 'reporter.whatsapp_user_id_cleared', 'reporter', r.id,
      jsonb_build_object('reason', 'other_number', 'source', 'twilio_whatsapp'));
  end loop;
  -- A real sender never reaches a demo org's reporters (sms-webhook's `realOnly`).
  for r in
    update reporters t set whatsapp_user_id = p_user_id
      from orgs o
     where o.id = t.org_id and not o.is_demo
       and t.phone_e164 = p_phone_e164 and t.whatsapp_user_id is distinct from p_user_id
    returning t.id, t.org_id
  loop
    v_set := v_set + 1;
    perform log_audit(r.org_id, 'system', null, 'reporter.whatsapp_user_id_set', 'reporter', r.id,
      jsonb_build_object('source', 'twilio_whatsapp'));
  end loop;
  return jsonb_build_object('set', v_set, 'cleared', v_cleared);
end $$;
revoke execute on function record_whatsapp_user_id(text, text) from public, anon, authenticated;
grant execute on function record_whatsapp_user_id(text, text) to service_role;

-- 3. A new number drops the id ------------------------------------------------------------------------
create function reporters_phone_drops_whatsapp_user_id() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.phone_e164 is distinct from old.phone_e164
     and new.whatsapp_user_id is not distinct from old.whatsapp_user_id then
    new.whatsapp_user_id := null;
  end if;
  return new;
end $$;
revoke execute on function reporters_phone_drops_whatsapp_user_id() from public, anon, authenticated;

create trigger reporters_phone_drops_whatsapp_user_id before update of phone_e164 on reporters
  for each row execute function reporters_phone_drops_whatsapp_user_id();
