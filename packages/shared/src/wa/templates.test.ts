import { describe, expect, it } from 'vitest';
import {
  buildTemplatePayload,
  renderTemplateText,
  templateButtons,
  TEMPLATES,
} from './templates.ts';

describe('templates', () => {
  it('renders variables into the free-form equivalent', () => {
    expect(renderTemplateText('sitelog_reminder_1', ['Priya', 'Elm St. Townhomes'])).toBe(
      'Hi Priya — no report yet for Elm St. Townhomes today. A one-minute voice note is plenty.',
    );
  });
  it('builds a Meta template payload with quick-reply payloads', () => {
    const buttons = templateButtons('sitelog_reminder_1', { siteDayId: 'sd1' });
    expect(buttons.map((b) => b.id)).toEqual([
      'rem:sd1:recording',
      'rem:sd1:no_work',
      'rem:sd1:weather',
    ]);
    const payload = buildTemplatePayload('sitelog_reminder_1', ['Priya', 'Elm St.'], buttons);
    expect(payload).toMatchObject({ name: 'sitelog_reminder_1', language: { code: 'en' } });
    const components = payload.components as Array<Record<string, unknown>>;
    expect(components[0]).toEqual({
      type: 'body',
      parameters: [
        { type: 'text', text: 'Priya' },
        { type: 'text', text: 'Elm St.' },
      ],
    });
    expect(components).toHaveLength(4);
  });
  it('keeps every template button title within 20 chars', () => {
    for (const t of Object.values(TEMPLATES))
      for (const b of t.buttons) expect(b.length).toBeLessThanOrEqual(20);
  });
});
