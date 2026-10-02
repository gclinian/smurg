// The platform's zh-TW suite: a browser that starts in Traditional Chinese gets the landing page, the join page, the
// workbench shell and the connection screens in zh-TW, with <html lang="zh-Hant-TW">.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PENDING_INVITE_KEY_PREFIX } from '../boot/capture-invite.ts';
import { WORKSPACE_ID, makeInvite, makeMember, makeWelcome, presenceOf } from '../testing/fixtures.ts';
import { useTestLocale } from '../testing/locale.ts';
import { createTestServices } from '../testing/services.tsx';
import { App } from './App.tsx';

useTestLocale('zh-TW');

describe('the app in zh-TW', () => {
  it('landing page: tagline, login, footer and the menus', async () => {
    render(<App services={createTestServices({ path: '/', user: null })} />);
    expect(await screen.findByRole('heading', { name: '多人 × 多 agent 即時協作工作區' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用 GitHub 登入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '語言' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '外觀' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '說明文件' }).getAttribute('href')).toBe('https://smurg.ai/zh-TW/docs/');
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
  });

  it('join page: the confirmation names the workspace and the identity', async () => {
    const services = createTestServices({ path: `/join/${WORKSPACE_ID}` });
    services.sessionStorage.setItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID, makeInvite().fragment);
    render(<App services={services} />);
    const confirm = await screen.findByTestId('join-confirm');
    expect(within(confirm).getByRole('heading', { name: '要加入這個工作區嗎？' })).toBeTruthy();
    expect(confirm.textContent).toContain('Amy（開發用帳號）');
    expect(within(confirm).getByRole('button', { name: '加入' })).toBeTruthy();
    expect(within(confirm).getByRole('button', { name: '不要加入' })).toBeTruthy();
  });

  it('workbench: the top bar, the role from the wire catalogue, the drawer tabs and the host-offline banner', async () => {
    const services = createTestServices({ path: `/w/${WORKSPACE_ID}` });
    render(<App services={services} />);
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    const { conn } = services.connections[0]!;
    expect(await screen.findByRole('heading', { name: '正在連線到工作區' })).toBeTruthy();
    act(() => conn.admit(makeWelcome({ role: 'agent' })));
    const topbar = await screen.findByRole('banner', { name: '工作區' }, { timeout: 15_000 });
    expect(within(topbar).getByText('主人：Ian')).toBeTruthy();
    expect(within(topbar).getByText('可使用 agent')).toBeTruthy();
    expect(within(topbar).getByRole('status').textContent).toContain('已連線');
    expect(within(topbar).getByRole('button', { name: '離開' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '合併請求' })).toBeTruthy();
    act(() => conn.emit('presence.state', { members: [presenceOf(makeMember({ userId: 'dev:bob', displayName: 'Bob', role: 'viewer' }))], agents: [] }));
    expect(within(screen.getByRole('group', { name: '線上成員' })).getByRole('img', { name: 'Bob · 旁觀' })).toBeTruthy();

    act(() => conn.setState({ kind: 'host-offline', reason: 'relay', since: 0 }));
    const banner = await screen.findByTestId('host-offline-banner');
    expect(banner.textContent).toBe('主人的電腦目前離線（可能進入睡眠或網路中斷）。主人回來後會自動重新連線。在主人回來之前，檔案修改不會被儲存，也無法操作 agent。');
    act(() => conn.setState({ kind: 'relay-unreachable', attempt: 2, retryAt: Date.now() + 5_000, cause: 'closed' }));
    expect((await screen.findByTestId('relay-unreachable-banner')).textContent).toMatch(/不是主人離線。\d 秒後重試$/);
  });

  it('a refused connection and the key-mismatch warning', async () => {
    const services = createTestServices({ path: `/w/${WORKSPACE_ID}` });
    render(<App services={services} />);
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    const { conn } = services.connections[0]!;
    act(() => conn.setState({ kind: 'rejected', reason: 'device-revoked' }));
    expect(await screen.findByRole('heading', { name: '這個裝置已無法連線' })).toBeTruthy();
    act(() => conn.setState({ kind: 'key-mismatch', mode: 'device', detail: 'unauthenticated' }));
    const warning = await screen.findByRole('alertdialog', { name: '安全警告：已拒絕連線' });
    expect(warning.textContent).toContain('技術資訊：對方無法證明持有主人金鑰（重新連線）');
  });
});
