import { describe, expect, it } from 'vitest';
import {
  INVOICE_GAP_POLICY,
  invoiceHours,
  invoiceUploadPath,
  shouldNotifyInvoiceGap,
} from './invoices.ts';

describe('shouldNotifyInvoiceGap (spec §19 Q133 default)', () => {
  it('keeps the recommended default', () => {
    expect(INVOICE_GAP_POLICY).toEqual({
      minGapHours: 1,
      minChangeHours: 1,
      silentStatuses: ['queried', 'resolved'],
    });
  });

  it('notifies a first gap of at least 1 h, either way', () => {
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 16, lastNotified: null })).toBe(true);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: -8, lastNotified: null })).toBe(true);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 1, lastNotified: null })).toBe(true);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 0.75, lastNotified: null })).toBe(false);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 0, lastNotified: null })).toBe(false);
  });

  it('notifies again only when the gap moved by 1 h or more', () => {
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 16, lastNotified: 16 })).toBe(false);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 16.5, lastNotified: 16 })).toBe(false);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 17, lastNotified: 16 })).toBe(true);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 8, lastNotified: 16 })).toBe(true);
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: -16, lastNotified: 16 })).toBe(true);
    // Closed below the threshold: nothing to say, whatever was said before.
    expect(shouldNotifyInvoiceGap({ status: 'open', gap: 0, lastNotified: 16 })).toBe(false);
  });

  it('never notifies a queried or resolved invoice', () => {
    expect(shouldNotifyInvoiceGap({ status: 'queried', gap: 16, lastNotified: null })).toBe(false);
    expect(shouldNotifyInvoiceGap({ status: 'resolved', gap: 40, lastNotified: 16 })).toBe(false);
  });
});

describe('invoiceHours', () => {
  it('reads the total, else the sum of the lines', () => {
    expect(invoiceHours({ total_hours: 212, lines: [] })).toBe(212);
    expect(invoiceHours({ total_hours: '212.50', lines: null })).toBe(212.5);
    expect(
      invoiceHours({
        total_hours: null,
        lines: [
          { date: '2026-10-05', hours: 40 },
          { date: '2026-10-06', hours: 44 },
        ],
      }),
    ).toBe(84);
    expect(invoiceHours({ total_hours: null, lines: null })).toBe(0);
  });
});

describe('invoiceUploadPath (audit :878)', () => {
  const org = '7a0cfa5d-2a29-43fb-8665-fcd9bed4106d';
  const id = '0b1c2d3e-0000-4000-8000-000000000001';

  it('keeps the org folder first and only safe characters after it', () => {
    expect(invoiceUploadPath(org, 'BL-3381.pdf', id)).toBe(`${org}/${id}-BL-3381.pdf`);
    expect(invoiceUploadPath(org, 'Rechnung_März.pdf', id)).toBe(`${org}/${id}-Rechnung_Marz.pdf`);
    expect(invoiceUploadPath(org, 'Invoice [Oct].pdf', id)).toBe(`${org}/${id}-Invoice_Oct.pdf`);
    expect(invoiceUploadPath(org, 'Invoice #4471.PDF', id)).toBe(`${org}/${id}-Invoice_4471.pdf`);
    expect(invoiceUploadPath(org, 'Fatura Şubat %50 ığüş.pdf', id)).toBe(
      `${org}/${id}-Fatura_Subat_50_igus.pdf`,
    );
  });

  it('names a file with nothing safe left, or no extension', () => {
    expect(invoiceUploadPath(org, '####.pdf', id)).toBe(`${org}/${id}-invoice.pdf`);
    expect(invoiceUploadPath(org, 'scan', id)).toBe(`${org}/${id}-scan.pdf`);
    expect(invoiceUploadPath(org, '../../etc/passwd', id)).toMatch(
      new RegExp(`^${org}/${id}-[A-Za-z0-9._-]+\\.[a-z0-9]+$`),
    );
  });
});
