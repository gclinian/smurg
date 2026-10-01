import { SmurgError } from '@smurg/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App.tsx';
import { WORKSPACE_ID, makeWelcome, presenceOf } from '../../testing/fixtures.ts';
import { createTestServices } from '../../testing/services.tsx';
import { AMY, BOB, HOST, asMember, renderConsole } from './test-support.tsx';

/** The risk text the host confirms before handing out 「可使用 agent」 (owner decision 2026-10-01, verbatim). */
const RISK = '可使用 agent 的人可以請 agent 在你的電腦上執行任何指令、讀取你家目錄裡的檔案，並使用你的 Claude 帳號。只開給你完全信任的人。';

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('host console: access', () => {
  it('non-hosts cannot reach the console: the route explains instead, and nothing asks the daemon for admin data', async () => {
    const services = createTestServices({ path: `/w/${WORKSPACE_ID}/console` });
    render(<App services={services} />);
    // The workspace route is a lazy chunk: its first load can take seconds on a busy machine.
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    const { conn } = services.connections[0]!;
    act(() => conn.admit(makeWelcome({ role: 'agent' })));
    expect(await screen.findByText('只有主人可以使用控制台', undefined, { timeout: 15_000 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '主人控制台' })).toBeNull();
    expect(conn.requests.filter((request) => request.type.startsWith('admin.'))).toEqual([]);
  });

  it('non-hosts cannot reach the console: the page itself refuses too (defence in depth)', async () => {
    for (const role of ['agent', 'editor', 'viewer'] as const) {
      const view = renderConsole({ role });
      await settle();
      expect(screen.getByText('只有主人可以使用控制台')).toBeTruthy();
      expect(screen.getByText(new RegExp(`你的角色是「${role === 'agent' ? '可使用 agent' : role === 'editor' ? '可編輯' : '旁觀'}」`))).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
      expect(view.conn.requests.filter((request) => request.type.startsWith('admin.'))).toEqual([]);
      view.unmount();
    }
  });

  it('the host gets ONE screen with the security notes and every section', async () => {
    renderConsole();
    expect(await screen.findByRole('heading', { level: 1, name: '主人控制台' })).toBeTruthy();
    const notes = screen.getByText('主人必讀的安全提醒').closest('.ui-banner') as HTMLElement;
    expect(within(notes).getByText(/每個 session（包括「可使用 agent」的成員開的）都在你的電腦上、以你的身分執行，沒有沙盒/)).toBeTruthy();
    expect(within(notes).getByText('只把「可使用 agent」給你完全信任的人；其他人請給「可編輯」或「旁觀」。')).toBeTruthy();
    expect(within(notes).getByText(/prompt injection/)).toBeTruthy();
    expect(within(notes).getByText(/請保持 Claude Code 的權限確認開啟/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { name: '成員（3）' })).toBeTruthy());
    for (const name of ['所有 session（2）', '待處理的建議（1）', '合併請求', '邀請連結', '操作紀錄', '設定']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    // The in-page navigation moves focus to a section without touching the URL.
    fireEvent.click(within(screen.getByRole('navigation', { name: '控制台區塊' })).getByRole('button', { name: '操作紀錄' }));
    expect(document.activeElement?.textContent).toBe('操作紀錄');
  });
});

describe('host console: members', () => {
  it('shows online state, role, devices and what each member is doing', async () => {
    const view = renderConsole();
    await screen.findByText('amy-laptop（終端機）');
    act(() =>
      view.conn.emit('presence.state', {
        members: [presenceOf(asMember(HOST)), presenceOf(asMember(AMY), { connections: 2, activeFile: { root: { kind: 'main' }, path: 'src/login.tsx' } }), presenceOf(asMember(BOB), { online: false, connections: 0 })],
        agents: [],
      }),
    );
    const table = screen.getAllByRole('table')[0]!;
    const amyRow = within(table).getByText('Amy').closest('tr') as HTMLElement;
    expect(within(amyRow).getByText('線上（2 個連線）')).toBeTruthy();
    expect(within(amyRow).getByText('Chrome（網頁）')).toBeTruthy();
    expect(within(amyRow).getByText('正在看 src/login.tsx · 1 個 session 執行中')).toBeTruthy();
    const amyRole = within(amyRow).getByLabelText('Amy 的角色') as HTMLSelectElement;
    expect(amyRole.value).toBe('agent');
    // The role list names the three roles a host hands out.
    expect([...amyRole.options].map((option) => option.textContent)).toEqual(['可使用 agent', '可編輯', '旁觀']);
    const bobRow = within(table).getByText('Bob').closest('tr') as HTMLElement;
    expect(within(bobRow).getByText('離線')).toBeTruthy();
    expect(within(bobRow).getByText('已撤銷')).toBeTruthy();
    expect(within(bobRow).getByText('沒有進行中的活動')).toBeTruthy();
    const hostRow = within(table).getByText('Ian').closest('tr') as HTMLElement;
    expect(within(hostRow).getByText('（你）')).toBeTruthy();
    expect(within(hostRow).queryByRole('button', { name: /踢出/ })).toBeNull();
    expect(within(hostRow).queryByRole('combobox')).toBeNull();
  });

  it('changing a role sends admin.member.setRole and reflects the result and the error', async () => {
    const view = renderConsole();
    const select = (await screen.findByLabelText('Bob 的角色')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'editor' } });
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:bob', role: 'editor' });
    expect(select.disabled).toBe(true);
    await act(async () => {
      view.conn.respond('admin.member.setRole', { member: { ...asMember(BOB), role: 'editor' } });
    });
    expect(select.value).toBe('editor');
    expect(select.disabled).toBe(false);
    expect(screen.getByText('已把 Bob 的角色改為「可編輯」，對方會自動重新連線並套用新權限。')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'viewer' } });
    await act(async () => {
      view.conn.fail('admin.member.setRole', new SmurgError('not_found', '找不到這位成員'));
    });
    expect(screen.getByText('無法變更 Bob 的角色：找不到這位成員')).toBeTruthy();
    expect(select.value).toBe('editor');
  });

  it('choosing 「可使用 agent」 for a member shows the risk first; nothing is sent until the host confirms', async () => {
    const view = renderConsole();
    const select = (await screen.findByLabelText('Bob 的角色')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'agent' } });
    const dialog = screen.getByRole('alertdialog', { name: '把 Bob 的角色改成「可使用 agent」？' });
    expect(within(dialog).getByTestId('role-risk-text').textContent).toBe(RISK);
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    // The select still shows the role in force.
    expect(select.value).toBe('viewer');
    // 取消 changes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    // Confirmed: the role is applied.
    fireEvent.change(select, { target: { value: 'agent' } });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '我了解，變更角色' }));
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:bob', role: 'agent' });
    await act(async () => {
      view.conn.respond('admin.member.setRole', { member: { ...asMember(BOB), role: 'agent' } });
    });
    expect(screen.getByText('已把 Bob 的角色改為「可使用 agent」，對方會自動重新連線並套用新權限。')).toBeTruthy();
  });

  it('taking 「可使用 agent」 from a member who opened sessions asks first, because those sessions end', async () => {
    const view = renderConsole();
    fireEvent.change(await screen.findByLabelText('Amy 的角色'), { target: { value: 'viewer' } });
    const dialog = screen.getByRole('alertdialog', { name: '變更 Amy 的角色？' });
    expect(within(dialog).getByText('Amy 目前開著 1 個 session。改成「旁觀」之後就不能再使用 agent：這些 session 會結束。')).toBeTruthy();
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '變更角色' }));
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:amy', role: 'viewer' });
  });

  it('主人能從控制台一鍵終止任何 session 或踢掉任何成員 — kick: one click, a confirmation that says what happens, then admin.member.kick', async () => {
    const view = renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: '踢出 Amy' }));
    const dialog = screen.getByRole('alertdialog', { name: '踢出 Amy？' });
    expect(within(dialog).getByText('Amy 開的所有 session 立即終止（目前 1 個）。')).toBeTruthy();
    expect(within(dialog).getByText(/所有裝置的金鑰被撤銷/)).toBeTruthy();
    // No guest directory or Claude login of the member exists on the host's computer any more.
    expect(dialog.textContent).not.toMatch(/暫存目錄|登入資料/);
    expect(within(dialog).getByText(/這個動作無法復原/)).toBeTruthy();
    expect(view.conn.requestsOf('admin.member.kick')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: '踢出 Amy' }));
    expect(view.conn.lastRequest('admin.member.kick')?.payload).toEqual({ userId: 'dev:amy' });
    await act(async () => {
      view.conn.fail('admin.member.kick', new SmurgError('internal', '暫時無法處理'));
    });
    expect(within(dialog).getByText('無法踢出 Amy：暫時無法處理')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '踢出 Amy' }));
    view.fixture.members = view.fixture.members.filter((member) => member.userId !== 'dev:amy');
    const listsBefore = view.conn.requestsOf('admin.member.list').length;
    await act(async () => {
      view.conn.respond('admin.member.kick', {});
    });
    expect(await screen.findByText('已踢出 Amy。')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.member.list').length).toBe(listsBefore + 1);
    await waitFor(() => expect(screen.queryByRole('button', { name: '踢出 Amy' })).toBeNull());
    expect(screen.getByRole('heading', { name: '成員（2）' })).toBeTruthy();
  });
});

describe('host console: sessions and suggestions', () => {
  it('shows every session with status, who opened it, where it runs and what its agent is doing (no sandbox column)', async () => {
    const view = renderConsole();
    const table = (await screen.findByText('登入頁')).closest('table') as HTMLElement;
    const amy = within(table).getByText('登入頁').closest('tr') as HTMLElement;
    expect(within(amy).getByText('Amy')).toBeTruthy();
    expect(within(amy).getByText('執行中')).toBeTruthy();
    expect(within(amy).getByText('Amy的 worktree（登入頁）')).toBeTruthy();
    expect(within(table).queryByText(/沙盒/)).toBeNull();
    expect(within(table).getByRole('columnheader', { name: '開啟的人' })).toBeTruthy();
    expect(within(amy).getByText('2 人')).toBeTruthy();
    act(() =>
      view.conn.emit('presence.state', {
        members: [],
        agents: [{ sessionId: 'sess_amy', ownerUserId: 'dev:amy', displayName: 'Claude（Amy）', color: '#3b82f6', status: 'running', activeFile: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'src/login.tsx' } }],
      }),
    );
    expect(within(amy).getByText('正在處理 src/login.tsx')).toBeTruthy();
    const host = within(table).getByText('Claude').closest('tr') as HTMLElement;
    expect(within(host).getByText('主工作區')).toBeTruthy();
    // Exited sessions are behind a toggle.
    expect(within(table).queryByText('終端機')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '顯示已結束的 session（1）' }));
    expect(screen.getByText('已結束（結束代碼 0）')).toBeTruthy();
  });

  it('主人能從控制台一鍵終止任何 session 或踢掉任何成員 — terminate: one click sends admin.session.terminate and reports the outcome', async () => {
    const view = renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: '終止 Amy 開的「登入頁」' }));
    expect(view.conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_amy' });
    await act(async () => {
      view.conn.fail('admin.session.terminate', new SmurgError('not_found', '找不到這個 session'));
    });
    expect(screen.getByText('無法終止 登入頁：找不到這個 session')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '終止 Amy 開的「登入頁」' }));
    await act(async () => {
      view.conn.respond('admin.session.terminate', {});
    });
    expect(screen.getByText('已終止 Amy 開的「登入頁」。')).toBeTruthy();
    act(() => view.conn.emit('session.state', { session: { ...view.fixture.sessions[1]!, status: 'exited', exitCode: 137, endedAt: Date.now() } }));
    expect(screen.queryByRole('button', { name: '終止 Amy 開的「登入頁」' })).toBeNull();
    expect(screen.getByRole('heading', { name: '所有 session（1）' })).toBeTruthy();
  });

  it('lists pending suggestions across all sessions, read-only', async () => {
    const view = renderConsole();
    const section = (await screen.findByRole('heading', { name: '待處理的建議（1）' })).closest('section') as HTMLElement;
    expect(within(section).getByText('Ian → Amy 開的 登入頁')).toBeTruthy();
    expect(within(section).getByText('先補上表單驗證的測試')).toBeTruthy();
    expect(within(section).queryByText('已經處理過的建議')).toBeNull();
    expect(within(section).queryByRole('button')).toBeNull();
    act(() => view.conn.emit('suggest.updated', { suggestion: { ...view.fixture.suggestions[0]!, status: 'rejected', resolvedAt: Date.now() } }));
    expect(within(section).getByText('目前沒有待處理的建議。')).toBeTruthy();
  });

  it('shows the merge requests with the review action', async () => {
    renderConsole();
    const section = (await screen.findByRole('heading', { level: 2, name: '合併請求' })).closest('section') as HTMLElement;
    expect(await within(section).findByText('Amy 的合併請求')).toBeTruthy();
    expect(within(section).getByRole('button', { name: '審核' })).toBeTruthy();
  });
});
