import { formatDuration, formatMonthDay, weekdayName } from '../format.ts';
import { PROGRESS_COPY_EN, fillCopy, progressCrewLine } from '../report/progress.ts';

/**
 * §9.3 — free-form message catalog (inside the 24 h service window).
 * Tone (§9.7): short, lead with the result, no blame, no emoji, first names only.
 */
export const waCopy = {
  ackReceived: (first: string, durationS: number | null, nPhotos: number): string => {
    const parts: string[] = [];
    if (durationS !== null) parts.push(formatDuration(durationS));
    if (nPhotos > 0) parts.push(`${nPhotos} photo${nPhotos === 1 ? '' : 's'}`);
    return `Got it, ${first}${parts.length ? ` — ${parts.join(' and ')}` : ''}.`;
  },
  progress: (): string => 'Writing your report…',
  /**
   * §F5 step 3. WhatsApp cannot edit a sent message, so this is one bubble listing the steps done
   * so far; lines use a plain "- " marker (§9.3 note: no emoji, no check glyphs elsewhere in copy).
   */
  progressLines: (steps: string[]): string =>
    ['Writing your report…', ...steps.map((s) => `- ${s}`)].join('\n'),
  /** The step phrases moved to the field copy (`field.processing.steps`, W1-09); read from there. */
  progressTranscribed: (): string => PROGRESS_COPY_EN.transcribed,
  progressCrew: (n: number, k: number): string => progressCrewLine(n, k),
  /** "Rain 07:00–10:30 logged as delay"; other conditions pass their own label ("High wind"). */
  progressRain: (start: string, end: string, condition = 'Rain'): string =>
    fillCopy(PROGRESS_COPY_EN.weather, { condition, start, end }),
  progressHours: (): string => PROGRESS_COPY_EN.hours,
  questionGeneric: (question: string): string =>
    question.startsWith('Quick check') ? question : `Quick check: ${question}`,
  answerAckManpower: (company: string, workers: number, hoursPer: number, total: number): string =>
    `Thanks — ${company}: ${workers} workers × ${hoursPer} h = ${total} h.`,
  answerOther: (): string => 'Tell me in a voice note or text.',
  fixPrompt: (): string => 'What should I change?',
  draftFooter: (): string => 'Reply OK to file it, or tell me what to fix.',
  filed: (reportNo: string, first: string): string =>
    `Filed. Daily Report ${reportNo} is with the office. Thanks, ${first} — that's it for today.`,
  editHint: (weekday: string): string =>
    `Need a change later? Reply "edit ${weekday}" any time. The office gets a new version; the old one is kept.`,
  editApplied: (weekday: string, change: string, v: number): string =>
    `Updated ${weekday}: ${change}. Version ${v} sent to the office · version ${v - 1} kept in history.`,
  weatherDayLogged: (time: string | null, cause: string): string =>
    time
      ? `Logged as a weather day: crew released ${time}, cause ${cause}. It's now in the delay record for extension claims.`
      : `Logged as a weather day: no work because of ${cause}. It's now in the delay record for extension claims.`,
  weatherDayFollowup: (): string =>
    'How many were on site this morning? And a photo of conditions would make the record stronger.',
  noWorkLogged: (site: string): string => `Noted — no work today at ${site}.`,
  photoOnNoWorkDay: (site: string): string =>
    `Got the photo. Today is logged as no work at ${site}; if the crew did work, send a quick voice note.`,
  photosOnly: (): string =>
    "Got the photos. Send a quick voice note with today's work, crew and weather.",
  unclearAudio: (): string =>
    "I couldn't make that out — try again closer to the phone, away from machinery.",
  unknownNumber: (): string =>
    "Hi — this number isn't set up with TalkOlog yet, so nothing was filed. I've let the office know.",
  unknownNumberNoOrg: (): string =>
    "Hi — this number isn't set up with TalkOlog yet, so nothing was filed. Ask your office to add your number.",
  sitePaused: (site: string): string =>
    `${site} is paused in TalkOlog. Ask the office to resume it.`,
  pickSite: (): string => 'Which site is this for?',
  whichDay: (today: string, yesterday: string): string =>
    `Is this for today (${formatMonthDay(today)}) or yesterday (${formatMonthDay(yesterday)})?`,
  lockedReport: (): string => 'That report is locked. Ask the office to change it.',
  noReportFound: (): string => "I couldn't find a report for that day. Which day do you mean?",
  help: (): string =>
    'Send one voice note a day: work done, crew by company, weather, deliveries, safety. ' +
    'Commands: "edit Friday …", "no work today", "stop" (no more reminders today).',
  errorRetry: (): string =>
    "Something went wrong on my side — I've kept your note and I'm retrying. No need to resend.",
  stopAck: (): string => 'OK — no more reminders today.',
  recordingAck: (): string => "Great — I'm listening.",
  welcomeFollowup: (): string =>
    'Speak Spanish or English — the report always comes out in English. Try a 20-second test note now; nothing gets filed.',
  wrongSiteAck: (): string => "Thanks — I've told the office.",
  testHeard: (snippet: string, deadline: string): string =>
    `Heard you clearly: "${snippet}." You're all set — see you at ${deadline}.`,
  testTextInstead: (): string =>
    'That works too, but voice is faster. Send a test voice note when you can.',
  testDone: (deadline: string): string => `You're all set — see you at ${deadline}.`,
  mergedMore: (): string => "Got it — adding that to today's report.",
  draftNudge: (): string =>
    "Still waiting on your OK for today's draft. Reply OK to file it, or tell me what to fix.",
  filedUnconfirmed: (reportNo: string): string =>
    `Filed ${reportNo} without your OK so the office has it. Reply "edit today" if anything is wrong.`,
  youreWelcome: (): string => "You're welcome.",
  languageAck: (lang: string): string =>
    `Noted — replies in ${lang} are coming in a later version. Reports always come out in English.`,
  editCandidates: (): string => 'Which report do you mean?',
  weatherPhotoAck: (): string => 'Thanks — the photo is in the delay record.',
  processingDelayed: (): string =>
    "Your note is in — the report is taking a little longer than usual. I'll send the draft shortly.",
  /** "edit Friday" hint uses the report's weekday. */
  weekdayFor: (isoDate: string): string => weekdayName(isoDate),
} as const;

export type WaCopyKey = keyof typeof waCopy;
