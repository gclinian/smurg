// The login guide (SPEC R4 「登入引導」, §11 host → guest; ARCHITECTURE §7.6 "Login guide"; claude-hooks.md §1.6):
// shown to the OWNER of a logged-out agent session beside its terminal; subscription login through the code shown in
// the terminal, or the guest's own API key (sent with session.create only, to that one session); an honest warning
// that the host can technically read the guest's credentials, a spending limit, and that leaving deletes the temporary
// directory; a way to re-check the login state.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SmurgError, worktreeRoot, type SessionInfo } from '@smurg/protocol';
import { makeSession, makeWelcome } from '../../testing/fixtures.ts';
import { AgentsPanel } from './index.tsx';
import { captureConsole, nextRequest, renderWithSessions, storesText, webStorageText } from './test-support.tsx';

const API_KEY = 'sk-ant-api03-guest-OWN-key-abcdefghijklmnop';

const guestAgent = makeSession({
  id: 'sess_amy',
  ownerUserId: 'dev:amy',
  ownerName: 'Amy',
  title: 'Claude',
  sandboxed: true,
  login: 'logged-out',
  cols: 100,
  rows: 30,
});

const guide = (): HTMLElement => screen.getByRole('complementary', { name: '登入 Claude' });

let consoleCapture: ReturnType<typeof captureConsole> | null = null;
afterEach(() => {
  consoleCapture?.restore();
  consoleCapture = null;
});

describe('login guide: who sees what', () => {
  it("the guest who owns a logged-out agent sees the step-by-step guide and the honest warnings beside the terminal", async () => {
    await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    const aside = guide();
    const text = aside.textContent ?? '';
    // Subscription login through the daemon's login process (D-12): /login cannot work inside the guest's sandbox.
    expect(within(aside).getByRole('button', { name: '用 Claude 訂閱登入' })).toBeTruthy();
    expect(text).toContain('專用的登入程序（只有你看得到）');
    expect(text).not.toContain('輸入 /login');
    expect(text).toContain('不會在主人的電腦上打開瀏覽器');
    // API key login, spending limit.
    expect(text).toContain('方法二：用 Anthropic API key 登入');
    expect(text).toContain('設定花費上限');
    // The host can technically read the guest's credentials; leaving deletes the temporary directory.
    expect(text).toContain('主人在技術上仍然可以讀取你在這裡使用的憑證');
    expect(text).toContain('刪除你在主人電腦上的暫存目錄');
    expect(within(aside).getByLabelText('你的 Anthropic API key')).toHaveProperty('type', 'password');
    // The guide sits next to the terminal, in the same stage.
    expect(aside.closest('.agents-session__stage')?.querySelector('.agents-term')).toBeTruthy();
  });

  it('others watching the session only see that the owner is not logged in (no guide, no key field)', async () => {
    const bobs = { ...guestAgent, ownerUserId: 'dev:bob', ownerName: 'Bob' };
    await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [bobs] });
    expect(screen.queryByRole('complementary', { name: '登入 Claude' })).toBeNull();
    expect(screen.queryByLabelText('你的 Anthropic API key')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新檢查登入狀態' })).toBeNull();
    expect(screen.getByText('Bob 的 Claude 還沒有登入。')).toBeTruthy();
  });

  it("the host's own session gets the /login steps but no guest warnings and no key field (their own machine)", async () => {
    const hostAgent = makeSession({ id: 'sess_host', login: 'logged-out' });
    await renderWithSessions(<AgentsPanel />, { role: 'host', sessions: [hostAgent] });
    const text = guide().textContent ?? '';
    expect(text).toContain('你的 Claude Code 還沒有登入');
    expect(text).toContain('輸入 /login');
    expect(text).toContain('Paste code here if prompted');
    expect(text).not.toContain('主人在技術上仍然可以讀取');
    expect(screen.queryByLabelText('你的 Anthropic API key')).toBeNull();
    expect(screen.queryByRole('button', { name: '用 Claude 訂閱登入' })).toBeNull();
  });

  it('a logged-in session or a terminal shows no guide; an unknown state offers a check', async () => {
    const loggedIn = { ...guestAgent, id: 'sess_ok', login: 'logged-in' as const };
    const terminal = { ...guestAgent, id: 'sess_term', kind: 'terminal' as const, createdAt: guestAgent.createdAt + 1 };
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [loggedIn, terminal] });
    expect(screen.queryByRole('complementary', { name: '登入 Claude' })).toBeNull();
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    expect(screen.queryByRole('complementary', { name: '登入 Claude' })).toBeNull();
    await act(async () => {
      conn.emit('session.state', { session: { ...loggedIn, login: 'unknown' } });
    });
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '檢查登入狀態' }));
    });
    expect(conn.lastRequest('session.loginStatus')?.payload).toEqual({ sessionId: 'sess_ok' });
  });
});

describe('login guide: re-checking the login state', () => {
  it('asks the daemon (session.loginStatus); still logged out → says so; logged in → the guide closes', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '重新檢查登入狀態' }));
    });
    expect(conn.lastRequest('session.loginStatus')?.payload).toEqual({ sessionId: 'sess_amy' });
    await act(async () => {
      conn.respond('session.loginStatus', { login: 'logged-out' });
    });
    expect(within(guide()).getByText(/還沒有登入。完成上面的步驟後再檢查一次/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '重新檢查登入狀態' }));
    });
    await act(async () => {
      conn.respond('session.loginStatus', { login: 'logged-in' });
    });
    expect(screen.queryByRole('complementary', { name: '登入 Claude' })).toBeNull();
    expect(screen.getByText('已登入 Claude。')).toBeTruthy();
  });

  it('can be hidden and brought back; a new logged-out report from the daemon shows it again', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    fireEvent.click(within(guide()).getByRole('button', { name: '先隱藏說明' }));
    expect(screen.queryByRole('complementary', { name: '登入 Claude' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '登入說明' }));
    expect(guide()).toBeTruthy();
    fireEvent.click(within(guide()).getByRole('button', { name: '先隱藏說明' }));
    await act(async () => {
      conn.emit('session.state', { session: { ...guestAgent, login: 'logged-in' } });
    });
    await act(async () => {
      conn.emit('session.state', { session: { ...guestAgent, login: 'logged-out' } });
    });
    expect(guide()).toBeTruthy();
  });
});

describe('login guide: API key login', () => {
  it('opens a new session with the key (session.create only), then ends the logged-out one; the key is kept nowhere', async () => {
    consoleCapture = captureConsole();
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    fireEvent.change(within(guide()).getByLabelText('你的 Anthropic API key'), { target: { value: API_KEY } });
    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '用這個 key 重新開啟 session' }));
    });
    // Main workspace: the new session first, so a refusal loses nothing.
    expect(conn.requestsOf('session.end')).toHaveLength(0);
    const create = conn.lastRequest('session.create');
    expect(create?.payload).toEqual({ kind: 'agent', workspace: { mode: 'main' }, cols: 100, rows: 30, title: 'Claude', apiKey: API_KEY });
    const replacement = { ...guestAgent, id: 'sess_amy2', login: 'logged-in' as const, createdAt: guestAgent.createdAt + 5 };
    await act(async () => {
      conn.respond('session.create', { session: replacement });
    });
    const end = await nextRequest(conn, 'session.end');
    expect(end.payload).toEqual({ sessionId: 'sess_amy' });
    await act(async () => {
      conn.respond('session.end', {});
      conn.emit('session.state', { session: { ...guestAgent, status: 'exited', exitCode: 0 } });
    });
    // The new session is shown.
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Claude（Amy）');
    expect(stores.sessions.getState().focusedId).toBe('sess_amy2');
    // Only the request carried the key.
    expect(conn.requestsOf('session.create').map((request) => request.payload.apiKey)).toEqual([API_KEY]);
    expect(conn.requests.filter((request) => request.type !== 'session.create' && JSON.stringify(request.payload).includes(API_KEY))).toEqual([]);
    expect(storesText(stores)).not.toContain(API_KEY);
    expect(webStorageText()).not.toContain(API_KEY);
    for (const input of document.querySelectorAll('input')) expect(input.value).not.toContain(API_KEY);
    expect(document.body.innerHTML).not.toContain(API_KEY);
    expect(consoleCapture.text()).not.toContain(API_KEY);
  });

  it('in a worktree the logged-out session ends first, KEEPING the worktree, and the new one continues in it', async () => {
    const inWorktree = { ...guestAgent, root: worktreeRoot('wt_3') };
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [inWorktree] });
    fireEvent.change(within(guide()).getByLabelText('你的 Anthropic API key'), { target: { value: API_KEY } });
    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '用這個 key 重新開啟 session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_amy', keepWorktree: true });
    expect(conn.requestsOf('session.create')).toHaveLength(0);
    await act(async () => {
      conn.respond('session.end', {});
    });
    const create = await nextRequest(conn, 'session.create');
    expect(create.payload.workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_3' });
  });

  it('refuses a malformed key without sending anything', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    fireEvent.change(within(guide()).getByLabelText('你的 Anthropic API key'), { target: { value: 'two words' } });
    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '用這個 key 重新開啟 session' }));
    });
    expect(conn.requestsOf('session.create')).toHaveLength(0);
    expect(conn.requestsOf('session.end')).toHaveLength(0);
    expect(within(guide()).getByText(/API key 的格式不正確/)).toBeTruthy();
  });
});

/** The guest's login process as the daemon reports it (ARCHITECTURE §11 D-12). */
const loginSession = (overrides: Partial<SessionInfo> = {}): SessionInfo =>
  makeSession({
    id: 'sess_login',
    kind: 'login',
    ownerUserId: 'dev:amy',
    ownerName: 'Amy',
    title: 'Claude 訂閱登入（Amy）',
    sandboxed: true,
    login: 'unknown',
    cols: 100,
    rows: 30,
    createdAt: guestAgent.createdAt + 10,
    ...overrides,
  });

describe('login guide: subscription login through the login process (D-12)', () => {
  it("「用 Claude 訂閱登入」 starts the guest's own login process (the fixed session.create kind 'login') and shows its terminal with the steps", async () => {
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '用 Claude 訂閱登入' }));
    });
    // Nothing but the kind, the main workspace and a size: the daemon runs a fixed command.
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    await act(async () => {
      conn.respond('session.create', { session: loginSession() });
    });
    await waitFor(() => expect(stores.sessions.getState().focusedId).toBe('sess_login'));
    const panel = within(screen.getByRole('tabpanel')).getByTestId('login-process');
    const text = panel.textContent ?? '';
    expect(text).toContain('在你自己的瀏覽器開啟');
    expect(text).toContain('登入你的 Claude 帳號');
    expect(text).toContain('Paste code here if prompted');
    expect(text).toContain('只有你看得到');
    // The honest notice stays: the host can technically read the credential.
    expect(text).toContain('主人在技術上仍然可以讀取你在這裡使用的憑證');
    // Its terminal is the guest's own (they type the code into it) and attaches with the guest's panel size.
    expect(within(panel).getByRole('region', { name: /終端機/ })).toBeTruthy();
    await waitFor(() => expect(conn.pendingOf('session.attach').map((request) => request.payload.sessionId)).toContain('sess_login'));
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: '取消登入' })).toBeTruthy();
  });

  it('only the API key way when the host switched subscription logins off, with one sentence why', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    await act(async () => {
      conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, guestSubscriptionLogin: false } });
    });
    const aside = guide();
    expect(within(aside).queryByRole('button', { name: '用 Claude 訂閱登入' })).toBeNull();
    expect(within(aside).getByTestId('login-subscription-off').textContent).toBe('主人關閉了客人用 Claude 訂閱登入的功能，所以請用你自己的 Anthropic API key 登入。');
    expect(within(aside).getByText('用 Anthropic API key 登入')).toBeTruthy();
    expect(within(aside).getByLabelText('你的 Anthropic API key')).toBeTruthy();
    // Also gone from the panel's menu.
    fireEvent.click(screen.getByRole('button', { name: '更多動作' }));
    expect(screen.queryByRole('menuitem', { name: '用 Claude 訂閱登入' })).toBeNull();
  });

  it("the daemon's refusal is shown as it says (switched off), and a login already running is shown instead of a second one", async () => {
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent] });
    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '用 Claude 訂閱登入' }));
    });
    await act(async () => {
      conn.fail('session.create', new SmurgError('forbidden', '主人已關閉客人的訂閱登入，客人請使用自己的 API key 登入。', { reason: 'guest-subscription-login-off' }));
    });
    expect(within(guide()).getByRole('alert').textContent).toContain('主人已關閉客人的訂閱登入');
    expect(within(guide()).getByRole('alert').textContent).toContain('請改用你自己的 API key 登入');

    await act(async () => {
      fireEvent.click(within(guide()).getByRole('button', { name: '用 Claude 訂閱登入' }));
    });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', '已有登入程序在執行。', { reason: 'login-running' }));
    });
    // Another tab of this guest started one: the list is asked again and that one is shown.
    const list = await nextRequest(conn, 'session.list');
    expect(list.payload).toEqual({});
    await act(async () => {
      conn.respond('session.list', { sessions: [guestAgent, loginSession()] });
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_login');
  });

  it('after the login process ends by itself, the login state is checked again and the guest is told what to do next (no restart)', async () => {
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent, loginSession()] });
    act(() => stores.sessions.focus('sess_login'));
    expect(conn.requestsOf('session.loginStatus')).toHaveLength(0);
    await act(async () => {
      conn.emit('session.state', { session: loginSession({ status: 'exited', exitCode: 0, endReason: 'exit' }) });
    });
    const check = await nextRequest(conn, 'session.loginStatus');
    expect(check.payload).toEqual({ sessionId: 'sess_amy' });
    await act(async () => {
      conn.respond('session.loginStatus', { login: 'logged-in' });
    });
    const panel = screen.getByTestId('login-process');
    expect(panel.textContent).toContain('已登入 Claude。');
    expect(panel.textContent).toContain('直接輸入下一個指令就可以，不需要重新開啟 session');
    fireEvent.click(within(panel).getByRole('button', { name: '回到「Claude」' }));
    expect(stores.sessions.getState().focusedId).toBe('sess_amy');
  });

  it('a login that did not work says so and offers to try again; the 10-minute limit and a cancel are named', async () => {
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [guestAgent, loginSession()] });
    act(() => stores.sessions.focus('sess_login'));
    await act(async () => {
      conn.emit('session.state', { session: loginSession({ status: 'exited', exitCode: 1, endReason: 'exit' }) });
    });
    await nextRequest(conn, 'session.loginStatus');
    await act(async () => {
      conn.respond('session.loginStatus', { login: 'logged-out' });
    });
    const panel = screen.getByTestId('login-process');
    expect(panel.textContent).toContain('還沒有登入：登入程序已結束（結束代碼 1）');
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: '再試一次' }));
    });
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    await act(async () => {
      conn.respond('session.create', { session: loginSession({ id: 'sess_login2', createdAt: guestAgent.createdAt + 20 }) });
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_login2');

    await act(async () => {
      conn.emit('session.state', { session: loginSession({ id: 'sess_login2', createdAt: guestAgent.createdAt + 20, status: 'exited', endReason: 'terminated' }) });
    });
    expect(within(screen.getByRole('tabpanel')).getByTestId('login-process').textContent).toContain('登入程序已執行 10 分鐘，自動結束了');
  });

  it('a host that keeps guests out of the main workspace, on a share that is not git (§11 D-14): the empty panel says why, and the subscription login still starts (kind login, mode main)', async () => {
    const base = makeWelcome({ role: 'runner' });
    const welcome = { ...base, workspace: { ...base.workspace, isGitRepo: false, platform: 'linux' as const }, settings: { ...base.settings, guestMainWorkspace: false } };
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [], welcome });
    expect(screen.getByText(/這台主人電腦沒有開放客人使用共享主工作區，這個資料夾也不是 git 儲存庫/)).toBeTruthy();
    expect(screen.queryByText('開一個 agent session 或終端機，所有組員都能即時看到它在做什麼。')).toBeNull();
    // Only the header's 「新增 session」 (its dialog explains); the empty state offers none.
    expect(screen.getAllByRole('button', { name: '新增 session' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '更多動作' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '用 Claude 訂閱登入' }));
    });
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    await act(async () => {
      conn.respond('session.create', { session: loginSession() });
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_login');
  });

  it('a git share with guests kept out of the main workspace: the empty panel still offers 「新增 session」 (their worktree)', async () => {
    const base = makeWelcome({ role: 'runner' });
    const welcome = { ...base, settings: { ...base.settings, guestMainWorkspace: false } };
    await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [], welcome });
    expect(screen.getByText('開一個 agent session 或終端機，所有組員都能即時看到它在做什麼。')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '新增 session' })).toHaveLength(2);
  });

  it("a runner can start it from the panel's menu too (no agent session needed)", async () => {
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'runner', sessions: [] });
    fireEvent.click(screen.getByRole('button', { name: '更多動作' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '用 Claude 訂閱登入' }));
    });
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    await act(async () => {
      conn.respond('session.create', { session: loginSession() });
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_login');
  });
});
