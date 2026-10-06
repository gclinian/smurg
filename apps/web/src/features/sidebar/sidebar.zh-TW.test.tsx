// The left column in Traditional Chinese: the inbox (收件夾, the owner's word), its two groups and counts, the rows the
// shell composes from structured fields, the session tree's fixed rows and statuses, "New", the filter, the banners.
// Text people or agents wrote (a question, a command, a topic's name) stays as it is.
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildInboxItem } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { useTestLocale } from '../../testing/locale.ts';
import { InboxNotices, ShellBanners } from './Notices.tsx';
import { MEI, SEARCH, TOPIC, mountSidebar } from './test-support.tsx';

useTestLocale('zh-TW');

const NOW = Date.now();
const INBOX = [
  buildInboxItem('question', { excerpt: '購物車的總金額要在哪裡計算？', topicId: 'tp_1', voted: 3, eligible: 3, allVoted: true, leading: '在伺服器上', at: NOW - 6 * 60_000 }),
  buildInboxItem('vote', { key: 'vote:q_2', excerpt: '先做哪個篩選？', topicId: 'tp_1', voted: 1, eligible: 4, waitsFor: { userId: 'dev:host', displayName: 'Ian' }, waitsForOffline: false, at: NOW - 3 * 60_000 }),
  buildInboxItem('attention', { topicId: 'tp_1', at: NOW - 4 * 60_000 }),
  buildInboxItem('suggestion', { count: 3, topicId: 'tp_1', at: NOW - 8 * 60_000 }),
  buildInboxItem('report', { outcome: 'partial', checks: { passed: 2, notVerified: 1 }, at: NOW - 12 * 60_000 }),
  buildInboxItem('merge', { unblocks: [6], at: NOW - 60 * 60_000 }),
  buildInboxItem('mention', { from: { kind: 'user', ...MEI }, excerpt: 'A 加上快取就夠了', topicId: 'tp_1', at: NOW - 5 * 60_000 }),
];

describe('the left column in zh-TW', () => {
  it('the inbox has the owner\'s word for it, its two groups, the two counts in words, and rows composed in Chinese', async () => {
    await mountSidebar({ inbox: INBOX });
    expect(screen.getByRole('complementary', { name: '收件夾與 session' })).toBeTruthy();
    const inbox = screen.getByRole('region', { name: '收件夾' });
    expect(inbox.querySelector('.inbox-counts')?.textContent).toContain('3 個在等，4 個待看');
    expect(within(inbox).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent?.replace(/\d+$/, ''))).toEqual(['agent 在等你', '等你看的']);
    const row = (key: string): { title: string; where: string } => {
      const element = document.querySelector(`[data-inbox-key="${key}"]`) as HTMLElement;
      return { title: element.querySelector('.inbox-item__title')?.textContent ?? '', where: element.querySelector('.inbox-item__where')?.textContent ?? '' };
    };
    // The question is the agent's own words; what the shell adds is Chinese.
    expect(row('question:q_1')).toEqual({ title: '購物車的總金額要在哪裡計算？', where: 'Checkout redesign › 1 · Cart API · 3 人都投票了 · 送出「在伺服器上」' });
    expect(row('vote:q_2')).toEqual({ title: '投票：先做哪個篩選？', where: 'Checkout redesign › 1 · Cart API · 4 人中 1 人已投票 · 由 Ian 決定' });
    expect(row('attention:item-stalled:tp_1.cart-api').title).toBe('1 · Cart API 沒寫報告就停下了');
    expect(row('suggestion:sess_a.dev-amy').title).toBe('Amy：3 則建議');
    expect(row('report:tp_1.cart-api')).toEqual({ title: '結果報告：1 · Cart API', where: 'Checkout redesign · 部分完成 · 2 項通過 · 1 項未驗證' });
    expect(row('merge:mr_1')).toEqual({ title: '已看過，可以合併：1 · Cart API', where: 'Checkout redesign · 項目 6 在等它' });
    expect(row('mention:nt_1').title).toBe('Mei 提到你：A 加上快取就夠了');
    // Kinds, ages and actions.
    const stalled = document.querySelector('[data-inbox-key="attention:item-stalled:tp_1.cart-api"]') as HTMLElement;
    expect(within(stalled).getByRole('img', { name: '停住了：需要有人處理' })).toBeTruthy();
    expect(within(stalled).getByRole('button', { name: '繼續' })).toBeTruthy();
    expect(stalled.querySelector('.inbox-item__age')?.textContent).toMatch(/^4\s?分鐘$/);
    expect(within(document.querySelector('[data-inbox-key="mention:nt_1"]') as HTMLElement).getByRole('button', { name: '移除：Mei 提到你：A 加上快取就夠了' })).toBeTruthy();
    expect(within(document.querySelector('[data-inbox-key="question:q_1"]') as HTMLElement).getByRole('img', { name: '選擇題' })).toBeTruthy();
  });

  it('an empty inbox, also for a viewer', async () => {
    await mountSidebar({ role: 'viewer' });
    expect(screen.getByRole('region', { name: '收件夾' }).textContent).toContain('目前沒有等你處理的事。旁觀者在這裡只會收到提及。');
  });

  it('the session tree: phases, the fixed rows, statuses and who is responsible; the group of sessions without a topic', async () => {
    await mountSidebar();
    const sessions = screen.getByRole('region', { name: 'session' });
    const tree = within(sessions).getByRole('tree', { name: '依主題分組的 session' });
    expect(within(tree).getAllByRole('treeitem').filter((item) => item.getAttribute('aria-level') === '1').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Checkout redesign，執行中',
      'Search filters，討論中',
      '未分主題',
    ]);
    const checkout = within(tree).getByRole('treeitem', { name: /^Checkout redesign/ });
    expect(within(checkout).getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))).toEqual([
      '討論, 待命, 沒有負責人：大家一起看',
      'spec',
      '計畫, 6 項中 0 項已看過',
      '1 · Cart API, 等待回答, 負責人：Ian',
      '2 · Payment form, 執行中, 負責人：Mei',
    ]);
    expect(within(within(tree).getByRole('treeitem', { name: /^Search filters/ })).getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))).toEqual(['spec, 還沒寫', '計畫, 還沒有計畫']);
    expect(within(tree).getByRole('treeitem', { name: /^終端機（Ian）/ })).toBeTruthy();
    // Folded: the count in words.
    await userEvent.click(screen.getByText('Checkout redesign'));
    expect(checkout.getAttribute('aria-label')).toBe('Checkout redesign，執行中，1 個在等');
  });

  it('"New", the filter, the context menu and the archived topics', async () => {
    await mountSidebar();
    const sessions = screen.getByRole('region', { name: 'session' });
    await userEvent.click(within(sessions).getByRole('button', { name: '新增' }));
    expect(within(screen.getByRole('menu', { name: '新增主題、session 或終端機' })).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['新增主題', '新增 session', '終端機']);
    await userEvent.click(screen.getByRole('menuitem', { name: '終端機' }));
    expect(await screen.findByText('這個版本的 smurg 無法開啟這個功能。')).toBeTruthy();
    expect(within(within(sessions).getByRole('radiogroup', { name: '顯示' })).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['全部', '我的', '等待中']);
    act(() => screen.getByRole('treeitem', { name: /^1 · Cart API/ }).focus());
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    expect(within(screen.getByRole('menu', { name: '「1 · Cart API」的操作' })).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['開啟', '在旁邊開啟']);
    await userEvent.keyboard('{Escape}');
    expect(within(sessions).getByRole('button', { name: '顯示已封存的主題' })).toBeTruthy();
  });

  it('the rail', async () => {
    await mountSidebar({ inbox: INBOX, collapsed: true });
    expect(within(document.querySelector('.sidebar-rail') as HTMLElement).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['收件夾：3 個在等，4 個待看', 'session', '新增主題']);
  });

  it('the banners and the announcement of a new waiting item', async () => {
    const paused = { ...TOPIC, plan: { ...TOPIC.plan, paused: true } };
    const view = await mountSidebar({
      ui: (
        <>
          <ShellBanners />
          <InboxNotices sessionsShown />
        </>
      ),
      role: 'viewer',
      topics: [paused, SEARCH],
    });
    expect(document.querySelector('[data-banner="restart"]')?.textContent).toBe('主人電腦上的 smurg 重新啟動了。1 個主題的計畫已暫停。 主人或「可使用 agent」的成員可以讓它們繼續。');
    act(() => view.conn.emit('session.host', { account: { state: 'usage-limit', sessions: 2 }, mainProjectSettings: 'none' }));
    expect(document.querySelector('[data-banner="account"]')?.textContent).toBe('主人的 Claude 帳號達到用量上限。agent 會等到額度重置。 2 個 session 在等。');
    act(() => view.conn.emit('inbox.changed', { upsert: [buildInboxItem('permission', { excerpt: 'pnpm lint', sessionId: 's_free', target: { kind: 'session', sessionId: 's_free' } })], remove: [] }));
    expect(document.querySelector('[data-inbox-announcer]')?.textContent).toBe('收件夾有新項目，agent 在等：pnpm lint。未分主題 › Fix flaky CI test');
    const toast = (await screen.findByText('agent 在等：pnpm lint')).closest('.ui-toast') as HTMLElement;
    expect(within(toast).getByRole('button', { name: '開啟' })).toBeTruthy();
  });
});
