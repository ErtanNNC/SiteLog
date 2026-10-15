import type { ButtonHTMLAttributes } from 'react';
import { buttonClasses, type ButtonVariant } from './buttonStyles';

/** `className` takes layout classes only (`buttonStyles.ts`). */
type Props = ButtonHTMLAttributes<HTMLButtonElement>;

function Base({ variant, className = '', ...rest }: Props & { variant: ButtonVariant }) {
  return <button type="button" {...rest} className={buttonClasses(variant, className)} />;
}

/** Orange: the one primary action of a screen; text on orange is Asphalt. */
export function PrimaryButton(props: Props) {
  return <Base variant="primary" {...props} />;
}

/** Asphalt on Chalk: the primary action where orange is not warranted (a confirm, a retry). */
export function SolidButton(props: Props) {
  return <Base variant="solid" {...props} />;
}

/** Chalk on the dark Recording screen (a retry there). */
export function InverseButton(props: Props) {
  return <Base variant="inverse" {...props} />;
}

/** White with a Rebar border: a secondary action (Add photos). */
export function OutlineButton(props: Props) {
  return <Base variant="outline" {...props} />;
}

/** Concrete: a tertiary action (No work today, Site closed: weather). */
export function QuietButton(props: Props) {
  return <Base variant="quiet" {...props} />;
}

/** Steel on the dark Recording screen: a secondary action there. */
export function SteelButton(props: Props) {
  return <Base variant="steel" {...props} />;
}

/** A text-only action that still fills a 56 px row (a resend link). */
export function TextButton(props: Props) {
  return <Base variant="text" {...props} />;
}
