-- SiteLog · the stored PDF carries the sign-off (W1-14, GAP §7 step 19; spec §12 page 2;
-- docs/AUDIT_BACKLOG.md "Daily report PDF never shows 'Signed off in SiteLog by {name}'")
--
-- §12 prints the project manager's line as "Signed off in SiteLog by {name} · {time}" once a
-- report is signed off, and the signature line again after an undo. The PDF is rendered when a
-- version is filed or edited, so a sign-off never reached the stored file. Now:
--
--   1. sign_off_report(): as before, then enqueues render_pdf for the current version (no email:
--      the version's content did not change). The worker overwrites the version's stored PDF in
--      place (`pdfs/{org}/{site}/{report_no}_v{n}.pdf`, upsert), reading the sign-off as it runs.
--   2. undo_sign_off(): as before, then enqueues the same re-render, so the signature line is
--      blank again.
--
-- Dedupe keys: a key is never used twice (D16, 20261015000001), and a report can be signed off,
-- undone and signed off again, so each event has its own key:
-- `render_pdf:<report>:<version>:signoff:<µs>` and `…:signoff_undone:<µs>` (transaction time).
--
-- Forward-only and CLI-safe: `create or replace` of two existing functions with the same
-- signatures (their grants are kept), no lock or transaction-block statement. Live: the deployed
-- panel calls the same RPCs with the same results; a worker without this change renders the same
-- job type it already handles.

create or replace function sign_off_report(p_report_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.status <> 'filed' then raise exception 'only filed reports can be signed off (status %)', r.status; end if;
  update reports set status = 'signed_off', signed_off_by = auth.uid(), signed_off_at = now() where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.signed_off', 'report', p_report_id, jsonb_build_object('version', r.current_version));
  perform enqueue_job('render_pdf',
                      jsonb_build_object('reportId', p_report_id, 'version', r.current_version, 'emailRecipients', false),
                      null,
                      'render_pdf:' || p_report_id || ':' || r.current_version || ':signoff:'
                        || (extract(epoch from now()) * 1000000)::bigint);
  return jsonb_build_object('status', 'signed_off', 'signed_off_at', now(), 'version', r.current_version);
end $$;

create or replace function undo_sign_off(p_report_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if r.status <> 'signed_off' then raise exception 'report is not signed off'; end if;
  if not (r.signed_off_by = auth.uid() or has_role(r.org_id, '{admin}')) then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.signed_off_at < now() - interval '10 minutes' and not has_role(r.org_id, '{admin}') then raise exception 'undo window has passed'; end if;
  update reports set status = 'filed', signed_off_by = null, signed_off_at = null where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.signoff_undone', 'report', p_report_id, null);
  perform enqueue_job('render_pdf',
                      jsonb_build_object('reportId', p_report_id, 'version', r.current_version, 'emailRecipients', false),
                      null,
                      'render_pdf:' || p_report_id || ':' || r.current_version || ':signoff_undone:'
                        || (extract(epoch from now()) * 1000000)::bigint);
  return jsonb_build_object('status', 'filed');
end $$;
