import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
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
    const dana = store.data.reporters.find((r) => r.name === 'Dana Whitfield')!;
    expect(dana.status).toBe('opted_out');
    // As the worker: the office's §13 notice and the change audited as the reporter.
    expect(store.data.notifications).toContainEqual(
      expect.objectContaining({
        org_id: store.data.org.id,
        user_id: null,
        kind: 'reporter_opted_out',
        title: 'Dana Whitfield opted out of texts (STOP)',
        target_path: '/team',
      }),
    );
    expect(store.data.audit.at(-1)).toMatchObject({
      actor_type: 'reporter',
      actor_id: dana.id,
      action: 'reporter.opted_out',
      entity: 'reporter',
      entity_id: dana.id,
    });
  });

  it('shows a push to the installed app in the thread with its channel (W2-14)', async () => {
    const store = new DemoStore();
    const marco = store.data.reporters.find((r) => r.name === 'Marco Ruiz')!;
    const template = store.data.messages.find((m) => m.reporter_id === marco.id)!;
    store.data.messages.push({
      ...template,
      id: '00000000-0000-4000-8000-00000000f00d',
      channel: 'push',
      phone_e164: null,
      direction: 'out',
      provider: 'console',
      copy_key: 'draft_ready',
      body: 'Your draft is ready to check: https://go.sitelog.app/r/K7Q2MX',
      status: 'delivered',
      created_at: '2099-01-01T00:00:00.000Z',
    });
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const thread = await openThread(/Marco Ruiz/);
    const items = within(thread).getAllByRole('listitem');
    const push = items.at(-1)!;
    expect(push).toHaveTextContent('Your draft is ready to check');
    expect(push).toHaveTextContent('Push notification');
    expect(push).toHaveTextContent('draft_ready');
    expect(items[0]!).toHaveTextContent('Text');
  });

  it('rings a demo org’s outbound call in the thread, then words a missed one (W3-17, §19 Q132)', async () => {
    const store = new DemoStore();
    const kevin = store.data.reporters.find((r) => r.name === "Kevin O'Brien")!;
    const template = store.data.calls[0]!;
    const call = (id: string, status: string, outcome: string | null, at: string) =>
      store.data.calls.push({
        ...template,
        id,
        reporter_id: kevin.id,
        direction: 'outbound',
        transport: 'pstn',
        purpose: 'reminder',
        attempt: 1,
        status: status as never,
        outcome: outcome as never,
        created_at: at,
      });
    call(
      '00000000-0000-4000-8000-0000000ca111',
      'no_answer',
      'not_reached',
      '2099-01-01T00:00:00.000Z',
    );
    call('00000000-0000-4000-8000-0000000ca112', 'ringing', null, '2099-01-01T00:45:00.000Z');
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const thread = await openThread(/Kevin O'Brien/);
    const calls = within(thread).getAllByTestId('demo-phone-call');
    expect(calls.at(-2)).toHaveTextContent('Missed call from SiteLog');
    expect(calls.at(-1)).toHaveTextContent('SiteLog is calling: ringing');
    expect(calls.at(-1)).toHaveTextContent('Call · Reminder call');
  });

  it('a one-way pack types no texts, only WhatsApp where the pack lists it (§19 Q35, W2-16)', async () => {
    const store = new DemoStore();
    store.data.org.country = 'TR';
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const thread = await openThread(/Marco Ruiz/);
    expect(screen.queryByRole('textbox', { name: 'Reply as Marco Ruiz' })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'The TR country pack has one-way SMS: a reporter replies to SiteLog on WhatsApp.',
      ),
    ).toBeInTheDocument();
    // HELP on WhatsApp is answered there, labelled WhatsApp.
    const box = screen.getByRole('textbox', { name: 'Reply on WhatsApp as Marco Ruiz' });
    await userEvent.type(box, 'HELP{Enter}');
    const help = await within(thread).findByText(/SiteLog daily reports for Kestrel Build Group/);
    expect(help.closest('li')).toHaveTextContent('WhatsApp');
  });

  it('a two-way pack with WhatsApp offers both: the reply goes by the one chosen (W2-16)', async () => {
    const store = new DemoStore();
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const thread = await openThread(/Dana Whitfield/);
    await userEvent.click(screen.getByRole('radio', { name: 'WhatsApp' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply on WhatsApp as Dana Whitfield' }),
      'HELP{Enter}',
    );
    const help = await within(thread).findByText(/SiteLog daily reports for Kestrel Build Group/);
    expect(help.closest('li')).toHaveTextContent('WhatsApp');
    // STOP on WhatsApp stops WhatsApp only: Dana is not opted out of texts (§19 Q40).
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply on WhatsApp as Dana Whitfield' }),
      'STOP{Enter}',
    );
    expect(
      await within(thread).findByText(
        "You won't get more WhatsApp messages from SiteLog. Reply START to resume.",
      ),
    ).toBeInTheDocument();
    expect(store.data.reporters.find((r) => r.name === 'Dana Whitfield')!.status).not.toBe(
      'opted_out',
    );
  });

  it('an invite shows the welcome text in the Demo phone, in the language the office ticked (F3)', async () => {
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
    store.inviteReporter(
      {
        name: 'Ben Okafor',
        phone: '+15550149002',
        role: 'backup',
        siteIds: [store.data.sites[0]!.id],
        languages: ['en', 'es'],
      },
      'user',
    );
    expect(store.data.reporters.find((r) => r.name === 'Ana Torres')!.locale).toBe('es-US');
    expect(store.data.reporters.find((r) => r.name === 'Ben Okafor')!.locale).toBe('en-US');
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const thread = await openThread(/Ana Torres/);
    expect(within(thread).getByText(/Hola Ana, soy SiteLog/)).toBeInTheDocument();
    expect(within(thread).getByRole('link', { name: /\/r\// })).toBeInTheDocument();
  });

  it('keeps 44 px tab targets at every width (the list grows with its triggers)', async () => {
    renderWithProviders(<DevPhonePage />, { as: 'admin' });
    const tab = await screen.findByRole('tab', { name: 'Texts' });
    // The 44 px token, not rem: the panel's 15 px root makes `min-h-11` 41.25 px (e2e/a11y.spec.ts
    // measures it).
    expect(tab.className).toMatch(/\bmin-h-target\b/);
    expect(tab.className).not.toMatch(/\bmin-h-11\b/);
    expect(tab.className).not.toMatch(/\bsm:min-h-9\b/);
    expect(tab.closest('[role="tablist"]')!.className).toMatch(/\bh-auto\b/);
  });

  it('moves focus to the thread on select and back to the reporter on Back', async () => {
    renderWithProviders(<DevPhonePage />, { as: 'admin' });
    const list = await screen.findByRole('navigation', { name: 'Reporters' });
    const marco = within(list).getByRole('button', { name: /Marco Ruiz/ });
    await userEvent.click(marco);
    const heading = await screen.findByRole('heading', { level: 2, name: 'Marco Ruiz' });
    await waitFor(() => expect(heading).toHaveFocus());
    // The thread box itself is a labelled, focusable region (WCAG 2.1.1 for a scroll box).
    const region = screen.getByRole('region', { name: 'Texts with Marco Ruiz' });
    expect(region).toHaveAttribute('tabindex', '0');
    await userEvent.click(screen.getByRole('button', { name: 'All reporters' }));
    await waitFor(() => expect(marco).toHaveFocus());
    expect(screen.queryByRole('heading', { level: 2, name: 'Marco Ruiz' })).not.toBeInTheDocument();
  });

  it('scrolls the thread to its newest text on open and when one arrives; the live region is always there', async () => {
    const store = new DemoStore();
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    await openThread(/Dana Whitfield/);
    const region = screen.getByRole('region', { name: 'Texts with Dana Whitfield' });
    // jsdom has no layout: give the box a height to scroll to and check where it lands.
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 900 });
    region.scrollTop = 0;
    const live = region.querySelector('[aria-live="polite"]')!;
    // New texts only: a status moving from Sent to Delivered is not read out.
    expect(live).toHaveAttribute('aria-relevant', 'additions');
    const before = within(region).getAllByRole('listitem').length;
    act(() =>
      store.demoPhoneReply(
        store.data.reporters.find((r) => r.name === 'Dana Whitfield')!.id,
        'CALL',
      ),
    );
    // The text and SiteLog's confirmation of the switch (spec §19 Q46).
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(before + 2));
    await waitFor(() => expect(region.scrollTop).toBe(900));
    // The new text landed inside the live region that was mounted before it.
    expect(live.contains(within(region).getAllByRole('listitem').at(-1)!)).toBe(true);
  });

  it('switching back to a cached thread gives it a new live region, so its texts are not read out as new', async () => {
    // The panel's own cache (src/lib/query.ts): a thread opened in the last 5 minutes renders at
    // once from it. renderWithProviders' client keeps nothing (gcTime 0), so this test brings one.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 300_000 } },
    });
    renderWithProviders(
      <QueryClientProvider client={client}>
        <DevPhonePage />
      </QueryClientProvider>,
      { as: 'admin' },
    );
    const liveOf = async (name: string) => {
      const region = await screen.findByRole('region', { name: `Texts with ${name}` });
      await within(region).findAllByRole('listitem');
      return region.querySelector('[aria-live]')!;
    };
    await openThread(/Dana Whitfield/);
    const dana1 = await liveOf('Dana Whitfield');
    await openThread(/Marco Ruiz/);
    const marco = await liveOf('Marco Ruiz');
    expect(marco).not.toBe(dana1);
    await openThread(/Dana Whitfield/);
    const dana2 = await liveOf('Dana Whitfield');
    expect(dana2).not.toBe(marco);
    expect(dana2).not.toBe(dana1);
    expect(dana2.isConnected && !marco.isConnected).toBe(true);
    client.clear();
  });

  it('a thread with no texts yet announces inside the same live region', async () => {
    const store = new DemoStore();
    const id = store.inviteReporter(
      {
        name: 'Quiet Person',
        phone: '+15550149003',
        role: 'backup',
        siteIds: [store.data.sites[0]!.id],
        languages: ['en'],
      },
      'user',
    );
    // Drop the welcome the demo invite wrote, so the thread starts empty.
    store.data.messages = store.data.messages.filter((m) => m.reporter_id !== id);
    renderWithProviders(<DevPhonePage />, { as: 'admin', store });
    const list = await screen.findByRole('navigation', { name: 'Reporters' });
    await userEvent.click(within(list).getByRole('button', { name: /Quiet Person/ }));
    const region = await screen.findByRole('region', { name: 'Texts with Quiet Person' });
    const live = region.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent('No texts with Quiet Person yet.');
    act(() => store.demoPhoneReply(id, 'HELP'));
    await waitFor(() =>
      expect(within(live as HTMLElement).getAllByRole('listitem')).toHaveLength(2),
    );
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
