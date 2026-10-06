// The columns in Traditional Chinese: the frame's own words (the header's buttons, the menu, the refusal, the states
// without content) and the names the shell gives a column. What people and agents wrote is never translated.
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useTestLocale } from '../../testing/locale.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { ColumnStrip, SideColumn } from './index.tsx';
import { PROBES, TERMINAL, loadWorkspace } from './test-support.tsx';

useTestLocale('zh-TW');

const CJK = /[㐀-鿿]/;

describe('the columns in zh-TW', () => {
  it('a column\'s header: the name from the shell, the status in words, pin, more actions, close', async () => {
    const view = renderInWorkspace(<ColumnStrip shown empty={null} />, { role: 'host', slots: [PROBES] });
    await loadWorkspace(view);
    act(() => {
      view.stores.columns.open({ kind: 'session', sessionId: 's_cart' });
      view.stores.columns.open({ kind: 'plan', topicId: 't1' }, { side: true });
      view.stores.columns.open({ kind: 'session', sessionId: 's_disc' }, { side: true });
    });
    // A work item's name is its own; the plan and a discussion are named by the shell.
    const cart = screen.getByRole('region', { name: '1 · Cart API' });
    expect(within(cart).getByRole('img', { name: '等待回答' })).toBeTruthy();
    expect(within(cart).getByRole('button', { name: '釘選這一欄：1 · Cart API' })).toBeTruthy();
    expect(within(cart).getByRole('button', { name: '關閉這一欄：1 · Cart API' })).toBeTruthy();
    const plan = screen.getByRole('region', { name: '計畫 · Checkout redesign' });
    expect(within(plan).getByRole('heading', { level: 2 }).textContent).toBe('計畫');
    expect(screen.getByRole('region', { name: '討論 · Checkout redesign' })).toBeTruthy();
    await userEvent.click(within(plan).getByRole('button', { name: '「計畫 · Checkout redesign」的更多操作' }));
    expect(within(screen.getByRole('menu', { name: '「計畫 · Checkout redesign」的更多操作' })).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['釘選這一欄', '關閉其他欄', 'Update plan']);
    await userEvent.keyboard('{Escape}');
    expect(screen.getAllByRole('separator')[0]?.getAttribute('aria-label')).toBe('拖曳或用方向鍵調整「1 · Cart API」的寬度');
    await userEvent.click(within(plan).getByRole('button', { name: '釘選這一欄：計畫 · Checkout redesign' }));
    expect(within(plan).getByRole('button', { name: '取消釘選：計畫 · Checkout redesign' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the fifth column, a session the host no longer keeps, a kind nothing shows', async () => {
    const view = renderInWorkspace(<ColumnStrip shown empty={null} />, { role: 'host' });
    await loadWorkspace(view);
    act(() => {
      view.stores.columns.open({ kind: 'session', sessionId: 's_term' });
      view.stores.columns.open({ kind: 'session', sessionId: 's_gone' }, { side: true });
      view.stores.columns.open({ kind: 'spec', topicId: 't1' }, { side: true });
      view.stores.columns.open({ kind: 'report', topicId: 't1', itemId: 'cart-api' }, { side: true });
      view.stores.columns.open({ kind: 'plan', topicId: 't1' }, { side: true });
    });
    expect(await screen.findByText('已經開了四欄，請先關閉一欄。')).toBeTruthy();
    expect(screen.getByRole('region', { name: '終端機（Ian）' }).textContent).toContain('這裡無法顯示「終端機（Ian）」');
    const gone = screen.getByRole('region', { name: 'session' });
    expect(gone.textContent).toContain('主人的電腦不再保留它的內容');
    expect(within(gone).getByRole('button', { name: '關閉這一欄' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'spec · Checkout redesign' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '結果報告：1 · Cart API · Checkout redesign' })).toBeTruthy();
    // Every word of the frame is Chinese (the names people gave stay as they are).
    for (const button of screen.getAllByRole('button')) expect(button.getAttribute('aria-label') ?? button.textContent, button.outerHTML.slice(0, 80)).toMatch(CJK);
  });

  it('code mode\'s session column', async () => {
    const view = renderInWorkspace(<SideColumn shown />, { role: 'host', slots: [PROBES] });
    await loadWorkspace(view);
    const region = screen.getByRole('region', { name: '編輯器旁的 session' });
    expect(region.textContent).toContain('編輯器旁沒有 session');
    expect(region.textContent).toContain('選一個 agent session，把它的對話留在程式碼旁邊。');
    const select = within(region).getByRole('combobox', { name: '顯示在編輯器旁的 session' });
    const options = within(select).getAllByRole('option').map((option) => option.textContent);
    expect(options[0]).toBe('不顯示 session');
    // The order of the sessions is the collation of the viewer's language.
    expect(options.slice(1).sort()).toEqual(['1 · Cart API · Checkout redesign', 'Fix flaky CI test', '討論 · Checkout redesign'].sort());
    void TERMINAL;
  });
});
