// The "New session" dialog in Traditional Chinese where git decides what it offers: the reason the worktree choices
// are off is the host's own sentence, it follows how work items run while the dialog is open (`HostState.work`,
// DESIGN 0.6.0 D14: 0.6.0 on purpose, a folder without `.git` gets smurg's own history), and a refusal of the host says
// why and what to do. The model and mode pickers in Traditional Chinese (D18).
import { SmurgError, type HostState } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HOST_MODELS, makeHostState, makeWelcome } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { hostDefaultLabel, modeOptions, modeReadOnly, modelReadOnly } from './agent-choice.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';

useTestLocale('zh-TW');

const UNCHECKED = 'smurg 還沒在主人的電腦上檢查 git。等主人打開過一個主題的開始對話框，或自己建立過一個 worktree，你就可以建立了。';

function renderDialog(git: boolean, host: HostState = makeHostState()) {
  const result = renderInWorkspace(<NewSessionDialog kind="agent" open onClose={vi.fn()} onCreated={vi.fn()} />, { role: 'agent', admit: false });
  const welcome = makeWelcome({ role: 'agent' });
  act(() => {
    result.conn.admit({ ...welcome, workspace: { ...welcome.workspace, isGitRepo: git } });
  });
  act(() => {
    result.conn.emit('session.host', host);
  });
  return result;
}

describe('new session dialog in zh-TW: git', () => {
  it("before the host's smurg looked for git: the reason and when, until the host's smurg says how items run", () => {
    const { conn } = renderDialog(false, makeHostState({ work: { history: 'unchecked' } }));
    expect(screen.getByRole('dialog', { name: '新增 session' })).toBeTruthy();
    expect(screen.getByText(UNCHECKED)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /我的新 worktree/ })).toHaveProperty('disabled', true);
    act(() => {
      conn.emit('session.host', makeHostState({ work: { history: 'smurg' } }));
    });
    expect(screen.getByRole('radio', { name: /我的新 worktree/ })).toHaveProperty('disabled', false);
    expect(screen.queryByText(UNCHECKED)).toBeNull();
  });

  it('the model and what it may do without asking, in the words of the zh-TW catalogue', () => {
    renderDialog(true);
    const models = Array.from((screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement).options).map((option) => option.textContent);
    expect(models[0]).toBe('主人的預設（Opus）');
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'fable' } });
    expect(screen.getByText('在某些方案上，這個模型會從用量額度扣款，而且 Claude Code 在這裡不會先問。')).toBeTruthy();
    const modes = Array.from((screen.getByRole('combobox', { name: '不必先問就能做的事' }) as HTMLSelectElement).options).map((option) => option.textContent);
    expect(modes).toEqual(['工作區預設（自動：檢查通過就執行）', '自動：檢查通過就執行', '執行指令前先問', '編輯和執行指令前都先問']);
    expect(screen.getByText('自動模式會多送請求給 Claude 來檢查指令，可能算進主人的用量。')).toBeTruthy();
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

describe('the pickers in zh-TW: what they say', () => {
  const agent = { models: HOST_MODELS, modelsKnown: true, hostDefault: 'claude-opus-5-5', autoMode: 'ok', asksNothing: 'ok' } as const;
  it("the follow option, the host's default, and the read-only lines", () => {
    expect(hostDefaultLabel(agent)).toBe('主人的預設（Opus）');
    expect(modeOptions('topic', 'auto')[0]?.label).toBe('主題的設定（自動：檢查通過就執行）');
    expect(modelReadOnly(agent, 'fable')).toBe('模型：Fable');
    expect(modeReadOnly('workspace', null, 'ask-nothing')).toBe('權限模式：工作區預設（什麼都不問）');
  });
});
