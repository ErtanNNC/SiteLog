import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import TryPage, { TrySimulator } from './Page';

describe('Try it on WhatsApp page', () => {
  it('pick the hero note → answer → OK → the report is filed in the store and linked', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    renderWithProviders(<TrySimulator store={store} delayScale={0} />, { store });

    expect(screen.getByRole('heading', { level: 1, name: 'Try it on WhatsApp' })).toBeVisible();
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(
      within(log).getByText(/You are Marco Ruiz, site manager at Riverside Lofts/),
    ).toBeVisible();
    // Riverside already filed today: the office side shows that until the chat replaces it.
    expect(within(screen.getByTestId('try-status')).getByText('Filed')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Send voice note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send a voice note' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(10);
    // The empty chat offers the note itself, right under the intro (no scrolling to start).
    expect(within(log).getByRole('button', { name: 'Send Marco’s voice note' })).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Send: Marco’s Friday report' }));

    expect(await within(log).findByText('Got it, Marco — 2 min 48 s.')).toBeVisible();
    expect(
      within(log).getByText(
        "Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?",
      ),
    ).toBeVisible();
    expect(within(screen.getByTestId('try-status')).getByText('Awaiting')).toBeVisible();

    await user.click(within(log).getByRole('button', { name: '5 · full day' }));
    expect(
      await within(log).findByText('Thanks — Delta Mechanical: 5 workers × 8 h = 40 h.'),
    ).toBeVisible();
    expect(within(log).getByText(/23 on site · 4 subs · 184 h/)).toBeVisible();

    await user.click(within(log).getByRole('button', { name: 'OK, file it' }));
    expect(
      await within(log).findByText(
        "Filed. Daily Report RL-2041-0187 is with the office. Thanks, Marco — that's it for today.",
      ),
    ).toBeVisible();
    expect(within(log).getByText('RL-2041-0187_2026-10-09_v1.pdf')).toBeVisible();

    const info = store.fieldDay(store.data.sites.find((s) => s.project_code === 'RL-2041')!.id);
    expect(info.status).toBe('filed');
    const report = store.data.reports.find((r) => r.id === info.reportId)!;
    expect(report.status).toBe('filed');
    expect(report.report_no).toBe('RL-2041-0187');

    await waitFor(() =>
      expect(within(screen.getByTestId('try-status')).getByText('Filed')).toBeVisible(),
    );
    expect(screen.getByTestId('try-report-no')).toHaveTextContent('RL-2041-0187');
    expect(screen.getByTestId('try-open-report')).toHaveAttribute('href', `/reports/${report.id}`);
    expect(screen.getByTestId('try-legend')).toHaveTextContent('Filed RL-2041-0187');
  });

  it('typed "no work today" flips Elm St. to No work; unsupported text gets a system note', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    renderWithProviders(
      <TrySimulator store={store} delayScale={0} initialScenario="elm-2026-10-08-no-work" />,
      { store },
    );
    const log = screen.getByRole('log', { name: 'Conversation' });
    // Elm is missing today: the reminders are in the chat with their buttons.
    expect(within(log).getByRole('button', { name: 'Site closed: weather' })).toBeEnabled();

    const input = screen.getByRole('textbox', { name: 'Type a reply' });
    await user.type(input, 'what is this{Enter}');
    expect(
      await within(log).findByText(/The live agent uses the AI to understand free text/),
    ).toBeVisible();

    await user.type(input, 'no work today{Enter}');
    expect(
      await within(log).findByText('Noted — no work today at Elm St. Townhomes.'),
    ).toBeVisible();
    expect(within(screen.getByTestId('try-status')).getByText('No work')).toBeVisible();
  });

  it('leaving /try and coming back resumes the chat; nothing extra is cleared', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    const first = renderWithProviders(<TrySimulator store={store} delayScale={0} />, { store });
    const log = () => screen.getByRole('log', { name: 'Conversation' });
    await user.click(within(log()).getByRole('button', { name: 'Send Marco’s voice note' }));
    await within(log()).findByRole('button', { name: '5 · full day' });
    first.unmount();
    renderWithProviders(<TrySimulator store={store} delayScale={0} />, { store });
    expect(within(log()).getByText('Got it, Marco — 2 min 48 s.')).toBeVisible();
    await user.click(within(log()).getByRole('button', { name: '5 · full day' }));
    expect(await within(log()).findByRole('button', { name: 'OK, file it' })).toBeEnabled();
  });

  it('switching scenario mid-question clears the unfinished site instead of leaving it Awaiting', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    renderWithProviders(<TrySimulator store={store} delayScale={0} />, { store });
    const log = screen.getByRole('log', { name: 'Conversation' });
    await user.click(within(log).getByRole('button', { name: 'Send Marco’s voice note' }));
    await within(log).findByRole('button', { name: '5 · full day' });
    const riverside = store.data.sites.find((x) => x.project_code === 'RL-2041')!;
    expect(store.fieldDay(riverside.id).status).toBe('processing');

    await user.click(screen.getByRole('button', { name: 'Send voice note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send a voice note' });
    expect(within(dialog).getAllByText(/Your unfinished chat at Riverside Lofts/)).not.toHaveLength(
      0,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Send: Rained out until 10' }));
    expect(await within(log).findByText('Got it, Priya — 33 s.')).toBeVisible();
    const info = store.fieldDay(riverside.id);
    expect(info.status).toBe('missing');
    expect(info.reportId).toBeNull();
    expect(
      store.data.reports.some(
        (r) => r.site_id === riverside.id && r.status !== 'void' && r.report_no === 'RL-2041-0187',
      ),
    ).toBe(false);
  });

  it('Start over clears the chat and the site’s day; a keyboard-only run reaches the report', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    renderWithProviders(<TrySimulator store={store} delayScale={0} />, { store });
    const log = screen.getByRole('log', { name: 'Conversation' });
    within(log).getByRole('button', { name: 'Send Marco’s voice note' }).focus();
    await user.keyboard('{Enter}');
    const five = await within(log).findByRole('button', { name: '5 · full day' });
    // Focus lands on the question's first button once the reply is in.
    await waitFor(() =>
      expect(within(log).getByRole('button', { name: '4 · full day' })).toHaveFocus(),
    );
    five.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(within(log).getByRole('button', { name: 'OK, file it' })).toHaveFocus(),
    );
    await user.keyboard('{Enter}');
    expect(await within(log).findByText(/^Filed\. Daily Report RL-2041-0187/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(within(log).queryByText(/^Filed\./)).not.toBeInTheDocument();
    const riverside = store.data.sites.find((x) => x.project_code === 'RL-2041')!;
    expect(store.fieldDay(riverside.id)).toMatchObject({ status: 'missing', reportId: null });
  });

  it('renders an empty state outside demo data', () => {
    renderWithProviders(<TryPage />, { source: null });
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });
});
