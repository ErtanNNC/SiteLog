-- SiteLog · spec v1.2 §6.2 enums, expand phase A1 (W1-05 step 8, docs/GAP_ANALYSIS.md §7)
--   Only new types and new labels: no table, column, function or row uses them yet. Step 9 adds
--   the tables and columns that do, step 11 renames `verified` → `active` (so `active` is not
--   added here), `reporter_reply` → `reporter` and `sender_status` → `contact_status`.
--   Labels and order are §6.2's, plus `office` at the end of `field_channel` for reports typed in
--   the panel (GAP D13, a recorded deviation). Keep in sync with packages/shared/src/enums.ts
--   (asserted by supabase/db-tests).
--
-- Transactions: the Supabase CLI applies each migration file in one transaction, and PGlite runs
-- a multi-statement string as one implicit transaction. `ALTER TYPE … ADD VALUE` is allowed inside
-- a transaction (Postgres 12+), but the new label cannot be used before that transaction commits.
-- So this file must never use a label it adds (no default, cast, insert or function body that
-- names one); later migration files run in their own transactions and may. `if not exists` keeps
-- a re-run harmless.

-- New types (§6.2 order) --------------------------------------------------------------------------
create type contact_pref    as enum ('link','call');
create type consent_type    as enum ('sms','auto_call','recording','data_processing');
create type field_channel   as enum ('web','voice','sms','office');  -- + 'office': typed reports (D13)
create type link_kind       as enum ('personal','daily','photos');
create type upload_kind     as enum ('audio','photo');
create type call_direction  as enum ('inbound','outbound');
create type call_transport  as enum ('pstn','web');          -- phone network (SIP) or Talk now in the browser
create type call_status     as enum ('queued','ringing','in_progress','completed','no_answer','busy','failed','voicemail');
create type call_outcome    as enum ('filed','draft_saved','no_work','weather_day','edit_applied','callback_requested',
                                     'fallback_recording','abandoned','not_reached');
create type source_kind     as enum ('voice_note','call','photo','answer','text');

-- New labels on existing types, placed as in §6.2 --------------------------------------------------
-- report_status:   collecting, processing, awaiting_answer, awaiting_confirmation, filed, signed_off, void
alter type report_status add value if not exists 'processing' after 'collecting';
-- reporter_status: invited, verified (→ active in step 11), opted_out, disabled
alter type reporter_status add value if not exists 'opted_out' before 'disabled';
-- msg_status:      received, queued, sent, delivered, read (WhatsApp only, dropped with a new type
--                  in step 23), failed, undeliverable
alter type msg_status add value if not exists 'undeliverable' after 'failed';
