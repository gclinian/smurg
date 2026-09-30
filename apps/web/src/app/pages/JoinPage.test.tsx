import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { x25519KeyPair } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { PENDING_INVITE_KEY_PREFIX, captureInviteFragment } from '../../boot/capture-invite.ts';
import { App } from '../App.tsx';
import { MemoryStorage, createTestServices, type TestServices } from '../../testing/services.tsx';
import { WORKSPACE_ID, makeInvite, makeWelcome } from '../../testing/fixtures.ts';

const JOIN_PATH = `/join/${WORKSPACE_ID}`;

function servicesWithInvite(options: Parameters<typeof createTestServices>[0] = {}): { services: TestServices; invite: ReturnType<typeof makeInvite> } {
  const services = createTestServices({ path: JOIN_PATH, ...options });
  const invite = makeInvite();
  services.sessionStorage.setItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID, invite.fragment);
  return { services, invite };
}

/** Step 4: the explicit 「加入」 (SEC-E-02). */
async function confirmJoin(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: '加入' }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('join flow (ARCHITECTURE §4.1)', () => {
  it('removes the fragment from the address bar before any navigation, including the OAuth redirect', async () => {
    const { fragment, secret } = makeInvite();
    // The link as opened: https://…/join/<id>#k=…&s=…
    window.history.replaceState(null, '', `${JOIN_PATH}#${fragment}`);
    // What main.tsx runs first.
    captureInviteFragment({ location: window.location, history: window.history, sessionStorage: window.sessionStorage });
    expect(window.location.href).not.toContain('#');

    const services = createTestServices({ path: JOIN_PATH, user: null });
    const tabStorage = new MemoryStorage();
    tabStorage.setItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID, window.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID) ?? '');
    const withTab: TestServices = { ...services, sessionStorage: tabStorage };
    render(<App services={withTab} />);

    // Not logged in: the login step. Choosing GitHub leaves the SPA …
    await userEvent.click(await screen.findByRole('button', { name: '使用 GitHub 登入' }));
    expect(services.router.assigned).toHaveLength(1);
    const redirect = services.router.assigned[0]!;
    // … with a return URL that carries no fragment and no secret, while the address bar has none either.
    expect(redirect).not.toContain('#');
    expect(decodeURIComponent(redirect)).not.toContain('#');
    expect(decodeURIComponent(redirect)).not.toContain(fragment);
    expect(redirect).toContain(encodeURIComponent(JOIN_PATH));
    expect(window.location.href).not.toContain('#');
    // The invite waits in the tab's storage for the return; nothing was connected yet.
    expect(tabStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBe(fragment);
    expect(services.connections).toHaveLength(0);
    expect(secret).toHaveLength(32);
    window.history.replaceState(null, '', '/');
  });

  it('logged in: connects in invite mode with the parsed invite, then forgets it and opens the workspace on the same connection', async () => {
    const { services, invite } = servicesWithInvite();
    render(<App services={services} />);
    await confirmJoin();
    await waitFor(() => expect(services.connections).toHaveLength(1));
    const { conn, options, workspaceId } = services.connections[0]!;
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect([...(options.invite?.fingerprint ?? [])]).toEqual([...invite.fingerprint]);
    expect([...(options.invite?.secret ?? [])]).toEqual([...invite.secret]);
    expect(options.preferInvite).toBe(false);
    expect(conn.started).toBe(true);
    expect(await screen.findByRole('heading', { name: '正在加入工作區' })).toBeTruthy();

    // Still pending while the handshake runs (the SDK pins the daemon key before it proves the invite).
    act(() => conn.setState({ kind: 'handshaking', mode: 'invite', attempt: 1 }));
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBe(invite.fragment);

    act(() => conn.admit(makeWelcome()));
    // The workspace chunk loads lazily (seconds on a loaded machine): wait for it generously.
    await waitFor(() => expect(services.router.getState().pathname).toBe(`/w/${WORKSPACE_ID}`), { timeout: 15_000 });
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBeNull();
    expect(services.recent.getState()[0]).toMatchObject({ id: WORKSPACE_ID, name: 'class-project', hostName: 'Ian' });
    // The workspace page reuses the admitted connection: ONE connection per workspace, no second handshake.
    await flush();
    expect(services.connections).toHaveLength(1);
    // The workspace page is the lazy chunk too: as generous as the wait for the URL above.
    expect(await screen.findByText('class-project', {}, { timeout: 15_000 })).toBeTruthy();
  });

  it('a logged-in visitor sent to an invite link by another page joins nothing until they click 「加入」 (SEC-E-02)', async () => {
    const { services, invite } = servicesWithInvite();
    let meCalls = 0;
    const me = services.auth.me;
    services.auth.me = () => {
      meCalls++;
      return me();
    };
    render(<App services={services} />);
    // The page has read the invite and asked /api/me (the step where it used to connect on its own)…
    await waitFor(() => expect(meCalls).toBeGreaterThan(0));
    for (let i = 0; i < 5; i++) await flush();
    // …and still: no connection, no handshake, no identity token sent.
    expect(services.connections).toHaveLength(0);
    const confirm = await screen.findByTestId('join-confirm');
    // It says what joining shares, and with which identity.
    expect(confirm.textContent).toContain(WORKSPACE_ID);
    expect(confirm.textContent).toContain('主人會看到你的名稱、帳號和裝置名稱');
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBe(invite.fragment);

    // 「不要加入」 forgets the link and goes home, still without connecting.
    await userEvent.click(screen.getByRole('button', { name: '不要加入' }));
    expect(services.router.getState().pathname).toBe('/');
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBeNull();
    expect(services.connections).toHaveLength(0);
  });

  it('refuses a malformed fragment without connecting, and forgets it', async () => {
    const services = createTestServices({ path: JOIN_PATH });
    services.sessionStorage.setItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID, 'k=abc&s=def');
    render(<App services={services} />);
    expect(await screen.findByRole('heading', { name: '邀請連結格式不正確' })).toBeTruthy();
    expect(services.connections).toHaveLength(0);
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBeNull();
  });

  it('without a fragment: goes to the workspace if this browser already joined, explains otherwise', async () => {
    const joined = createTestServices({ path: JOIN_PATH });
    await joined.pins.pin(WORKSPACE_ID, x25519KeyPair().publicKey);
    render(<App services={joined} />);
    await waitFor(() => expect(joined.router.getState().pathname).toBe(`/w/${WORKSPACE_ID}`));

    const fresh = createTestServices({ path: JOIN_PATH });
    render(<App services={fresh} />);
    expect(await screen.findByRole('heading', { name: '邀請連結不完整' })).toBeTruthy();
    expect(fresh.connections).toHaveLength(0);
  });

  it('a pinned daemon key that differs from the invite is never replaced silently: the person must confirm', async () => {
    const { services } = servicesWithInvite();
    await services.pins.pin(WORKSPACE_ID, x25519KeyPair().publicKey);
    render(<App services={services} />);
    const dialog = await screen.findByTestId('key-change-confirm');
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(services.connections).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: '我已向主人確認，使用新的連結' }));
    await waitFor(() => expect(services.connections).toHaveLength(1));
    expect(services.connections[0]!.options.preferInvite).toBe(true);
  });

  it('cancelling the key change forgets the invite and goes home', async () => {
    const { services } = servicesWithInvite();
    await services.pins.pin(WORKSPACE_ID, x25519KeyPair().publicKey);
    render(<App services={services} />);
    await userEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(services.router.getState().pathname).toBe('/');
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBeNull();
    expect(services.connections).toHaveLength(0);
  });

  it('a pinned key equal to the invite asks nothing about the key (only the usual 「加入」)', async () => {
    const { services, invite } = servicesWithInvite();
    await services.pins.pin(WORKSPACE_ID, invite.daemonKey);
    render(<App services={services} />);
    await confirmJoin();
    await waitFor(() => expect(services.connections).toHaveLength(1));
    expect(services.connections[0]!.options.preferInvite).toBe(false);
  });

  it('relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告 — during the join (web)', async () => {
    const { services } = servicesWithInvite();
    render(<App services={services} />);
    await confirmJoin();
    await waitFor(() => expect(services.connections).toHaveLength(1));
    act(() => services.connections[0]!.conn.keyMismatch('fingerprint', 'invite'));
    const warning = await screen.findByTestId('key-mismatch-screen');
    expect(warning.getAttribute('role')).toBe('alertdialog');
    expect(warning.textContent).toContain('已拒絕連線');
    expect(warning.textContent).toContain('請主人產生一個新的邀請連結');
    // The invite cannot be used through this relay; it is not kept around.
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBeNull();
    expect(services.router.getState().pathname).toBe(JOIN_PATH);
  });

  it('an invalid or used-up invite is explained, and forgotten', async () => {
    const { services } = servicesWithInvite();
    render(<App services={services} />);
    await confirmJoin();
    await waitFor(() => expect(services.connections).toHaveLength(1));
    act(() => services.connections[0]!.conn.setState({ kind: 'rejected', reason: 'invite-invalid' }));
    expect(await screen.findByRole('heading', { name: '邀請連結無法使用' })).toBeTruthy();
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBeNull();
  });

  it('a login that expired during the join keeps the invite and asks to log in again', async () => {
    const { services, invite } = servicesWithInvite();
    render(<App services={services} />);
    await confirmJoin();
    await waitFor(() => expect(services.connections).toHaveLength(1));
    act(() => services.connections[0]!.conn.setState({ kind: 'closed', reason: 'login-required' }));
    expect(await screen.findByTestId('login-required-screen')).toBeTruthy();
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).toBe(invite.fragment);
  });

  it('while the host is offline the join waits and says so', async () => {
    const { services } = servicesWithInvite();
    render(<App services={services} />);
    await confirmJoin();
    await waitFor(() => expect(services.connections).toHaveLength(1));
    act(() => services.connections[0]!.conn.hostOffline('relay'));
    expect(await screen.findByText(/主人的電腦目前離線。主人上線後會自動繼續加入/)).toBeTruthy();
  });

  it('shows the dev-login form only when the relay reports dev login', async () => {
    const without = servicesWithInvite({ user: null, dev: false }).services;
    const { unmount } = render(<App services={without} />);
    expect(await screen.findByRole('button', { name: '使用 GitHub 登入' })).toBeTruthy();
    await flush();
    expect(screen.queryByTestId('dev-login-form')).toBeNull();
    unmount();

    const withDev = servicesWithInvite({ user: null, dev: true }).services;
    render(<App services={withDev} />);
    const form = await screen.findByTestId('dev-login-form');
    await userEvent.type(screen.getByLabelText('帳號名稱'), 'bob');
    await userEvent.click(screen.getByRole('button', { name: '以開發用帳號登入' }));
    expect(withDev.router.assigned[0]).toContain('/auth/dev/start?user=bob');
    expect(withDev.router.assigned[0]).not.toContain('#');
    expect(form).toBeTruthy();
  });
});
