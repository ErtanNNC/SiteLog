import type { Database } from './types.ts';

type Rows = Database['public']['Tables'];

/**
 * What the v1.2 columns of 20261013000007_schema_expand_v1_2.sql hold on a row whose writer does
 * not set them: the column's database default, or null. In-memory stores that build rows by hand
 * (the Kestrel dataset, the panel's demo store, the worker's fake database) spread these, so their
 * rows have every column a select returns. A v1.2 writer sets its own values instead.
 */
export const V12_ROW_DEFAULTS = {
  orgs: {
    country: 'US',
    locale: 'en-US',
    units: 'imperial',
    currency: 'USD',
    tax_no: null,
    is_demo: false,
  },
  org_members: { ui_locale: null },
  org_settings: {
    daily_link_time: '17:00:00',
    auto_call_enabled: true,
    second_call_enabled: true,
    call_window_start: '07:00:00',
    call_window_end: '20:00:00',
  },
  reporters: { locale: 'en-US', contact_pref: 'link', activated_at: null, opted_out_at: null },
  messages: {
    reporter_id: null,
    phone_e164: null,
    provider: null,
    provider_message_id: null,
    copy_key: null,
  },
  transcripts: { upload_id: null, call_id: null },
  /**
   * language: NOT NULL with no default since 20261014000002, so every writer sets it; the rows built
   * here are the en-US Kestrel org's (reportLanguageFor('en-US')).
   */
  reports: { channel: null, language: 'en', confirmed_via: null },
  report_versions: { via: null },
  /** created_at: null as on the rows from before the migration; new rows get now(). */
  report_sources: { upload_id: null, call_id: null, question_id: null, created_at: null },
  questions: { channel: null, call_id: null, answer_source: null },
} as const satisfies { [T in keyof Rows]?: Partial<Rows[T]['Row']> };
