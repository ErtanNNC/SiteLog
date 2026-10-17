import { describe, expect, it } from 'vitest';
import type { FieldApiClient, FieldApiRequest } from './client';
import { createFieldRoutes } from './field';

describe('field routes (W1-12)', () => {
  it('posts an answer to reports/:id/answer with the link code', async () => {
    const calls: Array<[string, FieldApiRequest | undefined]> = [];
    const api: FieldApiClient = {
      url: (route) => `/api/${route}`,
      request: <T>(route: string, init?: FieldApiRequest) => {
        calls.push([route, init]);
        return Promise.resolve({ status: 'processing', reportStatus: 'processing' } as T);
      },
    };
    const routes = createFieldRoutes(api);
    const res = await routes.answer('K7Q2MX', 'r 1', {
      questionId: '11111111-0000-4000-8000-00000000f101',
      value: 5,
      hours: 'full_day',
    });
    expect(res).toEqual({ status: 'processing', reportStatus: 'processing' });
    expect(calls).toEqual([
      [
        'reports/r%201/answer',
        {
          body: { questionId: '11111111-0000-4000-8000-00000000f101', value: 5, hours: 'full_day' },
          linkCode: 'K7Q2MX',
        },
      ],
    ]);
  });
});
