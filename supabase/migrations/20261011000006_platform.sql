-- SiteLog · Supabase platform wiring: storage buckets + policies, realtime, pg_cron scheduler.
-- Every block is guarded so the migration also runs on plain Postgres (PGlite tests).

-- Storage (§4.2, §6.5): private buckets; object paths start with {org_id}/ ------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values
      ('audio', 'audio', false), ('photos', 'photos', false), ('pdfs', 'pdfs', false),
      ('exports', 'exports', false), ('logos', 'logos', false), ('invoices', 'invoices', false)
    on conflict (id) do nothing;

    execute $p$ create policy "members read org files" on storage.objects for select to authenticated
      using (bucket_id in ('audio','photos','pdfs','exports','logos','invoices')
             and public.is_member(((storage.foldername(name))[1])::uuid)) $p$;
    execute $p$ create policy "admins upload logos" on storage.objects for insert to authenticated
      with check (bucket_id = 'logos' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin}')) $p$;
    execute $p$ create policy "members upload invoices" on storage.objects for insert to authenticated
      with check (bucket_id = 'invoices' and public.is_member(((storage.foldername(name))[1])::uuid)) $p$;
  end if;
end $$;

-- Realtime (§F13, §11.2) --------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table site_days, reports, notifications, unknown_senders, evidence_packs;
  end if;
end $$;

-- pg_cron → scheduler-tick every 5 minutes (§4.2). URL and secret live in Vault:
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/scheduler-tick', 'scheduler_tick_url');
--   select vault.create_secret('<SCHEDULER_SECRET>', 'scheduler_secret');
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.unschedule(jobid) from cron.job where jobname = 'sitelog-scheduler-tick';
    perform cron.schedule(
      'sitelog-scheduler-tick',
      '*/5 * * * *',
      $cron$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_tick_url'),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_secret')),
          body := jsonb_build_object('source', 'pg_cron', 'at', now()),
          timeout_milliseconds := 60000
        );
      $cron$
    );
  end if;
end $$;
