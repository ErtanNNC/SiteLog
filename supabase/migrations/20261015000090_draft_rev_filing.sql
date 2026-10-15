-- SiteLog · filing writes no new draft revision (W1-15 review; spec §6.2 report_versions, §8 F8)
--
-- 20261015000070 bumps report_versions.draft_rev on every change of `data`. Filing freezes the
-- version (the worker writes the computed missingRequired / lowConfidence into it), and that
-- write bumped the revision too. field-api's `reports/:id` reads the report and then its version,
-- so a poll between the two could see the report still awaiting confirmation with the filing's
-- revision, and the Draft screen said the draft had changed while it was being filed.
--
-- The worker now files in one transaction (apps/worker/src/db.ts `fileVersion`): under the
-- site-day and report row locks it checks the status, the version and the revision the filing
-- was computed from, sets the report to filed, then writes the frozen data. This trigger counts
-- revisions of a draft only: a data change of a version whose report is no longer a draft
-- (filed, signed off, void) keeps its revision. Office edits insert a new version (revision 1),
-- as before.
--
-- Live database (staging): one trigger function replaced in place; no table changes. The
-- deployed v1.0 worker never reads draft_rev.

set local lock_timeout = '5s';

create or replace function report_versions_draft_rev() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.draft_rev := 1;
  elsif new.data is distinct from old.data
        and exists (select 1 from reports r
                    where r.id = new.report_id
                      and r.status in ('collecting', 'processing', 'awaiting_answer',
                                       'awaiting_confirmation')) then
    new.draft_rev := old.draft_rev + 1;
  else
    new.draft_rev := old.draft_rev;
  end if;
  return new;
end $$;
