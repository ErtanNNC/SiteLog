/**
 * The demo calls' two-lane material (W3-05): a call transcript with both speakers, built from the
 * report the call filed, and the two-lane `calls.peaks` drawn from it, so the panel's call player
 * shows its reporter and assistant lanes without a stack. The demo's synthetic recordings
 * (`apps/web/public/demo/*.ogg`, `pnpm demo:call-audio`) are tones laid out on the same segments:
 * the reporter on the left channel, the assistant on the right (§9.4 "Recording"), no speech.
 *
 * Seed text, not product copy: the agent's real lines are `copy/voice.*.ts` (W3-12).
 */
import type { CallPeaks } from '../voice.ts';
import type { DailyReportData, Source } from '../schemas/report.ts';
import { demoRand } from './ids.ts';

export interface DemoCallSegment {
  start: number;
  end: number;
  speaker: 'reporter' | 'agent';
  text: string;
}

/** The demo calls that have a synthetic recording, by the site key of their report. */
export const DEMO_CALL_AUDIO_SITES = ['northgate', 'hillcrest'] as const;
export type DemoCallAudioSite = (typeof DEMO_CALL_AUDIO_SITES)[number];

/** Where a demo call's synthetic recording is served from, under the panel's base URL. */
export function demoCallAudioPath(site: DemoCallAudioSite): string {
  return `demo/call-${site}.ogg`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The second a value's first call source starts at, if it cites this call. */
function callStart(sources: readonly Source[] | undefined, callId: string): number | null {
  const s = sources?.find((x) => x.type === 'call' && x.callId === callId);
  return s && s.type === 'call' ? s.start : null;
}

/**
 * A call's transcript with both speakers: the assistant's opening, the reporter's lines at the
 * seconds the report's values cite (each line says the values cited there), the assistant's
 * prompts in the gaps, the read-back with code's totals, the spoken yes and the goodbye, ending
 * a second before the call does.
 */
export function demoCallTranscript(
  data: DailyReportData,
  input: {
    callId: string;
    firstName: string;
    company: string;
    durationS: number;
    /** The read-back's totals (computed in code, never by a model). */
    totals: { crewOnSite: number; totalHours: number; lostHours: number };
  },
): DemoCallSegment[] {
  const facts: Array<{ start: number; text: string }> = [];
  const add = (sources: readonly Source[] | undefined, text: string) => {
    const start = callStart(sources, input.callId);
    if (start !== null) facts.push({ start, text });
  };
  for (const p of data.weather.periods)
    add(
      p.source,
      [p.condition + (p.start ? ` from ${p.start}` : ''), p.impact].filter(Boolean).join('. ') +
        '.',
    );
  for (const m of data.manpower)
    add(
      m.source,
      `${m.companyNameHeard || m.companyName}, ${m.workers ?? 'some'} guys, ${m.hoursPerWorker ?? 'a few'} hours${m.area ? `, ${m.area}` : ''}.`,
    );
  for (const w of data.workPerformed)
    add(
      w.source,
      `${w.activity} at ${w.area}${w.status === 'complete' ? ', all done' : ', still going'}.`,
    );
  for (const d of data.deliveries)
    add(d.source, `${d.item}${d.quantity ? `, ${d.quantity}` : ''} came in.`);
  add(
    data.safety.source,
    [
      data.safety.toolboxTalk ? `Toolbox talk on ${data.safety.toolboxTalk.toLowerCase()}` : null,
      data.safety.noIncidentsStated ? 'No incidents' : null,
    ]
      .filter(Boolean)
      .join('. ') + '.',
  );
  for (const n of data.nextWorkday) add(n.source, `Tomorrow: ${n.item}.`);

  const starts = [...new Set(facts.map((f) => f.start))].sort((a, b) => a - b);
  const out: DemoCallSegment[] = [];
  const first = starts[0] ?? 8;
  out.push({
    start: 0,
    end: round1(Math.max(1, first - 0.5)),
    speaker: 'agent',
    text: `Hi ${input.firstName}, this is the SiteLog assistant for ${input.company}. This call is recorded for your daily report. Tell me about today.`,
  });
  let last = first;
  starts.forEach((start, i) => {
    const next = starts[i + 1];
    const end = round1(next !== undefined ? Math.min(next, start + 9) : start + 9);
    if (i > 0 && start - last >= 3)
      out.push({
        start: round1(last + 0.3),
        end: round1(start - 0.3),
        speaker: 'agent',
        text: 'Got it. What else?',
      });
    out.push({
      start,
      end,
      speaker: 'reporter',
      text: facts
        .filter((f) => f.start === start)
        .map((f) => f.text)
        .join(' '),
    });
    last = end;
  });

  const tail = Math.max(last + 1, input.durationS - 12);
  const t = input.totals;
  const readBack =
    data.manpower.length > 0
      ? `Here is what I have: ${data.manpower
          .map(
            (m) =>
              `${m.companyName}, ${m.workers ?? '?'} workers, ${m.hoursPerWorker ?? '?'} hours`,
          )
          .join('; ')}. ${t.crewOnSite} on site, ${t.totalHours} hours in total. Shall I file it?`
      : `Here is what I have: a weather day, ${t.lostHours} hours lost. Shall I file it?`;
  out.push({ start: round1(last + 1), end: round1(tail - 0.5), speaker: 'agent', text: readBack });
  out.push({
    start: round1(tail),
    end: round1(tail + 3),
    speaker: 'reporter',
    text: 'Yes, file it.',
  });
  out.push({
    start: round1(tail + 4),
    end: round1(Math.max(tail + 5, input.durationS - 1)),
    speaker: 'agent',
    text: `Filed. The PDF comes by text. Thanks, ${input.firstName}.`,
  });
  return out;
}

/** Lane peaks per bar of the call (0 … 1), deterministic per key: loud while that lane speaks. */
export function demoCallPeaks(
  segments: readonly DemoCallSegment[],
  durationS: number,
  key: string,
  bars = 96,
): CallPeaks {
  const lane = (speaker: DemoCallSegment['speaker']) =>
    Array.from({ length: bars }, (_, i) => {
      const from = (i * durationS) / bars;
      const to = ((i + 1) * durationS) / bars;
      const on = segments.some((s) => s.speaker === speaker && s.start < to && s.end > from);
      return on
        ? Math.round((0.35 + 0.6 * demoRand(`lane:${key}:${speaker}`, i)) * 100) / 100
        : 0.02;
    });
  return { reporter: lane('reporter'), agent: lane('agent') };
}
