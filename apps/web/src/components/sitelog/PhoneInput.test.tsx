import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { phoneRegions } from '@sitelog/shared/phone-regions.ts';
import { EnglishOnly } from '@/i18n/EnglishOnly';
import { i18n } from '@/i18n/i18n';
import { emptyPhone, PhoneInput, phoneCountryFor, phoneValue, type PhoneValue } from './PhoneInput';

function Harness({
  start = 'US',
  packCountry,
  onValue,
}: {
  start?: string;
  packCountry?: string | null;
  onValue?: (v: PhoneValue) => void;
}) {
  const [value, setValue] = useState<PhoneValue>(emptyPhone(phoneCountryFor(start)));
  return (
    <PhoneInput
      label="Mobile number"
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
      packCountry={packCountry}
      data-testid="phone"
    />
  );
}

afterEach(async () => {
  await act(() => i18n.changeLanguage('en'));
});

describe('PhoneInput values', () => {
  it('parses national input for the picked region; the §18.2 range with +90', () => {
    expect(phoneValue('TR', '0532 000 0512').e164).toBe('+905320000512');
    expect(phoneValue('US', '555 014 3378').e164).toBe('+15550143378');
    expect(phoneValue('MX', '55 1234 5678').e164).toBe('+525512345678');
    expect(phoneValue('US', '').e164).toBeNull();
  });

  it('starts in the org’s country when libphonenumber knows it, otherwise US', () => {
    expect(phoneCountryFor('TR')).toBe('TR');
    expect(phoneCountryFor('US')).toBe('US');
    // A pack the old fixed list did not have: no code needed.
    expect(phoneCountryFor('NL')).toBe('NL');
    // A synthetic pack row libphonenumber does not know falls back.
    expect(phoneCountryFor('XX')).toBe('US');
    expect(phoneCountryFor(undefined)).toBe('US');
    expect(emptyPhone(phoneCountryFor('TR'))).toEqual({ country: 'TR', raw: '', e164: null });
  });
});

describe('PhoneInput picker (W4-01)', () => {
  async function openPicker() {
    await userEvent.click(screen.getByTestId('phone-country'));
    return screen.findByRole('combobox');
  }

  it('lists every libphonenumber region, the pack country first, named in English', async () => {
    render(<Harness start="US" packCountry="TR" />);
    expect(screen.getByTestId('phone-country')).toHaveAccessibleName(
      'Country code: United States, US +1',
    );
    expect(await openPicker()).toHaveAccessibleName('Search countries');
    const options = within(screen.getByRole('listbox', { name: 'Country code' })).getAllByRole(
      'option',
    );
    // Every region libphonenumber knows (245 in 1.13).
    expect(options).toHaveLength(phoneRegions('en').length);
    expect(options.length).toBeGreaterThan(240);
    expect(options[0]).toHaveTextContent('TR +90Türkiye');
    for (const { code } of DEMO_COUNTRIES)
      expect(options.some((o) => o.textContent?.startsWith(`${code} +`))).toBe(true);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('United States');
  });

  it('names the regions in Turkish in a Turkish panel, and in English under <EnglishOnly>', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const { unmount } = render(<Harness start="DE" packCountry="TR" />);
    expect(screen.getByTestId('phone-country')).toHaveAccessibleName('Ülke kodu: Almanya, DE +49');
    const search = await openPicker();
    expect(search).toHaveAccessibleName('Ülke ara');
    await userEvent.type(search, 'alm');
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Almanya');
    await userEvent.keyboard('{Escape}');
    unmount();
    render(
      <EnglishOnly>
        <Harness start="DE" packCountry="TR" />
      </EnglishOnly>,
    );
    expect(screen.getByTestId('phone-country')).toHaveAccessibleName(
      'Country code: Germany, DE +49',
    );
  });

  it('searches by name or calling code and picks with the keyboard', async () => {
    let last: PhoneValue | null = null;
    render(<Harness start="US" packCountry="US" onValue={(v) => (last = v)} />);
    const search = await openPicker();
    await userEvent.type(search, '+52');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: /Mexico/ }).id,
    );
    await userEvent.keyboard('{Enter}');
    expect(last).toMatchObject({ country: 'MX' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('phone-country')).toHaveFocus();
    expect(screen.getByTestId('phone-country')).toHaveAccessibleName(
      'Country code: Mexico, MX +52',
    );

    // By name: the arrows move through the matches.
    const again = await openPicker();
    await userEvent.type(again, 'united');
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(names[1]).toContain('United');
    expect(screen.getByTestId('phone-country')).toHaveTextContent(last!.country);

    // No match says so.
    const third = await openPicker();
    await userEvent.type(third, 'qqqq');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No country matches “qqqq”.');
  });

  it('warns for a Mexican number in a US org, and never blocks it (§19 Q23)', async () => {
    let last: PhoneValue | null = null;
    render(<Harness start="US" packCountry="US" onValue={(v) => (last = v)} />);
    await userEvent.type(screen.getByTestId('phone'), '+52 55 1234 5678');
    expect(last).toMatchObject({ e164: '+525512345678' });
    expect(screen.getByTestId('phone-foreign')).toHaveTextContent(
      'This is a Mexico number. SiteLog texts it from your United States number.',
    );
    expect(screen.getByTestId('phone')).toHaveAccessibleDescription(
      /This is a Mexico number\. SiteLog texts it from your United States number\./,
    );
    expect(screen.getByTestId('phone')).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('does not warn for the org’s own numbers or without a pack country', async () => {
    const { unmount } = render(<Harness start="US" packCountry="US" />);
    await userEvent.type(screen.getByTestId('phone'), '555 014 3378');
    expect(screen.queryByTestId('phone-foreign')).not.toBeInTheDocument();
    unmount();
    render(<Harness start="US" />);
    await userEvent.type(screen.getByTestId('phone'), '+52 55 1234 5678');
    expect(screen.queryByTestId('phone-foreign')).not.toBeInTheDocument();
  });

  it('warns in Turkish in a Turkish panel', async () => {
    await act(() => i18n.changeLanguage('tr'));
    render(<Harness start="TR" packCountry="TR" />);
    await userEvent.type(screen.getByTestId('phone'), '+1 555 014 3378');
    expect(screen.getByTestId('phone-foreign')).toHaveTextContent(
      'Bu bir Amerika Birleşik Devletleri numarası. SiteLog bu numaraya Türkiye numaranızdan mesaj gönderir.',
    );
  });

  it('needs no code for a new pack: a synthetic pack row (§17)', async () => {
    // A real region outside the old fixed list is listed first and parsed as its own.
    const { unmount } = render(<Harness start="NL" packCountry="NL" />);
    expect(screen.getByTestId('phone-country')).toHaveAccessibleName(
      'Country code: Netherlands, NL +31',
    );
    await openPicker();
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('NL +31Netherlands');
    await userEvent.keyboard('{Escape}');
    unmount();
    // `XX`, a row libphonenumber does not know: the picker starts on US and warns nothing.
    render(<Harness start="XX" packCountry="XX" />);
    expect(screen.getByTestId('phone-country')).toHaveAccessibleName(
      'Country code: United States, US +1',
    );
    await userEvent.type(screen.getByTestId('phone'), '+52 55 1234 5678');
    expect(screen.queryByTestId('phone-foreign')).not.toBeInTheDocument();
  });
});
