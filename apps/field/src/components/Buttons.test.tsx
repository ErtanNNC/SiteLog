import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InverseButton } from './Buttons';
import { BUTTON_VARIANTS, buttonClasses } from './buttonStyles';

/** Each Tailwind property group a variant may set once (two classes of a group conflict). */
const GROUPS: Record<string, RegExp> = {
  background: /^bg-/,
  textColour: /^text-(?!\[|center$|left$|right$)/,
  textSize: /^text-\[/,
  weight: /^font-(bold|semibold|medium|normal|extrabold)$/,
};

describe('field buttons', () => {
  it('give every variant exactly one background, text colour, size and weight', () => {
    for (const [name, classes] of Object.entries(BUTTON_VARIANTS)) {
      const list = buttonClasses(name as keyof typeof BUTTON_VARIANTS).split(/\s+/);
      for (const [group, pattern] of Object.entries(GROUPS)) {
        expect(
          list.filter((c) => pattern.test(c)),
          `${name} ${group}: ${classes}`,
        ).toHaveLength(1);
      }
    }
  });

  it('keep the artboard sizes (Field-03: Add photos 16 px, No work / Weather 14 px)', () => {
    expect(BUTTON_VARIANTS.outline).toContain('text-[16px]');
    expect(BUTTON_VARIANTS.quiet).toContain('text-[14px]');
    expect(BUTTON_VARIANTS.primary).toContain('text-[17px]');
  });

  it('take layout classes only, and stay light on the dark screen', () => {
    render(<InverseButton className="flex-1">Try again</InverseButton>);
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button).toHaveClass('flex-1', 'bg-chalk', 'text-asphalt');
    expect(button).not.toHaveClass('bg-asphalt');
    expect(button).not.toHaveClass('text-chalk');
    expect(button).toHaveAttribute('type', 'button');
  });
});
