/** §9.4 — interactive reply IDs. Titles ≤ 20 chars, ≤ 3 buttons per message. */

export const BUTTON_TITLE_MAX = 20;
export const BUTTONS_MAX = 3;

export interface Button {
  id: string;
  title: string;
}

export function truncateTitle(title: string, max = BUTTON_TITLE_MAX): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export function button(id: string, title: string): Button {
  return { id, title: truncateTitle(title) };
}

export const ButtonIds = {
  welcomeOk: () => 'welcome:ok',
  welcomeWrongSite: () => 'welcome:wrong_site',
  testExample: () => 'test:example',
  testDone: () => 'test:done',
  question: (questionId: string, optionIndex: number | 'other') => `q:${questionId}:${optionIndex}`,
  draftOk: (reportId: string) => `draft:${reportId}:ok`,
  draftFix: (reportId: string) => `draft:${reportId}:fix`,
  reminderRecording: (siteDayId: string) => `rem:${siteDayId}:recording`,
  reminderNoWork: (siteDayId: string) => `rem:${siteDayId}:no_work`,
  reminderWeather: (siteDayId: string) => `rem:${siteDayId}:weather`,
  weatherPhoto: (reportId: string) => `wx:${reportId}:photo`,
  weatherVoice: (reportId: string) => `wx:${reportId}:voice`,
  site: (siteId: string) => `site:${siteId}`,
  day: (isoDate: string) => `day:${isoDate}`,
  editCandidate: (reportId: string) => `edit:${reportId}`,
  reinviteStart: () => 'reinvite:start',
} as const;

export type ParsedButton =
  | { kind: 'welcome'; action: 'ok' | 'wrong_site' }
  | { kind: 'test'; action: 'example' | 'done' }
  | { kind: 'question'; questionId: string; option: number | 'other' }
  | { kind: 'draft'; reportId: string; action: 'ok' | 'fix' }
  | { kind: 'reminder'; siteDayId: string; action: 'recording' | 'no_work' | 'weather' }
  | { kind: 'weather'; reportId: string; action: 'photo' | 'voice' }
  | { kind: 'site'; siteId: string }
  | { kind: 'day'; date: string }
  | { kind: 'edit'; reportId: string }
  | { kind: 'reinvite' }
  | { kind: 'unknown'; id: string };

export function parseButtonId(id: string): ParsedButton {
  const [ns, a, b] = id.split(':');
  switch (ns) {
    case 'welcome':
      if (a === 'ok' || a === 'wrong_site') return { kind: 'welcome', action: a };
      break;
    case 'test':
      if (a === 'example' || a === 'done') return { kind: 'test', action: a };
      break;
    case 'q':
      if (a && b !== undefined) {
        if (b === 'other') return { kind: 'question', questionId: a, option: 'other' };
        const n = Number(b);
        if (Number.isInteger(n) && n >= 0) return { kind: 'question', questionId: a, option: n };
      }
      break;
    case 'draft':
      if (a && (b === 'ok' || b === 'fix')) return { kind: 'draft', reportId: a, action: b };
      break;
    case 'rem':
      if (a && (b === 'recording' || b === 'no_work' || b === 'weather'))
        return { kind: 'reminder', siteDayId: a, action: b };
      break;
    case 'wx':
      if (a && (b === 'photo' || b === 'voice')) return { kind: 'weather', reportId: a, action: b };
      break;
    case 'site':
      if (a) return { kind: 'site', siteId: a };
      break;
    case 'day':
      if (a && /^\d{4}-\d{2}-\d{2}$/.test(a)) return { kind: 'day', date: a };
      break;
    case 'edit':
      if (a) return { kind: 'edit', reportId: a };
      break;
    case 'reinvite':
      return { kind: 'reinvite' };
  }
  return { kind: 'unknown', id };
}

/** Standard button sets. */
export const ButtonSets = {
  welcome: (): Button[] => [
    button(ButtonIds.welcomeOk(), 'Got it'),
    button(ButtonIds.welcomeWrongSite(), 'Wrong site'),
  ],
  test: (): Button[] => [
    button(ButtonIds.testExample(), 'Show an example'),
    button(ButtonIds.testDone(), 'Done'),
  ],
  draft: (reportId: string): Button[] => [
    button(ButtonIds.draftOk(reportId), 'OK, file it'),
    button(ButtonIds.draftFix(reportId), 'Fix something'),
  ],
  reminder1: (siteDayId: string): Button[] => [
    button(ButtonIds.reminderRecording(siteDayId), 'Recording now'),
    button(ButtonIds.reminderNoWork(siteDayId), 'No work today'),
    button(ButtonIds.reminderWeather(siteDayId), 'Site closed: weather'),
  ],
  weatherFollowup: (reportId: string): Button[] => [
    button(ButtonIds.weatherPhoto(reportId), 'Send photo'),
    button(ButtonIds.weatherVoice(reportId), 'Answer by voice'),
  ],
  whichDay: (
    today: string,
    yesterday: string,
    labels: { today: string; yesterday: string },
  ): Button[] => [
    button(ButtonIds.day(today), labels.today),
    button(ButtonIds.day(yesterday), labels.yesterday),
  ],
  /** Model options (≤ 2) + Other… (§10.5 step 5). */
  question: (questionId: string, options: string[]): Button[] => {
    const opts = options
      .slice(0, BUTTONS_MAX - 1)
      .map((o, i) => button(ButtonIds.question(questionId, i), o));
    return [...opts, button(ButtonIds.question(questionId, 'other'), 'Other…')];
  },
  sites: (sites: Array<{ id: string; shortName: string }>): Button[] =>
    sites.slice(0, BUTTONS_MAX).map((s) => button(ButtonIds.site(s.id), s.shortName)),
  editCandidates: (reports: Array<{ id: string; label: string }>): Button[] =>
    reports.slice(0, BUTTONS_MAX).map((r) => button(ButtonIds.editCandidate(r.id), r.label)),
};
