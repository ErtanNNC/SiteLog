/**
 * Panel notices in the reader's language (review 2026-10-15): a notification's `data`
 * (`{ key, params }`, migration 20261015000080, `noticeDataSchema` in @sitelog/shared) as copy
 * refs of `shell.notifications.notices.*`, rendered by the bell with the panel's `t()`. A row
 * without data, or with a key or values this panel does not know, keeps its stored English title
 * and body (`noticeText` → null); a notice whose wording has no body copy shows the stored body
 * (`body` null): a change note, a heard snippet, glossary terms, a provider's error.
 */
import { parseNoticeData } from '@sitelog/shared/notifications.ts';
import { copyRef } from '@/i18n/copyRef';
import type { CopyRef } from './types';

export interface NoticeText {
  title: CopyRef;
  /** The body as copy (several parts are joined with ", "); null: the row's stored body. */
  body: CopyRef[] | null;
}

/** A review reason (§10.5, §10.9) as an Overview line, or a part of a needs-review notice. */
export function reviewReasonRef(reason: string): CopyRef {
  const [kind, ...rest] = reason.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'unknown_company':
      return copyRef('overview.attention.reasons.unknown_company', { name: arg });
    case 'low_confidence':
      return copyRef('overview.attention.reasons.low_confidence', { field: arg });
    case 'unanswered':
      return copyRef('overview.attention.reasons.unanswered', { field: arg });
    case 'unconfirmed':
      return copyRef('overview.attention.reasons.unconfirmed');
    case 'missing':
      return copyRef('overview.attention.reasons.missing', { field: arg });
    case 'no_photo':
      return copyRef('overview.attention.reasons.no_photo');
    case 'call_mismatch':
      // `call_mismatch:<path>:<heard>:<confirmed>` since W3-11 (§19 Q123): the line names the
      // path; P7 words both values.
      return copyRef('overview.attention.reasons.call_mismatch', { field: rest[0] ?? '' });
    case 'call_unreconciled':
      // §19 Q123, Q153 (W3-11): the post-call reconcile could not run.
      return copyRef('overview.attention.reasons.call_unreconciled');
    default:
      return copyRef('overview.attention.reasons.other', { reason });
  }
}

const one = (ref: CopyRef): CopyRef[] => [ref];

/** A notification's `data` as its title and body copy, or null (render the stored text). */
export function noticeText(data: unknown): NoticeText | null {
  const n = parseNoticeData(data);
  if (!n) return null;
  switch (n.key) {
    case 'late_upload': {
      const { site, date, reporter, reportNo } = n.params;
      return {
        title:
          n.params.media === 'audio'
            ? copyRef('shell.notifications.notices.late_upload.titleAudio', {
                site,
                date: { date },
              })
            : copyRef('shell.notifications.notices.late_upload.titlePhoto', {
                site,
                date: { date },
              }),
        body: one(
          reporter
            ? copyRef('shell.notifications.notices.late_upload.body', { reporter, reportNo })
            : copyRef('shell.notifications.notices.late_upload.bodyUnnamed', { reportNo }),
        ),
      };
    }
    case 'missing_report': {
      const { site, first, reminders } = n.params;
      return {
        title: copyRef('shell.notifications.notices.missing_report.title', { site }),
        body: one(
          !first
            ? copyRef('shell.notifications.notices.missing_report.bodyUnnamed')
            : reminders
              ? copyRef('shell.notifications.notices.missing_report.bodyReminders', {
                  first,
                  count: reminders,
                })
              : copyRef('shell.notifications.notices.missing_report.body', { first }),
        ),
      };
    }
    case 'report_edited':
      return {
        title: copyRef('shell.notifications.notices.report_edited.title', n.params),
        body: null,
      };
    case 'needs_review':
      return {
        title: copyRef('shell.notifications.notices.needs_review.title', {
          reportNo: n.params.reportNo,
        }),
        body: n.params.reasons.length ? n.params.reasons.map(reviewReasonRef) : null,
      };
    case 'glossary_review':
      return {
        title: copyRef('shell.notifications.notices.glossary_review.title', n.params),
        body: null,
      };
    case 'pack_ready':
      return {
        title: n.params.site
          ? copyRef('shell.notifications.notices.pack_ready.title', { site: n.params.site })
          : copyRef('shell.notifications.notices.pack_ready.titleAllSites'),
        body: one(
          copyRef('shell.notifications.notices.pack_ready.body', {
            from: { date: n.params.from },
            to: { date: n.params.to },
          }),
        ),
      };
    case 'processing_delayed':
      return {
        title: copyRef('shell.notifications.notices.processing_delayed.title', n.params),
        body: null,
      };
    case 'processing_failed':
      return {
        title: copyRef('shell.notifications.notices.processing_failed.title', {
          reportNo: n.params.reportNo,
        }),
        body: one(
          copyRef('shell.notifications.notices.processing_failed.body', {
            tries: n.params.tries,
            job: n.params.job,
          }),
        ),
      };
    case 'message_not_sent':
    case 'message_not_handled': {
      const { name, tries, job } = n.params;
      return n.key === 'message_not_sent'
        ? {
            title: copyRef('shell.notifications.notices.message_not_sent.title', { name }),
            body: one(copyRef('shell.notifications.notices.message_not_sent.body', { tries, job })),
          }
        : {
            title: copyRef('shell.notifications.notices.message_not_handled.title', { name }),
            body: one(
              copyRef('shell.notifications.notices.message_not_handled.body', { tries, job }),
            ),
          };
    }
    case 'message_opted_out':
      return {
        title: copyRef('shell.notifications.notices.message_opted_out.title', n.params),
        body: one(copyRef('shell.notifications.notices.message_opted_out.body')),
      };
    case 'message_refused':
      return {
        title: copyRef('shell.notifications.notices.message_refused.title', {
          name: n.params.name,
        }),
        body: one(
          copyRef('shell.notifications.notices.message_refused.body', { error: n.params.error }),
        ),
      };
    case 'message_channels_failed':
      return {
        title: copyRef('shell.notifications.notices.message_channels_failed.title', {
          name: n.params.name,
        }),
        body: one(
          copyRef('shell.notifications.notices.message_channels_failed.body', {
            channels: n.params.channels,
            error: n.params.error,
          }),
        ),
      };
    case 'message_account_fault':
      return {
        title: n.params.name
          ? copyRef('shell.notifications.notices.message_account_fault.title', {
              name: n.params.name,
            })
          : copyRef('shell.notifications.notices.message_account_fault.titleUnnamed'),
        body: one(
          copyRef('shell.notifications.notices.message_account_fault.body', {
            error: n.params.error,
          }),
        ),
      };
    case 'message_no_sender':
      return {
        title: copyRef('shell.notifications.notices.message_no_sender.title', n.params),
        body: one(copyRef('shell.notifications.notices.message_no_sender.body')),
      };
    case 'welcome_undeliverable':
      return {
        title: copyRef('shell.notifications.notices.welcome_undeliverable.title', n.params),
        body: null,
      };
    case 'welcome_provider_fault':
      return {
        title: copyRef('shell.notifications.notices.welcome_provider_fault.title', {
          name: n.params.name,
        }),
        body: one(
          copyRef('shell.notifications.notices.welcome_provider_fault.body', {
            error: n.params.error,
          }),
        ),
      };
    case 'welcome_not_sent': {
      const title = copyRef('shell.notifications.notices.welcome_not_sent.title', {
        name: n.params.name,
      });
      switch (n.params.reason) {
        case 'opted_out':
          return {
            title,
            body: one(copyRef('shell.notifications.notices.welcome_not_sent.bodies.opted_out')),
          };
        case 'no_consent':
          return {
            title,
            body: one(copyRef('shell.notifications.notices.welcome_not_sent.bodies.no_consent')),
          };
        case 'no_channel':
          return {
            title,
            body: one(copyRef('shell.notifications.notices.welcome_not_sent.bodies.no_channel')),
          };
        case 'console_real_org':
          return {
            title,
            body: one(
              copyRef('shell.notifications.notices.welcome_not_sent.bodies.console_real_org'),
            ),
          };
      }
      break;
    }
    case 'welcome_carrier_undelivered':
      return {
        title: copyRef('shell.notifications.notices.welcome_carrier_undelivered.title', {
          name: n.params.name,
        }),
        body: one(
          copyRef('shell.notifications.notices.welcome_carrier_undelivered.body', {
            error: n.params.error,
          }),
        ),
      };
    case 'welcome_account_fault':
      return {
        title: n.params.name
          ? copyRef('shell.notifications.notices.welcome_account_fault.title', {
              name: n.params.name,
            })
          : copyRef('shell.notifications.notices.welcome_account_fault.titleUnnamed'),
        body: one(
          copyRef('shell.notifications.notices.welcome_account_fault.body', {
            error: n.params.error,
          }),
        ),
      };
    case 'reporter_opted_out':
      return {
        title: copyRef('shell.notifications.notices.reporter_opted_out.title', {
          name: n.params.name,
        }),
        body: one(
          copyRef('shell.notifications.notices.reporter_opted_out.body', {
            phone: n.params.phone,
          }),
        ),
      };
    case 'reporter_stop':
      return {
        title: copyRef('shell.notifications.notices.reporter_stop.title', { name: n.params.name }),
        body: one(
          copyRef('shell.notifications.notices.reporter_stop.body', { phone: n.params.phone }),
        ),
      };
    case 'unknown_contact':
      return {
        title: copyRef('shell.notifications.notices.unknown_contact.title'),
        body: null,
      };
    case 'reporter_consent_revoked':
      return {
        title:
          n.params.type === 'recording'
            ? copyRef('shell.notifications.notices.reporter_consent_revoked.titles.recording', {
                name: n.params.name,
              })
            : copyRef(
                'shell.notifications.notices.reporter_consent_revoked.titles.data_processing',
                { name: n.params.name },
              ),
        body: one(copyRef('shell.notifications.notices.reporter_consent_revoked.body')),
      };
    case 'device_verify_locked':
      return {
        title: copyRef('shell.notifications.notices.device_verify_locked.title', n.params),
        body: one(copyRef('shell.notifications.notices.device_verify_locked.body')),
      };
    case 'reporter_wrong_site':
      return {
        title: copyRef('shell.notifications.notices.reporter_wrong_site.title', n.params),
        body: one(copyRef('shell.notifications.notices.reporter_wrong_site.body')),
      };
    case 'payment_failed':
      return {
        title: copyRef('shell.notifications.notices.payment_failed.title'),
        body: one(copyRef('shell.notifications.notices.payment_failed.body')),
      };
    case 'subscription_canceled':
      return {
        title: copyRef('shell.notifications.notices.subscription_canceled.title'),
        body: one(copyRef('shell.notifications.notices.subscription_canceled.body')),
      };
    case 'late_report': {
      const { site, reportNo, crew, hours } = n.params;
      return {
        title: copyRef('shell.notifications.notices.late_report.title', { site }),
        body: one(
          copyRef('shell.notifications.notices.late_report.body', {
            reportNo,
            crew,
            hours: { hours },
          }),
        ),
      };
    }
    case 'invoice_gap': {
      const { company, invoiceNo, invoiced, reported, gap } = n.params;
      return {
        // Either way (spec §19 Q133): "+16 h" or "−8 h".
        title: copyRef('shell.notifications.notices.invoice_gap.title', {
          company,
          sign: gap < 0 ? '−' : '+',
          gap: { hours: Math.abs(gap) },
        }),
        body: one(
          copyRef('shell.notifications.notices.invoice_gap.body', {
            invoiceNo,
            invoiced: { hours: invoiced },
            reported: { hours: reported },
          }),
        ),
      };
    }
  }
  return null;
}
