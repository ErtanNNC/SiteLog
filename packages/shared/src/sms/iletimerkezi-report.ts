import { z } from 'zod';
import type { MsgStatus } from '../enums.ts';
import type { FetchLike, IletimerkeziCredentials } from './transports.ts';
import { ILETIMERKEZI_API_BASE } from './transports.ts';

/**
 * İletimerkezi delivery status (spec §19 Q237, the recommended first option; W4-11): İletimerkezi
 * has no delivery callback wired, so the worker's `sms_status` job reads the order's report
 * +2 min, +15 min and +2 h after the send (`SMS_STATUS_POLL_OFFSETS_MS`), stopping at the first
 * final answer, and moves the `messages` row through the §4.5 statuses (never backwards,
 * `nextMessageStatus`), so the fallback walk and `message_failed` work for TR texts as they do for
 * Twilio's callbacks (`applyLateStatus`).
 *
 * The report endpoint's request and answer are not known to this repo: no account, no
 * documentation in hand, and no real send made (spec §19 Q280). So the transport-level part is
 * built (the POST, HTTP 429 / 5xx and network errors retryable, anything else a refusal) and the
 * endpoint itself is a parameter, `IletimerkeziReportEndpoint`: its path, its body and the parser
 * of its answer into SiteLog's own `IletimerkeziReport`. `ILETIMERKEZI_REPORT_ENDPOINT` stays null
 * until the owner has the documentation (W4-13); until then the job reads no report and the row
 * stays `sent` (as before W4-11), and the tests run the job and the transport against the fixture
 * endpoint (`ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT`, `fixtures/iletimerkezi/*.json`), whose answer
 * is the normalized report itself. Filling the real endpoint is one object here and its tests.
 */

/** What the report says of one recipient. `unknown`: a status the parser does not know. */
export const ILETIMERKEZI_DELIVERIES = ['pending', 'delivered', 'undelivered', 'unknown'] as const;
export type IletimerkeziDelivery = (typeof ILETIMERKEZI_DELIVERIES)[number];

export const IletimerkeziReportSchema = z.object({
  /** false: the provider has no report for the order yet (a report not ready is not a failure). */
  ready: z.boolean(),
  recipients: z
    .array(
      z.object({
        /** As the provider writes it (`905321234567`); compared without `+`. */
        number: z.string().min(1),
        delivery: z.enum(ILETIMERKEZI_DELIVERIES),
        /** The provider's own status code for the recipient, kept for `messages.error`. */
        code: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type IletimerkeziReport = z.infer<typeof IletimerkeziReportSchema>;

/** Reads the delivery report of an order (the order id of `iletimerkezi:<id>`). */
export interface IletimerkeziReportSource {
  report(orderId: string): Promise<IletimerkeziReport>;
}

/**
 * The report endpoint (spec §19 Q280): where to POST, what to send for an order, and how its
 * answer reads as an `IletimerkeziReport`. `parse` throws on an answer it does not recognise
 * (a refusal in the provider's envelope included); the source turns that into a refusal.
 */
export interface IletimerkeziReportEndpoint {
  path: string;
  body(orderId: string, creds: IletimerkeziCredentials): unknown;
  parse(json: unknown): IletimerkeziReport;
}

/**
 * The provider's report endpoint, once confirmed against its documentation (spec §19 Q280, W4-13).
 * null: not confirmed, so no report is read and İletimerkezi rows stay `sent`.
 */
export const ILETIMERKEZI_REPORT_ENDPOINT: IletimerkeziReportEndpoint | null = null;

/**
 * The tests' and the mock's endpoint: the answer is SiteLog's normalized report, validated. Never
 * pointed at the provider (its path does not exist there).
 */
export const ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT: IletimerkeziReportEndpoint = {
  path: '/sitelog-fixture/report',
  body: (orderId) => ({ orderId }),
  parse: (json) => IletimerkeziReportSchema.parse(json),
};

/** A report the provider refused or could not give; `retryable` for 429, 5xx and the network. */
export class IletimerkeziReportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'IletimerkeziReportError';
  }
}

/** The report source over HTTP for an endpoint (the credentials go only to `endpoint.body`). */
export function createIletimerkeziReportSource(
  creds: IletimerkeziCredentials,
  fetchImpl: FetchLike,
  endpoint: IletimerkeziReportEndpoint,
  apiBase: string = ILETIMERKEZI_API_BASE,
): IletimerkeziReportSource {
  return {
    async report(orderId) {
      let res: Response;
      try {
        res = await fetchImpl(`${apiBase}${endpoint.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(endpoint.body(orderId, creds)),
        });
      } catch (err) {
        throw new IletimerkeziReportError(
          `iletimerkezi report: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
      if (res.status === 429 || res.status >= 500) {
        throw new IletimerkeziReportError(
          `iletimerkezi report ${res.status}: ${res.statusText}`,
          true,
          res.status,
        );
      }
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new IletimerkeziReportError(
          `iletimerkezi report ${res.status}: ${res.statusText}`,
          false,
          res.status,
        );
      }
      try {
        return endpoint.parse(json);
      } catch (err) {
        throw new IletimerkeziReportError(
          `iletimerkezi report: unrecognised answer (${err instanceof Error ? err.name : 'error'})`,
          false,
          res.status,
        );
      }
    },
  };
}

/** The order id of a `messages.provider_message_id` written by the driver, or null. */
export function iletimerkeziOrderId(providerMessageId: string | null): string | null {
  const m = /^iletimerkezi:(.+)$/.exec(providerMessageId ?? '');
  return m ? m[1]! : null;
}

/**
 * When the `sms_status` job reads the report, after the send (spec §19 Q237): +2 min, +15 min,
 * +2 h. Poll n (1-based) runs at `sentAt + SMS_STATUS_POLL_OFFSETS_MS[n - 1]`; after the last, a
 * row still not final stays `sent` (audited `sms.status_unresolved`). The first offset is also
 * the delay of `enqueue_sms_status_poll()` (SQL, 20261017000440).
 */
export const SMS_STATUS_POLL_OFFSETS_MS = [2 * 60_000, 15 * 60_000, 2 * 60 * 60_000] as const;
export const SMS_STATUS_POLLS = SMS_STATUS_POLL_OFFSETS_MS.length;

/** `messages.error` of an undelivered İletimerkezi text (`iletimerkezi report 112`). */
export function iletimerkeziReportErrorText(code: string | null): string {
  return code ? `iletimerkezi report ${code}` : 'iletimerkezi report undelivered';
}

export interface ReportVerdict {
  /** The §4.5 status the report gives the message, or null while it is not final. */
  status: Extract<MsgStatus, 'delivered' | 'undeliverable'> | null;
  /** What the report said of the recipient (`pending` when not ready or not listed). */
  delivery: IletimerkeziDelivery;
  code: string | null;
}

/**
 * What a report says about the message to `phone` (E.164): its recipient by number (without
 * `+`), or the order's only recipient (SiteLog sends one number per order). A report not ready,
 * a recipient not listed, `pending` and `unknown` are not final: the message stays `sent` and the
 * next poll reads again. Only `delivered` and `undelivered` move it; an undelivered text counts as
 * the number's (`undeliverable`, F3 "Can't reach this number" for a welcome), never the account's,
 * since the report speaks of the recipient.
 */
export function reportVerdict(report: IletimerkeziReport, phone: string | null): ReportVerdict {
  if (!report.ready) return { status: null, delivery: 'pending', code: null };
  const digits = (phone ?? '').replace(/^\+/, '');
  const recipient =
    report.recipients.find((r) => r.number.replace(/^\+/, '') === digits) ??
    (report.recipients.length === 1 ? report.recipients[0] : undefined);
  if (!recipient) return { status: null, delivery: 'pending', code: null };
  const { delivery, code } = recipient;
  if (delivery === 'delivered') return { status: 'delivered', delivery, code };
  if (delivery === 'undelivered') return { status: 'undeliverable', delivery, code };
  return { status: null, delivery, code };
}
