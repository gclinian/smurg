// The host console in Traditional Chinese: a handful of strings of each section, the role labels from the wire
// catalogue, the risk confirmation of agent access, and a host refusal rendered from its message reference.
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTestLocale } from '../../testing/locale.ts';
import { renderConsole } from './test-support.tsx';

useTestLocale('zh-TW');

describe('host console in zh-TW', () => {
  it('the page, its sections and the role labels are Traditional Chinese', async () => {
    renderConsole();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(await screen.findByRole('heading', { level: 1, name: '主人控制台' })).toBeTruthy();
    expect(screen.getByText('主人必讀的安全提醒')).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: '成員（3）' })).toBeTruthy();
    for (const name of ['所有 session（2）', '待處理的建議（1）', '邀請連結', '操作紀錄', '設定']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    const role = (await screen.findByLabelText('Amy 的角色')) as HTMLSelectElement;
    expect([...role.options].map((option) => option.textContent)).toEqual(['可使用 agent', '可編輯', '旁觀']);
    expect(screen.getByText('amy-laptop（終端機）')).toBeTruthy();
    // The audit headers are built per render, so they follow the language too.
    expect(screen.getByRole('columnheader', { name: '結果' })).toBeTruthy();
    expect(await screen.findByText('權限不足被拒絕')).toBeTruthy();
  });

  it('agent access is confirmed with the risk in plain words, for a member and for an invite', async () => {
    const view = renderConsole();
    fireEvent.change(await screen.findByLabelText('Bob 的角色'), { target: { value: 'agent' } });
    const dialog = screen.getByRole('alertdialog', { name: '把 Bob 的角色改成「可使用 agent」？' });
    expect(within(dialog).getByTestId('role-risk-text').textContent).toBe(
      '可使用 agent 的人可以請 agent 在你的電腦上執行任何指令、讀取你家目錄裡的檔案，並使用你的 Claude 帳號。只開給你完全信任的人。',
    );
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '我了解，變更角色' }));
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:bob', role: 'agent' });
    // The host's refusal is a message reference: shown in the viewer's language, not as the English that came with it.
    await act(async () => {
      view.conn.fail('admin.member.setRole', new SmurgError('not_found', msg('member.notFound'), { reason: 'unknown-member' }));
    });
    expect(screen.getByText(/^無法變更 Bob 的角色：.*成員/)).toBeTruthy();
    expect(screen.queryByText(/That member was not found/)).toBeNull();

    const invites = (await screen.findByRole('heading', { level: 2, name: '邀請連結' })).closest('section') as HTMLElement;
    fireEvent.change(within(invites).getByLabelText('角色'), { target: { value: 'agent' } });
    fireEvent.click(within(invites).getByRole('button', { name: '建立邀請連結' }));
    expect(screen.getByRole('alertdialog', { name: '建立「可使用 agent」的邀請連結？' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我了解，建立邀請連結' })).toBeTruthy();
  });
});
