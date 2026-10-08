import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App.tsx';
import { createTestServices, type TestServices, type TestServicesOptions } from '../../testing/services.tsx';
import { WORKSPACE_ID, makeMember, makeWelcome, presenceOf } from '../../testing/fixtures.ts';
import type { FakeConnection } from '../../testing/fake-connection.ts';

async function openWorkspace(path = `/w/${WORKSPACE_ID}`, doubles: Omit<TestServicesOptions, 'path'> = {}): Promise<{ services: TestServices; conn: FakeConnection }> {
  const services = createTestServices({ path, ...doubles });
  render(<App services={services} />);
  // The workspace routes are a lazy chunk that grows with every feature: its cold import alone can take seconds on a
  // loaded machine, so wait for it generously (the default 1 s timed out under load).
  await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
  const { conn, options } = services.connections[0]!;
  // The workspace page never opens with an invite: only a pinned key (device mode) can be used here.
  expect(options.invite ?? null).toBeNull();
  return { services, conn };
}

async function openAdmitted(role: Parameters<typeof makeWelcome>[0] = {}) {
  const opened = await openWorkspace();
  act(() => opened.conn.admit(makeWelcome(role)));
  await screen.findByRole('heading', { name: 'class-project' }, { timeout: 15_000 });
  return opened;
}

describe('connection states in the UI', () => {
  it('connecting and handshaking: a connecting screen that says what happens', async () => {
    const { conn } = await openWorkspace();
    expect(await screen.findByRole('heading', { name: 'Connecting to the workspace' })).toBeTruthy();
    expect(screen.getByText('Connecting to the smurg server.')).toBeTruthy();
    act(() => conn.setState({ kind: 'handshaking', mode: 'device', attempt: 1 }));
    expect(screen.getByText("Verifying the identity of the host's computer.")).toBeTruthy();
  });

  it('online: the sessions view with its two landmarks, the status pill and the member avatars', async () => {
    const { conn } = await openAdmitted({ role: 'editor' });
    const topbar = screen.getByRole('banner', { name: 'Workspace' });
    expect(within(topbar).getByRole('status').textContent).toContain('Connected');
    expect(within(topbar).getByText('Editor')).toBeTruthy();
    // The main screen is the sessions view: the left column and the columns (UX §1).
    expect(screen.getByRole('complementary', { name: 'Inbox and sessions' })).toBeTruthy();
    expect(screen.getByRole('main', { name: 'Open columns' })).toBeTruthy();
    expect(within(topbar).getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    act(() => conn.emit('presence.state', { members: [presenceOf(makeMember()), presenceOf(makeMember({ userId: 'dev:bob', displayName: 'Bob', color: '#ef4444' }))], agents: [] }));
    const people = screen.getByRole('group', { name: 'Online members' });
    expect(within(people).getByRole('img', { name: 'Bob (online)' })).toBeTruthy();
    // No console link for a guest (cosmetic; the daemon refuses admin.* anyway).
    expect(screen.queryByRole('link', { name: /Host console/ })).toBeNull();
  });

  it('within 10 seconds of the host disconnecting, the interface of every guest shows offline — the web UI shows "Host offline" without freezing', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.hostOffline('silence'));
    const banner = await screen.findByTestId('host-offline-banner');
    expect(banner.closest('[role="alert"]')?.textContent).toContain('Host offline');
    expect(screen.getByRole('banner', { name: 'Workspace' }).textContent).toContain('Host offline');
    // Not frozen: the sessions view is still there and interactive.
    const inbox = screen.getByRole('button', { name: 'Inbox' });
    expect(inbox.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(inbox);
    expect(inbox.getAttribute('aria-expanded')).toBe('false');
    expect((screen.getByRole('button', { name: 'Leave' }) as HTMLButtonElement).disabled).toBe(false);
    // Back when the host is back.
    act(() => conn.admit(makeWelcome(), { resumed: true }));
    await waitFor(() => expect(screen.queryByTestId('host-offline-banner')).toBeNull());
  });

  it('the host stopped sharing: "Host offline" with the reason', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.hostOffline('stopped'));
    expect((await screen.findByTestId('host-offline-banner')).textContent).toContain('The host stopped sharing this workspace.');
  });

  it('host offline BEFORE the first admission is a clear state too, not a spinner forever', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.hostOffline('relay'));
    expect(await screen.findByRole('heading', { name: 'Host offline' })).toBeTruthy();
  });

  it('relay unreachable is a DIFFERENT message from host offline, with the retry countdown', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.relayUnreachable(Date.now() + 5_000));
    const banner = await screen.findByTestId('relay-unreachable-banner');
    expect(banner.textContent).toContain('the host is not offline');
    expect(banner.textContent).toMatch(/Retrying in \d+ seconds?\./);
    expect(screen.queryByTestId('host-offline-banner')).toBeNull();
  });

  it('retrying shows why', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.retrying('busy'));
    expect(await screen.findByText(/The host's computer is busy/)).toBeTruthy();
  });

  it('role changed: reconnects, then says so and applies the new role', async () => {
    const { conn } = await openAdmitted({ role: 'editor' });
    act(() => conn.setState({ kind: 'connecting', attempt: 1, retryAt: Date.now(), cause: 'role-changed' }));
    expect(await screen.findByText(/The host changed your role/)).toBeTruthy();
    act(() => conn.admit(makeWelcome({ role: 'viewer' }), { resumed: true }));
    expect(await screen.findByText('Your role is now Viewer')).toBeTruthy();
    expect(within(screen.getByRole('banner', { name: 'Workspace' })).getByText('Viewer')).toBeTruthy();
  });

  it('kicked: a blocking explanation, nothing of the workspace left', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.kicked());
    const screenEl = await screen.findByTestId('connection-ended-screen');
    expect(screenEl.textContent).toContain('You were removed from the workspace');
    expect(screen.queryByRole('banner', { name: 'Workspace' })).toBeNull();
  });

  it('when the relay replaces the daemon public key with its own, the client refuses the connection and shows a warning — reconnect of a device that pinned the real key (web)', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.keyMismatch('unauthenticated', 'device'));
    const warning = await screen.findByTestId('key-mismatch-screen');
    // A blocking alert dialog that takes focus …
    expect(warning.getAttribute('role')).toBe('alertdialog');
    expect(warning.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(warning);
    expect(screen.getByRole('alertdialog', { name: 'Security warning: connection refused' })).toBe(warning);
    // … in plain words: a different host key, the connection was refused, and what to do.
    expect(warning.textContent).toContain("The host computer's key that the smurg server (relay) handed you");
    expect(warning.textContent).toContain('this connection was refused');
    expect(warning.textContent).toContain('Contact the host some other way');
    expect(warning.textContent).toContain('Ask the host to make a new invite link');
    expect(warning.textContent).toContain("the other side could not prove it holds the host's key");
    // Nothing of the workspace stays behind it, and there is no "retry anyway".
    expect(screen.queryByRole('banner', { name: 'Workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry|Reconnect/ })).toBeNull();
    await userEvent.click(within(warning).getByRole('button', { name: 'Back to home' }));
  });

  it('rejected: device revoked / version / identity are each explained', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'rejected', reason: 'device-revoked' }));
    expect(await screen.findByRole('heading', { name: 'This device can no longer connect' })).toBeTruthy();
  });

  // The refusal itself says only `version`. The page asks the relay whether it still serves this tab's page and says
  // which side has to act; a refusal is final until the page is reloaded, so every answer names the reload.
  it('refused for its version, and the relay serves another page by now: this tab is from before an update, and Reload is the way out', async () => {
    const { conn } = await openWorkspace(undefined, { pageBuild: () => Promise.resolve('stale') });
    act(() => conn.setState({ kind: 'rejected', reason: 'version' }));
    expect(await screen.findByRole('heading', { name: 'This tab is from before an update' })).toBeTruthy();
    const ended = screen.getByTestId('connection-ended-screen');
    expect(ended.textContent).toContain('Reload the page to get the new one.');
    expect(within(ended).getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(ended.textContent).not.toContain('smurg update');
  });

  it("refused for its version, and this tab runs the current page: the host's smurg is the older side; what the host does, and then a reload of this page", async () => {
    const { conn } = await openWorkspace(undefined, { pageBuild: () => Promise.resolve('current') });
    act(() => conn.setState({ kind: 'rejected', reason: 'version' }));
    expect(await screen.findByRole('heading', { name: "The host's smurg is older than this page" })).toBeTruthy();
    const ended = screen.getByTestId('connection-ended-screen');
    expect(ended.textContent).toContain('The host stops sharing, runs smurg update and shares again (a host who runs their own relay deploys the relay again). Then reload this page.');
    expect(within(ended).getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });

  it('refused for its version: while the relay is asked the page says so, and when it cannot be asked the page names both steps', async () => {
    let answer: (build: 'unknown') => void = () => {};
    const asked: number[] = [];
    const { conn } = await openWorkspace(undefined, {
      pageBuild: () => {
        asked.push(asked.length);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    act(() => conn.setState({ kind: 'rejected', reason: 'version' }));
    expect(await screen.findByRole('heading', { name: 'Incompatible versions' })).toBeTruthy();
    expect(screen.getByText('Checking whether this tab runs the newest page…')).toBeTruthy();
    await act(async () => answer('unknown'));
    expect(screen.getByRole('heading', { name: 'Incompatible versions' })).toBeTruthy();
    expect(screen.getByText(/Reload the page\. If the page says this again, the host's smurg is older than the page/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    // Asked once for the refusal, not on every render.
    expect(asked).toHaveLength(1);
  });

  it('the relay is asked only for a version refusal', async () => {
    const asked: number[] = [];
    const { conn } = await openWorkspace(undefined, {
      pageBuild: () => {
        asked.push(1);
        return Promise.resolve('stale');
      },
    });
    act(() => conn.setState({ kind: 'rejected', reason: 'device-revoked' }));
    expect(await screen.findByRole('heading', { name: 'This device can no longer connect' })).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("the browser's key was written by a newer page: the page says so and offers the reload; the plain storage error keeps its words", async () => {
    const newer = await openWorkspace(undefined, { keyStorage: { persistent: true, newerRecord: true } });
    act(() => newer.conn.setState({ kind: 'closed', reason: 'storage-error' }));
    expect(await screen.findByRole('heading', { name: "This browser's smurg key was written by a newer page" })).toBeTruthy();
    const ended = screen.getByTestId('connection-ended-screen');
    expect(ended.textContent).toContain('Nothing was changed. Reload the page to get the newer one.');
    expect(within(ended).getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    cleanup();

    const plain = await openWorkspace();
    act(() => plain.conn.setState({ kind: 'closed', reason: 'storage-error' }));
    expect(await screen.findByRole('heading', { name: 'Cannot read or write the device key' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload the page' })).toBeNull();
  });

  it('rejected: a browser that joined as another account is told so, and what to do about it', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'rejected', reason: 'device-other-account' }));
    expect(await screen.findByRole('heading', { name: 'This browser already joined with another account' })).toBeTruthy();
    expect(screen.getByText(/log in with the original account/)).toBeTruthy();
    expect(screen.getByText(/another browser profile or a private window/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your login could not be verified' })).toBeNull();
  });

  it('login required: the login screen, returning to this workspace', async () => {
    const { services, conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'closed', reason: 'login-required' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Log in with Google' }));
    expect(services.router.assigned[0]).toContain(encodeURIComponent(`/w/${WORKSPACE_ID}`));
  });

  it('no pinned key and no invite: explains how to join', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'closed', reason: 'no-trust' }));
    expect(await screen.findByRole('heading', { name: 'This browser has not joined this workspace yet' })).toBeTruthy();
  });

  it('"Leave" asks first, then sends channel.leave and goes home', async () => {
    const { services, conn } = await openAdmitted();
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave this workspace?' });
    // What ends, what passes to the host, what is removed (DESIGN §3.9, §5.7).
    expect(dialog.textContent).toContain('The terminals and the sessions without a topic that you opened end.');
    expect(dialog.textContent).toContain('The topic sessions you started (discussions and work items) pass to the host and keep running.');
    expect(dialog.textContent).toContain('What you put in place is removed');
    // There is no guest login on the host's computer any more (protocol v2).
    expect(dialog.textContent).not.toMatch(/Claude (login|sign-in|credentials)/i);
    conn.handle('channel.leave', () => ({}));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(services.router.getState().pathname).toBe('/'));
    expect(conn.requestsOf('channel.leave')).toHaveLength(1);
    expect(conn.getState()).toMatchObject({ kind: 'closed', reason: 'local' });
  });

  it('the host sees the console link; the console route shows the console for the host only', async () => {
    const { services } = await openAdmitted({ role: 'host' });
    await userEvent.click(screen.getByRole('link', { name: /Host console/ }));
    expect(services.router.getState().pathname).toBe(`/w/${WORKSPACE_ID}/console`);
    expect(await screen.findByRole('main', { name: 'Host console' })).toBeTruthy();
    expect(services.connections).toHaveLength(1);
  });

  it('a guest opening the console gets an explanation, not the console', async () => {
    const services = createTestServices({ path: `/w/${WORKSPACE_ID}/console` });
    render(<App services={services} />);
    await waitFor(() => expect(services.connections).toHaveLength(1));
    act(() => services.connections[0]!.conn.admit(makeWelcome({ role: 'agent' })));
    expect(await screen.findByText('Only the host can use the console')).toBeTruthy();
  });
});
