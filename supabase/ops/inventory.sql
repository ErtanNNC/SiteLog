-- SiteLog · read-only staging inventory (docs/GAP_ANALYSIS.md §4.1 stage 1, W1-01 step 0).
--
-- Run by the Deploy workflow's `inventory` target (.github/workflows/deploy.yml):
--   psql -X -q -A -t -F "<tab>" -v ON_ERROR_STOP=1 -f supabase/ops/inventory.sql
-- Every statement runs in one READ ONLY transaction that is rolled back, so nothing can be written.
-- The output is counts and labels only (enum values, job types, notification kinds, bucket ids,
-- fixed names), never row contents: no names, phone numbers, message bodies, paths or secrets.
--
-- Each row has five columns: section, label, demo orgs, other orgs, total. "Demo orgs" counts rows
-- of the demo orgs: the orgs with `is_demo` (W1-05 step 9 on: the seeded Kestrel and Demir Yapı
-- orgs, and any other org flagged as a demo), or, on a database without that column (staging until
-- the cut-over), the seeded Kestrel org by its fixed id (DEMO_ORG_ID = demoId('org:kestrel'),
-- packages/shared/src/demo/kestrel.ts and ids.ts; asserted by supabase/db-tests/src/inventory.test.ts).
-- "Other orgs" counts every other row, including rows with no org. Both are empty where a table has
-- no org. A grouped section ends with an "all" row, so it shows even when the table is empty.

set default_transaction_read_only = on;
begin transaction isolation level repeatable read, read only;
-- The demo orgs' ids, as a Postgres array; replaced below when orgs.is_demo exists.
set local sitelog.demo_orgs = '{7a0cfa5d-2a29-43fb-8665-fcd9bed4106d}';

-- Optional Supabase parts: storage, pg_cron and Vault exist on hosted projects, not on every Postgres.
-- has_is_demo: orgs.is_demo (W1-05 step 9, 20261013000007). has_unknown_contacts: the schema after
-- W1-05 step 11 (20261014000003 renamed unknown_senders). So the same script reads staging before
-- the cut-over (W1-19 re-runs it right before the push) and after.
select
  coalesce(has_table_privilege(to_regclass('storage.objects'), 'select'), false)
    and coalesce(has_table_privilege(to_regclass('storage.buckets'), 'select'), false) as has_storage,
  coalesce(has_table_privilege(to_regclass('cron.job'), 'select'), false) as has_cron,
  coalesce(has_table_privilege(to_regclass('vault.secrets'), 'select'), false) as has_vault,
  exists (select 1 from pg_attribute where attrelid = 'public.orgs'::regclass and attname = 'is_demo'
          and not attisdropped) as has_is_demo,
  to_regclass('public.unknown_contacts') is not null as has_unknown_contacts
\gset

\if :has_is_demo
-- One row whatever the data (an aggregate), so psql always stores the value; it prints nothing.
select set_config('sitelog.demo_orgs', coalesce(array_agg(id order by id)::text, '{}'), true) as demo_orgs
from orgs where is_demo
\gset
select 'Orgs' as section, 'demo orgs by' as label, null::bigint, null::bigint, 'is_demo' as total;
\else
select 'Orgs' as section, 'demo orgs by' as label, null::bigint, null::bigint,
  'fixed Kestrel id (no is_demo column)' as total;
\endif

select 'Orgs' as section, 'orgs' as label,
  count(*) filter (where id = any(current_setting('sitelog.demo_orgs')::uuid[])) as demo_orgs,
  count(*) filter (where not coalesce(id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)) as other_orgs,
  count(*)::text as total
from orgs;

select 'Conversations by state', case when grouping(state) = 1 then 'all' else state::text end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from conversations
group by rollup (state)
order by grouping(state), state;

select 'Messages by type and conversation',
  case when grouping(label) = 1 then 'all' else label end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from (
  -- An SMS row has no WhatsApp type (v1.2, D15).
  select coalesce(m.type::text, 'sms') || case when m.conversation_id is null then ' · no conversation'
                                               else ' · conversation' end as label,
         coalesce(m.org_id, c.org_id) as org_id
  from messages m
  left join conversations c on c.id = m.conversation_id
) x
group by rollup (label)
order by grouping(label), label;

\if :has_unknown_contacts
-- v1.2 schema (W1-05 step 9 on): a transcript belongs to a WhatsApp message, an upload or a call.
select 'Transcripts', 'transcripts',
  count(*) filter (where o.org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(o.org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from transcripts t
cross join lateral (
  select coalesce(
    (select coalesce(m.org_id, c.org_id) from messages m
       left join conversations c on c.id = m.conversation_id where m.id = t.message_id),
    (select s.org_id from uploads u join sites s on s.id = u.site_id where u.id = t.upload_id),
    (select k.org_id from calls k where k.id = t.call_id)) as org_id
) o;
\else
select 'Transcripts', 'transcripts',
  count(*) filter (where coalesce(m.org_id, c.org_id) = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(coalesce(m.org_id, c.org_id) = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from transcripts t
join messages m on m.id = t.message_id
left join conversations c on c.id = m.conversation_id;
\endif

\if :has_unknown_contacts
select 'Unknown contacts by status', case when grouping(status) = 1 then 'all' else status::text end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from unknown_contacts
group by rollup (status)
order by grouping(status), status;
\else
select 'Unknown contacts by status', case when grouping(status) = 1 then 'all' else status::text end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from unknown_senders
group by rollup (status)
order by grouping(status), status;
\endif

select 'Report sources by kind', case when grouping(s.kind) = 1 then 'all' else s.kind end,
  count(*) filter (where r.org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(r.org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from report_sources s
join reports r on r.id = s.report_id
group by rollup (s.kind)
order by grouping(s.kind), s.kind;

select 'Reports by status', case when grouping(status) = 1 then 'all' else status::text end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from reports
group by rollup (status)
order by grouping(status), status;

select 'Report versions by data schemaVersion',
  case when grouping(label) = 1 then 'all' else label end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from (
  select 'schemaVersion ' || coalesce(v.data ->> 'schemaVersion', 'missing') as label, r.org_id
  from report_versions v
  join reports r on r.id = v.report_id
) x
group by rollup (label)
order by grouping(label), label;

select 'Reporters by status', case when grouping(status) = 1 then 'all' else status::text end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from reporters
group by rollup (status)
order by grouping(status), status;

-- Jobs carry no org column.
select 'Jobs by type and status', case when grouping(label) = 1 then 'all' else label end,
  null::bigint, null::bigint, count(*)::text
from (select type || ' · ' || status::text as label from jobs) x
group by rollup (label)
order by grouping(label), label;

-- Queued office-edit PDFs that would notify the reporter on WhatsApp once a worker runs (D31).
select 'Queued render_pdf jobs with notifyReporter', 'render_pdf · queued · notifyReporter',
  null::bigint, null::bigint, count(*)::text
from jobs
where type = 'render_pdf' and status = 'queued' and (payload ->> 'notifyReporter') = 'true';

select 'Notifications by kind', case when grouping(kind) = 1 then 'all' else kind end,
  count(*) filter (where org_id = any(current_setting('sitelog.demo_orgs')::uuid[])),
  count(*) filter (where not coalesce(org_id = any(current_setting('sitelog.demo_orgs')::uuid[]), false)),
  count(*)::text
from notifications
group by rollup (kind)
order by grouping(kind), kind;

-- Object names start with "{org_id}/" (supabase/migrations/20261011000006_platform.sql).
\if :has_storage
select 'Storage objects by bucket', case when grouping(b.id) = 1 then 'all' else b.id end,
  count(o.id) filter (where split_part(o.name, '/', 1) = any(current_setting('sitelog.demo_orgs')::text[])),
  count(o.id) filter (where not coalesce(split_part(o.name, '/', 1) = any(current_setting('sitelog.demo_orgs')::text[]), false)),
  count(o.id)::text
from storage.buckets b
left join storage.objects o on o.bucket_id = b.id
group by rollup (b.id)
order by grouping(b.id), b.id;
\else
select 'Storage objects by bucket', 'storage.objects', null::bigint, null::bigint, 'not readable';
\endif

\if :has_cron
select 'Scheduler (pg_cron)', 'job sitelog-scheduler-tick', null::bigint, null::bigint,
  coalesce((select case when bool_or(active) then 'present, active' else 'present, inactive' end
            from cron.job where jobname = 'sitelog-scheduler-tick' having count(*) > 0), 'missing');
\else
select 'Scheduler (pg_cron)', 'cron.job', null::bigint, null::bigint, 'not readable';
\endif

-- Names only: never vault.decrypted_secrets, never a value.
\if :has_vault
select 'Vault secrets for scheduler-tick', n.name, null::bigint, null::bigint,
  case when exists (select 1 from vault.secrets s where s.name = n.name) then 'present' else 'missing' end
from (values ('scheduler_tick_url'), ('scheduler_secret')) as n (name)
order by n.name;
\else
select 'Vault secrets for scheduler-tick', 'vault.secrets', null::bigint, null::bigint, 'not readable';
\endif

rollback;
