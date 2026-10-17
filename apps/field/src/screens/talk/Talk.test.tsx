import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { VOICE_CATALOGS } from '@sitelog/shared/copy/voice.ts';
import type { VoiceTokenResponse } from '@sitelog/shared/field-contract.ts';
import { ApiProvider } from '@/api/ApiContext';
import type { FieldRoutes } from '@/api/field';
import { i18n } from '@/i18n/i18n';
import { QueueProvider } from '@/queue/QueueContext';
import { SessionProvider } from '@/session/SessionContext';
import type { FieldSession } from '@/session/session';
import { apiError, demoSession, fakeQueue, fakeRoutes, SITE, todayResponse } from '@/test/render';
import type { VoiceCall, VoiceCallHandlers, VoiceClient } from '@/voice/client';
import { Talk, type TalkDeps } from './Talk';

const TOKEN: VoiceTokenResponse = {
  livekitUrl: 'wss://sitelog-test.livekit.invalid',
  token: 'participant-token',
  room: 'call-7a1c0000-0000-4000-8000-000000000001',
  callId: '7a1c0000-0000-4000-8000-000000000001',
};

/** A VoiceClient the test drives: it connects at once and hands the test its handlers. */
function controlledClient() {
  const state: { handlers: VoiceCallHandlers | null; muted: boolean[]; hungUp: number } = {
    handlers: null,
    muted: [],
    hungUp: 0,
  };
  const client: VoiceClient = {
    connect: vi.fn((_input, handlers: VoiceCallHandlers) => {
      state.handlers = handlers;
      handlers.onState('connecting');
      const call: VoiceCall = {
        setMuted: (m) => {
          state.muted.push(m);
          return Promise.resolve();
        },
        resumeAudio: () => Promise.resolve(),
        hangUp: () => {
          state.hungUp++;
          handlers.onEnded('local');
          return Promise.resolve();
        },
      };
      handlers.onState('connected');
      return Promise.resolve(call);
    }),
  };
  return { client, state };
}

function stream(): MediaStream {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track] } as unknown as MediaStream;
}

function renderTalk(
  routes: FieldRoutes,
  deps: TalkDeps,
  session: FieldSession = demoSession(),
  state: unknown = { siteId: SITE.id },
) {
  return render(
    <SessionProvider initial={session} persist={false}>
      <ApiProvider routes={routes}>
        <QueueProvider queue={fakeQueue().queue} routes={routes}>
          <MemoryRouter initialEntries={[{ pathname: '/talk', state }]}>
            <Routes>
              <Route path="/talk" element={<Talk {...deps} />} />
              <Route path="/today" element={<p>Today screen</p>} />
              <Route path="/record" element={<p>Record screen</p>} />
              <Route path="/photos" element={<p>Photos screen</p>} />
              <Route path="/report/:id" element={<p>Report screen</p>} />
              <Route path="/r/:code" element={<p>Link screen</p>} />
            </Routes>
          </MemoryRouter>
        </QueueProvider>
      </ApiProvider>
    </SessionProvider>,
  );
}

describe('Talk now (W3-13, §9.4, §19 Q121)', () => {
  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('asks for the microphone, starts the call for the site, shows status, notice, timer', async () => {
    const { client, state } = controlledClient();
    const gum = vi.fn().mockResolvedValue(stream());
    const routes = fakeRoutes({
      voiceToken: vi.fn().mockResolvedValue(TOKEN),
      today: vi.fn().mockResolvedValue(
        todayResponse({
          report: { id: 'r9', reportNo: 'RL-2041-0188', status: 'filed', kind: 'daily' },
        }),
      ),
    });
    let t = 1_000;
    renderTalk(routes, {
      getUserMedia: gum,
      loadClient: () => Promise.resolve(client),
      now: () => t,
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Speaking with the SiteLog assistant' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(routes.voiceToken).toHaveBeenCalledWith('K7Q2MX', SITE.id));
    expect(gum).toHaveBeenCalledWith({ audio: true });
    expect(client.connect).toHaveBeenCalledWith(
      { url: TOKEN.livekitUrl, token: TOKEN.token },
      expect.any(Object),
    );
    // The recording notice as text, in the reporter's language (the voice copy's line).
    expect(screen.getByText(VOICE_CATALOGS.en.recording_notice)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'This call is recorded' })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('The assistant is listening'),
    );
    act(() => state.handlers!.onAgentSpeaking(true));
    expect(screen.getByRole('status')).toHaveTextContent('The assistant is speaking');
    act(() => state.handlers!.onState('reconnecting'));
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost — reconnecting…');
    act(() => state.handlers!.onState('connected'));

    // The timer runs from the call's start.
    t += 65_000;
    await waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent('01:05'), {
      timeout: 2000,
    });

    // Mute: the button says what a tap does; the microphone goes off and the screen says so.
    fireEvent.click(screen.getByRole('button', { name: 'Mute the microphone' }));
    await screen.findByRole('button', { name: 'Turn the microphone on' });
    expect(state.muted).toEqual([true]);
    expect(screen.getByText('Your microphone is off')).toBeInTheDocument();

    // End call → the day's report (Filed, here).
    fireEvent.click(screen.getByRole('button', { name: 'End call' }));
    expect(state.hungUp).toBe(1);
    expect(await screen.findByText('Report screen')).toBeInTheDocument();
    expect(routes.today).toHaveBeenCalledWith('K7Q2MX', SITE.id);
  });

  it('the assistant ending the call with no report on the day goes back to Today', async () => {
    const { client, state } = controlledClient();
    const routes = fakeRoutes({
      voiceToken: vi.fn().mockResolvedValue(TOKEN),
      today: vi.fn().mockResolvedValue(todayResponse()),
    });
    renderTalk(routes, {
      getUserMedia: () => Promise.resolve(stream()),
      loadClient: () => Promise.resolve(client),
    });
    await screen.findByRole('button', { name: 'End call' });
    await waitFor(() => expect(state.handlers).not.toBeNull());
    act(() => state.handlers!.onEnded('remote'));
    expect(await screen.findByText('Today screen')).toBeInTheDocument();
  });

  it('a refused microphone says how to allow it, with Record instead; no call is started', async () => {
    const routes = fakeRoutes({ voiceToken: vi.fn() });
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    renderTalk(routes, { getUserMedia: () => Promise.reject(denied) });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Microphone needed' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/iPhone: Settings/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Record instead' })).toHaveAttribute('href', '/record');
    expect(routes.voiceToken).not.toHaveBeenCalled();
  });

  it.each([
    ['rate_limited', 429, 'You’ve started three calls this hour.', false],
    ['talk_now_unavailable', 403, 'Talk now isn’t available right now.', false],
    ['voice_unavailable', 502, 'The assistant couldn’t be reached.', true],
    ['internal', 500, 'Couldn’t start the call.', true],
  ] as const)('a %s refusal says so (retry: %s)', async (code, status, text, retry) => {
    const routes = fakeRoutes({ voiceToken: vi.fn().mockRejectedValue(apiError(status, code)) });
    renderTalk(routes, { getUserMedia: () => Promise.resolve(stream()) });
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retry);
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/today');
  });

  it('the Talk now limit says when the next call is possible, with Record instead (§19 Q171)', async () => {
    const routes = fakeRoutes({
      voiceToken: vi.fn().mockRejectedValue(apiError(429, 'rate_limited', { retryAfter: 1501 })),
    });
    renderTalk(routes, { getUserMedia: () => Promise.resolve(stream()) });
    expect(await screen.findByRole('alert')).toHaveTextContent('You can call again in 26 min');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Record instead' })).toHaveAttribute('href', '/record');
  });

  it('a device or consent refusal goes back through the link', async () => {
    const routes = fakeRoutes({
      voiceToken: vi.fn().mockRejectedValue(apiError(403, 'consent_required')),
    });
    renderTalk(routes, { getUserMedia: () => Promise.resolve(stream()) });
    expect(await screen.findByText('Link screen')).toBeInTheDocument();
  });

  it('a call that cannot connect offers another try', async () => {
    const routes = fakeRoutes({ voiceToken: vi.fn().mockResolvedValue(TOKEN) });
    const failing: VoiceClient = { connect: () => Promise.reject(new Error('ice failed')) };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTalk(routes, {
      getUserMedia: () => Promise.resolve(stream()),
      loadClient: () => Promise.resolve(failing),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t connect the call.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    err.mockRestore();
  });

  it('a photos link has no Talk now: the photo-only screen', async () => {
    const routes = fakeRoutes();
    renderTalk(
      routes,
      {},
      demoSession({
        link: { kind: 'photos', siteId: SITE.id, reportDate: '2026-10-09', expiresAt: null },
      }),
    );
    expect(await screen.findByText('Photos screen')).toBeInTheDocument();
  });

  it('says it in Spanish and Turkish, with the notice in that language', async () => {
    for (const [lang, locale] of [
      ['es', 'es-US'],
      ['tr', 'tr-TR'],
    ] as const) {
      const { client } = controlledClient();
      const routes = fakeRoutes({ voiceToken: vi.fn().mockResolvedValue(TOKEN) });
      const session = demoSession();
      const view = renderTalk(
        routes,
        {
          getUserMedia: () => Promise.resolve(stream()),
          loadClient: () => Promise.resolve(client),
        },
        { ...session, reporter: { ...session.reporter, locale } },
      );
      expect(await screen.findByText(VOICE_CATALOGS[lang].recording_notice)).toBeInTheDocument();
      view.unmount();
    }
  });
});
