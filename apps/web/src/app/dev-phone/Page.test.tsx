import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import DevPhonePage from './Page';

/** /dev/phone · Demo phone (§11.1, W1-08) on the in-memory Kestrel org. */

async function openThread(name: RegExp) {
  const list = await screen.findByRole('navigation', { name: 'Reporters' });
  await userEvent.click(within(list).getByRole('button', { name }));
  return screen.findByRole('list', { name: new RegExp(`^Texts with`) });
}

describe('Demo phone', () => {
  it('lists the reporters and shows a thread with links that open in a new tab', async () => {
    renderWithProviders(<DevPhonePage />, { as: 'admin' });
    const thread = await openThread(/Marco Ruiz/);
    const welcome = within(thread).getAllByRole('listitem')[0]!;
    expect(welcome).toHaveTextContent(/Hi Marco, I'm SiteLog/);
    expect(welcome).toHaveTextContent('welcome');
    expect(welcome).toHaveTextContent('Sent');
    const link = within(welcome).getByRole('link', { name: /go\.sitelog\.app\/r\// });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName(/\(opens in a new tab\)$/);
    // The reporter's selected state is announced, not shown by colour alone.
    expect(screen.getByRole('button', { name: /Marco Ruiz/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('a reply runs the keyword handler: HELP gets the help text, STOP opts the reporter out', async () => {
    const store = new DemoStore();
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const thread = await openThread(/Dana Whitfield/);
    const before = within(thread).getAllByRole('listitem').length;
    const box = screen.getByRole('textbox', { name: 'Reply as Dana Whitfield' });
    await userEvent.type(box, 'help');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await within(thread).findByText(/SiteLog daily reports for Kestrel Build Group\. Your link:/),
    ).toBeInTheDocument();
    expect(within(thread).getAllByRole('listitem')).toHaveLength(before + 2);
    expect(box).toHaveValue('');

    await userEvent.type(box, 'STOP{Enter}');
    expect(
      await within(thread).findByText(
        "You won't get more texts from SiteLog. Reply START to resume.",
      ),
    ).toBeInTheDocument();
    expect(store.data.reporters.find((r) => r.name === 'Dana Whitfield')!.status).toBe('opted_out');
  });

  it('a one-way pack shows no reply box (spec §19 Q35)', async () => {
    const store = new DemoStore();
    store.data.org.country = 'TR';
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    await openThread(/Marco Ruiz/);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.getByText(/the TR country pack has one-way SMS, so a reporter cannot text SiteLog/),
    ).toBeInTheDocument();
  });

  it('an invite shows the welcome text in the Demo phone (the worker’s send_welcome)', async () => {
    const store = new DemoStore();
    store.inviteReporter(
      {
        name: 'Ana Torres',
        phone: '+15550149001',
        role: 'backup',
        siteIds: [store.data.sites[0]!.id],
        languages: ['es'],
      },
      'user',
    );
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const thread = await openThread(/Ana Torres/);
    expect(within(thread).getByText(/Hi Ana, I'm SiteLog/)).toBeInTheDocument();
    expect(within(thread).getByRole('link', { name: /\/r\// })).toBeInTheDocument();
  });

  it('the Email tab shows what the console email provider would have sent', async () => {
    const store = new DemoStore();
    store.consoleEmails.push({
      id: 'e1',
      kind: 'report_filed',
      recipients: ['pm@kestrelbuild.example'],
      subject: 'Daily report · Riverside Lofts — Block B · Oct 9 · RL-2041-0187',
      body: 'Filed by Marco. Open: https://app.sitelog.app/reports/r1',
      attachments: [{ filename: 'RL-2041-0187.pdf', bytes: 52_000 }],
      at: '2026-10-09T22:43:00Z',
    });
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    await userEvent.click(await screen.findByRole('tab', { name: 'Email' }));
    const list = await screen.findByRole('list', { name: 'Emails' });
    expect(within(list).getByRole('heading', { name: /RL-2041-0187/ })).toBeInTheDocument();
    expect(within(list).getByText(/To pm@kestrelbuild\.example/)).toBeInTheDocument();
    expect(within(list).getByText('RL-2041-0187.pdf · 51 KB')).toBeInTheDocument();
  });

  it('a real org outside staging gets no Demo phone', async () => {
    renderWithProviders(<DevPhonePage />, {
      as: 'admin',
      auth: {
        isDemo: false,
        currentOrg: {
          id: 'org',
          name: 'Real Builders',
          timezone: 'America/Chicago',
          activeSites: 1,
          role: 'admin',
          demoOrg: false,
        },
      },
    });
    expect(await screen.findByText('The Demo phone is for demo organisations')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Reporters' })).not.toBeInTheDocument();
  });
});
