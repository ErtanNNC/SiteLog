import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CountryPack } from '@sitelog/shared/countries.ts';
import { demoPack } from '@sitelog/shared/demo/countries.ts';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { CompanyStep } from './CompanyStep';
import { countryName, DEMO_PACKS } from './countries';

// The launch packs: most tests pick between these two; §19 Q379 lists every country.
const LAUNCH_PACKS = DEMO_PACKS.filter((p) => p.code === 'TR' || p.code === 'US');
import { emptyCompany, type CompanyDraft } from './state';

/** The step is controlled: the harness keeps the draft and exposes the latest one. */
function renderStep(
  initial: Partial<CompanyDraft> = {},
  props: {
    countryLocked?: boolean;
    onContinue?: () => void;
    packs?: readonly CountryPack[];
  } = {},
) {
  const latest: { draft: CompanyDraft } = { draft: { ...emptyCompany(), ...initial } };
  function Harness() {
    const [draft, setDraft] = useState<CompanyDraft>(latest.draft);
    return (
      <CompanyStep
        draft={draft}
        onChange={(next) => {
          latest.draft = next;
          setDraft(next);
        }}
        onContinue={props.onContinue ?? (() => undefined)}
        busy={false}
        logoUrl={null}
        onLogoChange={() => null}
        packs={props.packs ?? LAUNCH_PACKS}
        countryLocked={props.countryLocked}
      />
    );
  }
  render(
    <TooltipProvider>
      <Harness />
    </TooltipProvider>,
  );
  return latest;
}

const country = () => screen.getByRole('combobox', { name: 'Country' });
const timezone = () => screen.getByRole('combobox', { name: 'Company time zone' });

/** Options and the trigger are asserted by code (ICU names Türkiye "Türkiye" or "Turkey"). */
async function chooseCountry(code: string) {
  await userEvent.click(country());
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(`\\b${code}$`) }));
}

describe('CompanyStep · country (spec §4.6, F2 step 1)', () => {
  it('lists one option per country pack, US preselected with its presets', async () => {
    renderStep();
    expect(country()).toHaveAccessibleDescription(
      'Sets the report language, units, paper size, currency and time zone.',
    );
    expect(country()).toHaveTextContent(/\bUS$/);
    // Language, units and paper names are copy; the zone is the select's, not repeated below.
    const presets = screen.getByTestId('country-presets');
    expect(within(presets).getByText('English')).toBeInTheDocument();
    expect(within(presets).getByText('Imperial')).toBeInTheDocument();
    expect(within(presets).getByText('Letter')).toBeInTheDocument();
    expect(within(presets).getByText('USD')).toBeInTheDocument();
    expect(timezone()).toHaveTextContent('America/Chicago');
    expect(presets).not.toHaveTextContent('America/Chicago');

    await userEvent.click(country());
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent?.slice(-3))).toEqual([' TR', ' US']);
    await userEvent.keyboard('{Escape}');
  });

  it('lists every country (§19 Q379), by name', async () => {
    renderStep({}, { packs: DEMO_PACKS });
    await userEvent.click(country());
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(DEMO_PACKS.length);
    expect(DEMO_PACKS.length).toBeGreaterThan(200);
    const names = options.map((o) => o.textContent?.slice(0, -3) ?? '');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(options.map((o) => o.textContent?.slice(-2))).toEqual(
      expect.arrayContaining(['DE', 'GB', 'TR', 'US']),
    );
    await userEvent.keyboard('{Escape}');
  });

  it('lists the countries by name, not by code (a new country is a new row)', async () => {
    // GB sorts before TR by code, but "United Kingdom" after "Türkiye" by name.
    const gb: CountryPack = { ...demoPack('US'), code: 'GB', defaultTimezone: 'Europe/London' };
    renderStep({}, { packs: [gb, ...LAUNCH_PACKS] });
    await userEvent.click(country());
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent?.slice(-2))).toEqual(['TR', 'GB', 'US']);
    expect(options.map((o) => o.textContent?.slice(0, -3))).toEqual(
      ['TR', 'GB', 'US'].map((c) => countryName(c)),
    );
    await userEvent.keyboard('{Escape}');
  });

  it('choosing TR presets Istanbul and shows metric, A4, TRY and Turkish', async () => {
    const latest = renderStep();
    await chooseCountry('TR');
    expect(latest.draft).toMatchObject({
      country: 'TR',
      timezone: 'Europe/Istanbul',
      timezoneTouched: false,
    });
    expect(timezone()).toHaveTextContent('Europe/Istanbul');
    expect(country()).toHaveTextContent(/\bTR$/);
    const presets = screen.getByTestId('country-presets');
    for (const text of ['Turkish', 'Metric', 'A4', 'TRY'])
      expect(within(presets).getByText(text)).toBeInTheDocument();
    // And back: the zone follows the country while the user has not picked one.
    await chooseCountry('US');
    expect(latest.draft).toMatchObject({ country: 'US', timezone: 'America/Chicago' });
  });

  it('keeps a time zone the user picked when the country changes', async () => {
    const latest = renderStep();
    await userEvent.click(timezone());
    await userEvent.click(await screen.findByRole('option', { name: /^America\/Denver/ }));
    expect(latest.draft).toMatchObject({ timezone: 'America/Denver', timezoneTouched: true });
    await chooseCountry('TR');
    expect(latest.draft).toMatchObject({ country: 'TR', timezone: 'America/Denver' });
    // One zone on screen, the one create_org gets: the presets do not name the pack's own.
    expect(timezone()).toHaveTextContent('America/Denver');
    expect(screen.getByTestId('country-presets')).not.toHaveTextContent('Europe/Istanbul');
  });

  it('asks for a country the packs do not offer before continuing', async () => {
    const onContinue = vi.fn();
    // Saved progress naming a country that is no pack (any more): shown as no choice.
    renderStep({ name: 'Fresh Build Co', country: 'ZZ' }, { onContinue });
    expect(country()).toHaveTextContent('Choose a country');
    expect(screen.queryByTestId('country-presets')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose your company’s country.');
    expect(country()).toHaveAttribute('aria-invalid', 'true');
    expect(onContinue).not.toHaveBeenCalled();
    await chooseCountry('TR');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('shows an existing org’s country locked, without presets (update_org cannot change it)', async () => {
    const onContinue = vi.fn();
    renderStep(
      { name: 'Demir Yapı A.Ş.', country: 'TR', timezone: 'Europe/Istanbul' },
      { countryLocked: true, onContinue },
    );
    expect(country()).toBeDisabled();
    expect(country()).toHaveTextContent(countryName('TR'));
    expect(country()).toHaveTextContent(/\bTR$/);
    expect(country()).not.toHaveTextContent('Choose a country');
    expect(country()).toHaveAccessibleDescription('The country can’t be changed after setup.');
    expect(screen.queryByTestId('country-presets')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('still shows a locked country this build has no pack for', async () => {
    const onContinue = vi.fn();
    renderStep(
      { name: 'Demir Yapı A.Ş.', country: 'TR', timezone: 'Europe/Istanbul' },
      { countryLocked: true, onContinue, packs: [demoPack('US')] },
    );
    expect(country()).toBeDisabled();
    expect(country()).toHaveTextContent(/\bTR$/);
    expect(country()).not.toHaveTextContent('Choose a country');
    expect(screen.queryByTestId('country-presets')).not.toBeInTheDocument();
    // Locked: no country error, the step continues.
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
