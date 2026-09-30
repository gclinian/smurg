import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App.tsx';
import { createTestServices, type TestServices } from '../../testing/services.tsx';
import { WORKSPACE_ID, makeMember, makeSession, makeWelcome, presenceOf } from '../../testing/fixtures.ts';
import type { FakeConnection } from '../../testing/fake-connection.ts';

async function openWorkspace(path = `/w/${WORKSPACE_ID}`): Promise<{ services: TestServices; conn: FakeConnection }> {
  const services = createTestServices({ path });
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
    expect(await screen.findByRole('heading', { name: '正在連線到工作區' })).toBeTruthy();
    expect(screen.getByText('正在連線到 smurg 伺服器。')).toBeTruthy();
    act(() => conn.setState({ kind: 'handshaking', mode: 'device', attempt: 1 }));
    expect(screen.getByText('正在驗證主人電腦的身分。')).toBeTruthy();
  });

  it('online: the workbench with every slot, the status pill and the member avatars', async () => {
    const { conn } = await openAdmitted({ role: 'editor' });
    const topbar = screen.getByRole('banner', { name: '工作區' });
    expect(within(topbar).getByRole('status').textContent).toContain('已連線');
    expect(within(topbar).getByText('可編輯')).toBeTruthy();
    expect(screen.getByRole('region', { name: '檔案' })).toBeTruthy();
    expect(screen.getByRole('main', { name: '編輯器' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'agent' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '建議' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: '動態與傳輸' })).toBeTruthy();
    act(() => conn.emit('presence.state', { members: [presenceOf(makeMember()), presenceOf(makeMember({ userId: 'dev:bob', displayName: 'Bob', color: '#ef4444' }))], agents: [] }));
    const people = screen.getByRole('group', { name: '線上成員' });
    expect(within(people).getByRole('img', { name: 'Bob（在線上）' })).toBeTruthy();
    // No console link for a guest (cosmetic; the daemon refuses admin.* anyway).
    expect(screen.queryByRole('link', { name: /主人控制台/ })).toBeNull();
  });

  it('主人斷線後 10 秒內，所有客人的介面顯示離線 — the web UI shows 「主人已離線」 without freezing', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.hostOffline('silence'));
    const banner = await screen.findByTestId('host-offline-banner');
    expect(banner.closest('[role="alert"]')?.textContent).toContain('主人已離線');
    expect(screen.getByRole('banner', { name: '工作區' }).textContent).toContain('主人已離線');
    // Not frozen: the workbench is still there and interactive.
    await userEvent.click(screen.getByRole('tab', { name: '衝突' }));
    expect(screen.getByRole('tab', { name: '衝突' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('button', { name: '離開' }) as HTMLButtonElement).disabled).toBe(false);
    // Back when the host is back.
    act(() => conn.admit(makeWelcome(), { resumed: true }));
    await waitFor(() => expect(screen.queryByTestId('host-offline-banner')).toBeNull());
  });

  it('the host stopped sharing: 「主人已離線」 with the reason', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.hostOffline('stopped'));
    expect((await screen.findByTestId('host-offline-banner')).textContent).toContain('主人已停止分享');
  });

  it('host offline BEFORE the first admission is a clear state too, not a spinner forever', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.hostOffline('relay'));
    expect(await screen.findByRole('heading', { name: '主人已離線' })).toBeTruthy();
  });

  it('relay unreachable is a DIFFERENT message from host offline, with the retry countdown', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.relayUnreachable(Date.now() + 5_000));
    const banner = await screen.findByTestId('relay-unreachable-banner');
    expect(banner.textContent).toContain('不是主人離線');
    expect(banner.textContent).toMatch(/\d+ 秒後重試/);
    expect(screen.queryByTestId('host-offline-banner')).toBeNull();
  });

  it('retrying shows why', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.retrying('busy'));
    expect(await screen.findByText(/主人的電腦忙碌中/)).toBeTruthy();
  });

  it('role changed: reconnects, then says so and applies the new role', async () => {
    const { conn } = await openAdmitted({ role: 'editor' });
    act(() => conn.setState({ kind: 'connecting', attempt: 1, retryAt: Date.now(), cause: 'role-changed' }));
    expect(await screen.findByText(/主人變更了你的角色/)).toBeTruthy();
    act(() => conn.admit(makeWelcome({ role: 'viewer' }), { resumed: true }));
    expect(await screen.findByText('你的角色已變更為「旁觀」')).toBeTruthy();
    expect(within(screen.getByRole('banner', { name: '工作區' })).getByText('旁觀')).toBeTruthy();
  });

  it('kicked: a blocking explanation, nothing of the workspace left', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.kicked());
    const screenEl = await screen.findByTestId('connection-ended-screen');
    expect(screenEl.textContent).toContain('你已被移出工作區');
    expect(screen.queryByRole('banner', { name: '工作區' })).toBeNull();
  });

  it('relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告 — reconnect of a device that pinned the real key (web)', async () => {
    const { conn } = await openAdmitted();
    act(() => conn.keyMismatch('unauthenticated', 'device'));
    const warning = await screen.findByTestId('key-mismatch-screen');
    // A blocking alert dialog that takes focus …
    expect(warning.getAttribute('role')).toBe('alertdialog');
    expect(warning.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(warning);
    expect(screen.getByRole('alertdialog', { name: '安全警告：已拒絕連線' })).toBe(warning);
    // … in plain zh-TW: a different host key, the connection was refused, and what to do.
    expect(warning.textContent).toContain('smurg 伺服器（relay）交給你的「主人電腦金鑰」');
    expect(warning.textContent).toContain('這次連線已被拒絕');
    expect(warning.textContent).toContain('透過其他管道聯絡主人');
    expect(warning.textContent).toContain('請主人產生一個新的邀請連結');
    expect(warning.textContent).toContain('對方無法證明持有主人金鑰');
    // Nothing of the workspace stays behind it, and there is no "retry anyway".
    expect(screen.queryByRole('banner', { name: '工作區' })).toBeNull();
    expect(screen.queryByRole('button', { name: /重試|重新連線/ })).toBeNull();
    await userEvent.click(within(warning).getByRole('button', { name: '回到首頁' }));
  });

  it('rejected: device revoked / version / identity are each explained', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'rejected', reason: 'device-revoked' }));
    expect(await screen.findByRole('heading', { name: '這個裝置已無法連線' })).toBeTruthy();
  });

  it('rejected: a browser that joined as another account is told so, and what to do about it', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'rejected', reason: 'device-other-account' }));
    expect(await screen.findByRole('heading', { name: '這個瀏覽器已經用另一個帳號加入過' })).toBeTruthy();
    expect(screen.getByText(/改用原本的帳號登入/)).toBeTruthy();
    expect(screen.getByText(/另一個瀏覽器設定檔或無痕視窗/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '無法確認你的登入身分' })).toBeNull();
  });

  it('login required: the login screen, returning to this workspace', async () => {
    const { services, conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'closed', reason: 'login-required' }));
    await userEvent.click(await screen.findByRole('button', { name: '使用 Google 登入' }));
    expect(services.router.assigned[0]).toContain(encodeURIComponent(`/w/${WORKSPACE_ID}`));
  });

  it('no pinned key and no invite: explains how to join', async () => {
    const { conn } = await openWorkspace();
    act(() => conn.setState({ kind: 'closed', reason: 'no-trust' }));
    expect(await screen.findByRole('heading', { name: '這個瀏覽器還沒有加入這個工作區' })).toBeTruthy();
  });

  it('「離開」 asks first, then sends channel.leave and goes home', async () => {
    const { services, conn } = await openAdmitted();
    await userEvent.click(screen.getByRole('button', { name: '離開' }));
    const dialog = await screen.findByRole('alertdialog', { name: '離開這個工作區？' });
    expect(dialog.textContent).toContain('Claude 登入資料也會從主人的電腦刪除');
    conn.handle('channel.leave', () => ({}));
    await userEvent.click(within(dialog).getByRole('button', { name: '離開' }));
    await waitFor(() => expect(services.router.getState().pathname).toBe('/'));
    expect(conn.requestsOf('channel.leave')).toHaveLength(1);
    expect(conn.getState()).toMatchObject({ kind: 'closed', reason: 'local' });
  });

  it('the host sees the console link; the console route shows the console for the host only', async () => {
    const { services } = await openAdmitted({ role: 'host' });
    await userEvent.click(screen.getByRole('link', { name: /主人控制台/ }));
    expect(services.router.getState().pathname).toBe(`/w/${WORKSPACE_ID}/console`);
    expect(await screen.findByRole('main', { name: '主人控制台' })).toBeTruthy();
    expect(services.connections).toHaveLength(1);
  });

  it('the terminal gets the room by default: drawer collapsed, suggestions collapsible, the agents column can take the editor’s place (WEB-02)', async () => {
    const { conn } = await openAdmitted({ role: 'host' });
    const drawerToggle = screen.getByRole('button', { name: '展開「動態與傳輸」' });
    expect(drawerToggle.getAttribute('aria-expanded')).toBe('false');

    const suggestions = screen.getByRole('region', { name: '建議' });
    const collapse = within(suggestions).getByRole('button', { name: '收合建議（讓終端機更大）' });
    await userEvent.click(collapse);
    expect(within(suggestions).getByRole('button', { name: '展開建議' }).getAttribute('aria-expanded')).toBe('false');
    expect((suggestions.closest('.ui-split__pane') as HTMLElement).style.height).toBe('33px');

    act(() => conn.emit('session.state', { session: makeSession({ id: 'sess_host', ownerUserId: 'dev:host', ownerName: 'Ian' }) }));
    const editorPane = screen.getByRole('main', { name: '編輯器' }).closest('.ui-split__pane') as HTMLElement;
    expect(editorPane.hidden).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: '放大 agent 面板（取代編輯器的位置）' }));
    expect(editorPane.hidden).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '還原 agent 面板大小' }));
    expect(editorPane.hidden).toBe(false);
  });

  it('a guest opening the console gets an explanation, not the console', async () => {
    const services = createTestServices({ path: `/w/${WORKSPACE_ID}/console` });
    render(<App services={services} />);
    await waitFor(() => expect(services.connections).toHaveLength(1));
    act(() => services.connections[0]!.conn.admit(makeWelcome({ role: 'runner' })));
    expect(await screen.findByText('只有主人可以使用控制台')).toBeTruthy();
  });
});
