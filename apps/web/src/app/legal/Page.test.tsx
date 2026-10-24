import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { smsEn, smsReplyHintEn } from '@sitelog/shared/copy/sms.en.ts';
import { renderWithProviders } from '@/test/render';
import { AppRoutes } from '../routes';
import { SAMPLE_WELCOME, VERBAL_SCRIPT } from './content';

/** The public pages, rendered through the route map with no session at all. */
function renderSignedOut(route: string) {
  return renderWithProviders(<AppRoutes />, {
    route,
    source: null,
    auth: {
      status: 'signed_out',
      user: null,
      orgs: [],
      currentOrg: null,
      role: null,
      isDemo: false,
    },
  });
}

const NO_SHARING =
  'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.';

function expectLegalFooter(current: string) {
  const footer = screen.getByRole('navigation', { name: 'Legal' });
  expect(within(footer).getByRole('link', { name: 'TalkOlog SMS program' })).toHaveAttribute(
    'href',
    '/sms',
  );
  expect(within(footer).getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
    'href',
    '/terms',
  );
  expect(within(footer).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
    'href',
    '/privacy',
  );
  expect(within(footer).getByRole('link', { current: 'page' })).toHaveAttribute('href', current);
  expect(screen.getAllByRole('link', { name: 'support@talkolog.com' })[0]).toHaveAttribute(
    'href',
    'mailto:support@talkolog.com',
  );
  expect(screen.getByRole('link', { name: 'TalkOlog' })).toHaveAttribute('href', '/');
}

describe('public legal pages', () => {
  it('/sms: the SMS program without a session, in English', async () => {
    renderSignedOut('/sms');
    const h1 = await screen.findByRole('heading', { level: 1, name: 'TalkOlog SMS program' });
    expect(h1.closest('[lang="en"]')).not.toBeNull();
    expect(document.title).toBe('SMS program · TalkOlog');
    expect(screen.getByText(VERBAL_SCRIPT)).toBeInTheDocument();
    expect(
      screen.getByText(
        '<Name> agreed to get daily report messages from TalkOlog by text or WhatsApp',
      ),
    ).toBeVisible();
    expect(screen.getByText(SAMPLE_WELCOME)).toBeInTheDocument();
    expect(screen.getByText('Usually 1 to 4 messages per workday.')).toBeInTheDocument();
    expect(screen.getByText('Message and data rates may apply.')).toBeInTheDocument();
    expect(screen.getByText(/^Reply STOP to opt out\./)).toBeInTheDocument();
    expect(screen.getByText('Reply START to resume.')).toBeInTheDocument();
    expect(screen.getByText('Reply HELP for help.')).toBeInTheDocument();
    // §19 Q372: one program on SMS and WhatsApp; STOP works on both.
    expect(screen.getByText(/^TalkOlog sends these messages by SMS or by WhatsApp/)).toBeVisible();
    expect(screen.getByText(/^On WhatsApp, STOP works the same way/)).toBeVisible();
    expect(VERBAL_SCRIPT).toContain('TalkOlog will text you or message you on WhatsApp');
    expect(
      screen.getByText('Carriers are not liable for delayed or undelivered messages.'),
    ).toBeInTheDocument();
    expect(screen.getByText(NO_SHARING, { exact: false })).toBeInTheDocument();
    // In the text and in the footer.
    expect(screen.getAllByRole('link', { name: 'Terms of Service' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Privacy Policy' })).toHaveLength(2);
    expectLegalFooter('/sms');
  });

  it('/sms: the first text is the catalogue welcome with the STOP/HELP clause', () => {
    expect(SAMPLE_WELCOME).toBe(
      "Hi <first name>, I'm TalkOlog, the daily report assistant for <Company> at <Site>. Each workday before <time>, tap your link and talk for ~3 min: <link> - Reply STOP to opt out, HELP for help",
    );
    expect(smsEn.welcome.withoutNumber).toMatch(/^Hi \{first\}, I'm TalkOlog/);
    expect(SAMPLE_WELCOME.endsWith(smsReplyHintEn)).toBe(true);
  });

  it('/terms: TalkOlog, the SMS terms, version 3, no company named', async () => {
    renderSignedOut('/terms');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Terms of Service' }),
    ).toBeVisible();
    expect(document.title).toBe('Terms of Service · TalkOlog');
    expect(screen.getByText('TalkOlog · Effective: 2026-10-24 · Version 3')).toBeInTheDocument();
    expect(
      screen.getByText(/These terms govern the use of TalkOlog \(“we”, “us”\)\./),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: '4. SMS messaging terms' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: '14. Contact' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Yalp|Wyoming/);
    expect(
      screen.getByText(/Reply STOP to opt out, START to resume and HELP for help\./),
    ).toBeVisible();
    expectLegalFooter('/terms');
  });

  it('/privacy: the no-sharing sentences, phone numbers never sent to the model', async () => {
    renderSignedOut('/privacy');
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
    expect(document.title).toBe('Privacy Policy · TalkOlog');
    expect(screen.getByText('TalkOlog · Effective: 2026-10-24 · Version 3')).toBeInTheDocument();
    expect(
      screen.getByText(
        `${NO_SHARING} Text messaging originator opt-in data and consent will not be shared with any third parties.`,
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Phone numbers are removed before any text is sent to the model/),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Yalp|Wyoming/);
    expectLegalFooter('/privacy');
  });

  it('a signed-in user sees the same page, not the shell', async () => {
    renderWithProviders(<AppRoutes />, { as: 'admin', route: '/privacy' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  });
});
