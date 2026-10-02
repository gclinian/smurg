// The agents panel in Traditional Chinese: tabs, the session line, the default title of an untitled session, and the
// strings of closing an ended session's tab (the close button, its hint, "close tab", the terminal that is gone, the
// line about hidden ended sessions).
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HOST_USER, makeSession } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { AgentsPanel } from './index.tsx';
import { nextRequest, renderWithSessions } from './test-support.tsx';

useTestLocale('zh-TW');

const running = makeSession({ id: 'sess_run', title: 'Claude', ownerUserId: HOST_USER, ownerName: 'Ian', createdAt: 1 });
const ended = makeSession({ id: 'sess_end', kind: 'terminal', title: 'first', ownerUserId: HOST_USER, ownerName: 'Ian', createdAt: 2, status: 'exited', exitCode: 0, endedAt: 3, endReason: 'exit' });

describe('agents panel in zh-TW', () => {
  it('tabs, the session line and the dialog for a viewer are Traditional Chinese', async () => {
    const { title: _title, ...untitled } = makeSession({ id: 'sess_ming', kind: 'terminal', ownerUserId: 'dev:ming', ownerName: 'Ming', createdAt: 5 });
    await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [running, untitled] });
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(screen.getByRole('tablist', { name: 'session 分頁' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs[0]).toContain('Claude（Ian 開的）');
    // A session nobody named: its kind, in the viewer's language.
    expect(tabs[1]).toContain('終端機（Ming 開的）');
    const summary = screen.getByLabelText('Claude 的資訊');
    expect(summary.textContent).toContain('Ian 開的');
    expect(summary.textContent).toContain('執行中');
    expect(within(screen.getByRole('tabpanel')).getByText('只能觀看')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: '詳細資訊' }));
    expect(screen.getByLabelText('Claude 的詳細資訊').textContent).toContain('開啟的人：Ian');
    fireEvent.click(screen.getByRole('button', { name: '新增 session' }));
    expect(await screen.findByText(/你的角色是「旁觀」/)).toBeTruthy();
  });

  it('closing an ended tab: the button, its hint, the bar button, the gone terminal and the hidden line', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [ended] });
    const tab = screen.getByRole('tab');
    expect(tab.getAttribute('aria-description')).toBe('按 Delete 關閉這個已結束的分頁');
    expect(screen.getByRole('button', { name: '關閉 first（Ian 開的）' })).toBeTruthy();
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByRole('button', { name: '關閉分頁' }).getAttribute('title')).toBe('只會從你自己的面板移除這個已結束的 session，其他成員仍然看得到。');
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      conn.fail('session.attach', new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' }));
    });
    expect(panel.getByRole('status').textContent).toBe('這個 session 結束已久，主人的電腦不再保留它的終端機內容。你可以關閉這個分頁。');
    fireEvent.click(panel.getByRole('button', { name: '關閉分頁' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText('目前沒有 session')).toBeTruthy();
    const hidden = screen.getByTestId('agents-hidden-ended');
    expect(hidden.textContent).toContain('有 1 個已結束的 session 被隱藏了（你關閉了它們的分頁）。');
    fireEvent.click(within(hidden).getByRole('button', { name: '顯示已結束的 session' }));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});
