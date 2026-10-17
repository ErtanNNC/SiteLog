import { METER_BARS, meterBars } from '@/recorder/level';

/** Field-04's level meter: 18 bars, the loud ones orange, decoration only (`aria-hidden`). */
export function LevelMeter({ levels, active }: { levels: readonly number[]; active: boolean }) {
  const bars = meterBars(active ? levels : [], METER_BARS);
  return (
    <div aria-hidden="true" className="flex h-[72px] items-center justify-center gap-1">
      {bars.map((level, i) => (
        <span
          key={i}
          className={`w-[5px] rounded-[3px] ${level > 0.35 ? 'bg-signal' : 'bg-iron'}`}
          style={{ height: `${Math.max(10, Math.round(10 + level * 54))}px` }}
        />
      ))}
    </div>
  );
}
