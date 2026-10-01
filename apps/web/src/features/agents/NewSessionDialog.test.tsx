// The new-session dialog per role (SPEC §8, R4, R5, R9; ARCHITECTURE §5.5) and the end-session question (R9.4).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmurgError, worktreeRoot, type Role } from '@smurg/protocol';
import { makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';
import { captureConsole, storesText, webStorageText } from './test-support.tsx';

const API_KEY = 'sk-ant-api03-SECRET-guest-key-0123456789';

function renderDialog(role: Role, options: { git?: boolean; guestMainWorkspace?: boolean; platform?: 'darwin' | 'linux' } = {}) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const result = renderInWorkspace(<NewSessionDialog open onClose={onClose} onCreated={onCreated} />, { role, admit: false });
  const welcome = makeWelcome({ role });
  act(() => {
    result.conn.admit({
      ...welcome,
      workspace: { ...welcome.workspace, isGitRepo: options.git ?? true, ...(options.platform ? { platform: options.platform } : {}) },
      settings: { ...welcome.settings, ...(options.guestMainWorkspace !== undefined ? { guestMainWorkspace: options.guestMainWorkspace } : {}) },
    });
  });
  return { ...result, onCreated, onClose };
}

/** The error inside the dialog (the toast region has an alert stack of its own). */
const dialogAlert = (): HTMLElement => within(screen.getByRole('dialog')).getByRole('alert');

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '開啟' }));
  });
}

let consoleCapture: ReturnType<typeof captureConsole> | null = null;
afterEach(() => {
  consoleCapture?.restore();
  consoleCapture = null;
});

describe('new session dialog: what the role allows', () => {
  it('the host opens an unsandboxed host session (the client never asks for a sandbox either way)', async () => {
    const { conn, onCreated } = renderDialog('host');
    expect(screen.getByText(/這是主人的 session：不放沙盒/)).toBeTruthy();
    // No API key field for the host: their own Claude Code login is used.
    expect(screen.queryByText(/用自己的 Anthropic API key 登入/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /一般終端機/ }));
    await submit();
    const [request] = conn.requestsOf('session.create');
    expect(request?.payload).toEqual({ kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    const created = makeSession({ id: 'sess_new', kind: 'terminal' });
    await act(async () => {
      conn.respond('session.create', { session: created });
    });
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('a runner gets a sandboxed session: the dialog says what the sandbox allows', () => {
    renderDialog('runner');
    expect(screen.getByText(/你的 session 會在主人電腦上的沙盒裡執行/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '開啟' })).toBeTruthy();
  });

  it('an editor and a viewer cannot open sessions and are told why (no way to submit)', () => {
    const editor = renderDialog('editor');
    expect(screen.getByText(/你的角色是「可編輯」，不能開啟 session/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '開啟' })).toBeNull();
    editor.unmount();
    renderDialog('viewer');
    expect(screen.getByText(/你的角色是「旁觀」/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '開啟' })).toBeNull();
  });
});

describe('new session dialog: where it runs (R9)', () => {
  it('offers the shared main workspace, a new worktree, or one of my kept worktrees', async () => {
    const { conn } = renderDialog('runner');
    await act(async () => {
      conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_kept', branch: 'smurg/amy/wt_kept', kept: true })] });
      conn.respond('worktree.merge.list', { requests: [] });
    });
    expect(screen.getByRole('radio', { name: /共享主工作區/ })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('radio', { name: /繼續我保留的 worktree：smurg\/amy\/wt_kept/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_kept' });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', 'session 數量已達上限', { reason: 'session-limit' }));
    });
    fireEvent.click(screen.getByRole('radio', { name: /我的新 worktree/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
  });

  it('the worktree choice is disabled with an explanation when the folder is not a git repository', () => {
    renderDialog('runner', { git: false });
    expect(screen.getByRole('radio', { name: /我的新 worktree/ })).toHaveProperty('disabled', true);
    expect(screen.getByText('這個資料夾不是 git 儲存庫，所以無法使用 worktree。')).toBeTruthy();
  });
});

describe('new session dialog: a host that keeps guests out of the main workspace (PublicSettings.guestMainWorkspace false, §11 D-14)', () => {
  const mainRadio = () => screen.getByRole('radio', { name: /共享主工作區/ });
  const newWorktreeRadio = () => screen.getByRole('radio', { name: /我的新 worktree/ });

  it('a guest on a Linux host (git share): 「共享主工作區」 is disabled with the reason, 「我的新 worktree」 is preselected and is what is sent', async () => {
    const { conn, onCreated } = renderDialog('runner', { guestMainWorkspace: false, platform: 'linux' });
    await act(async () => {
      conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_kept', branch: 'smurg/amy/wt_kept', kept: true })] });
      conn.respond('worktree.merge.list', { requests: [] });
    });
    expect(mainRadio()).toHaveProperty('disabled', true);
    expect(mainRadio()).toHaveProperty('checked', false);
    expect(newWorktreeRadio()).toHaveProperty('checked', true);
    expect(screen.getByText('主人沒有開放客人使用（原因見下方）。')).toBeTruthy();
    const note = screen.getByTestId('new-session-main-off').textContent ?? '';
    expect(note).toContain('這台主人電腦是 Linux：分享時預設不開放客人使用共享主工作區');
    expect(note).toContain('沙盒無法完整保護主工作區裡主人的設定檔');
    expect(note).toContain('你的 session 會在自己的 worktree 裡執行');
    expect(note).toContain('smurg host --allow-main-workspace-guests');
    // The sandbox banner names only the worktree.
    expect(screen.getByText(/只能讀寫你的 worktree 和你自己的暫存目錄/)).toBeTruthy();
    // Clicking the disabled choice changes nothing.
    fireEvent.click(mainRadio());
    expect(newWorktreeRadio()).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('radio', { name: /一般終端機/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'terminal', workspace: { mode: 'worktree' }, cols: 100, rows: 30 });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', 'session 數量已達上限', { reason: 'session-limit' }));
    });
    // A kept worktree of one's own can still be continued.
    fireEvent.click(screen.getByRole('radio', { name: /繼續我保留的 worktree：smurg\/amy\/wt_kept/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_kept' });
    const created = makeSession({ id: 'sess_wt', ownerUserId: 'dev:amy', ownerName: 'Amy', sandboxed: true, root: worktreeRoot('wt_kept') });
    await act(async () => {
      conn.respond('session.create', { session: created });
    });
    expect(onCreated).toHaveBeenCalledWith(created);
    // Never a main-mode request from this guest.
    expect(conn.requestsOf('session.create').map((request) => request.payload.workspace.mode)).not.toContain('main');
  });

  it('on a host that is not Linux the reason is the host\'s own choice (no claim about Linux)', () => {
    renderDialog('runner', { guestMainWorkspace: false, platform: 'darwin' });
    const note = screen.getByTestId('new-session-main-off').textContent ?? '';
    expect(note).toContain('主人分享時關閉了客人使用共享主工作區的功能。');
    expect(note).not.toContain('Linux');
    expect(newWorktreeRadio()).toHaveProperty('checked', true);
  });

  it('the setting arriving while the dialog is open (channel.settingsUpdated) moves the choice off the main workspace, and back', async () => {
    const { conn } = renderDialog('runner', { platform: 'linux' });
    expect(mainRadio()).toHaveProperty('checked', true);
    expect(screen.queryByTestId('new-session-main-off')).toBeNull();
    await act(async () => {
      conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, guestMainWorkspace: false } });
    });
    expect(mainRadio()).toHaveProperty('disabled', true);
    expect(newWorktreeRadio()).toHaveProperty('checked', true);
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', 'session 數量已達上限', { reason: 'session-limit' }));
    });
    await act(async () => {
      conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, guestMainWorkspace: true } });
    });
    expect(mainRadio()).toHaveProperty('disabled', false);
    expect(mainRadio()).toHaveProperty('checked', true);
  });

  it('a guest on a share that is not a git repository: no session can be opened here, the dialog says why and how the host opens them', () => {
    renderDialog('runner', { git: false, guestMainWorkspace: false, platform: 'linux' });
    const text = within(screen.getByRole('dialog')).getByText(/這個資料夾也不是 git 儲存庫/).closest('.ui-banner')?.textContent ?? '';
    expect(text).toContain('這台主人電腦是 Linux：分享時預設不開放客人使用共享主工作區');
    expect(text).toContain('所以這台主人電腦目前不能開啟客人的 session');
    expect(text).toContain('請主人用 smurg host --allow-main-workspace-guests 重新分享');
    expect(text).toContain('設成 git 儲存庫（至少有一個 commit）後重新分享');
    expect(screen.queryByRole('button', { name: '開啟' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('button', { name: '關閉' })).toBeTruthy();
  });

  it("the host's own session is not affected: the main workspace stays offered and preselected (git or not)", async () => {
    for (const git of [true, false]) {
      const { conn, unmount } = renderDialog('host', { git, guestMainWorkspace: false, platform: 'linux' });
      expect(mainRadio()).toHaveProperty('disabled', false);
      expect(mainRadio()).toHaveProperty('checked', true);
      expect(screen.queryByTestId('new-session-main-off')).toBeNull();
      await submit();
      expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'main' });
      unmount();
    }
  });

  it("the daemon's refusal (forbidden, main-workspace-off) is shown as it says, with what to do — never as a role problem", async () => {
    // A client that did not know yet (an older settings state): the daemon refuses and says so.
    const { conn } = renderDialog('runner');
    await submit();
    const message = '這台主人電腦沒有開放客人使用主工作區；請改用 worktree 模式，或請主人用 --allow-main-workspace-guests 重新分享';
    await act(async () => {
      conn.fail('session.create', new SmurgError('forbidden', message, { reason: 'main-workspace-off' }));
    });
    const alert = dialogAlert();
    expect(alert.textContent).toContain('無法開啟 session');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain('改選「我的新 worktree」');
    expect(alert.textContent).not.toContain('你的角色不能執行這個動作');
  });
});

describe('new session dialog: refusals in plain zh-TW', () => {
  it("sandbox_unavailable shows the daemon's actionable message and that there is no unsandboxed fallback", async () => {
    const { conn } = renderDialog('runner');
    await submit();
    const message = '缺少沙盒需要的 bubblewrap。請主人執行 sudo apt install bubblewrap socat ripgrep 後再試一次。';
    await act(async () => {
      conn.fail('session.create', new SmurgError('sandbox_unavailable', message, { reason: 'dependency-missing' }));
    });
    const alert = dialogAlert();
    expect(alert.textContent).toContain('沙盒無法啟動，session 沒有開啟');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain('smurg 不會在沒有沙盒的情況下執行客人的 session');
  });

  it('a Claude Code version refusal says what the host has to do', async () => {
    const { conn } = renderDialog('runner');
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('sandbox_unavailable', '無法啟動客人沙盒，已拒絕開啟 session', { reason: 'claude-version' }));
    });
    expect(dialogAlert().textContent).toContain('請主人更新 Claude Code');
  });

  it('a refusal the role cannot pass (forbidden) is explained, never shown as a code', async () => {
    const { conn } = renderDialog('runner');
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('forbidden'));
    });
    expect(dialogAlert().textContent).toContain('你的角色不能執行這個動作。');
  });
});

describe("new session dialog: the guest's own API key", () => {
  it('is a password field, is sent only with session.create, and never lands in a store, web storage, the DOM or the console', async () => {
    consoleCapture = captureConsole();
    const { conn, stores, onCreated } = renderDialog('runner');
    fireEvent.click(screen.getByRole('checkbox', { name: /用自己的 Anthropic API key 登入/ }));
    const field = screen.getByLabelText('你的 Anthropic API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    fireEvent.change(field, { target: { value: API_KEY } });
    await submit();
    expect(conn.lastRequest('session.create')?.payload).toMatchObject({ kind: 'agent', apiKey: API_KEY });
    const created = makeSession({ id: 'sess_amy', ownerUserId: 'dev:amy', ownerName: 'Amy', sandboxed: true, login: 'logged-in' });
    await act(async () => {
      conn.respond('session.create', { session: created });
    });
    expect(onCreated).toHaveBeenCalled();
    expect(storesText(stores)).not.toContain(API_KEY);
    expect(webStorageText()).not.toContain(API_KEY);
    expect(document.body.innerHTML).not.toContain(API_KEY);
    for (const input of document.querySelectorAll('input')) expect(input.value).not.toContain(API_KEY);
    expect(consoleCapture.text()).not.toContain(API_KEY);
  });

  it('a malformed key is refused before anything is sent; a failed create does not echo the key', async () => {
    consoleCapture = captureConsole();
    const { conn, stores } = renderDialog('runner');
    fireEvent.click(screen.getByRole('checkbox', { name: /用自己的 Anthropic API key 登入/ }));
    fireEvent.change(screen.getByLabelText('你的 Anthropic API key'), { target: { value: 'not a key' } });
    expect(screen.getByRole('button', { name: '開啟' })).toHaveProperty('disabled', true);
    expect(conn.requestsOf('session.create')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('你的 Anthropic API key'), { target: { value: API_KEY } });
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('sandbox_unavailable', '無法啟動客人沙盒，已拒絕開啟 session', { reason: 'preflight' }));
    });
    expect(dialogAlert().textContent).not.toContain(API_KEY);
    expect(storesText(stores)).not.toContain(API_KEY);
    expect(consoleCapture.text()).not.toContain(API_KEY);
  });
});

describe('ending a session (R9.4 「session 結束時詢問是否保留 worktree」)', () => {
  const inWorktree = makeSession({ id: 'sess_wt', ownerUserId: 'dev:amy', ownerName: 'Amy', sandboxed: true, root: worktreeRoot('wt_1'), title: '修登入頁' });

  it('asks whether to keep the worktree, and sends the answer explicitly', async () => {
    const { conn } = renderInWorkspace(<EndSessionDialog session={inWorktree} mode="end" onClose={() => {}} />, { role: 'runner' });
    expect(screen.getByText('要保留這個 session 的 worktree 嗎？')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /保留 worktree/ })).toHaveProperty('checked', true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '結束 session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_wt', keepWorktree: true });
    await act(async () => {
      conn.respond('session.end', {});
    });
    fireEvent.click(screen.getByRole('radio', { name: /刪除 worktree/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '結束 session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_wt', keepWorktree: false });
  });

  it('a session in the main workspace has no worktree question', async () => {
    const main = makeSession({ id: 'sess_main', ownerUserId: 'dev:amy', ownerName: 'Amy' });
    const { conn } = renderInWorkspace(<EndSessionDialog session={main} mode="end" onClose={() => {}} />, { role: 'runner' });
    expect(screen.queryByText('要保留這個 session 的 worktree 嗎？')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '結束 session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_main' });
  });

  it("the host terminates someone else's session with admin.session.terminate", async () => {
    const { conn } = renderInWorkspace(<EndSessionDialog session={inWorktree} mode="terminate" onClose={() => {}} />, { role: 'host' });
    expect(screen.getByText(/要終止Amy的「修登入頁」嗎？/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '終止' }));
    });
    expect(conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_wt' });
    expect(conn.requestsOf('session.end')).toHaveLength(0);
  });
});
