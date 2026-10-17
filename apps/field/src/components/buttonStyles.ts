/**
 * The field buttons' classes (§14.1, §14.6). A caller's `className` is for layout only
 * (`flex-1`, a margin): never a colour, a size or a weight. Two Tailwind classes for the same
 * property both stay on the element and the stylesheet's order picks one, so each variant owns its
 * colours and type, and a light button on the dark Recording screen is its own variant
 * (`inverse`), not an override.
 */

/** Shape and target only (56 px, §14.6): no colour, no type. */
const SHAPE =
  'flex h-target w-full items-center justify-center gap-2.5 rounded-card px-5 text-center disabled:opacity-60';

export const BUTTON_VARIANTS = {
  /** Orange: the one primary action of a screen (§14.1 "signal"); text on orange is Asphalt. */
  primary: 'border-0 bg-signal text-asphalt text-[17px] font-bold',
  /** Asphalt on Chalk: the primary action where orange is not warranted (a confirm, a retry). */
  solid: 'border-0 bg-asphalt text-chalk text-[17px] font-bold',
  /** Chalk on the dark Recording screen: a retry there. */
  inverse: 'border-0 bg-chalk text-asphalt text-[17px] font-bold',
  /** White with a Rebar border: a secondary action (Add photos; Field-03: 16 px). */
  outline: 'border border-rebar bg-white text-asphalt text-[16px] font-semibold',
  /** Concrete: a tertiary action (No work today, Site closed: weather; Field-03: 14 px). */
  quiet: 'border border-rebar bg-concrete text-steel text-[14px] font-semibold',
  /** Steel with an Iron border on the dark Recording screen: a secondary action there. */
  steel: 'border border-iron bg-steel text-chalk text-[16px] font-bold',
  /** Chalk with a Rebar border: an answer to tap (Field-05, 18 px bold). */
  choice: 'border border-rebar bg-chalk text-asphalt text-[18px] font-bold',
  /**
   * End call on the dark call screen (W3-13): White on Missing red, its words and icon carry the
   * meaning (never the colour alone); not orange, which is the live state there.
   */
  end: 'border-0 bg-missing text-white text-[17px] font-bold',
  /** A text-only action that still fills a 56 px row (a resend link). */
  text: 'border-0 bg-transparent text-level text-[15px] font-semibold underline',
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

/** The classes of a variant (also for a `Link` that looks like that button). */
export function buttonClasses(variant: ButtonVariant, layout = ''): string {
  return `${SHAPE} ${BUTTON_VARIANTS[variant]} ${layout}`.trim();
}
