import type { Resend } from 'resend';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock(import('resend'), () => ({
  Resend: class {
    emails = { send };
  } as unknown as typeof Resend,
}));

const { createResendProvider } = await import('./provider');

const msg = {
  to: ['office@example.com'],
  subject: 'Daily report',
  html: '<p>x</p>',
  text: 'x',
  idempotencyKey: 'email:report_filed:r1:1',
};

describe('Resend provider: idempotency conflicts (review of a5da973)', () => {
  beforeEach(() => send.mockReset());

  it('treats a 409 invalid_idempotent_request on a keyed retry as already sent', async () => {
    send.mockResolvedValueOnce({
      data: null,
      error: {
        name: 'invalid_idempotent_request',
        statusCode: 409,
        message: 'Same idempotency key used with a different request payload.',
      },
    });
    const provider = createResendProvider('re_test', 'TalkOlog <r@x.y>');
    await expect(provider.send(msg)).resolves.toEqual({ id: null, alreadySent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toEqual({ idempotencyKey: msg.idempotencyKey });
  });

  it('still fails a concurrent request (retried later) and any 409 without a key', async () => {
    send.mockResolvedValueOnce({
      data: null,
      error: { name: 'concurrent_idempotent_requests', statusCode: 409, message: 'in progress' },
    });
    const provider = createResendProvider('re_test', 'TalkOlog <r@x.y>');
    await expect(provider.send(msg)).rejects.toThrow(/concurrent_idempotent_requests/);
    send.mockResolvedValueOnce({
      data: null,
      error: { name: 'invalid_idempotent_request', statusCode: 409, message: 'x' },
    });
    await expect(provider.send({ ...msg, idempotencyKey: undefined })).rejects.toThrow(
      /invalid_idempotent_request/,
    );
  });

  it('returns the id of an accepted email', async () => {
    send.mockResolvedValueOnce({ data: { id: 'em_1' }, error: null });
    const provider = createResendProvider('re_test', 'TalkOlog <r@x.y>');
    await expect(provider.send(msg)).resolves.toEqual({ id: 'em_1' });
  });
});
