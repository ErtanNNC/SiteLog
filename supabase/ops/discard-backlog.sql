-- Discard the queued WhatsApp-era backlog before any worker runs (W1-19 cut-over, step 2;
-- docs/RUNBOOK.md §2 "Cut-over (W1-19), step by step" and "Before the worker runs").
--
-- Owner-approved; run once in the staging SQL editor (or `psql "$SUPABASE_DB_URL" -f`) right after
-- the backup and before the db push. It works on the v1.0 schema and on v1.2 alike, and is safe to
-- run again (a second run finds nothing and records a count of 0).
--
-- What it does, in one transaction:
--   - every job still `queued`, or `running` with a lock older than 10 minutes (claim_jobs() would
--     take it back), created more than an hour ago, becomes `failed` with a `last_error` that says
--     why. `failed` is never claimed again (claim_jobs() takes only `queued` and stale `running`),
--     and `ops_discard_job` cannot be used here: it accepts only `dead` jobs.
--   - one `ops.backlog_discarded` audit row with the count per job type (names and counts only,
--     never a payload).
--   - the last select shows that audit row.
--
-- Staging's inventory of 2026-10-13 found two such jobs: `send_welcome` (a WhatsApp template to a
-- real reporter if a worker ever ran it) and `build_evidence_pack`. Proven on a staging-shaped
-- PGlite database by supabase/db-tests/src/cutover.test.ts.

begin;

with discarded as (
  update jobs
     set status = 'failed',
         last_error = 'discarded: queued before the v1.2 cut-over (W1-19)',
         finished_at = now(),
         locked_at = null,
         locked_by = null
   where created_at < now() - interval '1 hour'
     and (status = 'queued'
          or (status = 'running' and locked_at < now() - interval '10 minutes'))
  returning type
),
by_type as (
  select type, count(*)::int as n from discarded group by type
)
insert into audit_log (actor_type, action, entity, diff)
select 'system',
       'ops.backlog_discarded',
       'jobs',
       jsonb_build_object(
         'count', coalesce(sum(n), 0)::int,
         'by_type', coalesce(jsonb_object_agg(type, n), '{}'::jsonb),
         'reason', 'W1-19 cut-over: queued before the v1.2 worker existed'
       )
from by_type;

commit;

select created_at, diff
from audit_log
where action = 'ops.backlog_discarded'
order by id desc
limit 1;
