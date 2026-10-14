/**
 * Allowlist for the D11 end-state diff (schema-end-state.test.ts): every difference between the
 * schema of the spec's §6.2–§6.4 SQL and the schema of supabase/migrations, each with its reason
 * and what closes it (a migration step of docs/GAP_ANALYSIS.md §7, a ticket, or `kept` for a
 * recorded deviation, README "Deliberate deviations").
 *
 * The test fails on a difference listed nowhere, and on a listed difference that no longer exists:
 * remove an entry's line in the commit that closes it. A `pending` entry records a deviation that
 * appears only when a later step lands: the test fails once it matches (drop `pending` then), and
 * also when its `pendingWhile` differences are gone without it appearing (the step landed in
 * another shape: fix the schema or remove the entry and its README row).
 */

export interface AllowEntry {
  id: string;
  reason: string;
  /** The migration step or ticket that removes these differences, or `kept`. */
  closes: string;
  /** The decision that records it (GAP §6) or where it is recorded. */
  decision?: string;
  /** Not a difference yet: it appears when this lands. */
  pending?: string;
  /**
   * With `pending`: differences (listed in other entries) that must still exist while the entry is
   * pending, e.g. the missing table its columns belong to. Once they are gone, `diffs` must exist.
   */
  pendingWhile?: string[];
  /** Exact strings from diffSchemas() (schema-diff.ts). */
  diffs: string[];
}

export const SCHEMA_ALLOWLIST: AllowEntry[] = [
  {
    id: 'd12-tables',
    reason:
      'Repo-only tables kept as recorded additions: panel notifications (§13), SiteLog operators and cost per report (/ops), scheduler bookkeeping, Stripe webhook idempotency.',
    closes: 'kept',
    decision: 'D12',
    diffs: [
      'table extra: notifications',
      'table extra: platform_admins',
      'table extra: report_costs',
      'table extra: scheduler_state',
      'table extra: stripe_events',
    ],
  },
  {
    id: 'd12-columns',
    reason:
      'Repo-only columns kept as recorded additions: reminder-ladder toggles, PDF template (footer, photos, letterhead; pdf_paper is in §6.3 since W1-06a), payroll and billing-grace settings (§F18, §P12, §F19), the 14-day trial, reports.kind (§F10 weather/no-work days), the "stop" flag on site-days.',
    closes: 'kept',
    decision: 'D12',
    diffs: [
      'column extra: org_settings.include_unconfirmed_in_payroll (boolean not null default true)',
      "column extra: org_settings.letterhead_lines (text[] not null default '{}'::text[])",
      'column extra: org_settings.missing_enabled (boolean not null default true)',
      'column extra: org_settings.no_work_pdf (boolean not null default false)',
      'column extra: org_settings.past_due_grace_days (integer not null default 14)',
      "column extra: org_settings.payroll_columns (text[] not null default '{date,site,project_code,company,trade,workers,hours,report_no,version}'::text[])",
      'column extra: org_settings.pdf_footer_enabled (boolean not null default true)',
      'column extra: org_settings.pdf_max_photos (integer not null default 4)',
      'column extra: org_settings.reminder1_enabled (boolean not null default true)',
      'column extra: org_settings.reminder2_enabled (boolean not null default true)',
      'column extra: org_settings.updated_at (timestamp with time zone not null default now())',
      'column extra: orgs.trial_ends_at (timestamp with time zone)',
      "column extra: reports.kind (text not null default 'daily'::text)",
      'column extra: site_days.reminders_paused (boolean not null default false)',
      "constraint extra: org_settings CHECK (((payroll_columns <@ '{date,site,project_code,company,trade,workers,hours,report_no,version}'::text[]) AND ((cardinality(payroll_columns) >= 1) AND (cardinality(payroll_columns) <= 9))))",
      "constraint extra: reports CHECK ((kind = ANY (ARRAY['daily'::text, 'weather_day'::text, 'no_work'::text])))",
    ],
  },
  {
    id: 'd12-bookkeeping',
    reason:
      'Repo-only bookkeeping columns kept as recorded additions (GAP 9.2 "extras"): created/updated timestamps, sites.paused_at, invoice query and resolve times, evidence-pack sections, error and ready time, the queue\'s locked_by, finished_at and lock_key, the manpower company-name snapshot and hours basis, work-item quantities.',
    closes: 'kept',
    decision: 'D12',
    diffs: [
      'column extra: companies.created_at (timestamp with time zone not null default now())',
      'column extra: evidence_packs.error (text)',
      'column extra: evidence_packs.ready_at (timestamp with time zone)',
      "column extra: evidence_packs.sections (text[] not null default '{summary,reports,transcripts,photos,weather}'::text[])",
      'column extra: jobs.finished_at (timestamp with time zone)',
      'column extra: jobs.lock_key (text)',
      'column extra: jobs.locked_by (text)',
      'column extra: manpower_entries.company_name (text)',
      'column extra: manpower_entries.hours_basis (text)',
      'column extra: org_members.created_at (timestamp with time zone not null default now())',
      'column extra: questions.created_at (timestamp with time zone not null default now())',
      'column extra: reporters.created_at (timestamp with time zone not null default now())',
      'column extra: reports.created_at (timestamp with time zone not null default now())',
      'column extra: reports.updated_at (timestamp with time zone not null default now())',
      'column extra: site_days.created_at (timestamp with time zone not null default now())',
      'column extra: site_days.updated_at (timestamp with time zone not null default now())',
      'column extra: sites.paused_at (timestamp with time zone)',
      'column extra: sub_invoices.queried_at (timestamp with time zone)',
      'column extra: sub_invoices.resolved_at (timestamp with time zone)',
      'column extra: work_items.quantity (text)',
    ],
  },
  {
    id: 'repo-checks',
    reason: 'Checks the repo adds on text columns and phone numbers (stricter than the spec).',
    closes: 'kept',
    decision: 'GAP 9.2 (repo stricter)',
    diffs: [
      "constraint extra: audit_log CHECK ((actor_type = ANY (ARRAY['user'::text, 'reporter'::text, 'agent'::text, 'system'::text])))",
      "constraint extra: reporters CHECK ((phone_e164 ~ '^\\+[1-9][0-9]{6,14}$'::text))",
      "constraint extra: sub_invoices CHECK ((status = ANY (ARRAY['open'::text, 'queried'::text, 'resolved'::text])))",
    ],
  },
  {
    id: 'repo-not-null',
    reason:
      'NOT NULL on columns that always have a value (a default, or a parent the row cannot exist without): the repo is stricter than the spec.',
    closes: 'kept',
    decision: 'GAP 9.2 (repo stricter)',
    diffs: [
      'column nullability: audit_log.created_at (spec null; repo not null)',
      'column nullability: companies.aliases (spec null; repo not null)',
      'column nullability: companies.is_self_perform (spec null; repo not null)',
      'column nullability: companies.status (spec null; repo not null)',
      'column nullability: evidence_packs.created_at (spec null; repo not null)',
      'column nullability: evidence_packs.org_id (spec null; repo not null)',
      'column nullability: evidence_packs.period_end (spec null; repo not null)',
      'column nullability: evidence_packs.period_start (spec null; repo not null)',
      'column nullability: evidence_packs.status (spec null; repo not null)',
      'column nullability: glossary_terms.first_seen_at (spec null; repo not null)',
      'column nullability: glossary_terms.kind (spec null; repo not null)',
      'column nullability: glossary_terms.language (spec null; repo not null)',
      'column nullability: glossary_terms.times_heard (spec null; repo not null)',
      'column nullability: jobs.created_at (spec null; repo not null)',
      'column nullability: jobs.run_after (spec null; repo not null)',
      'column nullability: messages.created_at (spec null; repo not null)',
      'column nullability: org_settings.email_pdf_on_file (spec null; repo not null)',
      'column nullability: org_settings.filing_mode (spec null; repo not null)',
      'column nullability: org_settings.heads_up_enabled (spec null; repo not null)',
      'column nullability: org_settings.heads_up_offset_min (spec null; repo not null)',
      'column nullability: org_settings.max_questions_per_report (spec null; repo not null)',
      'column nullability: org_settings.missing_offset_min (spec null; repo not null)',
      'column nullability: org_settings.payroll_csv_format (spec null; repo not null)',
      'column nullability: org_settings.reminder1_offset_min (spec null; repo not null)',
      'column nullability: org_settings.reminder2_offset_min (spec null; repo not null)',
      'column nullability: org_settings.required_fields (spec null; repo not null)',
      'column nullability: org_settings.signoff_required (spec null; repo not null)',
      'column nullability: orgs.created_at (spec null; repo not null)',
      'column nullability: questions.report_id (spec null; repo not null)',
      'column nullability: report_sources.report_id (spec null; repo not null)',
      'column nullability: report_versions.created_at (spec null; repo not null)',
      'column nullability: reporters.languages (spec null; repo not null)',
      'column nullability: reports.is_late (spec null; repo not null)',
      'column nullability: reports.needs_review (spec null; repo not null)',
      'column nullability: reports.review_reasons (spec null; repo not null)',
      'column nullability: site_days.is_late (spec null; repo not null)',
      'column nullability: site_reporters.is_primary (spec null; repo not null)',
      'column nullability: sites.created_at (spec null; repo not null)',
      'column nullability: sub_invoices.company_id (spec null; repo not null)',
      'column nullability: sub_invoices.created_at (spec null; repo not null)',
      'column nullability: sub_invoices.org_id (spec null; repo not null)',
      'column nullability: sub_invoices.status (spec null; repo not null)',
      'column nullability: transcripts.created_at (spec null; repo not null)',
      'column nullability: unknown_contacts.created_at (spec null; repo not null)',
      'column nullability: unknown_contacts.status (spec null; repo not null)',
      'column nullability: weather_events.full_day (spec null; repo not null)',
      'column nullability: weather_events.photo_count (spec null; repo not null)',
    ],
  },
  {
    id: 'repo-on-delete',
    reason:
      "ON DELETE actions the spec leaves as NO ACTION (17 keys), kept as built until the owner answers: deleting an org, site or site-day removes its reports with their versions, evidence packs and weather rows (org deletion, test and load-test cleanup), deleting an org also its unknown contacts, deleting a company its invoices, and deleting a company, reporter, user or report keeps the history with a null link, as deleting a message does for an unknown contact's message link (message_id becomes null). If the owner picks the spec, a forward migration changes the keys and this entry goes.",
    closes: 'kept',
    decision: 'pending owner: spec §19 question 17 (GAP §8 question 11)',
    diffs: [
      'constraint extra: evidence_packs FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE',
      'constraint extra: glossary_terms FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL',
      'constraint extra: glossary_terms FOREIGN KEY (scope_reporter_id) REFERENCES reporters(id) ON DELETE CASCADE',
      'constraint extra: glossary_terms FOREIGN KEY (scope_site_id) REFERENCES sites(id) ON DELETE CASCADE',
      'constraint extra: manpower_entries FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL',
      'constraint extra: messages FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE',
      'constraint extra: report_sources FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE',
      'constraint extra: reports FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE',
      'constraint extra: reports FOREIGN KEY (reporter_id) REFERENCES reporters(id) ON DELETE SET NULL',
      'constraint extra: reports FOREIGN KEY (signed_off_by) REFERENCES auth.users(id) ON DELETE SET NULL',
      'constraint extra: reports FOREIGN KEY (site_day_id) REFERENCES site_days(id) ON DELETE CASCADE',
      'constraint extra: reports FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE',
      'constraint extra: site_days FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL',
      'constraint extra: sub_invoices FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE',
      'constraint extra: unknown_contacts FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL',
      'constraint extra: unknown_contacts FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE',
      'constraint extra: weather_events FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE',
      'constraint missing: evidence_packs FOREIGN KEY (site_id) REFERENCES sites(id)',
      'constraint missing: glossary_terms FOREIGN KEY (company_id) REFERENCES companies(id)',
      'constraint missing: glossary_terms FOREIGN KEY (scope_reporter_id) REFERENCES reporters(id)',
      'constraint missing: glossary_terms FOREIGN KEY (scope_site_id) REFERENCES sites(id)',
      'constraint missing: manpower_entries FOREIGN KEY (company_id) REFERENCES companies(id)',
      'constraint missing: messages FOREIGN KEY (org_id) REFERENCES orgs(id)',
      'constraint missing: report_sources FOREIGN KEY (message_id) REFERENCES messages(id)',
      'constraint missing: reports FOREIGN KEY (org_id) REFERENCES orgs(id)',
      'constraint missing: reports FOREIGN KEY (reporter_id) REFERENCES reporters(id)',
      'constraint missing: reports FOREIGN KEY (signed_off_by) REFERENCES auth.users(id)',
      'constraint missing: reports FOREIGN KEY (site_day_id) REFERENCES site_days(id)',
      'constraint missing: reports FOREIGN KEY (site_id) REFERENCES sites(id)',
      'constraint missing: site_days FOREIGN KEY (report_id) REFERENCES reports(id)',
      'constraint missing: sub_invoices FOREIGN KEY (company_id) REFERENCES companies(id)',
      'constraint missing: unknown_contacts FOREIGN KEY (message_id) REFERENCES messages(id)',
      'constraint missing: unknown_contacts FOREIGN KEY (org_id) REFERENCES orgs(id)',
      'constraint missing: weather_events FOREIGN KEY (site_id) REFERENCES sites(id)',
    ],
  },
  {
    id: 'd13-office',
    reason:
      'field_channel has office for reports typed in the panel (typed reports are a recorded office fallback, D30). It has no whatsapp: WhatsApp is a message channel (message_channel, D48), and an inbound label waits for spec §19 Q26.',
    closes: 'kept',
    decision: 'D13',
    diffs: ['enum labels: field_channel (spec web,voice,sms; repo web,voice,sms,office)'],
  },
  {
    id: 'd13-channel-nullable',
    reason:
      'channel stays nullable: v1.0 Meta WhatsApp reports and questions have none. Every v1.2 writer sets it (field-api web, office RPCs office, W1-12 questions web) and an insert trigger rejects a null channel from step 22.',
    closes: 'kept',
    decision: 'D13',
    diffs: [
      'column nullability: questions.channel (spec not null; repo null)',
      'column nullability: reports.channel (spec not null; repo null)',
    ],
  },
  {
    id: 'd13-unknown-contacts-channel',
    reason:
      'unknown_contacts.channel stays nullable for the unknown v1.0 Meta WhatsApp senders it was renamed from (20261014000003) and the v1.0 Meta WhatsApp worker that writes them until step 22; sms-webhook (W1-08) writes sms and the voice agent (week 2) voice, and the step 22 insert trigger rejects a null channel.',
    closes: 'kept',
    decision: 'D13',
    diffs: ['column nullability: unknown_contacts.channel (spec not null; repo null)'],
  },
  {
    id: 'd12-unknown-contacts-guess',
    reason:
      'unknown_contacts.guessed_site_id: the site the content names, for the "Link to {guessed site}" action (§F13 "guessed org/site", GAP 9.2 "keep guessed_site_id"); cleared when the site is deleted.',
    closes: 'kept',
    decision: 'D12',
    diffs: [
      'column extra: unknown_contacts.guessed_site_id (uuid)',
      'constraint extra: unknown_contacts FOREIGN KEY (guessed_site_id) REFERENCES sites(id) ON DELETE SET NULL',
    ],
  },
  {
    id: 'd14-office-uploads',
    reason:
      'Office photos have no reporter: uploads.reporter_id is nullable and uploaded_by names the office user, so PDFs, the Photos tab and evidence packs read one photo model.',
    closes: 'kept',
    decision: 'D14',
    diffs: [
      'column extra: uploads.uploaded_by (uuid)',
      'column nullability: uploads.reporter_id (spec not null; repo null)',
    ],
  },
  {
    id: 'd12-uploads-purged',
    reason:
      'Retention (§15) deletes an expired file and its transcript and keeps the uploads row with purged_at (20261014000002), as it keeps a WhatsApp message with storage_path null: report_sources keep their upload_id (an office photo has no other key), so a version still lists a purged photo and an office edit does not drop it unaudited. Readers treat a purged upload as a missing file.',
    closes: 'kept',
    decision: 'D12',
    diffs: ['column extra: uploads.purged_at (timestamp with time zone)'],
  },
  {
    id: 'w1-10-dedupe',
    reason:
      'jobs.dedupe_key is unique only among queued and running jobs (index jobs_dedupe_key_active); §6.3 makes it fully unique with insert … on conflict do nothing (D16).',
    closes: 'W1-10',
    decision: 'D16',
    diffs: ['constraint missing: jobs UNIQUE (dedupe_key)'],
  },
  {
    id: 'step23-stripe',
    reason:
      'stripe_* → billing_* by expand/contract (GAP 9.1): since step 11 (20261014000003) every reader and writer uses billing_*, and the orgs_billing_ids trigger keeps the legacy stripe_* columns equal to them for the functions deployed before the cut-over; the contract drops them. The trigger is declared UPDATE OF both stripe_* columns, so they depend on it: the contract runs `drop trigger orgs_billing_ids on orgs; drop function sync_org_billing_ids();` before `alter table orgs drop column stripe_customer_id, drop column stripe_subscription_id` (without CASCADE, which would drop the trigger and leave the function behind).',
    closes: 'step 23',
    diffs: [
      'column extra: orgs.stripe_customer_id (text)',
      'column extra: orgs.stripe_subscription_id (text)',
    ],
  },
  {
    id: 'step23-whatsapp',
    reason:
      'WhatsApp-era schema (conversations, message media, type and template columns, WhatsApp message keys on questions, versions, sources and transcripts, the convo_state and msg_type enums). It keeps working until step 22 and is dropped in the contract, step 23; step 9 made messages.type and transcripts.message_id optional, so SMS rows and upload or call transcripts fit beside it.',
    closes: 'step 23',
    diffs: [
      'column extra: messages.conversation_id (uuid)',
      'column extra: messages.duration_s (numeric)',
      'column extra: messages.media_id (text)',
      'column extra: messages.media_mime (text)',
      'column extra: messages.payload (jsonb)',
      'column extra: messages.storage_path (text)',
      'column extra: messages.template_name (text)',
      'column extra: messages.type (msg_type)',
      'column extra: messages.wa_message_id (text)',
      'column extra: questions.answered_message_id (uuid)',
      'column extra: questions.asked_message_id (uuid)',
      'column extra: report_sources.caption (text)',
      'column extra: report_sources.taken_at (timestamp with time zone)',
      'column extra: report_versions.author_message_id (uuid)',
      'column extra: reporters.last_invite_error (text)',
      'column extra: reporters.verified_at (timestamp with time zone)',
      'column extra: transcripts.message_id (uuid)',
      'constraint extra: messages CHECK (((conversation_id IS NOT NULL) OR (org_id IS NOT NULL) OR (phone_e164 IS NOT NULL)))',
      'constraint extra: messages FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE',
      'constraint extra: messages UNIQUE (wa_message_id)',
      'constraint extra: questions FOREIGN KEY (answered_message_id) REFERENCES messages(id) ON DELETE SET NULL',
      'constraint extra: questions FOREIGN KEY (asked_message_id) REFERENCES messages(id) ON DELETE SET NULL',
      'constraint extra: report_sources UNIQUE (report_id, message_id)',
      'constraint extra: report_versions FOREIGN KEY (author_message_id) REFERENCES messages(id) ON DELETE SET NULL',
      'constraint extra: transcripts FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE',
      'constraint extra: transcripts UNIQUE (message_id)',
      'enum extra: convo_state',
      'enum extra: msg_type',
      'table extra: conversations',
    ],
  },
  {
    id: 'step23-messages',
    reason:
      'messages is extended in place (D15): v1.0 Meta WhatsApp rows have no body, phone number or message channel and start as received; office photo rows have no phone number. msg_status keeps read for WhatsApp receipts (D49). After the Meta integration is retired (step 22), legacy rows move to an archive and messages gets the v1.2 NOT NULLs (body, phone_e164, channel) and default.',
    closes: 'step 23',
    decision: 'D15',
    diffs: [
      "column default: messages.status (spec 'queued'::msg_status; repo 'received'::msg_status)",
      'column nullability: messages.body (spec not null; repo null)',
      'column nullability: messages.channel (spec not null; repo null)',
      'column nullability: messages.phone_e164 (spec not null; repo null)',
    ],
  },
  {
    id: 'step23-strict',
    reason:
      "The spec's exact transcripts XOR and report_sources.kind as source_kind: a NOT VALID check still checks new rows, and the WhatsApp transcribe_audio path writes transcripts with neither key and sources with the old kinds until step 22. Meanwhile step 9 allows at most one of upload_id / call_id and widens the kind check to the old and the source_kind labels; step 23 replaces both.",
    closes: 'step 23',
    diffs: [
      "constraint extra: report_sources CHECK ((kind = ANY (ARRAY['audio'::text, 'photo'::text, 'text'::text, 'reply'::text, 'voice_note'::text, 'call'::text, 'answer'::text])))",
      'constraint extra: transcripts CHECK ((num_nonnulls(upload_id, call_id) <= 1))',
      'column type: report_sources.kind (spec source_kind; repo text)',
      'constraint missing: transcripts CHECK (((upload_id IS NOT NULL) <> (call_id IS NOT NULL)))',
    ],
  },
];
