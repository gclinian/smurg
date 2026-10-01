// The new-session dialog per role (ARCHITECTURE §3, §5.5; SPEC R4, R9; protocol v2: every session runs as the host)
// and the end-session question (R9.4).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SmurgError, worktreeRoot, type Role } from '@smurg/protocol';
import { makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

function renderDialog(role: Role, options: { git?: boolean } = {}) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const result = renderInWorkspace(<NewSessionDialog open onClose={onClose} onCreated={onCreated} />, { role, admit: false });
  const welcome = makeWelcome({ role });
  act(() => {
    result.conn.admit({ ...welcome, workspace: { ...welcome.workspace, isGitRepo: options.git ?? true } });
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

describe('new session dialog: what the role allows', () => {
  it('the host opens a session; one line says it runs on their computer with their Claude account', async () => {
    const { conn, onCreated } = renderDialog('host');
    expect(screen.getByTestId('new-session-runs-as').textContent).toBe('這個 session 會在你的電腦上執行，agent 使用你的 Claude 帳號。');
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

  it("a 可使用 agent member opens the same kind of session: on the HOST's computer, with the host's Claude account — no sandbox, no login, no API key", async () => {
    const { conn } = renderDialog('agent');
    expect(screen.getByTestId('new-session-runs-as').textContent).toBe('這個 session 會在主人的電腦上執行，agent 使用主人的 Claude 帳號。');
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).not.toMatch(/沙盒|API key|訂閱|暫存目錄/);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await submit();
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'agent', workspace: { mode: 'main' }, cols: 100, rows: 30 });
  });

  it('an editor and a viewer cannot open sessions and are told why (no way to submit)', () => {
    const editor = renderDialog('editor');
    expect(screen.getByText(/你的角色是「可編輯」，不能開啟 session/)).toBeTruthy();
    expect(screen.getByText(/請主人把你的角色改成「可使用 agent」/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '開啟' })).toBeNull();
    editor.unmount();
    renderDialog('viewer');
    expect(screen.getByText(/你的角色是「旁觀」/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '開啟' })).toBeNull();
  });
});

describe('new session dialog: where it runs (R9)', () => {
  it('offers the shared main workspace, a new worktree, or one of my kept worktrees', async () => {
    const { conn } = renderDialog('agent');
    await act(async () => {
      conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_kept', branch: 'smurg/amy/wt_kept', kept: true })] });
      conn.respond('worktree.merge.list', { requests: [] });
    });
    expect(screen.getByRole('radio', { name: /共享主工作區/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: /共享主工作區/ })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('radio', { name: /繼續我保留的 worktree：smurg\/amy\/wt_kept/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_kept' });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', 'session 數量已達上限', { reason: 'session-limit' }));
    });
    expect(dialogAlert().textContent).toContain('請先結束不再使用的 session');
    fireEvent.click(screen.getByRole('radio', { name: /我的新 worktree/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    const created = makeSession({ id: 'sess_wt', ownerUserId: 'dev:amy', ownerName: 'Amy', root: worktreeRoot('wt_new') });
    await act(async () => {
      conn.respond('session.create', { session: created });
    });
  });

  it('the worktree choice is disabled with an explanation when the folder is not a git repository; the main workspace stays', () => {
    renderDialog('agent', { git: false });
    expect(screen.getByRole('radio', { name: /我的新 worktree/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /共享主工作區/ })).toHaveProperty('checked', true);
    expect(screen.getByText('這個資料夾不是 git 儲存庫，所以無法使用 worktree。')).toBeTruthy();
  });
});

describe('new session dialog: refusals in plain zh-TW', () => {
  it('a refusal the role cannot pass (forbidden) is explained, never shown as a code', async () => {
    const { conn } = renderDialog('agent');
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('forbidden'));
    });
    expect(dialogAlert().textContent).toContain('你的角色不能執行這個動作。');
  });

  it("a missing Claude Code on the host's computer says the host has to install it", async () => {
    const { conn } = renderDialog('agent');
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', '找不到 claude', { reason: 'claude-not-found' }));
    });
    expect(dialogAlert().textContent).toContain('請主人安裝後再試一次');
  });
});

describe('ending a session (R9.4 「session 結束時詢問是否保留 worktree」)', () => {
  const inWorktree = makeSession({ id: 'sess_wt', ownerUserId: 'dev:amy', ownerName: 'Amy', root: worktreeRoot('wt_1'), title: '修登入頁' });

  it('asks whether to keep the worktree, and sends the answer explicitly', async () => {
    const { conn } = renderInWorkspace(<EndSessionDialog session={inWorktree} mode="end" onClose={() => {}} />, { role: 'agent' });
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
    const { conn } = renderInWorkspace(<EndSessionDialog session={main} mode="end" onClose={() => {}} />, { role: 'agent' });
    expect(screen.queryByText('要保留這個 session 的 worktree 嗎？')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '結束 session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_main' });
  });

  it("the host terminates someone else's session with admin.session.terminate", async () => {
    const { conn } = renderInWorkspace(<EndSessionDialog session={inWorktree} mode="terminate" onClose={() => {}} />, { role: 'host' });
    expect(screen.getByText(/要終止 Amy 開的「修登入頁」嗎？/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '終止' }));
    });
    expect(conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_wt' });
    expect(conn.requestsOf('session.end')).toHaveLength(0);
  });
});
