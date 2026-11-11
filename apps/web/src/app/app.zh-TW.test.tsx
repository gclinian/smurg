// The platform's zh-TW suite: a browser that starts in Traditional Chinese gets the landing page, the join page, the
// workspace shell (the top bar with the mode switch, the sessions view around its columns, the sticky notes) and the
// connection screens in zh-TW, with <html lang="zh-Hant-TW">.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SmurgError } from '@smurg/protocol';
import { buildAgentSession } from '@smurg/protocol/testing';
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
    // The mode switch: the sessions view is the main screen; the sticky notes (DESIGN 0.8.0 D7.1) and code mode are behind
    // the switch.
    const mode = within(topbar).getByRole('group', { name: '模式' });
    expect(within(mode).getAllByRole('link').map((link) => link.textContent)).toEqual(['便利貼', 'session', '手寫 code 模式']);
    expect(within(mode).getByRole('link', { name: '便利貼' }).getAttribute('aria-current')).toBeNull();
    expect(within(mode).getByRole('link', { name: '便利貼' }).getAttribute('title')).toBe('便利貼：從 Home 長出來、互相連結的小張便利貼');
    expect(within(mode).getByRole('link', { name: 'session' }).getAttribute('aria-current')).toBe('page');
    expect(within(mode).getByRole('link', { name: '手寫 code 模式' }).getAttribute('aria-current')).toBeNull();
    expect(within(topbar).getByRole('button', { name: '顯示或隱藏收件夾與 session 清單' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: '收件夾與 session' })).toBeTruthy();
    expect(screen.getByRole('main', { name: '開啟的欄' })).toBeTruthy();
    expect(document.title).toBe('class-project · smurg');
    act(() => conn.emit('presence.state', { members: [presenceOf(makeMember({ userId: 'dev:bob', displayName: 'Bob', role: 'viewer' }))], agents: [] }));
    expect(within(screen.getByRole('group', { name: '線上成員' })).getByRole('img', { name: 'Bob · 旁觀' })).toBeTruthy();
    // While the host lets agents ask for nothing, a badge beside the name says so to every member (DESIGN 0.6.0 D13).
    act(() => conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, permissionMode: 'ask-nothing' } }));
    const badge = within(topbar).getByText('agent 什麼都不問');
    expect(badge.closest('[title]')?.getAttribute('title')).toBe('主人讓這個工作區的 agent 以主人的身分執行指令，Claude Code 不檢查，smurg 也不會先問；只剩 smurg 固定的限制。');
    act(() => conn.emit('channel.settingsUpdated', { settings: makeWelcome().settings }));
    expect(within(topbar).queryByText('agent 什麼都不問')).toBeNull();

    act(() => conn.setState({ kind: 'host-offline', reason: 'relay', since: 0 }));
    const banner = await screen.findByTestId('host-offline-banner');
    expect(banner.textContent).toBe('主人的電腦目前離線（可能進入睡眠或網路中斷）。主人回來後會自動重新連線。在主人回來之前，檔案修改不會被儲存，也無法操作 agent。');
    act(() => conn.setState({ kind: 'relay-unreachable', attempt: 2, retryAt: Date.now() + 5_000, cause: 'closed' }));
    expect((await screen.findByTestId('relay-unreachable-banner')).textContent).toMatch(/不是主人離線。\d 秒後重試$/);
  });

  it('the sticky notes at the address of a note: that note, the regions and the skip link in zh-TW; switching views keeps the one connection', async () => {
    const at = `/w/${WORKSPACE_ID}/notes/${encodeURIComponent('Payment form')}`;
    const services = createTestServices({ path: at });
    render(<App services={services} />);
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    const { conn } = services.connections[0]!;
    conn.handle('sticky.list', () => ({ notes: [{ name: 'Home', links: ['Payment form'] }, { name: 'Payment form', links: [] }], hasMore: false, truncated: false, sources: [] }));
    act(() => conn.admit(makeWelcome({ role: 'agent' })));
    // The note of the address, through App's routes (review S3-T3).
    expect(await screen.findByRole('heading', { level: 2, name: 'Payment form' }, { timeout: 15_000 })).toBeTruthy();
    // The notes view's own words (review S3-T4).
    expect(screen.getByRole('complementary', { name: '所有便利貼' })).toBeTruthy();
    expect(screen.getByRole('main', { name: '開啟的便利貼' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '跳到便利貼' }).getAttribute('href')).toBe('#notes-main');
    expect(screen.getAllByRole('separator').map((separator) => separator.getAttribute('aria-label'))).toEqual([
      '拖曳或用方向鍵調整「所有便利貼」的大小',
      '拖曳或用方向鍵調整「便利貼的 Claude」的大小',
    ]);
    const mode = within(screen.getByRole('banner', { name: '工作區' })).getByRole('group', { name: '模式' });
    expect(within(mode).getByRole('link', { name: '便利貼' }).getAttribute('aria-current')).toBe('page');
    await userEvent.click(within(mode).getByRole('link', { name: 'session' }));
    expect(services.router.getState().pathname).toBe(`/w/${WORKSPACE_ID}`);
    await userEvent.click(within(mode).getByRole('link', { name: '便利貼' }));
    expect(services.router.getState().pathname).toBe(at);
    expect(screen.getByRole('heading', { level: 2, name: 'Payment form' })).toBeTruthy();
    expect(services.connections).toHaveLength(1);
  }, 30_000);

  it('Claude\'s pane of the sticky notes in zh-TW: the spinner, "Start Claude" and its sentence, "Start Claude again", who can start it, a list that could not be loaded', async () => {
    const shell = async (role: 'agent' | 'editor', sessions: readonly unknown[] | 'fails') => {
      const services = createTestServices({ path: `/w/${WORKSPACE_ID}/notes` });
      const view = render(<App services={services} />);
      await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
      const { conn } = services.connections[0]!;
      conn.handle('sticky.list', () => ({ notes: [{ name: 'Home', links: [] }], hasMore: false, truncated: false, sources: [] }));
      act(() => conn.admit(makeWelcome({ role })));
      await screen.findByRole('main', { name: '開啟的便利貼' }, { timeout: 15_000 });
      const pane = document.querySelector('.app-notes__chat') as HTMLElement;
      // Until the session list is there.
      expect(within(pane).getByText('正在載入便利貼的 Claude…')).toBeTruthy();
      await act(async () => {
        if (sessions === 'fails') conn.fail('session.list', new SmurgError('internal', 'not implemented: sessions'));
        else conn.respond('session.list', { sessions: [...sessions] as never, hasMore: false });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      return { pane, unmount: view.unmount };
    };
    const first = await shell('agent', []);
    expect(within(first.pane).getByRole('heading', { level: 2, name: '便利貼的 Claude' })).toBeTruthy();
    expect(first.pane.textContent).toContain('Claude 幫你寫便利貼、整理便利貼。它會讀這個專案，但只寫便利貼；它寫了什麼，大家馬上都看得到。');
    expect(within(first.pane).getByRole('button', { name: '啟動 Claude' })).toBeTruthy();
    first.unmount();
    const ended = buildAgentSession({ id: 's_notes', purpose: 'notes', modeFixed: true, status: 'ended' });
    const again = await shell('agent', [ended]);
    expect(again.pane.textContent).toContain('便利貼的 Claude 已經結束了。');
    expect(within(again.pane).getByRole('button', { name: '重新啟動 Claude' })).toBeTruthy();
    again.unmount();
    const editor = await shell('editor', []);
    expect(editor.pane.textContent).toContain('可使用 agent 的成員可以啟動它。');
    expect(within(editor.pane).queryByRole('button')).toBeNull();
    editor.unmount();
    const failed = await shell('agent', 'fails');
    expect(within(failed.pane).getByRole('alert').textContent).toMatch(/^無法載入 session 清單：/);
    expect(within(failed.pane).getAllByRole('button').map((button) => button.textContent)).toEqual(['再試一次']);
  }, 60_000);

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
