-- SiteLog · the invoice gap notice (W3-06; spec F19, §13 "Invoice gap: ops, accounts", §19 Q133)
--
-- §13 lists an *Invoice gap* panel notice for ops and accounts, and nothing produced it (audit
-- "No 'invoice_gap' panel notification is ever produced"). Spec §19 Q133 is open with the owner;
-- this builds its recommended default, `INVOICE_GAP_POLICY` in packages/shared/src/invoices.ts
-- (supabase/db-tests compares the numbers): one notice per invoice when it is saved, or when a
-- new report version changes the hours behind it, while the gap is at least 1 h either way; again
-- only when the gap has moved by 1 h or more since the last notice; never for an invoice marked
-- queried or resolved.
--
--   1. sub_invoices.gap_notified: the gap (invoiced − reported, hours) of the last notice; null
--      until one is posted. It is the notice's key: one per invoice and gap.
--   2. invoice_reported_hours(): the filed hours of a company in a period (current versions of
--      filed and signed-off reports, the rows `current_manpower` shows), for the service and the
--      triggers. invoice_gaps() compares each invoice with its own period (audit "invoice_gaps
--      compares each invoice with reported hours for the query window…").
--   3. invoice_gap_check(invoice, cause): the policy. Locks the invoice row (two callers of one
--      change post one notice), posts `invoice_gap` through notify_org() with its English title
--      and body and its data (20261015000080: the panel renders it in the reader's language),
--      org-wide, so notification_audience() shows it to admin, ops and accounts; records the gap
--      and audits `invoice.gap_notified`.
--   4. Triggers: an invoice saved (insert, or its hours, period, company or status changed) is
--      checked at once; a report whose current version or status changes is checked when its
--      transaction commits (a deferred constraint trigger), so the version's manpower rows are in
--      place whichever order its writer used, and every open invoice of the report's companies
--      (any version: a company a new version removed too) covering its day is checked.
--
-- Live database (staging): one nullable column (no rewrite), three new functions, one replaced in
-- place (same signature), three triggers. Existing invoices keep gap_notified null: the next
-- save or report version that touches one with a gap of 1 h or more posts its first notice.

set local lock_timeout = '5s';

-- 1. The last notified gap --------------------------------------------------------------------------------
alter table sub_invoices add column gap_notified numeric(8,2);
comment on column sub_invoices.gap_notified is
  'Invoiced − reported hours of the last invoice_gap notice (null: none yet). W3-06, spec §19 Q133.';

-- 2. Reported hours of a company in a period -------------------------------------------------------------
create function invoice_reported_hours(p_org uuid, p_company uuid, p_start date, p_end date)
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(m.hours), 0)
  from manpower_entries m
  join reports r on r.id = m.report_id and r.current_version = m.version
  join site_days sd on sd.id = r.site_day_id
  where r.org_id = p_org and m.company_id = p_company
    and r.status in ('filed', 'signed_off')
    and sd.date between p_start and p_end;
$$;

revoke execute on function invoice_reported_hours(uuid, uuid, date, date)
  from public, anon, authenticated;
grant execute on function invoice_reported_hours(uuid, uuid, date, date) to service_role;

-- The office RPC: each invoice against the reports of its own period (was: the query window).
create or replace function invoice_gaps(p_org uuid, p_start date, p_end date)
returns table (company_id uuid, company_name text, invoiced numeric, reported numeric, gap numeric, invoice_id uuid, invoice_status text)
language sql stable security invoker set search_path = public as $$
  select c.id, c.name, coalesce(i.total_hours, 0), coalesce(r.hours, 0),
         coalesce(i.total_hours, 0) - coalesce(r.hours, 0), i.id, i.status
  from sub_invoices i
  join companies c on c.id = i.company_id
  left join lateral (
    select sum(cm.hours) as hours
    from current_manpower cm
    where cm.org_id = p_org and cm.company_id = i.company_id
      and cm.date between i.period_start and i.period_end
  ) r on true
  where i.org_id = p_org and i.period_start <= p_end and i.period_end >= p_start and is_member(p_org);
$$;

-- 3. The policy ------------------------------------------------------------------------------------------
create function invoice_gap_check(p_invoice_id uuid, p_cause text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  i sub_invoices%rowtype;
  -- INVOICE_GAP_POLICY (packages/shared/src/invoices.ts): minGapHours, minChangeHours; the
  -- silent statuses are 'queried' and 'resolved'.
  c_min_gap constant numeric := 1;
  c_min_change constant numeric := 1;
  v_company text;
  v_invoiced numeric;
  v_reported numeric;
  v_gap numeric;
  v_sign text;
begin
  select * into i from sub_invoices where id = p_invoice_id for update;
  if i.id is null or i.status in ('queried', 'resolved')
     or i.period_start is null or i.period_end is null then
    return false;
  end if;
  -- An invoice without hours (no total, no lines) has nothing to compare.
  if i.total_hours is not null then
    v_invoiced := i.total_hours;
  elsif jsonb_typeof(i.lines) = 'array' and jsonb_array_length(i.lines) > 0 then
    select coalesce(sum((l ->> 'hours')::numeric), 0) into v_invoiced
    from jsonb_array_elements(i.lines) l
    where jsonb_typeof(l -> 'hours') = 'number';
  else
    return false;
  end if;

  v_reported := invoice_reported_hours(i.org_id, i.company_id, i.period_start, i.period_end);
  v_gap := round(v_invoiced - v_reported, 2);
  if abs(v_gap) < c_min_gap then return false; end if;
  if i.gap_notified is not null and abs(v_gap - i.gap_notified) < c_min_change then
    return false;
  end if;

  select name into v_company from companies where id = i.company_id;
  v_sign := case when v_gap > 0 then '+' else '−' end;
  update sub_invoices set gap_notified = v_gap where id = i.id;
  perform notify_org(
    i.org_id,
    'invoice_gap',
    'Invoice gap: ' || v_company || ' ' || v_sign || trim_scale(abs(v_gap))::text || ' h',
    coalesce(i.invoice_no, '') || ' invoices ' || trim_scale(v_invoiced)::text
      || ' h · reports show ' || trim_scale(v_reported)::text || ' h',
    '/hours?week=' || to_char(i.period_start, 'IYYY-"W"IW'),
    null,
    jsonb_build_object('key', 'invoice_gap',
                       'params', jsonb_build_object(
                         'company', v_company,
                         'invoiceNo', coalesce(i.invoice_no, ''),
                         'invoiced', trim_scale(v_invoiced),
                         'reported', trim_scale(v_reported),
                         'gap', trim_scale(v_gap))));
  perform log_audit(i.org_id, case when auth.uid() is null then 'system' else 'user' end, auth.uid(),
    'invoice.gap_notified', 'sub_invoice', i.id,
    jsonb_build_object('gap', trim_scale(v_gap), 'previous', i.gap_notified,
                       'invoiced', trim_scale(v_invoiced), 'reported', trim_scale(v_reported),
                       'cause', p_cause));
  return true;
end $$;

revoke execute on function invoice_gap_check(uuid, text) from public, anon, authenticated;
grant execute on function invoice_gap_check(uuid, text) to service_role;

-- 4. Triggers --------------------------------------------------------------------------------------------
create function sub_invoices_gap_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform invoice_gap_check(new.id, case when tg_op = 'INSERT' then 'invoice_added' else 'invoice_updated' end);
  return null;
end $$;

create trigger sub_invoices_gap_notice
  after insert or update of total_hours, lines, period_start, period_end, company_id, status
  on sub_invoices for each row execute function sub_invoices_gap_notice();

create function reports_invoice_gap_notice() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_date date;
  v_invoice uuid;
begin
  select sd.date into v_date from site_days sd where sd.id = new.site_day_id;
  if v_date is null then return null; end if;
  for v_invoice in
    select i.id from sub_invoices i
    where i.org_id = new.org_id and i.status = 'open'
      and i.period_start <= v_date and i.period_end >= v_date
      and i.company_id in (select m.company_id from manpower_entries m
                           where m.report_id = new.id and m.company_id is not null)
    order by i.id
  loop
    perform invoice_gap_check(v_invoice, 'report_version');
  end loop;
  return null;
end $$;

create constraint trigger reports_invoice_gap_notice_insert
  after insert on reports deferrable initially deferred
  for each row execute function reports_invoice_gap_notice();

create constraint trigger reports_invoice_gap_notice_update
  after update of current_version, status on reports deferrable initially deferred
  for each row
  when (old.current_version is distinct from new.current_version or old.status is distinct from new.status)
  execute function reports_invoice_gap_notice();

revoke execute on function sub_invoices_gap_notice(), reports_invoice_gap_notice()
  from public, anon, authenticated;
