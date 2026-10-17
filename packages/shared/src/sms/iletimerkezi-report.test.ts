import { describe, expect, it } from 'vitest';
import {
  ILETIMERKEZI_REPORT_ENDPOINT,
  ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT,
  IletimerkeziReportError,
  SMS_STATUS_POLL_OFFSETS_MS,
  createIletimerkeziReportSource,
  iletimerkeziOrderId,
  iletimerkeziReportErrorText,
  reportVerdict,
  type IletimerkeziReport,
} from './iletimerkezi-report.ts';
import type { FetchLike } from './transports.ts';

/**
 * W4-11 (spec §19 Q237, Q280): the İletimerkezi delivery report behind its interface, against a
 * mocked İletimerkezi serving the fixture endpoint. The reports are those of
 * `fixtures/iletimerkezi/report-*.json` (this package has no Node types to read them; the worker's
 * PGlite test reads the files).
 */

const RECIPIENT = '905321234567';
const FIXTURES: Record<string, unknown> = {
  'report-delivered': {
    ready: true,
    recipients: [{ number: RECIPIENT, delivery: 'delivered', code: null }],
  },
  'report-undelivered': {
    ready: true,
    recipients: [{ number: RECIPIENT, delivery: 'undelivered', code: 'fixture-undelivered' }],
  },
  'report-pending': {
    ready: true,
    recipients: [{ number: RECIPIENT, delivery: 'pending', code: null }],
  },
  'report-not-ready': { ready: false, recipients: [] },
  'report-unknown': {
    ready: true,
    recipients: [{ number: RECIPIENT, delivery: 'unknown', code: 'fixture-unknown' }],
  },
};
const fixture = (name: string): unknown => FIXTURES[name];

function mockFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const creds = { apiKey: 'key-1', apiHash: 'hash-1' };
const PHONE = '+905321234567';

function source(http: ReturnType<typeof mockFetch>) {
  return createIletimerkeziReportSource(
    creds,
    http.fetch,
    ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT,
    'https://ime.test',
  );
}

describe('the report endpoint (spec §19 Q280)', () => {
  it('is not set until the owner has the provider documentation', () => {
    expect(ILETIMERKEZI_REPORT_ENDPOINT).toBeNull();
  });

  it('polls at +2 min, +15 min and +2 h (spec §19 Q237)', () => {
    expect(SMS_STATUS_POLL_OFFSETS_MS).toEqual([120_000, 900_000, 7_200_000]);
  });
});

describe('the report source over HTTP (mocked İletimerkezi)', () => {
  it('posts the endpoint body for the order and reads each fixture', async () => {
    const names = ['delivered', 'undelivered', 'pending', 'not-ready', 'unknown'];
    const http = mockFetch(...names.map((n) => json(200, fixture(`report-${n}`))));
    const reports: IletimerkeziReport[] = [];
    for (const _ of names) reports.push(await source(http).report('98765'));
    expect(http.calls[0]!.url).toBe('https://ime.test/sitelog-fixture/report');
    expect(http.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(http.calls[0]!.init.body))).toEqual({ orderId: '98765' });
    // The credentials never go in the URL.
    expect(http.calls.every((c) => !c.url.includes('key-1') && !c.url.includes('hash-1'))).toBe(
      true,
    );
    expect(reports.map((r) => reportVerdict(r, PHONE))).toEqual([
      { status: 'delivered', delivery: 'delivered', code: null },
      { status: 'undeliverable', delivery: 'undelivered', code: 'fixture-undelivered' },
      { status: null, delivery: 'pending', code: null },
      { status: null, delivery: 'pending', code: null },
      { status: null, delivery: 'unknown', code: 'fixture-unknown' },
    ]);
  });

  it('429, 5xx and the network are retryable; anything else is a refusal', async () => {
    const http = mockFetch(
      json(429, {}),
      json(503, {}),
      new TypeError('fetch failed'),
      json(401, {}),
      new Response('<html>', { status: 200 }),
      json(200, { ready: 'yes' }),
    );
    const errors: IletimerkeziReportError[] = [];
    for (let i = 0; i < 6; i++)
      errors.push(
        await source(http)
          .report('1')
          .catch((e) => e),
      );
    expect(errors.every((e) => e instanceof IletimerkeziReportError)).toBe(true);
    expect(errors.map((e) => [e.retryable, e.status])).toEqual([
      [true, 429],
      [true, 503],
      [true, null],
      [false, 401],
      [false, 200],
      [false, 200],
    ]);
  });
});

describe('reportVerdict', () => {
  const report = (recipients: IletimerkeziReport['recipients']): IletimerkeziReport => ({
    ready: true,
    recipients,
  });

  it('finds the recipient by number, with or without +', () => {
    const r = report([
      { number: '905320000001', delivery: 'undelivered', code: 'x' },
      { number: '+905321234567', delivery: 'delivered', code: null },
    ]);
    expect(reportVerdict(r, PHONE).status).toBe('delivered');
    expect(reportVerdict(r, '+905320000001').status).toBe('undeliverable');
    // Not listed among several: not final.
    expect(reportVerdict(r, '+905329999999')).toEqual({
      status: null,
      delivery: 'pending',
      code: null,
    });
  });

  it("takes an order's only recipient whatever its spelling", () => {
    const r = report([{ number: '05321234567', delivery: 'delivered', code: null }]);
    expect(reportVerdict(r, PHONE).status).toBe('delivered');
    expect(reportVerdict(report([]), PHONE).status).toBeNull();
  });
});

describe('helpers', () => {
  it('reads the order id the driver wrote', () => {
    expect(iletimerkeziOrderId('iletimerkezi:98765')).toBe('98765');
    expect(iletimerkeziOrderId('SM123')).toBeNull();
    expect(iletimerkeziOrderId(null)).toBeNull();
  });

  it("names an undelivered text's error", () => {
    expect(iletimerkeziReportErrorText('7')).toBe('iletimerkezi report 7');
    expect(iletimerkeziReportErrorText(null)).toBe('iletimerkezi report undelivered');
  });
});
