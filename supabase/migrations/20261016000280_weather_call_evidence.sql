-- SiteLog · weather evidence from calls and the archive's lost hours (W3-07; spec F20, P9)
--
-- P9 and F20: the delay log's evidence chips show *Voice note ts* or *Call ts*. A weather period a
-- call report cites by its call second (`{type: 'call', callId, start}`, §10.3) had no voice
-- evidence on its delay record: weather_events.audio_source took only 'audio' and 'voice_note'
-- sources, so the chip read "No audio" and the day was never claim-ready.
--
--   1. denormalize_report_version(): audio_source is the period's first voice note, else its
--      first call source (the same function as 20261014000002 otherwise, line for line). The
--      generated claim_ready (audio + photo + observed) now counts a call as the voice evidence.
--   2. Backfill: every version whose weather periods cite a call and whose delay record has no
--      voice evidence is denormalised again (the writers' own function: its manpower, work and
--      weather rows are rewritten from the same data, report_sources only gains rows).
--   3. report_archive_weather_hours(): the lost weather hours of every archive report matching
--      the Reports filters, in one request (audit "'X h lost to weather in this set' sums only the
--      current page"; the panel paged through the rows to add them up). Security invoker over
--      report_archive, which shows admin, pm and ops their own org's reports only.
--
-- Spec §19 Q134 (a report filed without the site manager's confirmation is claim-ready only once
-- signed off) is applied by the readers (packages/shared/src/report/evidence-pack.ts), not by the
-- generated column, which cannot read the report.
--
-- Live database (staging): one function replaced in place (same signature), one new function,
-- and a re-run of the writers' denormalisation for the versions that cite a call in a weather
-- period and have no voice evidence on its delay record.

set local lock_timeout = '5s';

-- 1. The delay record's voice evidence: a voice note, else a call ------------------------------------
create or replace function denormalize_report_version(p_report_id uuid, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_data jsonb; v_site uuid; v_org uuid; v_date date; v_photo_count int;
  v_src jsonb;
  v_type text;
  v_id uuid;
  v_question questions%rowtype;
  v_row_id uuid;
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  select rv.data, r.site_id, r.org_id, (rv.data->>'reportDate')::date
    into v_data, v_site, v_org, v_date
  from report_versions rv join reports r on r.id = rv.report_id
  where rv.report_id = p_report_id and rv.version = p_version;
  if v_data is null then raise exception 'version not found'; end if;
  v_photo_count := coalesce(jsonb_array_length(v_data->'photos'), 0);

  delete from manpower_entries where report_id = p_report_id and version = p_version;
  delete from work_items where report_id = p_report_id and version = p_version;
  delete from weather_events where report_id = p_report_id and version = p_version;

  insert into manpower_entries (report_id, version, company_id, company_name_heard, company_name, trade, area, workers, hours, hours_basis, source, confidence)
  select p_report_id, p_version,
         (select c.id from companies c
           where (m->>'companyId') ~ '^[0-9a-f-]{36}$'
             and c.id = (m->>'companyId')::uuid and c.org_id = v_org),
         m->>'companyNameHeard', m->>'companyName', m->>'trade', m->>'area',
         coalesce((m->>'workers')::int, 0), coalesce((m->>'totalHours')::numeric, 0),
         m->>'hoursBasis', m->'source'->0, (m->>'confidence')::numeric
  from jsonb_array_elements(coalesce(v_data->'manpower', '[]'::jsonb)) m;

  insert into work_items (report_id, version, area, activity, status, percent, quantity, source)
  select p_report_id, p_version, w->>'area', w->>'activity', w->>'status', (w->>'percentComplete')::int,
         case when w ? 'quantity' then (w->'quantity'->>'value') || ' ' || (w->'quantity'->>'unit') end,
         w->'source'->0
  from jsonb_array_elements(coalesce(v_data->'workPerformed', '[]'::jsonb)) w;

  insert into weather_events (report_id, version, site_id, date, start_local, end_local, condition, impact, lost_hours, full_day, audio_source, photo_count, observed)
  select p_report_id, p_version, v_site, v_date,
         nullif(p->>'start','')::time, nullif(p->>'end','')::time, p->>'condition', p->>'impact',
         coalesce((p->>'lostHours')::numeric, 0), coalesce((p->>'fullDay')::boolean, false),
         -- The period's voice evidence: its first voice note (v1 audio, v2 voice_note), else
         -- its first call second (W3-07: P9's *Call ts* chip, claim-ready).
         (select s from jsonb_array_elements(coalesce(p->'source','[]'::jsonb)) with ordinality as e(s, n)
          where s->>'type' in ('audio', 'voice_note', 'call')
          order by (s->>'type' = 'call'), n limit 1),
         v_photo_count, v_data->'weather'->'observed'
  from jsonb_array_elements(coalesce(v_data->'weather'->'periods', '[]'::jsonb)) p;

  -- report_sources with the v1.2 keys for the field sources the version cites.
  for v_src in select distinct s from report_data_sources(v_data) s loop
    v_type := v_src->>'type';
    v_id := null;
    v_row_id := null;
    v_question := null;

    if v_type in ('audio', 'voice_note') then
      if coalesce(v_src->>'uploadId', v_src->>'messageId') !~ c_uuid then continue; end if;
      v_id := coalesce(v_src->>'uploadId', v_src->>'messageId')::uuid;
      -- Only a voice-note row: a photo or answer row with that id is not re-keyed.
      select rs.id into v_row_id from report_sources rs
      where rs.report_id = p_report_id and (rs.upload_id = v_id or rs.message_id = v_id)
        and rs.kind in ('audio', 'voice_note')
      order by rs.created_at nulls first, rs.id limit 1;
      if v_row_id is not null then
        update report_sources rs
        set kind = case when rs.kind = 'audio' then 'voice_note' else rs.kind end,
            upload_id = coalesce(rs.upload_id,
                                 (select u.id from uploads u where u.id = v_id and u.site_id = v_site))
        where rs.id = v_row_id
          and (rs.kind = 'audio' or (rs.upload_id is null
               and exists (select 1 from uploads u where u.id = v_id and u.site_id = v_site)));
      elsif exists (select 1 from uploads u
                    where u.id = v_id and u.report_id = p_report_id and u.kind = 'audio') then
        insert into report_sources (report_id, kind, upload_id) values (p_report_id, 'voice_note', v_id);
      end if;

    elsif v_type in ('reply', 'answer') then
      if v_type = 'reply' then
        if v_src->>'messageId' !~ c_uuid then continue; end if;
        v_id := (v_src->>'messageId')::uuid;  -- the reply message
        select q.* into v_question from questions q
        where q.report_id = p_report_id and q.answered_message_id = v_id
        order by q.answered_at nulls last, q.created_at, q.id limit 1;
      else
        if v_src->>'questionId' !~ c_uuid then continue; end if;
        -- A v2 answer names its question; a v1 reply carried into v2 by the upgrade names the
        -- reply message (that question's answered_message_id).
        select q.* into v_question from questions q
        where q.report_id = p_report_id
          and (q.id = (v_src->>'questionId')::uuid or q.answered_message_id = (v_src->>'questionId')::uuid)
        order by (q.id = (v_src->>'questionId')::uuid) desc, q.answered_at nulls last, q.created_at, q.id
        limit 1;
        v_id := v_question.answered_message_id;
      end if;

      if v_question.id is not null then
        -- The answer row of the question, else the reply's own text row (a WhatsApp 'reply' or a
        -- 'text' row, or an answer row that names no question). Never a media row: a photo that
        -- answered a photo question, or a voice note, stays a photo or voice_note source.
        select rs.id into v_row_id from report_sources rs
        where rs.report_id = p_report_id
          and (rs.question_id = v_question.id
               or (v_id is not null and rs.message_id = v_id
                   and (rs.kind in ('reply', 'text') or (rs.kind = 'answer' and rs.question_id is null))))
        order by (rs.question_id = v_question.id) desc nulls last, rs.created_at nulls first, rs.id limit 1;
        if v_row_id is not null then
          update report_sources set kind = 'answer', question_id = v_question.id
          where id = v_row_id and (kind <> 'answer' or question_id is distinct from v_question.id);
        else
          -- When the reply message is already a source of this report (a photo, a voice note, the
          -- answer of another question), the answer row names only its question: unique
          -- (report_id, message_id) allows one row per message.
          insert into report_sources (report_id, kind, question_id, message_id)
          values (p_report_id, 'answer', v_question.id,
                  case when v_id is not null
                            and not exists (select 1 from report_sources rs
                                            where rs.report_id = p_report_id and rs.message_id = v_id)
                       then v_id end);
        end if;
      elsif v_type = 'reply' then
        -- A reply that answered no question (a typed weather or no-work message): text.
        update report_sources set kind = 'text'
        where report_id = p_report_id and message_id = v_id and kind = 'reply';
      end if;

    elsif v_type = 'call' then
      if v_src->>'callId' !~ c_uuid then continue; end if;
      v_id := (v_src->>'callId')::uuid;
      if exists (select 1 from calls c where c.id = v_id and c.report_id = p_report_id)
         and not exists (select 1 from report_sources rs
                         where rs.report_id = p_report_id and rs.call_id = v_id) then
        insert into report_sources (report_id, kind, call_id) values (p_report_id, 'call', v_id);
      end if;
    end if;
  end loop;
end $$;

-- 2. Backfill the delay records of call-sourced weather periods --------------------------------------
do $$
declare
  r record;
begin
  for r in
    select distinct rv.report_id, rv.version
    from report_versions rv
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(rv.data->'weather'->'periods') = 'array'
           then rv.data->'weather'->'periods' else '[]'::jsonb end) p
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(p->'source') = 'array' then p->'source' else '[]'::jsonb end) s
    where s->>'type' = 'call'
      and exists (select 1 from weather_events w
                  where w.report_id = rv.report_id and w.version = rv.version
                    and w.audio_source is null)
  loop
    perform denormalize_report_version(r.report_id, r.version);
  end loop;
end $$;

-- 3. Lost weather hours over the archive's filtered set ------------------------------------------------
-- The filters are the panel's (apps/web/src/data/supabase/SupabaseSource.ts `archive()`):
-- p_status 'needs_review' | 'filed' | 'signed_off' | 'weather_day' (else every status),
-- p_channel 'link' (web, sms) | 'call' (voice), p_text a substring of the report number, site
-- name, project code or summary (matched literally), p_ids the reports whose transcripts match.
create function report_archive_weather_hours(
  p_org uuid,
  p_site uuid default null,
  p_from date default null,
  p_to date default null,
  p_status text default null,
  p_edited boolean default false,
  p_late boolean default false,
  p_has_weather_delay boolean default false,
  p_incident boolean default false,
  p_channel text default null,
  p_text text default null,
  p_ids uuid[] default null
) returns numeric
language sql stable security invoker set search_path = public as $$
  select coalesce(round(sum(a.lost_hours), 2), 0)::numeric
  from report_archive a
  cross join (
    select '%' || replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ) q
  where a.org_id = p_org
    and a.lost_hours > 0
    and (p_site is null or a.site_id = p_site)
    and (p_from is null or a.date >= p_from)
    and (p_to is null or a.date <= p_to)
    and case p_status
          when 'needs_review' then a.status = 'filed' and a.needs_review
          when 'filed' then a.status = 'filed' and not a.needs_review and a.kind <> 'weather_day'
          when 'signed_off' then a.status = 'signed_off'
          when 'weather_day' then a.kind = 'weather_day'
          else true
        end
    and (not coalesce(p_edited, false) or a.current_version > 1)
    and (not coalesce(p_late, false) or a.is_late)
    and (not coalesce(p_has_weather_delay, false) or a.lost_hours > 0 or a.kind = 'weather_day')
    and (not coalesce(p_incident, false) or a.has_incident)
    and case p_channel
          when 'link' then a.channel in ('web', 'sms')
          when 'call' then a.channel = 'voice'
          else true
        end
    and (p_text is null
         or a.report_no ilike q.pat or a.site_name ilike q.pat
         or a.project_code ilike q.pat or a.summary ilike q.pat
         or a.id = any(coalesce(p_ids, '{}'::uuid[])));
$$;

revoke execute on function report_archive_weather_hours(uuid, uuid, date, date, text, boolean, boolean, boolean, boolean, text, text, uuid[])
  from public, anon;
grant execute on function report_archive_weather_hours(uuid, uuid, date, date, text, boolean, boolean, boolean, boolean, text, text, uuid[])
  to authenticated, service_role;
