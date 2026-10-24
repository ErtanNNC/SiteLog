import { ButtonIds, type Button } from './buttons.ts';

/** §9.2 — business-initiated templates (category Utility, language en). */
export const TEMPLATE_NAMES = [
  'sitelog_welcome',
  'sitelog_weather_headsup',
  'sitelog_reminder_1',
  'sitelog_reminder_2',
  'sitelog_report_edited_by_office',
  'sitelog_reinvite',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface TemplateSpec {
  name: TemplateName;
  /** Body text with {{n}} placeholders, exactly as submitted to Meta. */
  body: string;
  /** Quick-reply buttons in order; payloads are set per send. */
  buttons: string[];
}

export const TEMPLATES: Record<TemplateName, TemplateSpec> = {
  sitelog_welcome: {
    name: 'sitelog_welcome',
    body:
      "Hi {{1}} — I'm TalkOlog, the reporting assistant for {{2}}. You're set up as site manager for {{3}}. " +
      'Each workday before {{4}}, send me one voice note: work done, who was on site, weather, deliveries, delays. ' +
      "Add 1–2 photos. I'll do the paperwork.",
    buttons: ['Got it', 'Wrong site'],
  },
  sitelog_weather_headsup: {
    name: 'sitelog_weather_headsup',
    body: 'Heads-up: report due at {{1}}. {{2}} — mention the hours lost and what stopped.',
    buttons: [],
  },
  sitelog_reminder_1: {
    name: 'sitelog_reminder_1',
    body: 'Hi {{1}} — no report yet for {{2}} today. A one-minute voice note is plenty.',
    buttons: ['Recording now', 'No work today', 'Site closed: weather'],
  },
  sitelog_reminder_2: {
    name: 'sitelog_reminder_2',
    body: "Still nothing for today. I'll let the office know at {{1}} unless I hear from you.",
    buttons: [],
  },
  sitelog_report_edited_by_office: {
    name: 'sitelog_report_edited_by_office',
    body: "The office updated report {{1}}: {{2}}. Reply here if that's wrong.",
    buttons: [],
  },
  sitelog_reinvite: {
    name: 'sitelog_reinvite',
    body: 'Hi {{1}}, {{2}} uses TalkOlog for daily site reports. Reply to this message to get started.',
    buttons: ['Get started'],
  },
};

/** Fill {{n}} placeholders → the free-form equivalent used inside the 24 h window. */
export function renderTemplateText(name: TemplateName, vars: string[]): string {
  return TEMPLATES[name].body.replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => vars[Number(n) - 1] ?? '',
  );
}

/** Button payloads for each template send (quick replies come back as `button.payload`). */
export function templateButtons(name: TemplateName, ctx: { siteDayId?: string } = {}): Button[] {
  const titles = TEMPLATES[name].buttons;
  switch (name) {
    case 'sitelog_welcome':
      return [
        { id: ButtonIds.welcomeOk(), title: titles[0]! },
        { id: ButtonIds.welcomeWrongSite(), title: titles[1]! },
      ];
    case 'sitelog_reminder_1': {
      const sd = ctx.siteDayId ?? 'unknown';
      return [
        { id: ButtonIds.reminderRecording(sd), title: titles[0]! },
        { id: ButtonIds.reminderNoWork(sd), title: titles[1]! },
        { id: ButtonIds.reminderWeather(sd), title: titles[2]! },
      ];
    }
    case 'sitelog_reinvite':
      return [{ id: ButtonIds.reinviteStart(), title: titles[0]! }];
    default:
      return [];
  }
}

/** Meta Graph API `template` object for a send. */
export function buildTemplatePayload(
  name: TemplateName,
  vars: string[],
  buttons: Button[],
  language = 'en',
): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];
  if (vars.length > 0) {
    components.push({
      type: 'body',
      parameters: vars.map((text) => ({ type: 'text', text })),
    });
  }
  buttons.forEach((b, index) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload: b.id }],
    });
  });
  return { name, language: { code: language }, components };
}
