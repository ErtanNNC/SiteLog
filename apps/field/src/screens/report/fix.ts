import type { CorrectionView } from '@sitelog/shared/field-contract.ts';

/**
 * A fix of the draft on this screen (W2-10): `sending` while the clip goes through the queue or
 * the fix to field-api, `listening` while the worker makes the preview, then the preview
 * (`ready`), or what it could not do (`unclear`, `stale`), `saving` while Save change runs.
 */
export type Fix =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'listening'; id: string }
  | { kind: 'ready'; view: CorrectionView }
  | { kind: 'saving'; view: CorrectionView }
  | { kind: 'unclear'; view: CorrectionView | null }
  | { kind: 'stale' };

export function fixFromView(c: CorrectionView | null): Fix {
  if (!c) return { kind: 'idle' };
  if (c.status === 'listening') return { kind: 'listening', id: c.id };
  if (c.status === 'ready' && c.changes) return { kind: 'ready', view: c };
  if (c.status === 'unclear') return { kind: 'unclear', view: c };
  // W2-10 review: the report moved on while the fix was listened to: say so, once shown again.
  if (c.status === 'stale') return { kind: 'stale' };
  return { kind: 'idle' };
}
