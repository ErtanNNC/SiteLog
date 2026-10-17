import { expect, test } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { admin, pinSeedClock, SEED, signInWithMagicLink } from './support';

/**
 * W3-18 · Site glossary against the real stack (spec F21, P11; W3-08's audited RPCs), part of the
 * M9 acceptance suite (`pnpm e2e:m9`, tagged `@m9 @F21`): the seeded review queue, a term changed
 * on its review card (`review_glossary_term`, audited `glossary.reviewed`), and a term added with
 * *Add term* (`add_glossary_term`, audited `glossary.added`). That confirmed terms feed the
 * extraction prompt and the speech recogniser's key terms (`buildKeyterms`, voice notes and
 * `get_context` on calls) is covered by the worker's and field-api's tests. Everything this spec
 * writes is put back afterwards (the specs share one database).
 */
test.describe.configure({ mode: 'serial' });

/** §18.1's "mud" (Oakmont, needs review): the term the spec changes and then restores. */
const MUD = { id: demoId('term:mud'), official: 'Joint compound' };
const CHANGED = 'Joint compound (drywall mud)';
const ADDED = { heard: 'e2e hoist run', official: 'Hoist cycle' };

async function cleanup() {
  const db = admin();
  await db
    .from('glossary_terms')
    .update({ status: 'needs_review', official: MUD.official })
    .eq('id', MUD.id);
  await db.from('audit_log').delete().eq('entity_id', MUD.id).eq('action', 'glossary.reviewed');
  const { data: added } = await db
    .from('glossary_terms')
    .select('id')
    .eq('org_id', SEED.orgId)
    .eq('heard', ADDED.heard);
  const ids = (added ?? []).map((r: { id: string }) => r.id);
  if (ids.length) {
    await db.from('audit_log').delete().in('entity_id', ids);
    await db.from('glossary_terms').delete().in('id', ids);
  }
}

test.beforeAll(cleanup);
test.afterAll(cleanup);

test.beforeEach(async ({ page }) => {
  await pinSeedClock(page);
  await signInWithMagicLink(page);
});

test(
  'a review card’s Change confirms the term through the audited RPC',
  { tag: ['@m9', '@F21'] },
  async ({ page }) => {
    await page.goto('/glossary');
    await expect(page.getByRole('heading', { name: 'Site glossary', level: 1 })).toBeVisible();
    const queue = page.getByTestId('review-queue');
    const card = queue.getByTestId('review-card').filter({ hasText: '“mud”' });
    await expect(card).toContainText(MUD.official);
    await expect(queue.getByTestId('review-card').filter({ hasText: '“colado”' })).toBeVisible();

    await card.getByRole('button', { name: 'Change', exact: true }).click();
    await card.getByLabel('Official term').fill(CHANGED);
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card).toHaveCount(0);

    const { data: term } = await admin()
      .from('glossary_terms')
      .select('status, official')
      .eq('id', MUD.id)
      .single()
      .throwOnError();
    expect(term).toEqual({ status: 'confirmed', official: CHANGED });
    const { data: audit } = await admin()
      .from('audit_log')
      .select('action, actor_id, diff')
      .eq('entity_id', MUD.id)
      .eq('action', 'glossary.reviewed')
      .throwOnError();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'glossary.reviewed',
        actor_id: SEED.admin.id,
        diff: expect.objectContaining({ action: 'change', official: CHANGED }),
      }),
    ]);
    await expect(page.getByRole('table', { name: 'All terms' })).toContainText(CHANGED);
  },
);

test(
  'Add term saves a confirmed term through the audited RPC',
  { tag: ['@m9', '@F21'] },
  async ({ page }) => {
    await page.goto('/glossary');
    await page.getByRole('button', { name: 'Add term' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add term' });
    await dialog.getByLabel('Heard in the field').fill(ADDED.heard);
    await dialog.getByLabel('Written in reports as').fill(ADDED.official);
    await dialog.getByRole('button', { name: 'Add term' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'All terms' })).toContainText(ADDED.official);

    const { data: rows } = await admin()
      .from('glossary_terms')
      .select('id, official, kind, language, status, scope_site_id')
      .eq('org_id', SEED.orgId)
      .eq('heard', ADDED.heard)
      .throwOnError();
    expect(rows).toEqual([
      expect.objectContaining({
        official: ADDED.official,
        kind: 'term',
        language: 'en',
        status: 'confirmed',
        scope_site_id: null,
      }),
    ]);
    const { data: audit } = await admin()
      .from('audit_log')
      .select('action, actor_id')
      .eq('entity_id', rows![0]!.id)
      .throwOnError();
    expect(audit).toEqual([{ action: 'glossary.added', actor_id: SEED.admin.id }]);
  },
);
