-- SiteLog · §6.2 enums
-- Keep in sync with packages/shared/src/enums.ts (asserted by supabase/db-tests).

create extension if not exists pgcrypto;

create type member_role       as enum ('admin','pm','ops','accounts');
create type site_status       as enum ('active','paused','archived');
create type reporter_role     as enum ('site_manager','backup');
create type reporter_status   as enum ('invited','verified','disabled');
create type company_status    as enum ('confirmed','unconfirmed');
create type msg_direction     as enum ('in','out');
create type msg_type          as enum ('text','audio','image','document','interactive','template','reaction','unsupported');
create type msg_status        as enum ('received','queued','sent','delivered','read','failed');
create type convo_state       as enum ('new','welcome_sent','test_mode','idle','selecting_site',
                                       'processing','awaiting_answer','awaiting_confirmation','editing');
create type site_day_status   as enum ('pending','reminded','processing','filed','weather_day','no_work','missing');
create type report_status     as enum ('collecting','awaiting_answer','awaiting_confirmation','filed','signed_off','void');
create type version_author    as enum ('agent','reporter_reply','office_user');
create type term_status       as enum ('built_in','auto_learned','needs_review','confirmed','rejected');
create type term_kind         as enum ('term','company','area','unit');
create type sender_status     as enum ('pending','linked','ignored');
create type job_status        as enum ('queued','running','done','failed','dead');
create type pack_status       as enum ('queued','building','ready','failed');
