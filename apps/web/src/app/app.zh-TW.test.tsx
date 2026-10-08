// The platform's zh-TW suite: a browser that starts in Traditional Chinese gets the landing page, the join page, the
// workspace shell (the top bar with the mode switch, the sessions view around its columns) and the connection screens
// in zh-TW, with <html lang="zh-Hant-TW">.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PENDING_INVITE_KEY_PREFIX } from '../boot/capture-invite.ts';
import { ChunkLoadError } from '../lib/chunks.ts';
import { WORKSPACE_ID, makeInvite, makeMember, makeWelcome, presenceOf } from '../testing/fixtures.ts';
import { useTestLocale } from '../testing/locale.ts';
import { createTestServices } from '../testing/services.tsx';
import { ChunkFailureBanner, SlotBoundary } from '../ui/index.ts';
import { App } from './App.tsx';
import { PageBoundary } from './PageBoundary.tsx';
import { AppServicesProvider } from './services.tsx';

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

  it('workspace: the top bar with the mode switch, the role from the wire catalogue, the sessions view and the host-offline banner', async () => {
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
    // The mode switch: the sessions view is the main screen; code mode is behind the switch.
    const mode = within(topbar).getByRole('group', { name: '模式' });
    expect(within(mode).getByRole('link', { name: 'session' }).getAttribute('aria-current')).toBe('page');
    expect(within(mode).getByRole('link', { name: '手寫 code 模式' }).getAttribute('aria-current')).toBeNull();
    expect(within(topbar).getByRole('button', { name: '顯示或隱藏收件夾與 session 清單' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: '收件夾與 session' })).toBeTruthy();
    expect(screen.getByRole('main', { name: '開啟的欄' })).toBeTruthy();
    expect(document.title).toBe('class-project · smurg');
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

  it('refused for its version: which side has to act, and the reload, in zh-TW', async () => {
    const stale = createTestServices({ path: `/w/${WORKSPACE_ID}`, pageBuild: () => Promise.resolve('stale') });
    const first = render(<App services={stale} />);
    await waitFor(() => expect(stale.connections).toHaveLength(1), { timeout: 15_000 });
    act(() => stale.connections[0]!.conn.setState({ kind: 'rejected', reason: 'version' }));
    expect(await screen.findByRole('heading', { name: '這個分頁是更新之前開的' })).toBeTruthy();
    expect(screen.getByTestId('connection-ended-screen').textContent).toContain('這個分頁開著的時候 smurg 更新了，分頁裡還是更新前的網頁。請重新整理頁面，換成新的網頁。');
    expect(screen.getByRole('button', { name: '重新整理頁面' })).toBeTruthy();
    first.unmount();

    const current = createTestServices({ path: `/w/${WORKSPACE_ID}`, pageBuild: () => Promise.resolve('current') });
    render(<App services={current} />);
    await waitFor(() => expect(current.connections).toHaveLength(1), { timeout: 15_000 });
    act(() => current.connections[0]!.conn.setState({ kind: 'rejected', reason: 'version' }));
    expect(await screen.findByRole('heading', { name: '主人的 smurg 比這個網頁舊' })).toBeTruthy();
    expect(screen.getByTestId('connection-ended-screen').textContent).toContain('請主人停止分享、執行 smurg update，再重新開始分享（自己架設 relay 的主人要重新部署 relay）。然後重新整理這個頁面。');
    expect(screen.getByRole('button', { name: '重新整理頁面' })).toBeTruthy();
  });

  it("the browser's key was written by a newer page, in zh-TW", async () => {
    const services = createTestServices({ path: `/w/${WORKSPACE_ID}`, keyStorage: { persistent: true, newerRecord: true } });
    render(<App services={services} />);
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    act(() => services.connections[0]!.conn.setState({ kind: 'closed', reason: 'storage-error' }));
    expect(await screen.findByRole('heading', { name: '這個瀏覽器的 smurg 金鑰是比較新的網頁寫的' })).toBeTruthy();
    expect(screen.getByTestId('connection-ended-screen').textContent).toContain('金鑰沒有被更動。請重新整理頁面，換成比較新的網頁。');
    expect(screen.getByRole('button', { name: '重新整理頁面' })).toBeTruthy();
  });

  it('a part of the page that did not load: a slot, the banner of the workspace and the whole page say why, in zh-TW', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    function Throws({ error }: { error: unknown }): null {
      throw error;
    }
    const view = render(
      <AppServicesProvider services={createTestServices()}>
        <ChunkFailureBanner />
        <SlotBoundary name="終端機（Amy）">
          <Throws error={new ChunkLoadError('gone', null)} />
        </SlotBoundary>
        <SlotBoundary name="topics" silent>
          <Throws error={new ChunkLoadError('offline', null)} />
        </SlotBoundary>
      </AppServicesProvider>,
    );
    const [banner, slot] = screen.getAllByRole('alert') as [HTMLElement, HTMLElement];
    expect(slot.textContent).toBe('smurg 已經更新重新整理頁面就會換成新的網頁；如果主人還沒更新，頁面會告訴你。重新整理頁面');
    expect(banner.textContent).toContain('頁面的這個部分載入不了');
    expect(banner.textContent).toContain('瀏覽器離線了，或連不上 smurg 伺服器。網路恢復後，請重新整理頁面。');
    expect(within(banner).getByRole('button', { name: '重新整理頁面' })).toBeTruthy();
    view.unmount();

    render(
      <AppServicesProvider services={createTestServices()}>
        <PageBoundary resetKey="a">
          <Throws error={new ChunkLoadError('gone', null)} />
        </PageBoundary>
      </AppServicesProvider>,
    );
    const page = screen.getByTestId('page-not-loaded');
    expect(within(page).getByRole('heading', { name: 'smurg 已經更新' })).toBeTruthy();
    expect(page.textContent).toContain('重新整理頁面就會換成新的網頁；如果主人還沒更新，頁面會告訴你。');
    expect(within(page).getByRole('button', { name: '重新整理頁面' })).toBeTruthy();
    expect(within(page).getByRole('button', { name: '語言' })).toBeTruthy();
    warn.mockRestore();
  });
});
