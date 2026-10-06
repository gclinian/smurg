// The Terminal panel in Traditional Chinese: tabs, the session line, the default title of an untitled terminal, the
// terminal that is gone, the empty panel and the "New terminal" dialog.
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HOST_USER, makeSession } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { TerminalPanel } from './index.tsx';
import { nextRequest, renderWithSessions } from './test-support.tsx';

useTestLocale('zh-TW');

const running = makeSession({ id: 'sess_run', title: 'Claude', openedBy: { userId: HOST_USER, displayName: 'Ian' }, createdAt: 1 });
const ended = makeSession({ id: 'sess_end', kind: 'terminal', title: 'first', openedBy: { userId: HOST_USER, displayName: 'Ian' }, createdAt: 2, status: 'exited', exitCode: 0, endedAt: 3, endReason: 'exit' });

describe('terminal panel in zh-TW', () => {
  it('tabs, the session line and the dialog for a viewer are Traditional Chinese', async () => {
    const { title: _title, ...untitled } = makeSession({ id: 'sess_ming', kind: 'terminal', openedBy: { userId: 'dev:ming', displayName: 'Ming' }, createdAt: 5 });
    await renderWithSessions(<TerminalPanel />, { role: 'viewer', sessions: [running, untitled] });
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(screen.getByRole('tablist', { name: '終端機分頁' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '新增終端機' }));
    expect(await screen.findByText(/你的角色是「旁觀」/)).toBeTruthy();
  });

  it('an ended terminal the host no longer keeps, and the empty panel', async () => {
    const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [ended] });
    const panel = within(screen.getByRole('tabpanel'));
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      conn.fail('session.attach', new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' }));
    });
    expect(panel.getByRole('status').textContent).toBe('這個 session 結束已久，主人的電腦不再保留它的終端機內容。你可以把它關閉。');
    cleanup();

    await renderWithSessions(<TerminalPanel />, { role: 'agent', sessions: [] });
    expect(screen.getByText('目前沒有終端機')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '新增終端機' })[0]!);
    expect(await screen.findByRole('dialog', { name: '新增終端機' })).toBeTruthy();
    expect(screen.getByTestId('new-session-runs-as').textContent).toBe('這個終端機在主人的電腦上以主人的身分執行。');
  });
});
