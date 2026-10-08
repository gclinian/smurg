// The "New session" dialog in Traditional Chinese where git decides what it offers: the reason the worktree choices
// are off is the host's own sentence (the Start dialog's words), it follows the folder while the dialog is open, and a
// refusal of the host says why and what to do.
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildTopic } from '@smurg/protocol/testing';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeWelcome } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

useTestLocale('zh-TW');

const NOT_A_GIT_REPO = '分享的資料夾不是 git 儲存庫，無法使用 worktree。主人可以在資料夾裡執行 `git init` 並提交一次，不必重新分享。';

function renderDialog(git: boolean) {
  const result = renderInWorkspace(<NewSessionDialog kind="agent" open onClose={vi.fn()} onCreated={vi.fn()} />, { role: 'agent', admit: false });
  const welcome = makeWelcome({ role: 'agent' });
  act(() => {
    result.conn.admit({ ...welcome, workspace: { ...welcome.workspace, isGitRepo: git } });
  });
  return result;
}

describe('new session dialog in zh-TW: git', () => {
  it('a folder that is not a git repository yet: the reason and what the host can do, until a topic says it is one', () => {
    const { conn } = renderDialog(false);
    expect(screen.getByRole('dialog', { name: '新增 session' })).toBeTruthy();
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    // Still offered: the host's daemon looks at the folder again before it answers.
    expect(screen.getByRole('radio', { name: /我的新 worktree/ })).toHaveProperty('disabled', false);
    act(() => {
      conn.emit('topic.updated', { topic: buildTopic({ versioned: true }) });
    });
    expect(screen.getByRole('radio', { name: /我的新 worktree/ })).toHaveProperty('disabled', false);
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
  });

  it('a repository without a commit: the refusal says so, in the host’s words', async () => {
    const { conn } = renderDialog(true);
    fireEvent.click(screen.getByRole('radio', { name: /我的新 worktree/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '開啟' }));
    });
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('worktree.unavailable.noCommit'), { reason: 'no-commits' }));
    });
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('分享資料夾的 git 儲存庫還沒有任何提交，無法建立 worktree。主人可以提交一次，不必重新分享。');
  });
});
