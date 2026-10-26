import type { ReportView } from '@sitelog/shared/field-contract.ts';

/** The report is still being written: keep polling (F5 step 4). */
export function stillProcessing(view: Pick<ReportView, 'status'>): boolean {
  return view.status === 'collecting' || view.status === 'processing';
}

export type Tick = 'transcribed' | 'crew' | 'weather' | 'hours';

export const TICKS: Tick[] = ['transcribed', 'crew', 'weather', 'hours'];

/** Which step ticks are done, from the view model (never from the model's say-so: the data). */
export function ticksDone(view: ReportView): Record<Tick, boolean> {
  const data = view.data;
  return {
    transcribed:
      view.progress.voiceNotes > 0 && view.progress.transcribed >= view.progress.voiceNotes,
    crew: !!data && data.manpower.length > 0,
    weather: !!data && data.weather.periods.length > 0,
    hours: !stillProcessing(view),
  };
}
