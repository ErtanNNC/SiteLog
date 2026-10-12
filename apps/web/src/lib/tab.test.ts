import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInNewTab } from './tab';

describe('openInNewTab', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps noopener for remote URLs and drops it for blob: URLs (Chrome blob partitioning)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openInNewTab('https://x.supabase.co/storage/v1/object/sign/pdfs/a.pdf?token=t');
    openInNewTab('blob:https://app.example/8f1c');
    expect(open.mock.calls).toEqual([
      ['https://x.supabase.co/storage/v1/object/sign/pdfs/a.pdf?token=t', '_blank', 'noopener'],
      ['blob:https://app.example/8f1c', '_blank'],
    ]);
  });
});
